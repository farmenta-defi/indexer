import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zeroAddress, type Address, type Hex } from "viem";

import * as schema from "../ponder.schema.ts";
import { onPoolListed } from "../src/handlers/collateralPolicy.ts";
import { onCollateralDeposited } from "../src/handlers/farmentaMarket.ts";
import { onModifyLiquidity } from "../src/handlers/poolManager.ts";
import { poolIdOf } from "../src/lib/poolKey.ts";
import { chain } from "./support/events.ts";
import { fakeDb } from "./support/fakeDb.ts";

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const HOOK = "0x06a889870c8f83640d6816319f72e2aa579b6080" as Address;
const MANAGER = "0x58daec3116aae6d93017baaea7749052e8a04fa7" as Address;
const MARKET = "0x0000000000000000000000000000000000000042" as Address;
const key = { currency0: zeroAddress, currency1: USDG, fee: 8_388_608, tickSpacing: 10, hooks: HOOK };
const poolId = poolIdOf(key);
const terms = {
  maxLtvBps: 6_500,
  ltBps: 7_500,
  liquidatorBonusBps: 500,
  removeHaircutBps: 0,
  debtCapUsdg: 500_000_000_000n,
  minPositionUsd: 50n * 10n ** 18n,
};

function reader(responses: unknown[]) {
  const calls: { functionName: string; args: readonly unknown[] }[] = [];
  return {
    calls,
    readContract: async (input: { functionName: string; args: readonly unknown[] }) => {
      calls.push(input);
      return responses.shift();
    },
  };
}

describe("chain reads for history skipped by START_BLOCK_FLOOR", () => {
  describe("PoolListed", () => {
    it("loads and validates a missing PoolKey", async () => {
      const { db, rows } = fakeDb();
      const client = reader([key]);
      assert.equal(poolId, "0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551");
      await onPoolListed(db, chain()({ poolId, tier: 1, params: terms }), client as never);
      assert.deepEqual(
        (({ currency0, currency1, fee, tickSpacing, hooks }) => ({ currency0, currency1, fee, tickSpacing, hooks }))(rows(schema.pool)[0] as typeof key),
        key,
      );
      assert.deepEqual(client.calls[0]?.args, [`0x${poolId.slice(2, 52)}`]);
      assert.deepEqual(rows(schema.uniswapPool), []);
    });

    it("rejects a PoolKey whose hash differs from the listing", async () => {
      const { db } = fakeDb();
      const client = reader([{ ...key, fee: 500 }]);
      await assert.rejects(onPoolListed(db, chain()({ poolId, tier: 1, params: terms }), client as never), /hash/);
    });

    it("leaves an uninitialized pool key null without failing", async () => {
      const { db, rows } = fakeDb();
      const client = reader([{ ...key, tickSpacing: 0 }]);
      await onPoolListed(db, chain()({ poolId, tier: 1, params: terms }), client as never);
      const row = rows(schema.pool)[0] as Record<string, unknown>;
      for (const field of ["currency0", "currency1", "fee", "tickSpacing", "hooks"]) assert.equal(row[field], null);
    });

    it("does not read chain when the historical key exists", async () => {
      const { db } = fakeDb();
      const at = chain();
      await import("../src/handlers/poolManager.ts").then(({ onInitialize }) => onInitialize(db, at({ id: poolId, ...key })));
      const client = reader([]);
      await onPoolListed(db, at({ poolId, tier: 1, params: terms }), client as never);
      assert.equal(client.calls.length, 0);
    });
  });

  describe("CollateralDeposited", () => {
    it("rebuilds a missing position and later liquidity events update it", async () => {
      const { db, rows } = fakeDb();
      const tokenId = 42n;
      const packedInfo = (BigInt(poolId) & (((1n << 200n) - 1n) << 56n)) | (120n << 32n) | ((BigInt.asUintN(24, -120n)) << 8n);
      const client = reader([[key, packedInfo], 9_000n]);
      await onCollateralDeposited(db, chain()({ tokenId, owner: MARKET, poolId }, MARKET), client as never);
      assert.deepEqual(client.calls.map((call) => call.functionName), ["getPoolAndPositionInfo", "getPositionLiquidity"]);
      assert.equal(rows(schema.position)[0]?.poolId, poolId);
      assert.equal(rows(schema.position)[0]?.tickLower, -120);
      assert.equal(rows(schema.position)[0]?.tickUpper, 120);
      assert.equal(rows(schema.position)[0]?.liquidity, 9_000n);
      assert.equal(rows(schema.position)[0]?.mintedBlock, null);
      assert.equal(rows(schema.position)[0]?.mintedAt, null);

      const sender = MANAGER;
      await onModifyLiquidity(
        db,
        chain()({ id: poolId, sender, tickLower: -120, tickUpper: 120, liquidityDelta: 300n, salt: `0x${tokenId.toString(16).padStart(64, "0")}` as Hex }),
      );
      assert.equal(rows(schema.position)[0]?.liquidity, 9_300n);
    });

    it("does not reread a known position", async () => {
      const { db } = fakeDb();
      const tokenId = 43n;
      const at = chain();
      const salt = `0x${tokenId.toString(16).padStart(64, "0")}` as Hex;
      await import("../src/handlers/positionManager.ts").then(({ onTransfer }) => onTransfer(db, at({ from: zeroAddress, to: MARKET, tokenId })));
      await onModifyLiquidity(db, at({ id: poolId, sender: MANAGER, tickLower: -10, tickUpper: 10, liquidityDelta: 100n, salt }));
      const client = reader([]);
      await onCollateralDeposited(db, at({ tokenId, owner: MARKET, poolId }, MARKET), client as never);
      assert.equal(client.calls.length, 0);
    });

    it("rejects a position whose stored key belongs to another pool", async () => {
      const { db } = fakeDb();
      const tokenId = 44n;
      const otherPoolId = poolIdOf({ ...key, fee: 500 });
      const client = reader([[key, 0n], 1n]);
      await assert.rejects(
        onCollateralDeposited(db, chain()({ tokenId, owner: MARKET, poolId: otherPoolId }, MARKET), client as never),
        /not/,
      );
    });
  });
});
