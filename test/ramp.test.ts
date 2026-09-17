import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { effectiveLtBps, isRampRunning, type LtRamp } from "../src/lib/ramp.ts";

// 8000 → 6000 bps over 1000 seconds, starting at t = 10_000.
const ramp: LtRamp = { ltFromBps: 8000, ltTargetBps: 6000, start: 10_000n, duration: 1_000n };

describe("isRampRunning", () => {
  describe("positive", () => {
    it("is true in the middle of the ramp", () => {
      assert.equal(isRampRunning(ramp, 10_500n), true);
    });

    it("is true before `start`: the schedule is already published (spec §13)", () => {
      assert.equal(isRampRunning(ramp, 9_999n), true);
    });
  });

  describe("negative", () => {
    it("is false for a pool with no ramp", () => {
      assert.equal(isRampRunning(null, 10_500n), false);
    });

    it("is false after `start + duration`", () => {
      assert.equal(isRampRunning(ramp, 99_999n), false);
    });
  });

  describe("edge case", () => {
    it("is true one second before `start + duration` and false at it", () => {
      assert.equal(isRampRunning(ramp, 10_999n), true);
      assert.equal(isRampRunning(ramp, 11_000n), false);
    });
  });
});

describe("effectiveLtBps", () => {
  describe("positive", () => {
    it("is `ltFromBps` before `start`", () => {
      assert.equal(effectiveLtBps(7500, ramp, 0n), 8000);
    });

    it("falls linearly in between", () => {
      assert.equal(effectiveLtBps(7500, ramp, 10_250n), 7500);
      assert.equal(effectiveLtBps(7500, ramp, 10_500n), 7000);
    });

    it("is `ltTargetBps` after `start + duration`", () => {
      assert.equal(effectiveLtBps(7500, ramp, 99_999n), 6000);
    });
  });

  describe("negative", () => {
    it("ignores the ramp arithmetic with no ramp: the listed LT at any time", () => {
      assert.equal(effectiveLtBps(7500, null, 0n), 7500);
      assert.equal(effectiveLtBps(7500, null, 10_500n), 7500);
    });

    it("never leaves [ltTargetBps, ltFromBps], whatever the time", () => {
      for (const t of [0n, 10_000n, 10_001n, 10_999n, 11_000n, 2n ** 40n]) {
        const lt = effectiveLtBps(7500, ramp, t);
        assert.ok(lt >= 6000 && lt <= 8000, `t=${t} lt=${lt}`);
      }
    });
  });

  describe("edge case", () => {
    it("is still `ltFromBps` at `start` and already `ltTargetBps` at `start + duration`", () => {
      assert.equal(effectiveLtBps(7500, ramp, 10_000n), 8000);
      assert.equal(effectiveLtBps(7500, ramp, 11_000n), 6000);
    });

    it("truncates the fall like the contract's integer division", () => {
      // fall × elapsed / duration = 2000 × 1 / 1000 = 2, and 2000 × 333 / 1000 = 666.
      assert.equal(effectiveLtBps(7500, ramp, 10_001n), 7998);
      assert.equal(effectiveLtBps(7500, ramp, 10_333n), 7334);
      const odd: LtRamp = { ltFromBps: 8000, ltTargetBps: 7999, start: 0n, duration: 3n };
      assert.equal(effectiveLtBps(8000, odd, 2n), 8000); // 1 × 2 / 3 = 0
    });

    it("is flat for a ramp whose target equals its start", () => {
      const flat: LtRamp = { ltFromBps: 7000, ltTargetBps: 7000, start: 10_000n, duration: 1_000n };
      assert.equal(effectiveLtBps(7500, flat, 10_500n), 7000);
    });
  });
});
