import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, numberToHex, zeroAddress, type Address, type Hex } from "viem";

import { UNISWAP } from "../config/uniswap.ts";
import * as schema from "../ponder.schema.ts";
import {
  onBorrow,
  onCollateralDeposited,
  onCollateralWithdrawn,
  onCollectFees,
  onLiquidate,
  onLiquidityChanged,
  onRepay,
} from "../src/handlers/farmentaMarket.ts";
import { onModifyLiquidity } from "../src/handlers/poolManager.ts";
import { onTransfer } from "../src/handlers/positionManager.ts";
import { blockOf, chain, logIndexOf, nextLog, timeOf, txOf } from "./support/events.ts";
import { fakeDb } from "./support/fakeDb.ts";

const BLUE_CHIP: Address = "0x00000000000000000000000000000000000b10e0";
const MEME: Address = "0x000000000000000000000000000000000000e3e0";
const ALICE: Address = "0x00000000000000000000000000000000000a11ce";
const BOB: Address = "0x0000000000000000000000000000000000000b0b";
const POOL: Hex = "0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982";
const OTHER_POOL: Hex = "0x54f7883914619af9105355bf83ed678bcf9f63560218ac61c9963b9503d0ba32";

const modify = (tokenId: bigint, liquidityDelta: bigint) => ({
  id: POOL,
  sender: UNISWAP.positionManager.address,
  tickLower: -198_020,
  tickUpper: -197_970,
  liquidityDelta,
  salt: numberToHex(tokenId, { size: 32 }),
});

/** Events 1 and 2: position 7, minted to `to` with liquidity 1000. */
async function minted(to: Address = ALICE) {
  const store = fakeDb();
  const at = chain();
  await onTransfer(store.db, at({ from: zeroAddress, to, tokenId: 7n }));
  await onModifyLiquidity(store.db, at(modify(7n, 1_000n)));
  return { ...store, at };
}

/** Events 3 and 4 on top of `minted`: Alice's position 7 is in custody of the blue-chip market. */
async function deposited() {
  const store = await minted();
  await onTransfer(store.db, store.at({ from: ALICE, to: BLUE_CHIP, tokenId: 7n }));
  await onCollateralDeposited(store.db, store.at({ tokenId: 7n, owner: ALICE, poolId: POOL }, BLUE_CHIP));
  return store;
}

const IN_CUSTODY = {
  market: BLUE_CHIP,
  tokenId: 7n,
  owner: ALICE,
  poolId: POOL,
  status: "in_custody",
  everBorrowed: false,
  borrowedUsdg: 0n,
  repaidUsdg: 0n,
  liquidatedUsdg: 0n,
  depositedBlock: blockOf(4),
  depositedAt: timeOf(4),
  lastActivityAt: timeOf(4),
  closedAt: null,
};

const NO_FIGURES = { amountUsdg: null, liquidityDelta: null, amount0: null, amount1: null };

const activityRow = (n: number, kind: string, figures: Partial<Record<keyof typeof NO_FIGURES, bigint>> = {}) => ({
  market: BLUE_CHIP,
  blockNumber: blockOf(n),
  logIndex: logIndexOf(n),
  timestamp: timeOf(n),
  transactionHash: txOf(n),
  tokenId: 7n,
  owner: ALICE,
  kind,
  ...NO_FIGURES,
  ...figures,
});

