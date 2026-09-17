import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { decodeEventLog, type Address, type Hex } from "viem";

import { poolManagerAbi } from "../abis/PoolManager.ts";
import { positionManagerAbi } from "../abis/PositionManager.ts";
import { UNISWAP } from "../config/uniswap.ts";
import * as schema from "../ponder.schema.ts";
import { onModifyLiquidity } from "../src/handlers/poolManager.ts";
import { onTransfer } from "../src/handlers/positionManager.ts";
import { fakeDb } from "./support/fakeDb.ts";

// FAR-35: "ticks and liquidity match `getPoolAndPositionInfo` / `getPositionLiquidity` for real
// fixture positions". The logs are real (test/fixtures/README.md). The expected figures are
// the ones `smart-contract/test/fork/PositionFixtures.t.sol` asserts against those two views
// at the same block, so handlers and contracts are held to one number without an `eth_call`.

type RawLog = {
  address: Address;
  topics: [Hex, ...Hex[]];
  data: Hex;
  blockNumber: number;
  timestamp: number;
  logIndex: number;
  transactionHash: Hex;
};

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
// ETH/USDG, no hook, fee 460 (spec §18).
const POOL = "0x54f7883914619af9105355bf83ed678bcf9f63560218ac61c9963b9503d0ba32";

async function replay(tokenId: number, keep: (log: RawLog, i: number) => boolean = () => true) {
  const all = JSON.parse(readFileSync(join(FIXTURES, `position-${tokenId}.json`), "utf8")) as RawLog[];
  const logs = all.filter(keep);
  const { db, rows } = fakeDb();
  for (const log of logs) {
    const event = {
      block: { number: BigInt(log.blockNumber), timestamp: BigInt(log.timestamp) },
      log: { logIndex: log.logIndex, address: log.address },
      transaction: { hash: log.transactionHash },
    };
    if (log.address === UNISWAP.positionManager.address) {
      const { eventName, args } = decodeEventLog({ abi: positionManagerAbi, topics: log.topics, data: log.data });
      assert.equal(eventName, "Transfer");
      await onTransfer(db, { ...event, args: args as Parameters<typeof onTransfer>[1]["args"] });
    } else {
      assert.equal(log.address, UNISWAP.poolManager.address);
      const { eventName, args } = decodeEventLog({ abi: poolManagerAbi, topics: log.topics, data: log.data });
      assert.equal(eventName, "ModifyLiquidity");
      await onModifyLiquidity(db, { ...event, args: args as Parameters<typeof onModifyLiquidity>[1]["args"] });
    }
  }
  return { logs, rows: rows(schema.position) };
}

describe("real fixture positions", () => {
  describe("positive", () => {
    it("POS_ETH_USDG_ABOVE_RANGE (1,621,020): minted, then its fees collected", async () => {
      const { logs, rows } = await replay(1_621_020);
      assert.equal(logs.length, 3);
      assert.deepEqual(rows, [
        {
          tokenId: 1_621_020n,
          owner: "0x126894a625e466af34bb162288b5159f178293bd",
          poolId: POOL,
          tickLower: -198_486,
          tickUpper: -198_036,
          liquidity: 2_202_228_439_131_196n,
          burned: false,
          mintedBlock: 53_379_662n,
          mintedAt: 1_788_434_653n,
          // The fee collection: a `ModifyLiquidity` with a zero delta.
          updatedAt: 1_788_514_073n,
        },
      ]);
    });

    it("POS_ETH_USDG_IN_RANGE (1,768,881): minted 40,032 blocks before the fork block", async () => {
      const { rows } = await replay(1_768_881);
      assert.deepEqual(rows, [
        {
          tokenId: 1_768_881n,
          owner: "0x6ba0c2e739226ebb4ba3667fdc5604a37b4b73ad",
          poolId: POOL,
          tickLower: -198_018,
          tickUpper: -197_973,
          liquidity: 15_529_226_464_688_778n,
          burned: false,
          mintedBlock: 54_159_968n,
          mintedAt: 1_788_514_268n,
          updatedAt: 1_788_514_268n,
        },
      ]);
    });
  });

  describe("negative", () => {
    it("without the mint's `Transfer`, the real `ModifyLiquidity` logs alone make no position", async () => {
      const { logs, rows } = await replay(1_621_020, (log) => log.address === UNISWAP.poolManager.address);
      assert.equal(logs.length, 2);
      assert.deepEqual(rows, []);
    });
  });

  describe("edge case", () => {
    it("the real fee collection is a zero delta: liquidity as at the mint, only `updatedAt` moves", async () => {
      const atMint = await replay(1_621_020, (_, i) => i < 2);
      const afterCollect = await replay(1_621_020);
      assert.deepEqual(afterCollect.rows, [{ ...atMint.rows[0], updatedAt: 1_788_514_073n }]);
      assert.equal(atMint.rows[0]?.updatedAt, 1_788_434_653n);
    });
  });
});
