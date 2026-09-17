import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zeroAddress } from "viem";

import * as schema from "../ponder.schema.ts";
import {
  onHookAllowlisted,
  onLtRampScheduled,
  onPoolFrozen,
  onPoolListed,
  onPoolTermsUpdated,
  onTokenConfigured,
} from "../src/handlers/collateralPolicy.ts";
import { onInitialize } from "../src/handlers/poolManager.ts";
import { onRecorded } from "../src/handlers/twapRecorder.ts";
import { poolIdOf, type PoolKey } from "../src/lib/poolKey.ts";
import { observationAgeAt, rampStatusAt } from "../src/lib/poolView.ts";
import { blockOf, chain, logIndexOf, timeOf, txOf } from "./support/events.ts";
import { fakeDb } from "./support/fakeDb.ts";

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const FEED_A = "0x61b7e5650328764b076a108eff5fa7282a1b9ad2";
const FEED_B = "0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9";
const LISTED: PoolKey = { currency0: zeroAddress, currency1: USDG, fee: 500, tickSpacing: 10, hooks: zeroAddress };
const UNLISTED: PoolKey = { ...LISTED, fee: 3000, tickSpacing: 60 };
const LISTED_ID = poolIdOf(LISTED);
const UNLISTED_ID = poolIdOf(UNLISTED);

const TERMS = {
  maxLtvBps: 6500,
  ltBps: 7500,
  liquidatorBonusBps: 500,
  removeHaircutBps: 0,
  debtCapUsdg: 500_000_000_000n,
  minPositionUsd: 50n * 10n ** 18n,
};
const TIGHTER = {
  maxLtvBps: 6000,
  ltBps: 7400,
  liquidatorBonusBps: 600,
  removeHaircutBps: 100,
  debtCapUsdg: 400_000_000_000n,
  minPositionUsd: 60n * 10n ** 18n,
};
const NO_RAMP = { rampLtFromBps: null, rampLtTargetBps: null, rampStart: null, rampDuration: null };

const logRow = (n: number) => ({
  poolId: LISTED_ID,
  blockNumber: blockOf(n),
  logIndex: logIndexOf(n),
  timestamp: timeOf(n),
  transactionHash: txOf(n),
});

const initialize = (key: PoolKey) => ({ id: poolIdOf(key), ...key });

