import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zeroAddress, type Hex } from "viem";

import * as schema from "../ponder.schema.ts";
import {
  onHookAllowlisted,
  onLtRampScheduled,
  onPoolFrozen,
  onPoolListed,
  onPoolTermsUpdated,
  onTokenConfigured,
} from "../src/handlers/collateralPolicy.ts";
import type { Log } from "../src/handlers/event.ts";
import { onInitialize } from "../src/handlers/poolManager.ts";
import { onRecorded } from "../src/handlers/twapRecorder.ts";
import { poolIdOf, type PoolKey } from "../src/lib/poolKey.ts";
import { observationAgeAt, rampStatusAt } from "../src/lib/poolView.ts";
import { fakeDb } from "./support/fakeDb.ts";

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const LISTED: PoolKey = { currency0: zeroAddress, currency1: USDG, fee: 500, tickSpacing: 10, hooks: zeroAddress };
const UNLISTED: PoolKey = { ...LISTED, fee: 3000, tickSpacing: 60 };
const LISTED_ID = poolIdOf(LISTED);

const TERMS = {
  maxLtvBps: 6500,
  ltBps: 7500,
  liquidatorBonusBps: 500,
  removeHaircutBps: 0,
  debtCapUsdg: 500_000_000_000n,
  minPositionUsd: 50n * 10n ** 18n,
};
const TIGHTER = { ...TERMS, maxLtvBps: 6000, ltBps: 7400, debtCapUsdg: 400_000_000_000n };

// Events get increasing blocks and timestamps, like the chain gives them.
function chain() {
  let block = 100n;
  return <Args>(args: Args): Log<Args> => {
    block += 1n;
    return {
      args,
      block: { number: block, timestamp: 1_000_000n + block },
      log: { logIndex: 0 },
      transaction: { hash: `0x${block.toString(16).padStart(64, "0")}` as Hex },
    };
  };
}

const initialize = (key: PoolKey) => ({ id: poolIdOf(key), ...key });

