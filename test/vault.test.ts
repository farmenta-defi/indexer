import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, zeroAddress, type Address } from "viem";

import * as schema from "../ponder.schema.ts";
import { onDeposit, onShareTransfer, onWithdraw } from "../src/handlers/vault.ts";
import { blockOf, chain, logIndexOf, nextLog, timeOf, txOf } from "./support/events.ts";
import { fakeDb } from "./support/fakeDb.ts";

const MARKET: Address = "0x00000000000000000000000000000000000b10e0";
const OTHER_MARKET: Address = "0x000000000000000000000000000000000000e3e0";
const ALICE: Address = "0x00000000000000000000000000000000000a11ce";
const BOB: Address = "0x0000000000000000000000000000000000000b0b";
const ROUTER: Address = "0x0000000000000000000000000000000000000123";

/** Log `offset` of the transaction opened by event `n`. */
const logRow = (n: number, offset = 0, market: Address = MARKET) => ({
  market,
  blockNumber: blockOf(n),
  logIndex: logIndexOf(n) + offset,
  timestamp: timeOf(n),
  transactionHash: txOf(n),
});

/** Event 1, one transaction: a router deposits 1000 USDG for Alice, who gets 990 shares. */
async function depositedForAlice() {
  const store = fakeDb();
  const at = chain();
  const mint = at({ from: zeroAddress, to: ALICE, value: 990n }, MARKET);
  await onShareTransfer(store.db, mint);
  await onDeposit(store.db, nextLog(mint, { sender: getAddress(ROUTER), owner: getAddress(ALICE), assets: 1_000n, shares: 990n }));
  return { ...store, at };
}

describe("vault handlers", () => {
  describe("positive", () => {
    it("a deposit: one activity row, and the minted shares on the owner's balance", async () => {
      const { rows } = await depositedForAlice();

      assert.deepEqual(rows(schema.vaultActivity), [
        { ...logRow(1, 1), kind: "deposit", sender: ROUTER, owner: ALICE, receiver: null, assetsUsdg: 1_000n, shares: 990n },
      ]);
      assert.deepEqual(rows(schema.vaultBalance), [{ market: MARKET, account: ALICE, shares: 990n, updatedAt: timeOf(1) }]);
    });

    it("a withdrawal: the burned shares leave the owner, the USDG goes to the receiver", async () => {
      const { db, rows, at } = await depositedForAlice();
      const burn = at({ from: ALICE, to: zeroAddress, value: 400n }, MARKET);
      await onShareTransfer(db, burn);
      await onWithdraw(
        db,
        nextLog(burn, { sender: getAddress(ALICE), receiver: getAddress(BOB), owner: getAddress(ALICE), assets: 410n, shares: 400n }),
      );

      assert.deepEqual(rows(schema.vaultActivity).at(-1), {
        ...logRow(2, 1),
        kind: "withdraw",
        sender: ALICE,
        owner: ALICE,
        receiver: BOB,
        assetsUsdg: 410n,
        shares: 400n,
      });
      assert.deepEqual(rows(schema.vaultBalance), [{ market: MARKET, account: ALICE, shares: 590n, updatedAt: timeOf(2) }]);
    });

    it("a share transfer moves both balances and is an activity of its own", async () => {
      const { db, rows, at } = await depositedForAlice();
      await onShareTransfer(db, at({ from: getAddress(ALICE), to: getAddress(BOB), value: 90n }, MARKET));

      assert.deepEqual(rows(schema.vaultActivity).at(-1), {
        ...logRow(2),
        kind: "transfer",
        sender: null,
        owner: ALICE,
        receiver: BOB,
        assetsUsdg: null,
        shares: 90n,
      });
      assert.deepEqual(rows(schema.vaultBalance), [
        { market: MARKET, account: BOB, shares: 90n, updatedAt: timeOf(2) },
        { market: MARKET, account: ALICE, shares: 900n, updatedAt: timeOf(2) },
      ]);
    });

    it("balances are per market", async () => {
      const { db, rows, at } = await depositedForAlice();
      await onShareTransfer(db, at({ from: zeroAddress, to: ALICE, value: 5n }, OTHER_MARKET));

      assert.deepEqual(rows(schema.vaultBalance), [
        { market: OTHER_MARKET, account: ALICE, shares: 5n, updatedAt: timeOf(2) },
        { market: MARKET, account: ALICE, shares: 990n, updatedAt: timeOf(1) },
      ]);
    });
  });

  describe("negative", () => {
    it("refuses a transfer of more shares than the sender holds", async () => {
      const { db, at } = await depositedForAlice();
      await assert.rejects(onShareTransfer(db, at({ from: ALICE, to: BOB, value: 991n }, MARKET)), /would hold -1/);
      await assert.rejects(onShareTransfer(db, at({ from: BOB, to: ALICE, value: 1n }, MARKET)), /would hold -1/);
    });

    it("the zero address holds no balance, and a mint or a burn is not a transfer activity", async () => {
      const { db, rows, at } = await depositedForAlice();
      await onShareTransfer(db, at({ from: ALICE, to: zeroAddress, value: 990n }, MARKET));

      assert.deepEqual(rows(schema.vaultBalance), [{ market: MARKET, account: ALICE, shares: 0n, updatedAt: timeOf(2) }]);
      assert.deepEqual(
        rows(schema.vaultActivity).map((row) => row.kind),
        ["deposit"],
      );
    });
  });

  describe("edge case", () => {
    it("a transfer to oneself leaves the balance as it was", async () => {
      const { db, rows, at } = await depositedForAlice();
      await onShareTransfer(db, at({ from: ALICE, to: ALICE, value: 990n }, MARKET));
      assert.deepEqual(rows(schema.vaultBalance), [{ market: MARKET, account: ALICE, shares: 990n, updatedAt: timeOf(2) }]);
    });

    it("a transfer of zero shares still leaves a row for the receiver", async () => {
      const { db, rows, at } = await depositedForAlice();
      await onShareTransfer(db, at({ from: ALICE, to: BOB, value: 0n }, MARKET));
      assert.deepEqual(rows(schema.vaultBalance)[0], { market: MARKET, account: BOB, shares: 0n, updatedAt: timeOf(2) });
    });
  });
});
