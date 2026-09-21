import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, numberToHex, zeroAddress, type Address, type Hex } from "viem";

import { UNISWAP } from "../config/uniswap.ts";
import * as schema from "../ponder.schema.ts";
import { onBadDebtSocialized, onBorrow, onCollateralDeposited, onLiquidate } from "../src/handlers/farmentaMarket.ts";
import { onModifyLiquidity } from "../src/handlers/poolManager.ts";
import { onTransfer } from "../src/handlers/positionManager.ts";
import type { Log } from "../src/handlers/event.ts";
import { blockOf, chain, logIndexOf, nextLog, timeOf, txOf } from "./support/events.ts";
import { fakeDb } from "./support/fakeDb.ts";

const MARKET: Address = "0x000000000000000000000000000000000000e3e0";
const OTHER_MARKET: Address = "0x00000000000000000000000000000000000b10e0";
const ALICE: Address = "0x00000000000000000000000000000000000a11ce";
const KEEPER: Address = "0x00000000000000000000000000000000000cee9e";
const POOL: Hex = "0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982";

const modify = (liquidityDelta: bigint) => ({
  id: POOL,
  sender: UNISWAP.positionManager.address,
  tickLower: -198_020,
  tickUpper: -197_970,
  liquidityDelta,
  salt: numberToHex(7n, { size: 32 }),
});

/** Events 1 to 4: position 7, liquidity 1000, in custody of MARKET for Alice, 300 USDG borrowed. */
async function borrowed() {
  const store = fakeDb();
  const at = chain();
  await onTransfer(store.db, at({ from: zeroAddress, to: MARKET, tokenId: 7n }));
  await onModifyLiquidity(store.db, at(modify(1_000n)));
  await onCollateralDeposited(store.db, at({ tokenId: 7n, owner: ALICE }, MARKET));
  await onBorrow(store.db, at({ tokenId: 7n, amount: 300_000_000n }, MARKET));
  return { ...store, at };
}

const LOAN = {
  market: MARKET,
  tokenId: 7n,
  owner: ALICE,
  poolId: POOL,
  status: "in_custody",
  everBorrowed: true,
  borrowedUsdg: 300_000_000n,
  repaidUsdg: 0n,
  liquidatedUsdg: 0n,
  depositedBlock: blockOf(3),
  depositedAt: timeOf(3),
  lastActivityAt: timeOf(4),
  closedAt: null,
};

/** The row of a `Liquidate` that is log `offset` of the transaction opened by event `n`. */
const liquidationRow = (n: number, offset: number) => ({
  market: MARKET,
  blockNumber: blockOf(n),
  logIndex: logIndexOf(n) + offset,
  timestamp: timeOf(n),
  transactionHash: txOf(n),
  tokenId: 7n,
  owner: ALICE,
  poolId: POOL,
  liquidator: KEEPER,
});

