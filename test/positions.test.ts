import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, numberToHex, zeroAddress, type Address, type Hex } from "viem";

import { UNISWAP } from "../config/uniswap.ts";
import * as schema from "../ponder.schema.ts";
import { onModifyLiquidity } from "../src/handlers/poolManager.ts";
import { onTransfer } from "../src/handlers/positionManager.ts";
import { blockOf, chain, logIndexOf, timeOf, txOf } from "./support/events.ts";
import { fakeDb } from "./support/fakeDb.ts";

const POSITION_MANAGER = UNISWAP.positionManager.address;
const ROUTER: Address = "0x8876789976decbfcbbbe364623c63652db8c0904";
const ALICE: Address = "0x00000000000000000000000000000000000a11ce";
const BOB: Address = "0x0000000000000000000000000000000000000b0b";
// ETH/USDG fee 500 and fee 460 on Robinhood Chain (spec §18). Neither is listed here: the
// position tables do not depend on a listing.
const POOL: Hex = "0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982";
const OTHER_POOL: Hex = "0x54f7883914619af9105355bf83ed678bcf9f63560218ac61c9963b9503d0ba32";

const saltOf = (tokenId: bigint) => numberToHex(tokenId, { size: 32 });
const mint = (tokenId: bigint, to: Address) => ({ from: zeroAddress, to, tokenId });
const modify = (tokenId: bigint, liquidityDelta: bigint, sender: Address = POSITION_MANAGER) => ({
  id: POOL,
  sender,
  tickLower: -198_020,
  tickUpper: -197_970,
  liquidityDelta,
  salt: saltOf(tokenId),
});

const transferRow = (n: number, tokenId: bigint, from: Address, to: Address) => ({
  tokenId,
  blockNumber: blockOf(n),
  logIndex: logIndexOf(n),
  timestamp: timeOf(n),
  transactionHash: txOf(n),
  from,
  to,
});

