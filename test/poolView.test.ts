import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { observationAgeAt, parseTime, rampOf, rampStatusAt, toJson } from "../src/lib/poolView.ts";

const noRamp = { ltBps: 7500, rampLtFromBps: null, rampLtTargetBps: null, rampStart: null, rampDuration: null };
const ramped = { ltBps: 8000, rampLtFromBps: 8000, rampLtTargetBps: 6000, rampStart: 10_000n, rampDuration: 1_000n };

describe("rampOf", () => {
  describe("positive", () => {
    it("reads the four ramp columns", () => {
      assert.deepEqual(rampOf(ramped), { ltFromBps: 8000, ltTargetBps: 6000, start: 10_000n, duration: 1_000n });
    });
  });

  describe("negative", () => {
    it("is null for a pool with no ramp, as after `updateTerms` cleared it", () => {
      assert.equal(rampOf(noRamp), null);
    });
  });

  describe("edge case", () => {
    it("is null when any one column is missing, rather than a half-built ramp", () => {
      assert.equal(rampOf({ ...ramped, rampLtFromBps: null }), null);
      assert.equal(rampOf({ ...ramped, rampLtTargetBps: null }), null);
      assert.equal(rampOf({ ...ramped, rampStart: null }), null);
      assert.equal(rampOf({ ...ramped, rampDuration: null }), null);
    });
  });
});

describe("rampStatusAt", () => {
  describe("positive", () => {
    it("answers before `start`, in the middle and after `start + duration`", () => {
      assert.deepEqual(rampStatusAt(ramped, 9_000n), {
        t: 9_000n,
        rampRunning: true,
        rampEndsAt: 11_000n,
        effectiveLtBps: 8000,
      });
      assert.deepEqual(rampStatusAt(ramped, 10_500n), {
        t: 10_500n,
        rampRunning: true,
        rampEndsAt: 11_000n,
        effectiveLtBps: 7000,
      });
      assert.deepEqual(rampStatusAt(ramped, 12_000n), {
        t: 12_000n,
        rampRunning: false,
        rampEndsAt: 11_000n,
        effectiveLtBps: 6000,
      });
    });
  });

  describe("negative", () => {
    it("reports the listed LT and no ramp when none is set", () => {
      assert.deepEqual(rampStatusAt(noRamp, 10_500n), {
        t: 10_500n,
        rampRunning: false,
        rampEndsAt: null,
        effectiveLtBps: 7500,
      });
    });
  });

  describe("edge case", () => {
    it("stops running exactly at `start + duration`, with the LT at its target", () => {
      assert.deepEqual(rampStatusAt(ramped, 11_000n), {
        t: 11_000n,
        rampRunning: false,
        rampEndsAt: 11_000n,
        effectiveLtBps: 6000,
      });
    });
  });
});

describe("observationAgeAt", () => {
  describe("positive", () => {
    it("is the seconds since the newest observation, so 600 can be compared against it", () => {
      assert.equal(observationAgeAt(1_000n, 1_601n), 601n);
    });
  });

  describe("negative", () => {
    it("is null for a pool that was never recorded, not zero", () => {
      assert.equal(observationAgeAt(null, 1_601n), null);
    });
  });

  describe("edge case", () => {
    it("is zero at the observation's own second", () => {
      assert.equal(observationAgeAt(1_000n, 1_000n), 0n);
    });

    it("is never negative when the reader's clock trails the chain's", () => {
      assert.equal(observationAgeAt(1_000n, 990n), 0n);
    });
  });
});

describe("parseTime", () => {
  describe("positive", () => {
    it("reads unix seconds", () => {
      assert.equal(parseTime("1700000000"), 1_700_000_000n);
    });

    it("defaults to the current time in seconds", () => {
      assert.equal(parseTime(undefined, () => 1_700_000_000_999), 1_700_000_000n);
    });
  });

  describe("negative", () => {
    it("rejects anything that is not a whole number", () => {
      for (const raw of ["", "-1", "1.5", "1e9", "now", "0x10", " 1"]) assert.equal(parseTime(raw), null, raw);
    });
  });

  describe("edge case", () => {
    it("accepts 0 and rejects more digits than a timestamp can have", () => {
      assert.equal(parseTime("0"), 0n);
      assert.equal(parseTime("9".repeat(15)), 999_999_999_999_999n);
      assert.equal(parseTime("9".repeat(16)), null);
    });
  });
});

describe("toJson", () => {
  describe("positive", () => {
    it("writes bigints as decimal strings and leaves the rest alone", () => {
      assert.deepEqual(toJson({ debtCapUsdg: 400_000_000_000n, fee: 500, frozen: false }), {
        debtCapUsdg: "400000000000",
        fee: 500,
        frozen: false,
      });
    });
  });

  describe("negative", () => {
    it("does not turn null into a string: an unset ramp stays null", () => {
      assert.deepEqual(toJson({ rampStart: null, hooks: null }), { rampStart: null, hooks: null });
    });
  });

  describe("edge case", () => {
    it("keeps a uint128 beyond Number.MAX_SAFE_INTEGER exact, nested or not", () => {
      assert.deepEqual(toJson({ max: 2n ** 128n - 1n, rows: [{ v: 2n ** 100n }] }), {
        max: "340282366920938463463374607431768211455",
        rows: [{ v: "1267650600228229401496703205376" }],
      });
    });
  });
});
