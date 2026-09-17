import type { Address, Hex } from "viem";

import { badDebtSocialized, liquidation, loan, loanActivity, position } from "../../ponder.schema.ts";
import { LOAN_STATUS } from "../lib/loan.ts";
import { lower, marketLogKey, type Db, type Log } from "./event.ts";

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

// Emitted by `depositCollateral`, `depositCollateralWithPermit`, `mintAndDeposit` and the
// `safeTransferFrom` push alike, always after the NFT reached the market, so the position
// row is there to take the pool from.
export async function onCollateralDeposited(db: Db, event: Log<{ tokenId: bigint; owner: Address }>) {
  const market = lower(event.log.address);
  const { tokenId } = event.args;
  const owner = lower(event.args.owner);
  const held = await db.find(position, { tokenId });

  const row = {
    owner,
    poolId: held?.poolId ?? null,
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

export async function onCollateralWithdrawn(db: Db, event: Log<{ tokenId: bigint; owner: Address }>) {
  const market = lower(event.log.address);
  const { tokenId } = event.args;
  const held = await db.find(loan, { market, tokenId });
  if (!held) throw new Error(`CollateralWithdrawn for position ${tokenId}, which ${market} never took into custody`);

  await db.update(loan, { market, tokenId }).set({
    status: LOAN_STATUS.withdrawn,
    lastActivityAt: event.block.timestamp,
    closedAt: event.block.timestamp,
  });
  await db.insert(loanActivity).values(activity(event, lower(event.args.owner), "withdraw"));
}

export async function onBorrow(db: Db, event: Log<{ tokenId: bigint; amount: bigint }>) {
  const market = lower(event.log.address);
  const { tokenId, amount } = event.args;
  const held = await db.find(loan, { market, tokenId });
  if (!held) throw new Error(`Borrow against position ${tokenId}, which ${market} never took into custody`);

  await db.update(loan, { market, tokenId }).set({
    everBorrowed: true,
    borrowedUsdg: held.borrowedUsdg + amount,
    lastActivityAt: event.block.timestamp,
  });
  await db.insert(loanActivity).values(activity(event, held.owner, "borrow", { amountUsdg: amount }));
}

// `amount` is what was actually taken, after the cap at the outstanding debt. `everBorrowed`
// stays true even when that was all of it: only `debtOf` can tell.
export async function onRepay(db: Db, event: Log<{ tokenId: bigint; amount: bigint }>) {
  const market = lower(event.log.address);
  const { tokenId, amount } = event.args;
  const held = await db.find(loan, { market, tokenId });
  if (!held) throw new Error(`Repay for position ${tokenId}, which ${market} never took into custody`);

  await db.update(loan, { market, tokenId }).set({
    repaidUsdg: held.repaidUsdg + amount,
    lastActivityAt: event.block.timestamp,
  });
  await db.insert(loanActivity).values(activity(event, held.owner, "repay", { amountUsdg: amount }));
}

// `LiquidityChanged` and `CollectFees` already carry the loan's `poolKeyId` (the other events
// follow in FAR-42). It fills a pool that START_BLOCK_FLOOR left null, and must agree with
// one taken from `position`: a mismatch means the salt-to-tokenId join is wrong.
async function touch(db: Db, event: Log<{ tokenId: bigint; poolId: Hex }>) {
  const market = lower(event.log.address);
  const { tokenId, poolId } = event.args;
  const held = await db.find(loan, { market, tokenId });
  if (!held) throw new Error(`${market} changed position ${tokenId}, which it never took into custody`);
  if (held.poolId !== null && held.poolId !== poolId) {
    throw new Error(`position ${tokenId} on ${market}: event names pool ${poolId}, the position row ${held.poolId}`);
  }

  await db.update(loan, { market, tokenId }).set({ poolId, lastActivityAt: event.block.timestamp });
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

// Only `collectFees` emits this; the fee claims inside the two liquidity functions do not
// (spec §4.1, v0.48). The amounts are `to`'s balance change, not verified fee income.
export async function onCollectFees(
  db: Db,
  event: Log<{ tokenId: bigint; poolId: Hex; amount0: bigint; amount1: bigint }>,
) {
  const held = await touch(db, event);
  const { amount0, amount1 } = event.args;
  await db.insert(loanActivity).values(activity(event, held.owner, "collect_fees", { amount0, amount1 }));
}

export async function onBadDebtSocialized(db: Db, event: Log<{ amount: bigint }>) {
  await db.insert(badDebtSocialized).values({ ...marketLogKey(event), amountUsdg: event.args.amount });
}

// `liquidate` emits, in this order and with nothing in between: `ReservesUpdated`,
// `BadDebtSocialized` when lenders took a loss, `Liquidate`. On the full branch the burn,
// and so the `Transfer` that closed the loan, came earlier in the same transaction.
export async function onLiquidate(
  db: Db,
  event: Log<{ tokenId: bigint; liquidator: Address; repaid: bigint; out0: bigint; out1: bigint; badDebt: bigint }>,
) {
  const market = lower(event.log.address);
  const { tokenId, repaid, out0, out1, badDebt } = event.args;
  const held = await db.find(loan, { market, tokenId });
  if (!held) throw new Error(`Liquidate for position ${tokenId}, which ${market} never took into custody`);

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

  await db.update(loan, { market, tokenId }).set({
    liquidatedUsdg: held.liquidatedUsdg + repaid,
    lastActivityAt: event.block.timestamp,
  });
  await db.insert(liquidation).values({
    ...marketLogKey(event),
    tokenId,
    owner: held.owner,
    poolId: held.poolId,
    liquidator: lower(event.args.liquidator),
    full: held.status === LOAN_STATUS.liquidated,
    repaidUsdg: repaid,
    badDebtUsdg: badDebt,
    socializedUsdg: socialized,
    out0,
    out1,
  });
}
