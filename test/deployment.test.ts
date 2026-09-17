import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadDeployment } from "../config/deployment.ts";

const POLICY = "0x1111111111111111111111111111111111111111";
const TWAP = "0x2222222222222222222222222222222222222222";
const BLUE_CHIP = "0x3333333333333333333333333333333333333333";
const MEME = "0x4444444444444444444444444444444444444444";

const valid = {
  collateralPolicy: { address: POLICY, startBlock: 100 },
  twapRecorder: { address: TWAP, startBlock: 101 },
  markets: {
    blueChip: { address: BLUE_CHIP, startBlock: 102 },
    meme: { address: MEME, startBlock: 103 },
  },
};

function dirWith(name: string, content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "farmenta-deployment-"));
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(content));
  return dir;
}

describe("loadDeployment", () => {
  describe("positive", () => {
    it("returns every contract with its address and start block", () => {
      assert.deepEqual(loadDeployment("fork", dirWith("fork", valid)), valid);
    });

    it("accepts a single market", () => {
      const oneMarket = { ...valid, markets: { blueChip: valid.markets.blueChip } };
      assert.deepEqual(loadDeployment("fork", dirWith("fork", oneMarket))?.markets, oneMarket.markets);
    });
  });

  describe("negative", () => {
    it("rejects a name with no file behind it", () => {
      assert.throws(() => loadDeployment("mainnet", dirWith("fork", valid)), /mainnet\.json does not exist/);
    });

    it("rejects the zero address, so example.json cannot be used unedited", () => {
      assert.throws(() => loadDeployment("example"), /example\.markets\.blueChip\.address is not a deployed/);
    });

    it("rejects an address that is not 20 bytes", () => {
      const truncated = { ...valid, twapRecorder: { address: "0x2222…2222", startBlock: 101 } };
      assert.throws(() => loadDeployment("fork", dirWith("fork", truncated)), /fork\.twapRecorder\.address/);
    });

    it("rejects a missing or non-integer start block", () => {
      for (const startBlock of [undefined, "102", 1.5, -1]) {
        const broken = { ...valid, collateralPolicy: { address: POLICY, startBlock } };
        assert.throws(() => loadDeployment("fork", dirWith("fork", broken)), /fork\.collateralPolicy\.startBlock/);
      }
    });

    it("rejects a deployment with no market", () => {
      assert.throws(() => loadDeployment("fork", dirWith("fork", { ...valid, markets: {} })), /lists no FarmentaMarket/);
    });
  });

  describe("edge case", () => {
    it("treats an unset or empty name as no deployment", () => {
      assert.equal(loadDeployment(undefined), undefined);
      assert.equal(loadDeployment(""), undefined);
    });

    it("accepts start block 0", () => {
      const genesis = { ...valid, twapRecorder: { address: TWAP, startBlock: 0 } };
      assert.equal(loadDeployment("fork", dirWith("fork", genesis))?.twapRecorder.startBlock, 0);
    });
  });
});