describe("loan handlers", () => {
  describe("positive", () => {
    // `depositCollateralWithPermit` emits the same two events: `Transfer` is from the owner who
    // signed, and `CollateralDeposited` credits that owner, not the `msg.sender` who relayed it.
    it("`depositCollateral`: a loan in custody, with the depositor and the position's pool", async () => {
      const { rows } = await deposited();

      assert.deepEqual(rows(schema.loan), [IN_CUSTODY]);
      assert.deepEqual(rows(schema.loanActivity), [activityRow(4, "deposit")]);
      // The NFT is the market's now; the depositor is on the loan.
      assert.equal(rows(schema.position)[0]?.owner, BLUE_CHIP);
    });

    it("`mintAndDeposit`: the NFT is minted to the market, the loan is the depositor's", async () => {
      const { db, rows, at } = await minted(MEME);
      await onCollateralDeposited(db, at({ tokenId: 7n, owner: ALICE, poolId: POOL }, MEME));

      assert.deepEqual(rows(schema.loan), [
        { ...IN_CUSTODY, market: MEME, depositedBlock: blockOf(3), depositedAt: timeOf(3), lastActivityAt: timeOf(3) },
      ]);
      assert.equal(rows(schema.position)[0]?.owner, MEME);
    });

    it("`withdrawCollateral`: the loan leaves custody, and the NFT goes where the depositor sent it", async () => {
      const { db, rows, at } = await deposited();
      await onCollateralWithdrawn(db, at({ tokenId: 7n, owner: ALICE, poolId: POOL }, BLUE_CHIP));
      await onTransfer(db, at({ from: BLUE_CHIP, to: BOB, tokenId: 7n }));

      assert.deepEqual(rows(schema.loan), [
        { ...IN_CUSTODY, status: "withdrawn", lastActivityAt: timeOf(5), closedAt: timeOf(5) },
      ]);
      assert.deepEqual(rows(schema.loanActivity), [activityRow(4, "deposit"), activityRow(5, "withdraw")]);
      assert.equal(rows(schema.position)[0]?.owner, BOB);
    });

    it("borrow then repay in full: totals add up, and the loan stays a candidate for debt", async () => {
      const { db, rows, at } = await deposited();
      await onBorrow(db, at({ tokenId: 7n, poolId: POOL, amount: 300_000_000n }, BLUE_CHIP));
      await onBorrow(db, at({ tokenId: 7n, poolId: POOL, amount: 200_000_000n }, BLUE_CHIP));
      await onRepay(db, at({ tokenId: 7n, poolId: POOL, amount: 100_000_000n }, BLUE_CHIP));
      await onRepay(db, at({ tokenId: 7n, poolId: POOL, amount: 400_000_123n }, BLUE_CHIP)); // the rest, with interest

      assert.deepEqual(rows(schema.loan), [
        {
          ...IN_CUSTODY,
          everBorrowed: true,
          borrowedUsdg: 500_000_000n,
          repaidUsdg: 500_000_123n,
          lastActivityAt: timeOf(8),
        },
      ]);
      assert.deepEqual(rows(schema.loanActivity), [
        activityRow(4, "deposit"),
        activityRow(5, "borrow", { amountUsdg: 300_000_000n }),
        activityRow(6, "borrow", { amountUsdg: 200_000_000n }),
        activityRow(7, "repay", { amountUsdg: 100_000_000n }),
        activityRow(8, "repay", { amountUsdg: 400_000_123n }),
      ]);
    });

    it("adding, removing and claiming fees on collateral: history rows, liquidity from `ModifyLiquidity`", async () => {
      const { db, rows, at } = await deposited();
      // Each market call is the PoolManager's `ModifyLiquidity`, then the market's own event.
      await onModifyLiquidity(db, at(modify(7n, 250n))); // 5
      await onLiquidityChanged(db, at({ tokenId: 7n, poolId: POOL, liqDelta: 250n }, BLUE_CHIP)); // 6
      await onModifyLiquidity(db, at(modify(7n, -400n))); // 7
      await onLiquidityChanged(db, at({ tokenId: 7n, poolId: POOL, liqDelta: -400n }, BLUE_CHIP)); // 8
      await onModifyLiquidity(db, at(modify(7n, 0n))); // 9
      await onCollectFees(db, at({ tokenId: 7n, poolId: POOL, amount0: 11n, amount1: 22_000n }, BLUE_CHIP)); // 10

      assert.deepEqual(rows(schema.loanActivity), [
        activityRow(4, "deposit"),
        activityRow(6, "increase_liquidity", { liquidityDelta: 250n }),
        activityRow(8, "decrease_liquidity", { liquidityDelta: -400n }),
        activityRow(10, "collect_fees", { amount0: 11n, amount1: 22_000n }),
      ]);
      assert.deepEqual(rows(schema.loan), [{ ...IN_CUSTODY, lastActivityAt: timeOf(10) }]);
      // Counted once, from the PoolManager's event.
      assert.equal(rows(schema.position)[0]?.liquidity, 850n);
    });

    it("fees paid out by an addition or a removal are `collect_fees` rows too (FAR-52)", async () => {
      const { db, rows, at } = await deposited();
      // `increaseLiquidity`: `CollectFees` first, then the claim and the addition, then `LiquidityChanged`.
      await onCollectFees(db, at({ tokenId: 7n, poolId: POOL, amount0: 3n, amount1: 4_000n }, BLUE_CHIP)); // 5
      await onModifyLiquidity(db, at(modify(7n, 0n))); // 6
      await onModifyLiquidity(db, at(modify(7n, 250n))); // 7
      await onLiquidityChanged(db, at({ tokenId: 7n, poolId: POOL, liqDelta: 250n }, BLUE_CHIP)); // 8
      // `decreaseLiquidity`: the removal pays principal and fees together, then `CollectFees` and
      // `LiquidityChanged`.
      await onModifyLiquidity(db, at(modify(7n, -400n))); // 9
      await onCollectFees(db, at({ tokenId: 7n, poolId: POOL, amount0: 5n, amount1: 6_000n }, BLUE_CHIP)); // 10
      await onLiquidityChanged(db, at({ tokenId: 7n, poolId: POOL, liqDelta: -400n }, BLUE_CHIP)); // 11

      assert.deepEqual(rows(schema.loanActivity), [
        activityRow(4, "deposit"),
        activityRow(5, "collect_fees", { amount0: 3n, amount1: 4_000n }),
        activityRow(8, "increase_liquidity", { liquidityDelta: 250n }),
        activityRow(10, "collect_fees", { amount0: 5n, amount1: 6_000n }),
        activityRow(11, "decrease_liquidity", { liquidityDelta: -400n }),
      ]);
      assert.deepEqual(rows(schema.loan), [{ ...IN_CUSTODY, lastActivityAt: timeOf(11) }]);
      assert.equal(rows(schema.position)[0]?.liquidity, 850n);
    });

    it("a full liquidation burns the position, and its `Liquidate` closes the loan", async () => {
      const { db, rows, at } = await deposited();
      await onBorrow(db, at({ tokenId: 7n, poolId: POOL, amount: 300_000_000n }, BLUE_CHIP));
      // One transaction: the burn, its removal, then `Liquidate` with the flag set.
      const burn = at({ from: BLUE_CHIP, to: zeroAddress, tokenId: 7n });
      await onTransfer(db, burn);
      const removal = nextLog(burn, modify(7n, -1_000n));
      await onModifyLiquidity(db, removal);
      // The burn alone does not close it (FAR-51): only `Liquidate` says it was a seizure.
      assert.equal(rows(schema.loan)[0]?.status, "in_custody");
      const seized = { tokenId: 7n, liquidator: BOB, poolId: POOL, repaid: 300_000_000n, out0: 0n, out1: 0n, badDebt: 0n, fullSeizure: true };
      await onLiquidate(db, nextLog(removal, seized, BLUE_CHIP));

      assert.deepEqual(rows(schema.loan), [
        {
          ...IN_CUSTODY,
          status: "liquidated",
          everBorrowed: true,
          borrowedUsdg: 300_000_000n,
          liquidatedUsdg: 300_000_000n,
          lastActivityAt: timeOf(6),
          closedAt: timeOf(6),
        },
      ]);
    });

    it("the two markets are told apart by the emitting address, however it is spelled", async () => {
      const { db, rows, at } = await deposited();
      await onTransfer(db, at({ from: zeroAddress, to: MEME, tokenId: 8n }));
      await onModifyLiquidity(db, at(modify(8n, 500n)));
      await onCollateralDeposited(db, at({ tokenId: 8n, owner: getAddress(BOB), poolId: POOL }, getAddress(MEME)));
      await onBorrow(db, at({ tokenId: 8n, poolId: POOL, amount: 1_000_000n }, getAddress(MEME)));

      assert.deepEqual(
        rows(schema.loan).map(({ market, tokenId, owner, borrowedUsdg }) => ({ market, tokenId, owner, borrowedUsdg })),
        [
          { market: MEME, tokenId: 8n, owner: BOB, borrowedUsdg: 1_000_000n },
          { market: BLUE_CHIP, tokenId: 7n, owner: ALICE, borrowedUsdg: 0n },
        ],
      );
    });
  });

  describe("negative", () => {
    it("refuses borrow, repay and withdraw for a position the market never took into custody", async () => {
      const { db, at } = await minted();
      await assert.rejects(onBorrow(db, at({ tokenId: 7n, poolId: POOL, amount: 1n }, BLUE_CHIP)), /never took into custody/);
      await assert.rejects(onRepay(db, at({ tokenId: 7n, poolId: POOL, amount: 1n }, BLUE_CHIP)), /never took into custody/);
      await assert.rejects(onCollateralWithdrawn(db, at({ tokenId: 7n, owner: ALICE, poolId: POOL }, BLUE_CHIP)), /never took into custody/);
      await assert.rejects(
        onLiquidityChanged(db, at({ tokenId: 7n, poolId: POOL, liqDelta: 1n }, BLUE_CHIP)),
        /never took into custody/,
      );
      await assert.rejects(
        onCollectFees(db, at({ tokenId: 7n, poolId: POOL, amount0: 0n, amount1: 0n }, BLUE_CHIP)),
        /never took into custody/,
      );
    });

    it("refuses a `CollateralDeposited` that names another pool than the position's", async () => {
      const { db, rows, at } = await minted();
      await onTransfer(db, at({ from: ALICE, to: BLUE_CHIP, tokenId: 7n }));
      const event = at({ tokenId: 7n, owner: ALICE, poolId: OTHER_POOL }, BLUE_CHIP);
      await assert.rejects(onCollateralDeposited(db, event), /event names pool 0x54f7\w+, the position row 0x387b/);
      assert.deepEqual(rows(schema.loan), []);
    });

    it("refuses a market event that names another pool than the position's", async () => {
      const { db, at } = await deposited();
      const event = at({ tokenId: 7n, poolId: OTHER_POOL, liqDelta: 1n }, BLUE_CHIP);
      await assert.rejects(onLiquidityChanged(db, event), /event names pool/);
      // `CollectFees` too, now that three paths emit it (FAR-52).
      const fees = at({ tokenId: 7n, poolId: OTHER_POOL, amount0: 1n, amount1: 1n }, BLUE_CHIP);
      await assert.rejects(onCollectFees(db, fees), /event names pool/);
    });

    it("an event from the other market does not reach this market's loan", async () => {
      const { db, rows, at } = await deposited();
      await assert.rejects(onBorrow(db, at({ tokenId: 7n, poolId: POOL, amount: 1n }, MEME)), /never took into custody/);
      assert.deepEqual(rows(schema.loan), [IN_CUSTODY]);
    });

    it("a burn by its holder after a withdrawal leaves the closed loan as it was", async () => {
      const { db, rows, at } = await deposited();
      await onCollateralWithdrawn(db, at({ tokenId: 7n, owner: ALICE, poolId: POOL }, BLUE_CHIP));
      await onTransfer(db, at({ from: BLUE_CHIP, to: ALICE, tokenId: 7n }));
      await onTransfer(db, at({ from: ALICE, to: zeroAddress, tokenId: 7n }));

      assert.deepEqual(rows(schema.loan), [
        { ...IN_CUSTODY, status: "withdrawn", lastActivityAt: timeOf(5), closedAt: timeOf(5) },
      ]);
    });
  });

  describe("edge case", () => {
    it("only a loan in custody is closed by a burn: a withdrawn one keeps its own closing time", async () => {
      const { db, rows, at } = await deposited();
      await onCollateralWithdrawn(db, at({ tokenId: 7n, owner: ALICE, poolId: POOL }, BLUE_CHIP)); // 5
      // The market never burns a position it has released; the guard is what says so.
      await onTransfer(db, at({ from: BLUE_CHIP, to: zeroAddress, tokenId: 7n })); // 6

      assert.deepEqual(rows(schema.loan), [
        { ...IN_CUSTODY, status: "withdrawn", lastActivityAt: timeOf(5), closedAt: timeOf(5) },
      ]);
    });

    it("a redeposit by another owner starts the loan over; the earlier custody stays in `loan_activity`", async () => {
      const { db, rows, at } = await deposited();
      await onBorrow(db, at({ tokenId: 7n, poolId: POOL, amount: 300_000_000n }, BLUE_CHIP)); // 5
      await onRepay(db, at({ tokenId: 7n, poolId: POOL, amount: 300_000_001n }, BLUE_CHIP)); // 6
      await onCollateralWithdrawn(db, at({ tokenId: 7n, owner: getAddress(ALICE), poolId: POOL }, BLUE_CHIP)); // 7
      await onTransfer(db, at({ from: BLUE_CHIP, to: BOB, tokenId: 7n })); // 8
      await onTransfer(db, at({ from: BOB, to: BLUE_CHIP, tokenId: 7n })); // 9
      await onCollateralDeposited(db, at({ tokenId: 7n, owner: BOB, poolId: POOL }, BLUE_CHIP)); // 10

      assert.deepEqual(rows(schema.loan), [
        { ...IN_CUSTODY, owner: BOB, depositedBlock: blockOf(10), depositedAt: timeOf(10), lastActivityAt: timeOf(10) },
      ]);
      assert.deepEqual(
        rows(schema.loanActivity).map(({ kind, owner }) => ({ kind, owner })),
        [
          { kind: "deposit", owner: ALICE },
          { kind: "borrow", owner: ALICE },
          { kind: "repay", owner: ALICE },
          { kind: "withdraw", owner: ALICE },
          { kind: "deposit", owner: BOB },
        ],
      );
      // `depositedBlock` cuts the history per custody: Alice's rows are all before it.
      const { depositedBlock } = rows(schema.loan)[0] as { depositedBlock: bigint };
      assert.deepEqual(
        rows(schema.loanActivity)
          .filter((row) => (row.blockNumber as bigint) >= depositedBlock)
          .map(({ kind, owner }) => ({ kind, owner })),
        [{ kind: "deposit", owner: BOB }],
      );
    });

    it("a loan on a position whose mint was never seen (START_BLOCK_FLOOR) takes its pool from the event", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onTransfer(db, at({ from: ALICE, to: BLUE_CHIP, tokenId: 7n }));
      await onCollateralDeposited(db, at({ tokenId: 7n, owner: ALICE, poolId: POOL }, BLUE_CHIP));

      // There is no position row to take a pool from, or to confirm one.
      assert.deepEqual(rows(schema.position), []);
      assert.deepEqual(rows(schema.loan), [
        { ...IN_CUSTODY, depositedBlock: blockOf(2), depositedAt: timeOf(2), lastActivityAt: timeOf(2) },
      ]);
    });
  });
});
