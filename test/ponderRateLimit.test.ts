import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canRise, descent, readRateLimit, stallAbove, type RateLimit } from "./support/ponderRateLimit.ts";

// The limiter as Ponder 0.17.10 ships it, before the patch.
const SHIPPED = `
const EPSILON = 0.1;
const INITIAL_MAX_RPS = 20;
const MIN_RPS = 3;
const MAX_RPS = 500;
const RPS_INCREASE_FACTOR = 1.05;
const RPS_DECREASE_FACTOR = 0.95;
const RPS_INCREASE_QUALIFIER = 0.9;
const SUCCESS_MULTIPLIER = 5;
`;

const shipped: RateLimit = {
  initialMaxRps: 20,
  minRps: 3,
  maxRps: 500,
  increaseFactor: 1.05,
  decreaseFactor: 0.95,
  increaseQualifier: 0.9,
};

const withFloor = (minRps: number): RateLimit => ({ ...shipped, minRps });

describe("readRateLimit", () => {
  describe("positive", () => {
    it("reads the six constants", () => {
      assert.deepEqual(readRateLimit(SHIPPED), shipped);
    });

    it("reads a patched floor", () => {
      assert.deepEqual(readRateLimit(SHIPPED.replace("MIN_RPS = 3;", "MIN_RPS = 15;")), withFloor(15));
    });
  });

  describe("negative", () => {
    it("refuses a source without MIN_RPS, as after an upgrade that renamed it", () => {
      assert.throws(() => readRateLimit(SHIPPED.replace("MIN_RPS", "FLOOR_RPS")), /^Error: MIN_RPS: expected one declaration, found 0$/);
    });

    it("refuses a constant declared twice, where it could not tell which one runs", () => {
      assert.throws(() => readRateLimit(`${SHIPPED}const MIN_RPS = 15;\n`), /^Error: MIN_RPS: expected one declaration, found 2$/);
    });

    it("refuses a floor that is no longer a plain number", () => {
      assert.throws(
        () => readRateLimit(SHIPPED.replace("MIN_RPS = 3;", "MIN_RPS = Number(process.env.MIN_RPS);")),
        /^Error: MIN_RPS: expected one declaration, found 0$/,
      );
    });

    it("refuses factors that would not move the limit the way the limiter assumes", () => {
      assert.throws(() => readRateLimit(SHIPPED.replace("INCREASE_FACTOR = 1.05", "INCREASE_FACTOR = 1")), /rise by a factor above 1/);
      assert.throws(() => readRateLimit(SHIPPED.replace("DECREASE_FACTOR = 0.95", "DECREASE_FACTOR = 1")), /rise by a factor above 1/);
    });
  });

  describe("edge case", () => {
    it("reads a number written with separators", () => {
      assert.equal(readRateLimit(SHIPPED.replace("MAX_RPS = 500;", "MAX_RPS = 5_000;")).maxRps, 5000);
    });

    it("ignores a constant whose name only ends in MIN_RPS", () => {
      assert.equal(readRateLimit(`${SHIPPED}const WS_MIN_RPS = 1;\n`).minRps, 3);
    });
  });
});

describe("canRise", () => {
  describe("positive", () => {
    it("is true at 15: 15 requests fit in a second and 13.5 are asked for", () => {
      assert.equal(canRise(shipped, 15), true);
    });
  });

  describe("negative", () => {
    it("is false at 3.47: 3 requests fit in a second and 3.13 are asked for", () => {
      assert.equal(canRise(shipped, 3.47), false);
    });
  });

  describe("edge case", () => {
    it("is true at a whole number however small, since the whole limit fits in a second", () => {
      assert.equal(canRise(shipped, 3), true);
    });

    it("depends on the fraction below 10", () => {
      assert.equal(canRise(shipped, 9.5), true);
      assert.equal(canRise(shipped, 6.98), false);
      assert.equal(canRise(shipped, 6.3), true);
    });

    it("is true from 10 up, whatever the fraction", () => {
      assert.equal(canRise(shipped, 10.99), true);
      assert.equal(canRise(shipped, 19.99), true);
    });
  });
});

describe("descent", () => {
  describe("positive", () => {
    it("falls by 5% per 429 and ends on the floor", () => {
      const passed = descent(withFloor(15));
      assert.deepEqual(
        passed.map((limit) => limit.toFixed(2)),
        ["20.00", "19.00", "18.05", "17.15", "16.29", "15.48", "15.00"],
      );
    });
  });

  describe("negative", () => {
    it("never goes below the floor", () => {
      assert.equal(Math.min(...descent(shipped)), 3);
    });
  });

  describe("edge case", () => {
    it("is the initial limit alone when the floor equals it", () => {
      assert.deepEqual(descent(withFloor(20)), [20]);
    });
  });
});

describe("stallAbove", () => {
  describe("positive", () => {
    it("gets back to the initial limit from a floor of 15", () => {
      assert.equal(stallAbove(withFloor(15), 15), null);
    });
  });

  describe("negative", () => {
    it("stalls at 3.47 from Ponder's own floor of 3, the limit production logged on 29 Sep 2026", () => {
      assert.equal(stallAbove(shipped, 3)?.toFixed(2), "3.47");
    });

    it("stalls from a floor of 5 too", () => {
      assert.equal(stallAbove(withFloor(5), 5)?.toFixed(2), "5.79");
    });
  });

  describe("edge case", () => {
    it("has nothing to climb from the initial limit", () => {
      assert.equal(stallAbove(shipped, 20), null);
    });

    it("gets back from a floor of exactly 10", () => {
      assert.equal(stallAbove(withFloor(10), 10), null);
    });
  });
});