describe("pool and listing handlers", () => {
  describe("positive", () => {
    it("a listed pool has its full key, and the key hashes to its poolId", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onInitialize(db, at(initialize(LISTED)));
      await onPoolListed(db, at({ poolId: LISTED_ID, tier: 1, params: TERMS }));

      assert.deepEqual(rows(schema.uniswapPool), [
        { id: LISTED_ID, ...LISTED, initializedBlock: blockOf(1), initializedAt: timeOf(1) },
      ]);
      assert.deepEqual(rows(schema.pool), [
        {
          id: LISTED_ID,
          ...LISTED,
          tier: 1,
          ...TERMS,
          frozen: false,
          listedBlock: blockOf(2),
          listedAt: timeOf(2),
          updatedAt: timeOf(2),
        },
      ]);
      assert.equal(poolIdOf(rows(schema.pool)[0] as PoolKey), LISTED_ID);
    });

    it("`updateTerms` makes the new terms current and keeps the earlier ones", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onInitialize(db, at(initialize(LISTED)));
      await onPoolListed(db, at({ poolId: LISTED_ID, tier: 1, params: TERMS }));
      await onPoolTermsUpdated(db, at({ poolId: LISTED_ID, params: TIGHTER }));

      assert.deepEqual(rows(schema.pool), [
        {
          id: LISTED_ID,
          ...LISTED,
          tier: 1,
          ...TIGHTER,
          frozen: false,
          ...NO_RAMP,
          listedBlock: blockOf(2),
          listedAt: timeOf(2),
          updatedAt: timeOf(3),
        },
      ]);
      assert.deepEqual(rows(schema.poolTermsChange), [
        { ...logRow(2), source: "listed", ...TERMS },
        { ...logRow(3), source: "updated", ...TIGHTER },
      ]);
    });

    it("`setFrozen(true)` then `setFrozen(false)`: the status follows the order of events", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onPoolListed(db, at({ poolId: LISTED_ID, tier: 1, params: TERMS }));
      const status = () => {
        const { frozen, updatedAt } = rows(schema.pool)[0] as { frozen: boolean; updatedAt: bigint };
        return { frozen, updatedAt };
      };

      await onPoolFrozen(db, at({ poolId: LISTED_ID, frozen: true }));
      assert.deepEqual(status(), { frozen: true, updatedAt: timeOf(2) });
      await onPoolFrozen(db, at({ poolId: LISTED_ID, frozen: false }));
      assert.deepEqual(status(), { frozen: false, updatedAt: timeOf(3) });
    });

    it("a scheduled ramp answers before `start`, in the middle and after `start + duration`", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onPoolListed(db, at({ poolId: LISTED_ID, tier: 1, params: TERMS }));
      await onLtRampScheduled(
        db,
        at({ poolId: LISTED_ID, ltFromBps: 7500, ltTargetBps: 7000, start: 2_000_000, duration: 1_000 }),
      );

      assert.deepEqual(rows(schema.ltRamp), [
        { ...logRow(2), ltFromBps: 7500, ltTargetBps: 7000, start: 2_000_000n, duration: 1_000n },
      ]);
      const row = rows(schema.pool)[0] as Parameters<typeof rampStatusAt>[0] & { updatedAt: bigint };
      assert.deepEqual(
        {
          rampLtFromBps: row.rampLtFromBps,
          rampLtTargetBps: row.rampLtTargetBps,
          rampStart: row.rampStart,
          rampDuration: row.rampDuration,
          updatedAt: row.updatedAt,
        },
        { rampLtFromBps: 7500, rampLtTargetBps: 7000, rampStart: 2_000_000n, rampDuration: 1_000n, updatedAt: timeOf(2) },
      );

      const statusAt = (t: bigint) => {
        const { rampRunning, effectiveLtBps } = rampStatusAt(row, t);
        return { rampRunning, effectiveLtBps };
      };
      assert.deepEqual(statusAt(1_999_000n), { rampRunning: true, effectiveLtBps: 7500 });
      assert.deepEqual(statusAt(2_000_500n), { rampRunning: true, effectiveLtBps: 7250 });
      assert.deepEqual(statusAt(2_001_000n), { rampRunning: false, effectiveLtBps: 7000 });
    });

    it("TWAP observations are kept per pool, and the age of the newest one can be computed", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onRecorded(db, at({ poolId: LISTED_ID, index: 0, timestamp: 5_000n, tickCumulative: 0n }));
      await onRecorded(db, at({ poolId: UNLISTED_ID, index: 0, timestamp: 5_100n, tickCumulative: 0n }));
      await onRecorded(db, at({ poolId: LISTED_ID, index: 1, timestamp: 5_300n, tickCumulative: -59_455_200n }));

      const byPoolThenTime = (a: { poolId: string; timestamp?: bigint }, b: { poolId: string; timestamp?: bigint }) =>
        a.poolId.localeCompare(b.poolId) || Number((a.timestamp ?? 0n) - (b.timestamp ?? 0n));
      assert.deepEqual(
        (rows(schema.twapObservation) as { poolId: string; timestamp: bigint }[]).sort(byPoolThenTime),
        [
          { poolId: LISTED_ID, timestamp: 5_000n, index: 0, tickCumulative: 0n, blockNumber: blockOf(1) },
          { poolId: LISTED_ID, timestamp: 5_300n, index: 1, tickCumulative: -59_455_200n, blockNumber: blockOf(3) },
          { poolId: UNLISTED_ID, timestamp: 5_100n, index: 0, tickCumulative: 0n, blockNumber: blockOf(2) },
        ].sort(byPoolThenTime),
      );
      assert.deepEqual(
        (rows(schema.twapPool) as { poolId: string }[]).sort(byPoolThenTime),
        [
          { poolId: LISTED_ID, lastObservationAt: 5_300n, lastIndex: 1, lastTickCumulative: -59_455_200n, recordedCount: 2 },
          { poolId: UNLISTED_ID, lastObservationAt: 5_100n, lastIndex: 0, lastTickCumulative: 0n, recordedCount: 1 },
        ].sort(byPoolThenTime),
      );
      // The 600-second alert: 601 seconds after the newest observation it fires.
      assert.equal(observationAgeAt(5_300n, 5_901n), 601n);
    });

    it("tokens and hooks hold the latest configuration, every column of it", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onTokenConfigured(db, at({ currency: USDG, enabled: true, tier: 1, decimals: 6, priceFeed: FEED_A }));
      await onTokenConfigured(db, at({ currency: USDG, enabled: false, tier: 2, decimals: 8, priceFeed: FEED_B }));
      await onHookAllowlisted(db, at({ hooks: FEED_A, allowed: true }));
      await onHookAllowlisted(db, at({ hooks: FEED_A, allowed: false }));

      assert.deepEqual(rows(schema.token), [
        { currency: USDG, enabled: false, tier: 2, decimals: 8, priceFeed: FEED_B, updatedAt: timeOf(2) },
      ]);
      assert.deepEqual(rows(schema.hook), [{ address: FEED_A, allowed: false, updatedAt: timeOf(4) }]);
    });
  });

  describe("negative", () => {
    it("a pool in `uniswap_pool` that is not listed does not appear in `pool`", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onInitialize(db, at(initialize(LISTED)));
      await onInitialize(db, at(initialize(UNLISTED)));
      await onPoolListed(db, at({ poolId: LISTED_ID, tier: 1, params: TERMS }));

      assert.deepEqual(rows(schema.uniswapPool).map((row) => row.id).sort(), [LISTED_ID, UNLISTED_ID].sort());
      assert.deepEqual(
        rows(schema.pool).map((row) => row.id),
        [LISTED_ID],
      );
    });

    it("refuses an `Initialize` whose key does not hash to its id", async () => {
      const { db, rows } = fakeDb();
      const event = chain()({ ...initialize(LISTED), fee: 501 });
      await assert.rejects(onInitialize(db, event), /PoolKey hashes to/);
      assert.equal(rows(schema.uniswapPool).length, 0);
    });

    it("refuses terms, freeze and ramp events for a pool that was never listed", async () => {
      const { db } = fakeDb();
      const at = chain();
      await assert.rejects(onPoolTermsUpdated(db, at({ poolId: LISTED_ID, params: TIGHTER })));
      await assert.rejects(onPoolFrozen(db, at({ poolId: LISTED_ID, frozen: true })));
      await assert.rejects(
        onLtRampScheduled(db, at({ poolId: LISTED_ID, ltFromBps: 7500, ltTargetBps: 7000, start: 1, duration: 1 })),
      );
    });
  });

  describe("edge case", () => {
    it("a pool listed before its `Initialize` has a null key until the event arrives", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onPoolListed(db, at({ poolId: LISTED_ID, tier: 1, params: TERMS }));
      const keyOf = () => {
        const { currency0, currency1, fee, tickSpacing, hooks } = rows(schema.pool)[0] as Record<string, unknown>;
        return { currency0, currency1, fee, tickSpacing, hooks };
      };
      assert.deepEqual(keyOf(), { currency0: null, currency1: null, fee: null, tickSpacing: null, hooks: null });

      await onInitialize(db, at(initialize(LISTED)));
      assert.deepEqual(keyOf(), LISTED);
      assert.equal(poolIdOf(keyOf() as PoolKey), LISTED_ID);
    });

    it("`updateTerms` clears the ramp in force; the schedule stays in `lt_ramp`", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onPoolListed(db, at({ poolId: LISTED_ID, tier: 1, params: TERMS }));
      await onLtRampScheduled(
        db,
        at({ poolId: LISTED_ID, ltFromBps: 7500, ltTargetBps: 7000, start: 2_000_000, duration: 1_000 }),
      );
      await onPoolTermsUpdated(db, at({ poolId: LISTED_ID, params: TIGHTER }));

      const { rampLtFromBps, rampLtTargetBps, rampStart, rampDuration } = rows(schema.pool)[0] as Record<string, unknown>;
      assert.deepEqual({ rampLtFromBps, rampLtTargetBps, rampStart, rampDuration }, NO_RAMP);

      const status = rampStatusAt(rows(schema.pool)[0] as Parameters<typeof rampStatusAt>[0], 2_000_500n);
      assert.deepEqual(status, { t: 2_000_500n, rampRunning: false, rampEndsAt: null, effectiveLtBps: 7400 });
      assert.deepEqual(rows(schema.ltRamp), [
        { ...logRow(2), ltFromBps: 7500, ltTargetBps: 7000, start: 2_000_000n, duration: 1_000n },
      ]);
    });

    it("a second ramp replaces the first in `pool`, and both stay in `lt_ramp`", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onPoolListed(db, at({ poolId: LISTED_ID, tier: 1, params: TERMS }));
      await onLtRampScheduled(db, at({ poolId: LISTED_ID, ltFromBps: 7500, ltTargetBps: 7200, start: 2_000_000, duration: 1_000 }));
      await onLtRampScheduled(db, at({ poolId: LISTED_ID, ltFromBps: 7350, ltTargetBps: 7000, start: 2_000_500, duration: 500 }));

      const { rampLtFromBps, rampLtTargetBps, rampStart, rampDuration } = rows(schema.pool)[0] as Record<string, unknown>;
      assert.deepEqual(
        { rampLtFromBps, rampLtTargetBps, rampStart, rampDuration },
        { rampLtFromBps: 7350, rampLtTargetBps: 7000, rampStart: 2_000_500n, rampDuration: 500n },
      );
      assert.deepEqual(rows(schema.ltRamp), [
        { ...logRow(2), ltFromBps: 7500, ltTargetBps: 7200, start: 2_000_000n, duration: 1_000n },
        { ...logRow(3), ltFromBps: 7350, ltTargetBps: 7000, start: 2_000_500n, duration: 500n },
      ]);
    });

    it("a pool's first observation, `index 0` and `tickCumulative 0`, is stored as data", async () => {
      const { db, rows } = fakeDb();
      await onRecorded(db, chain()({ poolId: LISTED_ID, index: 0, timestamp: 5_000n, tickCumulative: 0n }));

      assert.deepEqual(rows(schema.twapObservation), [
        { poolId: LISTED_ID, timestamp: 5_000n, index: 0, tickCumulative: 0n, blockNumber: blockOf(1) },
      ]);
      assert.deepEqual(rows(schema.twapPool), [
        { poolId: LISTED_ID, lastObservationAt: 5_000n, lastIndex: 0, lastTickCumulative: 0n, recordedCount: 1 },
      ]);
    });
  });
});
