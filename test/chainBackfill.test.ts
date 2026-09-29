import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zeroAddress, type Address, type Hex } from "viem";

import { UNISWAP } from "../config/uniswap.ts";
import * as schema from "../ponder.schema.ts";
import { createApp } from "../src/api/app.ts";
import { onPoolListed } from "../src/handlers/collateralPolicy.ts";
import { onCollateralDeposited } from "../src/handlers/farmentaMarket.ts";
import { onModifyLiquidity } from "../src/handlers/poolManager.ts";
import { poolIdOf } from "../src/lib/poolKey.ts";
import { chain } from "./support/events.ts";
import { fakeDb } from "./support/fakeDb.ts";
import { pgDb } from "./support/pgDb.ts";

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
  const calls: { address: Address; functionName: string; args: readonly unknown[]; blockNumber?: bigint; cache?: string }[] = [];
  return {
    calls,
    readContract: async (input: (typeof calls)[number]) => {
      calls.push(input);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

describe("chain reads for history skipped by START_BLOCK_FLOOR", () => {
  describe("PoolListed", () => {
    describe("positive", () => {
      it("loads and validates a missing PoolKey", async () => {
        const { db, rows } = fakeDb();
        const client = reader([key]);
        assert.equal(poolId, "0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551");
        await onPoolListed(db, chain()({ poolId, tier: 1, params: terms }), client as never);
        assert.deepEqual(
          (({ currency0, currency1, fee, tickSpacing, hooks }) => ({ currency0, currency1, fee, tickSpacing, hooks }))(
            rows(schema.pool)[0] as typeof key,
          ),
          key,
        );
        assert.deepEqual(client.calls[0]?.args, [`0x${poolId.slice(2, 52)}`]);
        assert.equal(client.calls[0]?.address, UNISWAP.positionManager.address);
        assert.equal(client.calls[0]?.cache, "immutable");
        assert.equal(client.calls[0]?.blockNumber, undefined);
        assert.deepEqual(rows(schema.uniswapPool), []);
      });

      it("serves the recovered key from the pools API", async () => {
        const { db, rows } = fakeDb();
        await onPoolListed(db, chain()({ poolId, tier: 1, params: terms }), reader([key]) as never);
        const app = createApp(await pgDb(rows), schema);
        const response = await app.request(`/pools/${poolId}`);
        assert.equal(response.status, 200);
        const body = (await response.json()) as Record<string, unknown>;
        assert.equal(body.currency0, zeroAddress);
        assert.equal(String(body.currency1).toLowerCase(), USDG);
        assert.equal(body.fee, 8_388_608);
        assert.equal(body.tickSpacing, 10);
        assert.equal(String(body.hooks).toLowerCase(), HOOK);
      });
    });

    describe("negative", () => {
      it("rejects a PoolKey whose hash differs from the listing", async () => {
        const { db } = fakeDb();
        const client = reader([{ ...key, fee: 500 }]);
        await assert.rejects(onPoolListed(db, chain()({ poolId, tier: 1, params: terms }), client as never), /hash/);
      });
    });

    describe("edge case", () => {
      it("leaves an empty PositionManager key null without failing", async () => {
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
  });

  describe("CollateralDeposited", () => {
    describe("positive", () => {
      it("rebuilds a missing position and later liquidity events update it", async () => {
        const { db, rows } = fakeDb();
        const tokenId = 42n;
        const packedInfo =
          (BigInt(poolId) & (((1n << 200n) - 1n) << 56n)) |
          (120n << 32n) |
          (BigInt.asUintN(24, -120n) << 8n);
        const depositor = "0x00000000000000000000000000000000000000ab" as Address;
        const deposit = chain()({ tokenId, owner: depositor, poolId }, MARKET);
        const client = reader([[key, packedInfo], 9_000n]);
        await onCollateralDeposited(db, deposit, client as never);
        assert.deepEqual(client.calls.map((call) => call.functionName), ["getPoolAndPositionInfo", "getPositionLiquidity"]);
        assert.ok(client.calls.every((call) => call.address === UNISWAP.positionManager.address));
        assert.ok(client.calls.every((call) => call.blockNumber === undefined));
        assert.equal(rows(schema.position)[0]?.poolId, poolId);
        assert.equal(rows(schema.position)[0]?.owner, MARKET);
        assert.equal(rows(schema.loan)[0]?.owner, depositor);
        assert.equal(rows(schema.position)[0]?.tickLower, -120);
        assert.equal(rows(schema.position)[0]?.tickUpper, 120);
        assert.equal(rows(schema.position)[0]?.liquidity, 9_000n);
        assert.equal(rows(schema.position)[0]?.mintedBlock, null);
        assert.equal(rows(schema.position)[0]?.mintedAt, null);
        assert.equal(rows(schema.position)[0]?.recoveredBlock, deposit.block.number);

        const sender = MANAGER;
        await onModifyLiquidity(
          db,
          {
            ...deposit,
            args: {
              id: poolId,
              sender,
              tickLower: -120,
              tickUpper: 120,
              liquidityDelta: 300n,
              salt: `0x${tokenId.toString(16).padStart(64, "0")}` as Hex,
            },
          },
        );
        assert.equal(rows(schema.position)[0]?.liquidity, 9_000n);
        await onModifyLiquidity(
          db,
          {
            ...chain()({
              id: poolId,
              sender,
              tickLower: -120,
              tickUpper: 120,
              liquidityDelta: 300n,
              salt: `0x${tokenId.toString(16).padStart(64, "0")}` as Hex,
            }),
            block: { number: deposit.block.number + 1n, timestamp: deposit.block.timestamp + 1n },
          },
        );
        assert.equal(rows(schema.position)[0]?.liquidity, 9_300n);
      });

      it("rejects empty position info when the PoolKey matches", async () => {
        const { db } = fakeDb();
        const client = reader([[key, 0n]]);
        await assert.rejects(
          onCollateralDeposited(db, chain()({ tokenId: 45n, owner: MARKET, poolId }, MARKET), client as never),
          /empty position info/,
        );
        assert.equal(client.calls.length, 1);
      });
    });

    describe("negative", () => {
      it("rejects a position whose stored key belongs to another pool", async () => {
        const { db } = fakeDb();
        const tokenId = 44n;
        const otherPoolId = poolIdOf({ ...key, fee: 500 });
        const client = reader([[key, 1n], 1n]);
        await assert.rejects(
          onCollateralDeposited(db, chain()({ tokenId, owner: MARKET, poolId: otherPoolId }, MARKET), client as never),
          /not/,
        );
        assert.equal(client.calls.length, 1);
      });
    });

    describe("edge case", () => {
      it("keeps the loan and continues when the deposit block is outside RPC history", async () => {
        const { db, rows } = fakeDb();
        const tokenId = 46n;
        const client = reader([new Error("historical state 0xad46 is not available")]);
        const warn = console.warn;
        const warnings: string[] = [];
        console.warn = (...values: unknown[]) => warnings.push(values.join(" "));
        try {
          await onCollateralDeposited(db, chain()({ tokenId, owner: MARKET, poolId }, MARKET), client as never);
        } finally {
          console.warn = warn;
        }
        assert.equal(warnings.length, 1);
        assert.equal(rows(schema.position).length, 0);
        assert.equal(rows(schema.loan).length, 1);
        assert.match(warnings[0] ?? "", /tokenId 46 at block 101/);
      });

      it("propagates position read failures other than unavailable historical state", async () => {
        const { db } = fakeDb();
        const client = reader([new Error("execution reverted")]);
        await assert.rejects(
          onCollateralDeposited(db, chain()({ tokenId: 47n, owner: MARKET, poolId }, MARKET), client as never),
          /execution reverted/,
        );
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
    });
  });
});