describe("liquidation handlers", () => {
  describe("positive", () => {
    it("a partial liquidation: one row, and the loan stays in custody", async () => {
      const { db, rows, at } = await borrowed();
      // One transaction: the market pulls part of the liquidity, then emits `Liquidate`.
      const pull = at(modify(-400n));
      await onModifyLiquidity(db, pull);
      await onLiquidate(
        db,
        nextLog(pull, { tokenId: 7n, liquidator: KEEPER, repaid: 120_000_000n, out0: 5n, out1: 126_000_000n, badDebt: 0n, fullSeizure: false }, MARKET),
      );

      assert.deepEqual(rows(schema.liquidation), [
        {
          ...liquidationRow(5, 1),
          full: false,
          repaidUsdg: 120_000_000n,
          badDebtUsdg: 0n,
          socializedUsdg: 0n,
          out0: 5n,
          out1: 126_000_000n,
        },
      ]);
      assert.deepEqual(rows(schema.loan), [{ ...LOAN, liquidatedUsdg: 120_000_000n, lastActivityAt: timeOf(5) }]);
      assert.equal(rows(schema.position)[0]?.liquidity, 600n);
    });

    it("a full liquidation: `Liquidate` closes the loan and records the socialized loss", async () => {
      const { db, rows, at } = await borrowed();
      // One transaction: burn (`Transfer`, then the removal), `BadDebtSocialized`, `Liquidate`.
      const burn = at({ from: MARKET, to: zeroAddress, tokenId: 7n });
      await onTransfer(db, burn);
      const removal = nextLog(burn, modify(-1_000n));
      await onModifyLiquidity(db, removal);
      // The payout's ERC-20 transfer and `ReservesUpdated` sit in between; neither is indexed.
      const reservesUpdated = nextLog(nextLog(removal, null), null, MARKET);
      const loss = nextLog(reservesUpdated, { amount: 40_000_000n });
      await onBadDebtSocialized(db, loss);
      await onLiquidate(
        db,
        nextLog(loss, { tokenId: 7n, liquidator: getAddress(KEEPER), repaid: 250_000_000n, out0: 9n, out1: 262_500_000n, badDebt: 50_000_000n, fullSeizure: true }),
      );

      assert.deepEqual(rows(schema.liquidation), [
        {
          ...liquidationRow(5, 5),
          full: true,
          repaidUsdg: 250_000_000n,
          badDebtUsdg: 50_000_000n,
          socializedUsdg: 40_000_000n,
          out0: 9n,
          out1: 262_500_000n,
        },
      ]);
      assert.deepEqual(rows(schema.badDebtSocialized), [
        {
          market: MARKET,
          blockNumber: blockOf(5),
          logIndex: logIndexOf(5) + 4,
          timestamp: timeOf(5),
          transactionHash: txOf(5),
          amountUsdg: 40_000_000n,
        },
      ]);
      assert.deepEqual(rows(schema.loan), [
        { ...LOAN, status: "liquidated", liquidatedUsdg: 250_000_000n, lastActivityAt: timeOf(5), closedAt: timeOf(5) },
      ]);
      assert.deepEqual(
        (({ owner, liquidity, burned }) => ({ owner, liquidity, burned }))(rows(schema.position)[0] as Record<string, unknown>),
        { owner: zeroAddress, liquidity: 0n, burned: true },
      );
    });

    it("two partial liquidations add up on the loan, one row each", async () => {
      const { db, rows, at } = await borrowed();
      const liquidate = (repaid: bigint) => ({ tokenId: 7n, liquidator: KEEPER, repaid, out0: 0n, out1: 0n, badDebt: 0n, fullSeizure: false });
      await onLiquidate(db, at(liquidate(100_000_000n), MARKET));
      await onLiquidate(db, at(liquidate(50_000_000n), MARKET));

      assert.deepEqual(
        rows(schema.liquidation).map(({ repaidUsdg, full }) => ({ repaidUsdg, full })),
        [
          { repaidUsdg: 100_000_000n, full: false },
          { repaidUsdg: 50_000_000n, full: false },
        ],
      );
      assert.deepEqual(rows(schema.loan), [{ ...LOAN, liquidatedUsdg: 150_000_000n, lastActivityAt: timeOf(6) }]);
    });
  });

  describe("negative", () => {
    const liquidate = { tokenId: 7n, liquidator: KEEPER, repaid: 1n, out0: 0n, out1: 0n, badDebt: 50n, fullSeizure: false };

    it("refuses a `Liquidate` for a position the market never took into custody", async () => {
      const { db, at } = await borrowed();
      await assert.rejects(onLiquidate(db, at(liquidate, OTHER_MARKET)), /never took into custody/);
    });

    it("a `BadDebtSocialized` that is not the log right before, in the same transaction, is not this liquidation's", async () => {
      const { db, rows, at } = await borrowed();
      const loss: Log<{ amount: bigint }> = at({ amount: 40n }, MARKET);
      await onBadDebtSocialized(db, loss);
      // Same block and the next log index, but another transaction.
      await onLiquidate(db, { ...nextLog(loss, liquidate), transaction: { hash: txOf(99) } });
      // Same transaction, but with a log in between.
      const gap = nextLog(nextLog(loss, null), null);
      await onLiquidate(db, nextLog(gap, liquidate));
      // The other market's loss.
      const theirs = at({ amount: 40n }, OTHER_MARKET);
      await onBadDebtSocialized(db, theirs);
      await onLiquidate(db, nextLog(theirs, liquidate, MARKET));

      assert.deepEqual(rows(schema.liquidation).map((row) => row.socializedUsdg), [0n, 0n, 0n]);
    });

    it("refuses a socialized loss larger than the bad debt", async () => {
      const { db, at } = await borrowed();
      const loss = at({ amount: 51n }, MARKET);
      await onBadDebtSocialized(db, loss);
      await assert.rejects(onLiquidate(db, nextLog(loss, liquidate)), /socialized 51 of 50/);
    });
  });

  describe("edge case", () => {
    it("a full liquidation that covers the debt: `full` and the closed loan come from the flag, not from bad debt", async () => {
      const { db, rows, at } = await borrowed();
      const burn = at({ from: MARKET, to: zeroAddress, tokenId: 7n });
      await onTransfer(db, burn);
      await onLiquidate(
        db,
        nextLog(burn, { tokenId: 7n, liquidator: KEEPER, repaid: 300_000_010n, out0: 0n, out1: 0n, badDebt: 0n, fullSeizure: true }, MARKET),
      );

      const { full, badDebtUsdg } = rows(schema.liquidation)[0] as Record<string, unknown>;
      assert.deepEqual({ full, badDebtUsdg }, { full: true, badDebtUsdg: 0n });
      assert.equal(rows(schema.loan)[0]?.status, "liquidated");
    });

    it("bad debt the reserve covered in full: `badDebt` is set, nothing is socialized", async () => {
      const { db, rows, at } = await borrowed();
      const burn = at({ from: MARKET, to: zeroAddress, tokenId: 7n });
      await onTransfer(db, burn);
      await onLiquidate(
        db,
        nextLog(burn, { tokenId: 7n, liquidator: KEEPER, repaid: 250_000_000n, out0: 0n, out1: 0n, badDebt: 50_000_000n, fullSeizure: true }, MARKET),
      );

      const { full, badDebtUsdg, socializedUsdg } = rows(schema.liquidation)[0] as Record<string, unknown>;
      assert.deepEqual({ full, badDebtUsdg, socializedUsdg }, { full: true, badDebtUsdg: 50_000_000n, socializedUsdg: 0n });
      assert.deepEqual(rows(schema.badDebtSocialized), []);
    });
  });
});
