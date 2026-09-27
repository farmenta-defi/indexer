import type { Address, Hex } from "viem";

import { badDebtSocialized, liquidation, loan, loanActivity, position } from "../../ponder.schema.ts";
import { LOAN_STATUS } from "../lib/loan.ts";
import { lower, marketLogKey, type Db, type Log } from "./event.ts";
import { noStaleBurn, releaseBurn } from "./pendingBurn.ts";

// Both markets emit these; `event.log.address` says which one (ponder.config.ts).

type Kind = "deposit" | "withdraw" | "borrow" | "repay" | "increase_liquidity" | "decrease_liquidity" | "collect_fees";

const NO_FIGURES = { amountUsdg: null, liquidityDelta: null, amount0: null, amount1: null };

const activity = (
  event: Log<{ tokenId: bigint }>,
  owner: Address,
  kind: Kind,
  figures: Partial<Record<keyof typeof NO_FIGURES, bigint>> = {},
) => ({
  ...marketLogKey(event),
  tokenId: event.args.tokenId,
  owner,
  kind,
  ...NO_FIGURES,
  ...figures,
});

// Every event of a loan names its pool, and must name the one `CollateralDeposited` did:
// the contract emits `Loan.poolKeyId` each time (spec §4.1, FAR-42).
function samePool(held: { poolId: Hex }, event: Log<{ tokenId: bigint; poolId: Hex }>) {
  const { tokenId, poolId } = event.args;
  if (held.poolId !== poolId) {
    throw new Error(`position ${tokenId} on ${lower(event.log.address)}: event names pool ${poolId}, the loan ${held.poolId}`);
  }
}

// Emitted by `depositCollateral`, `depositCollateralWithPermit`, `mintAndDeposit` and the
// `safeTransferFrom` push alike, always after the NFT reached the market. The loan's pool
// is the one the event names (spec §4.1, FAR-42). `position` only confirms it, where the
// mint was seen: a mismatch means the salt-to-tokenId join is wrong.
export async function onCollateralDeposited(db: Db, event: Log<{ tokenId: bigint; owner: Address; poolId: Hex }>) {
  await noStaleBurn(db, event);
  const market = lower(event.log.address);
  const { tokenId, poolId } = event.args;
  const owner = lower(event.args.owner);
  const minted = await db.find(position, { tokenId });
  if (minted && minted.poolId !== null && minted.poolId !== poolId) {
    throw new Error(`position ${tokenId} on ${market}: event names pool ${poolId}, the position row ${minted.poolId}`);
  }

  const row = {
    owner,
    poolId,
    status: LOAN_STATUS.inCustody,
    everBorrowed: false,
    borrowedUsdg: 0n,
    repaidUsdg: 0n,
    liquidatedUsdg: 0n,
    depositedBlock: event.block.number,
    depositedAt: event.block.timestamp,
    lastActivityAt: event.block.timestamp,
    closedAt: null,
  };
  // A conflict is a redeposit: the earlier loan was deleted on chain, so the row starts over.
  await db.insert(loan).values({ market, tokenId, ...row }).onConflictDoUpdate(row);
  await db.insert(loanActivity).values(activity(event, owner, "deposit"));
}

export async function onCollateralWithdrawn(db: Db, event: Log<{ tokenId: bigint; owner: Address; poolId: Hex }>) {
  await noStaleBurn(db, event);
  const market = lower(event.log.address);
  const { tokenId } = event.args;
  const held = await db.find(loan, { market, tokenId });
  if (!held) throw new Error(`CollateralWithdrawn for position ${tokenId}, which ${market} never took into custody`);
  samePool(held, event);

  await db.update(loan, { market, tokenId }).set({
    status: LOAN_STATUS.withdrawn,
    lastActivityAt: event.block.timestamp,
    closedAt: event.block.timestamp,
  });
  await db.insert(loanActivity).values(activity(event, lower(event.args.owner), "withdraw"));
}

export async function onBorrow(db: Db, event: Log<{ tokenId: bigint; poolId: Hex; amount: bigint }>) {
  await noStaleBurn(db, event);
  const market = lower(event.log.address);
  const { tokenId, amount } = event.args;
  const held = await db.find(loan, { market, tokenId });
  if (!held) throw new Error(`Borrow against position ${tokenId}, which ${market} never took into custody`);
  samePool(held, event);

  await db.update(loan, { market, tokenId }).set({
    everBorrowed: true,
    borrowedUsdg: held.borrowedUsdg + amount,
    lastActivityAt: event.block.timestamp,
  });
  await db.insert(loanActivity).values(activity(event, held.owner, "borrow", { amountUsdg: amount }));
}

