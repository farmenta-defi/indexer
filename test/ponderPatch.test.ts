import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { descent, readRateLimit, stallAbove } from "./support/ponderRateLimit.ts";

// Guards the patch in patches/ (FAR-84, README "Ponder patch"). It reads the Ponder that
// `pnpm install` put in node_modules, so a patch lost in an upgrade fails here and not in
// production, hours later, as an indexer that falls behind.

// What following the chain takes: it produces 9.9 blocks per second (spec, Riwayat v2.10) and
// live mode asks for each of them with one eth_getBlockByNumber.
const LIVE_MODE_RPS = 10;
// The floor FAR-84 chose.
const FLOOR_RPS = 15;

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// `dist/esm` is what runs: package.json and ecosystem.config.cjs start dist/esm/bin/ponder.js.
const running = readRateLimit(read("node_modules/ponder/dist/esm/rpc/index.js"));
const shippedSource = readRateLimit(read("node_modules/ponder/src/rpc/index.ts"));

const manifest = JSON.parse(read("package.json")) as {
  engines: Record<string, string>;
  dependencies: Record<string, string>;
  pnpm?: { patchedDependencies?: Record<string, string> };
};
const installed = JSON.parse(read("node_modules/ponder/package.json")) as { version: string };

describe("installed Ponder", () => {
  describe("positive", () => {
    it(`has a rate limit floor of ${FLOOR_RPS} in the file that runs`, () => {
      assert.equal(running.minRps, FLOOR_RPS);
    });

    it("has a floor that covers live mode", () => {
      assert.ok(running.minRps >= LIVE_MODE_RPS, `MIN_RPS ${running.minRps} is below the ${LIVE_MODE_RPS} live mode needs`);
    });

    it("gets back to the initial limit from every limit a run of 429s leaves it at", () => {
      for (const from of descent(running)) {
        assert.equal(stallAbove(running, from), null, `stalls climbing from ${from}`);
      }
    });
  });

  describe("negative", () => {
    it("does not start below its floor: a 429 must lower the limit, never raise it", () => {
      assert.ok(running.minRps <= running.initialMaxRps);
    });

    it("has no other constant of the limiter changed", () => {
      const { minRps: _floor, ...others } = running;
      assert.deepEqual(others, { initialMaxRps: 20, maxRps: 500, increaseFactor: 1.05, decreaseFactor: 0.95, increaseQualifier: 0.9 });
    });
  });

  describe("edge case", () => {
    it("has the same limiter in the TypeScript source shipped next to it", () => {
      assert.deepEqual(shippedSource, running);
    });

    it("is the exact version package.json pins, and the patch is written for that version", () => {
      const pinned = manifest.dependencies.ponder;
      assert.match(pinned ?? "", /^\d+\.\d+\.\d+$/, "ponder must be pinned exactly, not as a range");
      assert.equal(installed.version, pinned);
      assert.deepEqual(manifest.pnpm?.patchedDependencies, { [`ponder@${pinned}`]: `patches/ponder@${pinned}.patch` });
    });

    it("asks for pnpm 10: pnpm 9 rejects the patch hash pnpm 10 wrote to the lockfile", () => {
      assert.equal(manifest.engines.pnpm, ">=10");
    });
  });
});
