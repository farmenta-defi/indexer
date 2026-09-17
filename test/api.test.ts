import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { getAddress, numberToHex, zeroAddress, type Address, type Hex } from "viem";

import { UNISWAP } from "../config/uniswap.ts";
import * as schema from "../ponder.schema.ts";
import { createApp } from "../src/api/app.ts";
import { onPoolListed } from "../src/handlers/collateralPolicy.ts";
import { onBorrow, onCollateralDeposited, onCollateralWithdrawn, onRepay } from "../src/handlers/farmentaMarket.ts";
import { onModifyLiquidity } from "../src/handlers/poolManager.ts";
import { onTransfer } from "../src/handlers/positionManager.ts";
import { onShareTransfer } from "../src/handlers/vault.ts";
import { blockOf, chain, timeOf } from "./support/events.ts";
import { fakeDb } from "./support/fakeDb.ts";
import { pgDb } from "./support/pgDb.ts";

// The routes against a real Postgres (test/support/pgDb.ts), filled with the rows the
// handlers wrote for the events below: events in, JSON out.

const BLUE_CHIP: Address = "0x00000000000000000000000000000000000b10e0";
const MEME: Address = "0x000000000000000000000000000000000000e3e0";
const ALICE: Address = "0x00000000000000000000000000000000000a11ce";
const BOB: Address = "0x0000000000000000000000000000000000000b0b";
const BLUE_POOL: Hex = "0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982";
const MEME_POOL: Hex = "0xc6451046bf06c20295032cf6e05e85bb1ca35fd7aebaf30c59c33350fe3c776e";
const UNLISTED_POOL: Hex = "0x54f7883914619af9105355bf83ed678bcf9f63560218ac61c9963b9503d0ba32";

const TERMS = {
  maxLtvBps: 6500,
  ltBps: 7500,
  liquidatorBonusBps: 500,
  removeHaircutBps: 0,
  debtCapUsdg: 500_000_000_000n,
  minPositionUsd: 50n * 10n ** 18n,
};

let app: ReturnType<typeof createApp>;
const get = async (path: string) => {
  const response = await app.request(path);
  return { status: response.status, body: (await response.json()) as any };
};

before(async () => {
  const { db, rows } = fakeDb();
  const at = chain();
  const mint = async (tokenId: bigint, to: Address, id: Hex) => {
    await onTransfer(db, at({ from: zeroAddress, to, tokenId }));
    const salt = numberToHex(tokenId, { size: 32 });
    const sender = UNISWAP.positionManager.address;
    await onModifyLiquidity(db, at({ id, sender, tickLower: -120, tickUpper: 120, liquidityDelta: 1_000n * tokenId, salt }));
  };
  const deposit = async (tokenId: bigint, owner: Address, market: Address) => {
    await onTransfer(db, at({ from: owner, to: market, tokenId }));
    await onCollateralDeposited(db, at({ tokenId, owner }, market));
  };

  await onPoolListed(db, at({ poolId: BLUE_POOL, tier: 1, params: TERMS })); // 1
  await onPoolListed(db, at({ poolId: MEME_POOL, tier: 2, params: TERMS })); // 2

  // Alice: 1, 2 and 3 in her wallet, then 2 goes to Bob. (3 to 9)
  await mint(1n, ALICE, UNLISTED_POOL);
  await mint(2n, ALICE, UNLISTED_POOL);
  await mint(3n, ALICE, BLUE_POOL);
  await onTransfer(db, at({ from: ALICE, to: BOB, tokenId: 2n }));

  // Meme loans. 11: borrowed, in custody. 12: never borrowed. 13: borrowed, repaid, withdrawn.
  // 14: borrowed and repaid in full, still in custody. (10 to 32)
  for (const tokenId of [11n, 12n, 13n, 14n]) await mint(tokenId, ALICE, MEME_POOL);
  for (const tokenId of [11n, 12n, 13n, 14n]) await deposit(tokenId, ALICE, MEME);
  await onBorrow(db, at({ tokenId: 11n, amount: 5_000_000n }, MEME));
  await onBorrow(db, at({ tokenId: 13n, amount: 5_000_000n }, MEME));
  await onRepay(db, at({ tokenId: 13n, amount: 5_000_001n }, MEME));
  await onCollateralWithdrawn(db, at({ tokenId: 13n, owner: ALICE }, MEME));
  await onTransfer(db, at({ from: MEME, to: ALICE, tokenId: 13n }));
  await onBorrow(db, at({ tokenId: 14n, amount: 7_000_000n }, MEME));
  await onRepay(db, at({ tokenId: 14n, amount: 7_000_002n }, MEME));

  // A blue-chip loan that borrowed: Bob's 21. (33 to 37)
  await mint(21n, BOB, BLUE_POOL);
  await deposit(21n, BOB, BLUE_CHIP);
  await onBorrow(db, at({ tokenId: 21n, amount: 9_000_000n }, BLUE_CHIP));

  // Alice lends on both markets, and hands some meme shares to Bob. (38 to 40)
  await onShareTransfer(db, at({ from: zeroAddress, to: ALICE, value: 990n }, BLUE_CHIP));
  await onShareTransfer(db, at({ from: zeroAddress, to: ALICE, value: 500n }, MEME));
  await onShareTransfer(db, at({ from: ALICE, to: BOB, value: 120n }, MEME));

  app = createApp(await pgDb(rows), schema);
});