describe("position handlers", () => {
  describe("positive", () => {
    it("a mint is `Transfer` then `ModifyLiquidity`: owner, pool, ticks and liquidity", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onTransfer(db, at(mint(7n, ALICE)));
      await onModifyLiquidity(db, at(modify(7n, 1_000n)));

      assert.deepEqual(rows(schema.position), [
        {
          tokenId: 7n,
          owner: ALICE,
          poolId: POOL,
          tickLower: -198_020,
          tickUpper: -197_970,
          liquidity: 1_000n,
          burned: false,
          mintedBlock: blockOf(1),
          mintedAt: timeOf(1),
          updatedAt: timeOf(2),
        },
      ]);
      assert.deepEqual(rows(schema.positionTransfer), [transferRow(1, 7n, zeroAddress, ALICE)]);
    });

    it("liquidity is the sum of every delta, as `getPositionLiquidity` reports it", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onTransfer(db, at(mint(7n, ALICE)));
      await onModifyLiquidity(db, at(modify(7n, 1_000n)));
      await onModifyLiquidity(db, at(modify(7n, 250n)));
      await onModifyLiquidity(db, at(modify(7n, -400n)));
      await onModifyLiquidity(db, at(modify(7n, 0n))); // a fee collection

      const { liquidity, updatedAt } = rows(schema.position)[0] as { liquidity: bigint; updatedAt: bigint };
      assert.deepEqual({ liquidity, updatedAt }, { liquidity: 850n, updatedAt: timeOf(5) });
    });

    it("an address with 3 NFTs that moves one away holds 2", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      for (const tokenId of [1n, 2n, 3n]) {
        await onTransfer(db, at(mint(tokenId, ALICE)));
        await onModifyLiquidity(db, at(modify(tokenId, 1_000n)));
      }
      await onTransfer(db, at({ from: ALICE, to: BOB, tokenId: 2n }));

      const heldBy = (owner: Address) =>
        rows(schema.position)
          .filter((row) => row.owner === owner)
          .map((row) => row.tokenId);
      assert.deepEqual(heldBy(ALICE), [1n, 3n]);
      assert.deepEqual(heldBy(BOB), [2n]);
      // A plain transfer moves `updatedAt` too; the mint of 2 was events 3 and 4.
      assert.equal(rows(schema.position).find((row) => row.tokenId === 2n)?.updatedAt, timeOf(7));
      assert.deepEqual(
        rows(schema.positionTransfer).filter((row) => row.tokenId === 2n),
        [transferRow(3, 2n, zeroAddress, ALICE), transferRow(7, 2n, ALICE, BOB)],
      );
    });

    it("addresses are stored lowercase, however the event spells them", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onTransfer(db, at(mint(7n, getAddress(ALICE))));
      await onModifyLiquidity(db, at(modify(7n, 1_000n, getAddress(POSITION_MANAGER))));
      await onTransfer(db, at({ from: getAddress(ALICE), to: getAddress(BOB), tokenId: 7n }));

      const { owner, liquidity } = rows(schema.position)[0] as { owner: Address; liquidity: bigint };
      assert.deepEqual({ owner, liquidity }, { owner: BOB, liquidity: 1_000n });
      assert.deepEqual(rows(schema.positionTransfer), [
        transferRow(1, 7n, zeroAddress, ALICE),
        transferRow(3, 7n, ALICE, BOB),
      ]);
    });
  });

  describe("negative", () => {
    it("liquidity from another sender is not a position, even with a tokenId as salt", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onTransfer(db, at(mint(7n, ALICE)));
      await onModifyLiquidity(db, at(modify(7n, 1_000n)));
      await onModifyLiquidity(db, at(modify(7n, 999n, ROUTER)));

      const { liquidity, updatedAt } = rows(schema.position)[0] as { liquidity: bigint; updatedAt: bigint };
      assert.deepEqual({ liquidity, updatedAt }, { liquidity: 1_000n, updatedAt: timeOf(2) });
    });

    it("refuses a `ModifyLiquidity` whose pool or range differs from the mint", async () => {
      const { db } = fakeDb();
      const at = chain();
      await onTransfer(db, at(mint(7n, ALICE)));
      await onModifyLiquidity(db, at(modify(7n, 1_000n)));

      await assert.rejects(onModifyLiquidity(db, at({ ...modify(7n, 1n), id: OTHER_POOL })), /pool or range differs/);
      await assert.rejects(onModifyLiquidity(db, at({ ...modify(7n, 1n), tickLower: -198_030 })), /pool or range differs/);
      await assert.rejects(onModifyLiquidity(db, at({ ...modify(7n, 1n), tickUpper: -197_960 })), /pool or range differs/);
    });

    it("refuses a removal larger than the position", async () => {
      const { db } = fakeDb();
      const at = chain();
      await onTransfer(db, at(mint(7n, ALICE)));
      await onModifyLiquidity(db, at(modify(7n, 1_000n)));
      await assert.rejects(onModifyLiquidity(db, at(modify(7n, -1_001n))), /liquidity would be -1/);
    });
  });

  describe("edge case", () => {
    it("a burn is `Transfer` to zero, then the removal: the row stays, empty and burned", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onTransfer(db, at(mint(7n, ALICE)));
      await onModifyLiquidity(db, at(modify(7n, 1_000n)));
      await onTransfer(db, at({ from: ALICE, to: zeroAddress, tokenId: 7n }));
      await onModifyLiquidity(db, at(modify(7n, -1_000n)));

      assert.deepEqual(rows(schema.position), [
        {
          tokenId: 7n,
          owner: zeroAddress,
          poolId: POOL,
          tickLower: -198_020,
          tickUpper: -197_970,
          liquidity: 0n,
          burned: true,
          mintedBlock: blockOf(1),
          mintedAt: timeOf(1),
          updatedAt: timeOf(4),
        },
      ]);
    });

    it("between a mint's `Transfer` and its `ModifyLiquidity` the pool and ticks are null", async () => {
      const { db, rows } = fakeDb();
      await onTransfer(db, chain()(mint(7n, ALICE)));
      const { poolId, tickLower, tickUpper, liquidity } = rows(schema.position)[0] as Record<string, unknown>;
      assert.deepEqual({ poolId, tickLower, tickUpper, liquidity }, { poolId: null, tickLower: null, tickUpper: null, liquidity: 0n });
    });

    it("a position whose mint was never seen (START_BLOCK_FLOOR) stays unknown", async () => {
      const { db, rows } = fakeDb();
      const at = chain();
      await onTransfer(db, at({ from: ALICE, to: BOB, tokenId: 7n }));
      await onModifyLiquidity(db, at(modify(7n, -400n)));

      assert.deepEqual(rows(schema.position), []);
      assert.deepEqual(rows(schema.positionTransfer), []);
    });
  });
});