// `amount` is what was actually taken, after the cap at the outstanding debt. `everBorrowed`
// stays true even when that was all of it: only `debtOf` can tell.
export async function onRepay(db: Db, event: Log<{ tokenId: bigint; poolId: Hex; amount: bigint }>) {
  await noStaleBurn(db, event);
  const market = lower(event.log.address);
  const { tokenId, amount } = event.args;
  const held = await db.find(loan, { market, tokenId });
  if (!held) throw new Error(`Repay for position ${tokenId}, which ${market} never took into custody`);
  samePool(held, event);

  await db.update(loan, { market, tokenId }).set({
    repaidUsdg: held.repaidUsdg + amount,
    lastActivityAt: event.block.timestamp,
  });
  await db.insert(loanActivity).values(activity(event, held.owner, "repay", { amountUsdg: amount }));
}

// `LiquidityChanged` and `CollectFees` change nothing on the loan but its last activity.
async function touch(db: Db, event: Log<{ tokenId: bigint; poolId: Hex }>) {
  await noStaleBurn(db, event);
  const market = lower(event.log.address);
  const { tokenId } = event.args;
  const held = await db.find(loan, { market, tokenId });
  if (!held) throw new Error(`${market} changed position ${tokenId}, which it never took into custody`);
  samePool(held, event);

  await db.update(loan, { market, tokenId }).set({ lastActivityAt: event.block.timestamp });
  return held;
}

// `increaseLiquidity` and `decreaseLiquidity` on a position in custody. Recorded as history
// only: the position's liquidity follows `ModifyLiquidity` (poolManager.ts), which also sees
// the partial liquidations and the burn that emit no `LiquidityChanged`.
export async function onLiquidityChanged(db: Db, event: Log<{ tokenId: bigint; poolId: Hex; liqDelta: bigint }>) {
  const held = await touch(db, event);
  const { liqDelta } = event.args;
  const kind = liqDelta < 0n ? "decrease_liquidity" : "increase_liquidity";
  await db.insert(loanActivity).values(activity(event, held.owner, kind, { liquidityDelta: liqDelta }));
}

// Emitted by `collectFees` and by the fee claims inside `increaseLiquidity` and
// `decreaseLiquidity` (spec §4.1, FAR-52). The amounts are the fees the position realised.
export async function onCollectFees(
  db: Db,
  event: Log<{ tokenId: bigint; poolId: Hex; amount0: bigint; amount1: bigint }>,
) {
  const held = await touch(db, event);
  const { amount0, amount1 } = event.args;
  await db.insert(loanActivity).values(activity(event, held.owner, "collect_fees", { amount0, amount1 }));
}

export async function onBadDebtSocialized(db: Db, event: Log<{ amount: bigint }>) {
  await noStaleBurn(db, event);
  await db.insert(badDebtSocialized).values({ ...marketLogKey(event), amountUsdg: event.args.amount });
}

// `liquidate` emits, in this order and with nothing in between: `ReservesUpdated`,
// `BadDebtSocialized` when lenders took a loss, `Liquidate`. `fullSeizure` says whether the
// position was burned and the loan deleted on chain (FAR-51); it is the only thing that
// closes a loan here, whether or not any bad debt was left.
export async function onLiquidate(
  db: Db,
  event: Log<{
    tokenId: bigint;
    liquidator: Address;
    poolId: Hex;
    repaid: bigint;
    out0: bigint;
    out1: bigint;
    badDebt: bigint;
    fullSeizure: boolean;
  }>,
) {
  const market = lower(event.log.address);
  const { tokenId, poolId, repaid, out0, out1, badDebt, fullSeizure } = event.args;
  const held = await db.find(loan, { market, tokenId });
  if (!held) throw new Error(`Liquidate for position ${tokenId}, which ${market} never took into custody`);
  samePool(held, event);

  // `BadDebtSocialized` names no position. It is this liquidation's when it is the log right
  // before this one, in the same transaction.
  const before = await db.find(badDebtSocialized, {
    market,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex - 1,
  });
  const socialized = before?.transactionHash === event.transaction.hash ? before.amountUsdg : 0n;
  // Lenders only lose what the position and the reserve could not cover.
  if (socialized > badDebt) throw new Error(`Liquidate for position ${tokenId}: socialized ${socialized} of ${badDebt}`);
  await releaseBurn(db, event);

  await db.update(loan, { market, tokenId }).set({
    liquidatedUsdg: held.liquidatedUsdg + repaid,
    lastActivityAt: event.block.timestamp,
    ...(fullSeizure ? { status: LOAN_STATUS.liquidated, closedAt: event.block.timestamp } : {}),
  });
  await db.insert(liquidation).values({
    ...marketLogKey(event),
    tokenId,
    owner: held.owner,
    poolId,
    liquidator: lower(event.args.liquidator),
    full: fullSeizure,
    repaidUsdg: repaid,
    badDebtUsdg: badDebt,
    socializedUsdg: socialized,
    out0,
    out1,
  });
}