describe("pool and listing handlers", () => {
  describe("positive", () => {
    it("a listed pool has its full key, and the key hashes to its poolId", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onInitialize(db, at(initialize(LISTED)));
      await onPoolListed(db, at({ poolId: LISTED_ID, tier: 1, params: TERMS }));

      const [row] = rows(schema.pool) as [PoolKey & { id: Hex; tier: number; frozen: boolean }];
      assert.deepEqual(
        { currency0: row.currency0, currency1: row.currency1, fee: row.fee, tickSpacing: row.tickSpacing, hooks: row.hooks },
        LISTED,
      );
      assert.equal(poolIdOf(row), row.id);
      assert.equal(row.tier, 1);
      assert.equal(row.frozen, false);
    });

    it("`updateTerms` makes the new terms current and keeps the earlier ones", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onInitialize(db, at(initialize(LISTED)));
      await onPoolListed(db, at({ poolId: LISTED_ID, tier: 1, params: TERMS }));
      await onPoolTermsUpdated(db, at({ poolId: LISTED_ID, params: TIGHTER }));

      const [row] = rows(schema.pool) as [typeof TERMS];
      assert.equal(row.ltBps, 7400);
      assert.equal(row.maxLtvBps, 6000);
      assert.equal(row.debtCapUsdg, 400_000_000_000n);

      const history = rows(schema.poolTermsChange) as ({ source: string } & typeof TERMS)[];
      assert.deepEqual(
        history.map(({ source, ltBps, maxLtvBps }) => ({ source, ltBps, maxLtvBps })),
        [
          { source: "listed", ltBps: 7500, maxLtvBps: 6500 },
          { source: "updated", ltBps: 7400, maxLtvBps: 6000 },
        ],
      );
    });

    it("`setFrozen(true)` then `setFrozen(false)`: the status follows the order of events", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onPoolListed(db, at({ poolId: LISTED_ID, tier: 1, params: TERMS }));
      const frozen = () => (rows(schema.pool)[0] as { frozen: boolean }).frozen;

      await onPoolFrozen(db, at({ poolId: LISTED_ID, frozen: true }));
      assert.equal(frozen(), true);
      await onPoolFrozen(db, at({ poolId: LISTED_ID, frozen: false }));
      assert.equal(frozen(), false);
    });

    it("a scheduled ramp answers before `start`, in the middle and after `start + duration`", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onPoolListed(db, at({ poolId: LISTED_ID, tier: 1, params: TERMS }));
      await onLtRampScheduled(
        db,
        at({ poolId: LISTED_ID, ltFromBps: 7500, ltTargetBps: 7000, start: 2_000_000, duration: 1_000 }),
      );

      const row = rows(schema.pool)[0] as Parameters<typeof rampStatusAt>[0];
      const at_ = (t: bigint) => {
        const { rampRunning, effectiveLtBps } = rampStatusAt(row, t);
        return { rampRunning, effectiveLtBps };
      };
      assert.deepEqual(at_(1_999_000n), { rampRunning: true, effectiveLtBps: 7500 });
      assert.deepEqual(at_(2_000_500n), { rampRunning: true, effectiveLtBps: 7250 });
      assert.deepEqual(at_(2_001_000n), { rampRunning: false, effectiveLtBps: 7000 });
      assert.equal(rows(schema.ltRamp).length, 1);
    });

    it("TWAP observations are kept per pool, and the age of the newest one can be computed", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      const other = poolIdOf(UNLISTED);
      await onRecorded(db, at({ poolId: LISTED_ID, index: 0, timestamp: 5_000n, tickCumulative: 0n }));
      await onRecorded(db, at({ poolId: other, index: 0, timestamp: 5_100n, tickCumulative: 0n }));
      await onRecorded(db, at({ poolId: LISTED_ID, index: 1, timestamp: 5_300n, tickCumulative: -59_455_200n }));

      assert.equal(rows(schema.twapObservation).length, 3);
      const latest = Object.fromEntries(
        (rows(schema.twapPool) as { poolId: Hex; lastObservationAt: bigint; observationCount: number }[]).map(
          (row) => [row.poolId, row],
        ),
      );
      assert.equal(latest[LISTED_ID]?.lastObservationAt, 5_300n);
      assert.equal(latest[LISTED_ID]?.observationCount, 2);
      assert.equal(latest[other]?.lastObservationAt, 5_100n);
      // The 600-second alert: 601 seconds after the newest observation it fires.
      assert.equal(observationAgeAt(latest[LISTED_ID]!.lastObservationAt, 5_901n), 601n);
    });

    it("tokens and hooks hold the latest configuration", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      const feed = "0x61b7e5650328764b076a108eff5fa7282a1b9ad2";
      await onTokenConfigured(db, at({ currency: USDG, enabled: true, tier: 1, decimals: 6, priceFeed: feed }));
      await onTokenConfigured(db, at({ currency: USDG, enabled: false, tier: 1, decimals: 6, priceFeed: feed }));
      await onHookAllowlisted(db, at({ hooks: feed, allowed: true }));
      await onHookAllowlisted(db, at({ hooks: feed, allowed: false }));

      assert.equal(rows(schema.token).length, 1);
      assert.equal((rows(schema.token)[0] as { enabled: boolean }).enabled, false);
      assert.equal(rows(schema.hook).length, 1);
      assert.equal((rows(schema.hook)[0] as { allowed: boolean }).allowed, false);
    });
  });

  describe("negative", () => {
    it("a pool in `uniswap_pool` that is not listed does not appear in `pool`", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onInitialize(db, at(initialize(LISTED)));
      await onInitialize(db, at(initialize(UNLISTED)));
      await onPoolListed(db, at({ poolId: LISTED_ID, tier: 1, params: TERMS }));

      assert.equal(rows(schema.uniswapPool).length, 2);
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
    it("a pool listed before its `Initialize` gets its key when the event arrives", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onPoolListed(db, at({ poolId: LISTED_ID, tier: 1, params: TERMS }));
      assert.equal((rows(schema.pool)[0] as { fee: number | null }).fee, null);

      await onInitialize(db, at(initialize(LISTED)));
      const row = rows(schema.pool)[0] as PoolKey & { id: Hex };
      assert.equal(poolIdOf(row), row.id);
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
      assert.deepEqual([rampLtFromBps, rampLtTargetBps, rampStart, rampDuration], [null, null, null, null]);

      const status = rampStatusAt(rows(schema.pool)[0] as Parameters<typeof rampStatusAt>[0], 2_000_500n);
      assert.deepEqual(status, { t: 2_000_500n, rampRunning: false, rampEndsAt: null, effectiveLtBps: 7400 });
      assert.equal(rows(schema.ltRamp).length, 1);
    });

    it("a second ramp replaces the first", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onPoolListed(db, at({ poolId: LISTED_ID, tier: 1, params: TERMS }));
      await onLtRampScheduled(db, at({ poolId: LISTED_ID, ltFromBps: 7500, ltTargetBps: 7200, start: 2_000_000, duration: 1_000 }));
      await onLtRampScheduled(db, at({ poolId: LISTED_ID, ltFromBps: 7350, ltTargetBps: 7000, start: 2_000_500, duration: 500 }));

      const row = rows(schema.pool)[0] as { rampLtFromBps: number; rampStart: bigint };
      assert.equal(row.rampLtFromBps, 7350);
      assert.equal(row.rampStart, 2_000_500n);
      assert.equal(rows(schema.ltRamp).length, 2);
    });

    it("a pool's first observation, `index 0` and `tickCumulative 0`, is stored as data", async () => {
      const { db, rows } = fakeDb();
      await onRecorded(db, chain()({ poolId: LISTED_ID, index: 0, timestamp: 5_000n, tickCumulative: 0n }));
      assert.deepEqual(
        (rows(schema.twapObservation) as { index: number; tickCumulative: bigint }[]).map((row) => [row.index, row.tickCumulative]),
        [[0, 0n]],
      );
      assert.equal((rows(schema.twapPool)[0] as { observationCount: number }).observationCount, 1);
    });

    it("a reindex from zero gives identical tables, without an `eth_call`", async () => {
      // fakeDb has no `client`, and the handlers receive the store alone: replaying the
      // same events is all a reindex can do.
      const replay = async () => {
        const { db, dump } = fakeDb();
        const at = chain();
        await onInitialize(db, at(initialize(LISTED)));
        await onInitialize(db, at(initialize(UNLISTED)));
        await onTokenConfigured(db, at({ currency: USDG, enabled: true, tier: 1, decimals: 6, priceFeed: USDG }));
        await onPoolListed(db, at({ poolId: LISTED_ID, tier: 1, params: TERMS }));
        await onPoolFrozen(db, at({ poolId: LISTED_ID, frozen: true }));
        await onLtRampScheduled(db, at({ poolId: LISTED_ID, ltFromBps: 7500, ltTargetBps: 6000, start: 2_000_000, duration: 1_000 }));
        await onRecorded(db, at({ poolId: LISTED_ID, index: 0, timestamp: 5_000n, tickCumulative: 0n }));
        await onRecorded(db, at({ poolId: LISTED_ID, index: 1, timestamp: 5_300n, tickCumulative: -1n }));
        return dump();
      };
      assert.deepEqual(await replay(), await replay());
    });
  });
});