const tokenIds = (loans: { tokenId: string }[]) => loans.map((loan) => loan.tokenId);

describe("api", () => {
  describe("positive", () => {
    it("/loans/keeper-candidates: meme pool, still in custody, ever borrowed; nothing else", async () => {
      const { status, body } = await get("/loans/keeper-candidates");
      assert.equal(status, 200);
      // Not 12 (never borrowed), not 13 (withdrawn), not 21 (blue-chip). 14 is repaid in full
      // and still listed: events cannot tell, which is why the keeper confirms with `debtOf`.
      assert.deepEqual(tokenIds(body), ["11", "14"]);
    });

    it("a loan comes with its position's range and liquidity and its pool's tier, every column", async () => {
      const { body } = await get("/loans/keeper-candidates");
      assert.deepEqual(body[0], {
        market: MEME,
        tokenId: "11",
        owner: ALICE,
        poolId: MEME_POOL,
        status: "in_custody",
        everBorrowed: true,
        borrowedUsdg: "5000000",
        repaidUsdg: "0",
        liquidatedUsdg: "0",
        depositedBlock: blockOf(19).toString(),
        depositedAt: timeOf(19).toString(),
        lastActivityAt: timeOf(26).toString(),
        closedAt: null,
        tickLower: -120,
        tickUpper: 120,
        liquidity: "11000",
        tier: 2,
      });
    });

    it("/portfolio: an address with 3 NFTs that moved one away holds 2, plus what the markets hold for it", async () => {
      const { status, body } = await get(`/portfolio/${ALICE}`);
      assert.equal(status, 200);
      assert.equal(body.address, ALICE);
      // 13 came back from the market, so it is in the wallet again and no longer a loan.
      assert.deepEqual(tokenIds(body.positions), ["1", "3", "13"]);
      assert.deepEqual(tokenIds(body.loans), ["11", "12", "14"]);

      assert.deepEqual(body.vaultShares, [
        { market: MEME, account: ALICE, shares: "380", updatedAt: timeOf(40).toString() },
        { market: BLUE_CHIP, account: ALICE, shares: "990", updatedAt: timeOf(38).toString() },
      ]);

      const bob = await get(`/portfolio/${BOB}`);
      assert.deepEqual(tokenIds(bob.body.positions), ["2"]);
      assert.deepEqual(tokenIds(bob.body.loans), ["21"]);
    });

    it("/loans filters by owner, market and status, in market and tokenId order", async () => {
      // MEME (0x…00e3e0) sorts before BLUE_CHIP (0x…0b10e0).
      assert.deepEqual(tokenIds((await get("/loans")).body), ["11", "12", "13", "14", "21"]);
      assert.deepEqual(tokenIds((await get("/loans?status=in_custody")).body), ["11", "12", "14", "21"]);
      assert.deepEqual(tokenIds((await get(`/loans?market=${MEME}&status=withdrawn`)).body), ["13"]);
      assert.deepEqual(tokenIds((await get(`/loans?owner=${BOB}`)).body), ["21"]);
    });

    it("an address is accepted in any case", async () => {
      assert.deepEqual(tokenIds((await get(`/loans?owner=${getAddress(BOB)}`)).body), ["21"]);
      assert.deepEqual(tokenIds((await get(`/portfolio/${getAddress(BOB)}`)).body.positions), ["2"]);
    });

    it("/pools still lists the pools, with the fields that depend on `t`", async () => {
      const { status, body } = await get("/pools?t=2000000");
      assert.equal(status, 200);
      assert.deepEqual(
        body.map((pool: any) => ({ id: pool.id, tier: pool.tier, t: pool.t, effectiveLtBps: pool.effectiveLtBps })).sort(byId),
        [
          { id: BLUE_POOL, tier: 1, t: "2000000", effectiveLtBps: 7500 },
          { id: MEME_POOL, tier: 2, t: "2000000", effectiveLtBps: 7500 },
        ].sort(byId),
      );
      assert.equal((await get(`/pools/${MEME_POOL}`)).body.tier, 2);
    });
  });

  describe("negative", () => {
    it("400 for a malformed address, status, pool id or time", async () => {
      for (const path of [
        "/loans?owner=0x123",
        "/loans?market=alice",
        "/loans?status=open",
        "/portfolio/0x123",
        `/portfolio/${zeroAddress}`,
        "/pools?t=now",
        "/pools/0x1234",
      ]) {
        const { status, body } = await get(path);
        assert.equal(status, 400, path);
        assert.equal(typeof body.error, "string", path);
      }
    });

    it("404 for a pool that is not listed", async () => {
      assert.equal((await get(`/pools/${UNLISTED_POOL}`)).status, 404);
    });
  });

  describe("edge case", () => {
    it("an address nobody has seen has an empty portfolio, not a 404", async () => {
      const { status, body } = await get(`/portfolio/${zeroAddress.replace(/0$/, "1")}`);
      assert.equal(status, 200);
      assert.deepEqual(
        { positions: body.positions, loans: body.loans, vaultShares: body.vaultShares },
        { positions: [], loans: [], vaultShares: [] },
      );
    });
  });
});

const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
