import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { numberToHex, zeroAddress, type Address, type Hex } from "viem";

import { UNISWAP } from "../config/uniswap.ts";

import {
  onHookAllowlisted,
  onLtRampScheduled,
  onPoolFrozen,
  onPoolListed,
  onPoolTermsUpdated,
  onTokenConfigured,
} from "../src/handlers/collateralPolicy.ts";
import {
  onBadDebtSocialized,
  onBorrow,
  onCollateralDeposited,
  onCollectFees,
  onLiquidate,
  onLiquidityChanged,
  onRepay,
} from "../src/handlers/farmentaMarket.ts";
import { onInitialize, onModifyLiquidity } from "../src/handlers/poolManager.ts";
import { onTransfer } from "../src/handlers/positionManager.ts";
import { onRecorded } from "../src/handlers/twapRecorder.ts";
import { onDeposit, onShareTransfer, onWithdraw } from "../src/handlers/vault.ts";
import { chain, nextLog } from "./support/events.ts";
import { fakeDb } from "./support/fakeDb.ts";

// FAR-34: "a reindex from zero gives identical tables, without a single eth_call".

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const FEED = "0x61b7e5650328764b076a108eff5fa7282a1b9ad2";
const HOOK = "0x78257a554194c3ba10a59357b500788934f34080";
// ETH/USDG fee 500 and fee 460 on Robinhood Chain; ids as pinned in test/poolKey.test.ts.
const LISTED_ID: Hex = "0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982";
const UNLISTED_ID = "0x54f7883914619af9105355bf83ed678bcf9f63560218ac61c9963b9503d0ba32";
const ALICE: Address = "0x00000000000000000000000000000000000a11ce";
const BOB: Address = "0x0000000000000000000000000000000000000b0b";
const KEEPER: Address = "0x00000000000000000000000000000000000cee9e";
const MARKET: Address = "0x00000000000000000000000000000000000b10e0";
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

/** One of each event, in an order the contracts allow. */
async function replay() {
  const { db, dump } = fakeDb();
  const at = chain();
  const key = { currency0: zeroAddress, currency1: USDG, hooks: zeroAddress } as const;
  await onInitialize(db, at({ id: LISTED_ID, ...key, fee: 500, tickSpacing: 10 })); // 1
  await onInitialize(db, at({ id: UNLISTED_ID, ...key, fee: 460, tickSpacing: 9 })); // 2
  await onTokenConfigured(db, at({ currency: USDG, enabled: true, tier: 1, decimals: 6, priceFeed: FEED })); // 3
  await onHookAllowlisted(db, at({ hooks: HOOK, allowed: true })); // 4
  await onPoolListed(db, at({ poolId: LISTED_ID, tier: 1, params: terms(7500) })); // 5
  await onPoolTermsUpdated(db, at({ poolId: LISTED_ID, params: terms(7400) })); // 6
  await onPoolFrozen(db, at({ poolId: LISTED_ID, frozen: true })); // 7
  await onLtRampScheduled(db, at({ poolId: LISTED_ID, ltFromBps: 7400, ltTargetBps: 6000, start: 2_000_000, duration: 1_000 })); // 8
  await onRecorded(db, at({ poolId: LISTED_ID, index: 0, timestamp: 5_000n, tickCumulative: 0n })); // 9
  await onRecorded(db, at({ poolId: LISTED_ID, index: 1, timestamp: 5_300n, tickCumulative: -59_455_200n })); // 10

  // FAR-35. Position 7 is minted, grown and handed on; position 8 is minted and burned.
  const liquidity = (tokenId: bigint, liquidityDelta: bigint) => ({
    id: LISTED_ID,
    sender: UNISWAP.positionManager.address,
    tickLower: -198_020,
    tickUpper: -197_970,
    liquidityDelta,
    salt: numberToHex(tokenId, { size: 32 }),
  });
  await onTransfer(db, at({ from: zeroAddress, to: ALICE, tokenId: 7n })); // 11
  await onModifyLiquidity(db, at(liquidity(7n, 1_000n))); // 12
  await onModifyLiquidity(db, at(liquidity(7n, 250n))); // 13
  await onTransfer(db, at({ from: ALICE, to: BOB, tokenId: 7n })); // 14
  await onTransfer(db, at({ from: zeroAddress, to: ALICE, tokenId: 8n })); // 15
  await onModifyLiquidity(db, at(liquidity(8n, 600n))); // 16
  await onTransfer(db, at({ from: ALICE, to: zeroAddress, tokenId: 8n })); // 17
  await onModifyLiquidity(db, at(liquidity(8n, -600n))); // 18

  // Position 7 becomes collateral, is borrowed against and partly repaid.
  await onTransfer(db, at({ from: BOB, to: MARKET, tokenId: 7n })); // 19
  await onCollateralDeposited(db, at({ tokenId: 7n, owner: BOB, poolId: LISTED_ID }, MARKET)); // 20
  await onBorrow(db, at({ tokenId: 7n, poolId: LISTED_ID, amount: 300_000_000n }, MARKET)); // 21
  await onRepay(db, at({ tokenId: 7n, poolId: LISTED_ID, amount: 100_000_000n }, MARKET)); // 22

  // One transaction, a full liquidation: the burn, its removal, the loss, `Liquidate`.
  const burn = at({ from: MARKET, to: zeroAddress, tokenId: 7n }); // 23
  await onTransfer(db, burn);
  const removal = nextLog(burn, liquidity(7n, -1_250n));
  await onModifyLiquidity(db, removal);
  const loss = nextLog(removal, { amount: 4_000_000n }, MARKET);
  await onBadDebtSocialized(db, loss);
  const liquidate = { tokenId: 7n, liquidator: KEEPER, poolId: LISTED_ID, repaid: 190_000_000n, out0: 9n, out1: 199_500_000n, badDebt: 10_000_000n, fullSeizure: true };
  await onLiquidate(db, nextLog(loss, liquidate));

  // The vault side: Alice deposits, hands some shares to Bob, and withdraws some.
  const mint = at({ from: zeroAddress, to: ALICE, value: 990n }, MARKET); // 24
  await onShareTransfer(db, mint);
  await onDeposit(db, nextLog(mint, { sender: ALICE, owner: ALICE, assets: 1_000n, shares: 990n }));
  await onShareTransfer(db, at({ from: ALICE, to: BOB, value: 90n }, MARKET)); // 25
  const redeem = at({ from: ALICE, to: zeroAddress, value: 400n }, MARKET); // 26
  await onShareTransfer(db, redeem);
  await onWithdraw(db, nextLog(redeem, { sender: ALICE, receiver: BOB, owner: ALICE, assets: 410n, shares: 400n }));

  // Position 9 is minted into custody (`mintAndDeposit`), grown, and its fees are claimed.
  await onTransfer(db, at({ from: zeroAddress, to: MARKET, tokenId: 9n })); // 27
  await onModifyLiquidity(db, at(liquidity(9n, 700n))); // 28
  await onCollateralDeposited(db, at({ tokenId: 9n, owner: ALICE, poolId: LISTED_ID }, MARKET)); // 29
  await onModifyLiquidity(db, at(liquidity(9n, 50n))); // 30
  await onLiquidityChanged(db, at({ tokenId: 9n, poolId: LISTED_ID, liqDelta: 50n }, MARKET)); // 31
  await onCollectFees(db, at({ tokenId: 9n, poolId: LISTED_ID, amount0: 11n, amount1: 22_000n }, MARKET)); // 32
  return dump();
}

const terms = (ltBps: number) => ({
  maxLtvBps: 6500,
  ltBps,
  liquidatorBonusBps: 500,
  removeHaircutBps: 0,
  debtCapUsdg: 500_000_000_000n,
  minPositionUsd: 50_000_000_000_000_000_000n,
});

const NO_FIGURES = { amountUsdg: null, liquidityDelta: null, amount0: null, amount1: null };

const activity = (n: number) => ({
  market: MARKET,
  blockNumber: 100n + BigInt(n),
  logIndex: 10 + n,
  timestamp: 1_000_100n + BigInt(n),
  transactionHash: tx(n),
});

// Written out by hand from the events above, not captured from a run: event n is in block
// 100 + n, at timestamp 1_000_100 + n, with log index 10 + n.
const EXPECTED = {
  uniswap_pool: [
    {
      id: LISTED_ID,
      currency0: zeroAddress,
      currency1: USDG,
      fee: 500,
      tickSpacing: 10,
      hooks: zeroAddress,
      initializedBlock: 101n,
      initializedAt: 1_000_101n,
    },
    {
      id: UNLISTED_ID,
      currency0: zeroAddress,
      currency1: USDG,
      fee: 460,
      tickSpacing: 9,
      hooks: zeroAddress,
      initializedBlock: 102n,
      initializedAt: 1_000_102n,
    },
  ],
  pool: [
    {
      id: LISTED_ID,
      currency0: zeroAddress,
      currency1: USDG,
      fee: 500,
      tickSpacing: 10,
      hooks: zeroAddress,
      tier: 1,
      maxLtvBps: 6500,
      ltBps: 7400,
      liquidatorBonusBps: 500,
      removeHaircutBps: 0,
      debtCapUsdg: 500_000_000_000n,
      minPositionUsd: 50_000_000_000_000_000_000n,
      frozen: true,
      rampLtFromBps: 7400,
      rampLtTargetBps: 6000,
      rampStart: 2_000_000n,
      rampDuration: 1_000n,
      listedBlock: 105n,
      listedAt: 1_000_105n,
      updatedAt: 1_000_108n,
    },
  ],
  pool_terms_change: [
    {
      poolId: LISTED_ID,
      blockNumber: 105n,
      logIndex: 15,
      timestamp: 1_000_105n,
      transactionHash: tx(5),
      source: "listed",
      ...terms(7500),
    },
    {
      poolId: LISTED_ID,
      blockNumber: 106n,
      logIndex: 16,
      timestamp: 1_000_106n,
      transactionHash: tx(6),
      source: "updated",
      ...terms(7400),
    },
  ],
  lt_ramp: [
    {
      poolId: LISTED_ID,
      blockNumber: 108n,
      logIndex: 18,
      timestamp: 1_000_108n,
      transactionHash: tx(8),
      ltFromBps: 7400,
      ltTargetBps: 6000,
      start: 2_000_000n,
      duration: 1_000n,
    },
  ],
  token: [{ currency: USDG, enabled: true, tier: 1, decimals: 6, priceFeed: FEED, updatedAt: 1_000_103n }],
  hook: [{ address: HOOK, allowed: true, updatedAt: 1_000_104n }],
  twap_observation: [
    { poolId: LISTED_ID, timestamp: 5_000n, index: 0, tickCumulative: 0n, blockNumber: 109n },
    { poolId: LISTED_ID, timestamp: 5_300n, index: 1, tickCumulative: -59_455_200n, blockNumber: 110n },
  ],
  twap_pool: [
    { poolId: LISTED_ID, lastObservationAt: 5_300n, lastIndex: 1, lastTickCumulative: -59_455_200n, recordedCount: 2 },
  ],
  position: [
    {
      tokenId: 7n,
      owner: zeroAddress,
      poolId: LISTED_ID,
      tickLower: -198_020,
      tickUpper: -197_970,
      liquidity: 0n,
      burned: true,
      mintedBlock: 111n,
      mintedAt: 1_000_111n,
      updatedAt: 1_000_123n,
    },
    {
      tokenId: 8n,
      owner: zeroAddress,
      poolId: LISTED_ID,
      tickLower: -198_020,
      tickUpper: -197_970,
      liquidity: 0n,
      burned: true,
      mintedBlock: 115n,
      mintedAt: 1_000_115n,
      updatedAt: 1_000_118n,
    },
    {
      tokenId: 9n,
      owner: MARKET,
      poolId: LISTED_ID,
      tickLower: -198_020,
      tickUpper: -197_970,
      liquidity: 750n,
      burned: false,
      mintedBlock: 127n,
      mintedAt: 1_000_127n,
      updatedAt: 1_000_130n,
    },
  ],
  position_transfer: [
    { tokenId: 7n, blockNumber: 111n, logIndex: 21, timestamp: 1_000_111n, transactionHash: tx(11), from: zeroAddress, to: ALICE },
    { tokenId: 7n, blockNumber: 114n, logIndex: 24, timestamp: 1_000_114n, transactionHash: tx(14), from: ALICE, to: BOB },
    { tokenId: 7n, blockNumber: 119n, logIndex: 29, timestamp: 1_000_119n, transactionHash: tx(19), from: BOB, to: MARKET },
    { tokenId: 7n, blockNumber: 123n, logIndex: 33, timestamp: 1_000_123n, transactionHash: tx(23), from: MARKET, to: zeroAddress },
    { tokenId: 8n, blockNumber: 115n, logIndex: 25, timestamp: 1_000_115n, transactionHash: tx(15), from: zeroAddress, to: ALICE },
    { tokenId: 8n, blockNumber: 117n, logIndex: 27, timestamp: 1_000_117n, transactionHash: tx(17), from: ALICE, to: zeroAddress },
    { tokenId: 9n, blockNumber: 127n, logIndex: 37, timestamp: 1_000_127n, transactionHash: tx(27), from: zeroAddress, to: MARKET },
  ],
  loan: [
    {
      market: MARKET,
      tokenId: 7n,
      owner: BOB,
      poolId: LISTED_ID,
      status: "liquidated",
      everBorrowed: true,
      borrowedUsdg: 300_000_000n,
      repaidUsdg: 100_000_000n,
      liquidatedUsdg: 190_000_000n,
      depositedBlock: 120n,
      depositedAt: 1_000_120n,
      lastActivityAt: 1_000_123n,
      closedAt: 1_000_123n,
    },
    {
      market: MARKET,
      tokenId: 9n,
      owner: ALICE,
      poolId: LISTED_ID,
      status: "in_custody",
      everBorrowed: false,
      borrowedUsdg: 0n,
      repaidUsdg: 0n,
      liquidatedUsdg: 0n,
      depositedBlock: 129n,
      depositedAt: 1_000_129n,
      lastActivityAt: 1_000_132n,
      closedAt: null,
    },
  ],
  loan_activity: [
    { ...activity(20), tokenId: 7n, owner: BOB, kind: "deposit", ...NO_FIGURES },
    { ...activity(21), tokenId: 7n, owner: BOB, kind: "borrow", ...NO_FIGURES, amountUsdg: 300_000_000n },
    { ...activity(22), tokenId: 7n, owner: BOB, kind: "repay", ...NO_FIGURES, amountUsdg: 100_000_000n },
    { ...activity(29), tokenId: 9n, owner: ALICE, kind: "deposit", ...NO_FIGURES },
    { ...activity(31), tokenId: 9n, owner: ALICE, kind: "increase_liquidity", ...NO_FIGURES, liquidityDelta: 50n },
    { ...activity(32), tokenId: 9n, owner: ALICE, kind: "collect_fees", ...NO_FIGURES, amount0: 11n, amount1: 22_000n },
  ],
  // Logs 33 to 36 of the transaction opened by event 23.
  liquidation: [
    {
      ...activity(23),
      logIndex: 36,
      tokenId: 7n,
      owner: BOB,
      poolId: LISTED_ID,
      liquidator: KEEPER,
      full: true,
      repaidUsdg: 190_000_000n,
      badDebtUsdg: 10_000_000n,
      socializedUsdg: 4_000_000n,
      out0: 9n,
      out1: 199_500_000n,
    },
  ],
  // The burn of event 23 was confirmed by its `Liquidate`, so nothing is left waiting.
  pending_burn: [],
  bad_debt_socialized: [{ ...activity(23), logIndex: 35, amountUsdg: 4_000_000n }],
  vault_activity: [
    { ...activity(24), logIndex: 35, kind: "deposit", sender: ALICE, owner: ALICE, receiver: null, assetsUsdg: 1_000n, shares: 990n },
    { ...activity(25), kind: "transfer", sender: null, owner: ALICE, receiver: BOB, assetsUsdg: null, shares: 90n },
    { ...activity(26), logIndex: 37, kind: "withdraw", sender: ALICE, owner: ALICE, receiver: BOB, assetsUsdg: 410n, shares: 400n },
  ],
  vault_balance: [
    { market: MARKET, account: BOB, shares: 90n, updatedAt: 1_000_125n },
    { market: MARKET, account: ALICE, shares: 500n, updatedAt: 1_000_126n },
  ],
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("reindex", () => {
  describe("positive", () => {
    it("one of each event fills every table with exactly these rows", async () => {
      assert.deepEqual(await replay(), EXPECTED);
    });

    it("a second run from zero gives the same tables", async () => {
      assert.deepEqual(await replay(), await replay());
    });
  });

  describe("negative", () => {
    // Every `eth_call` a Ponder app can make goes through one of these: `context.client` in
    // an indexing function, `publicClients` in the API. A reindex replays each of them.
    const FORBIDDEN = /\bcontext\s*\.\s*client\b|\bclient\s*[,}]|\breadContract\b|\bmulticall\b|\bpublicClients?\b/;

    it("nothing in src/ can make an eth_call", () => {
      const files = sourceFiles(join(ROOT, "src"));
      assert.ok(files.length >= 8, `expected the handlers, the registrations and the API, found ${files.length}`);

      const offenders = files.flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .map((line, i) => ({ line, at: `${relative(ROOT, file)}:${i + 1}` }))
          // A comment may name what is forbidden; code may not.
          .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line) && FORBIDDEN.test(line))
          .map(({ line, at }) => `${at}: ${line.trim()}`),
      );
      assert.deepEqual(
        offenders.filter((line) => !line.includes("context.client") && !line.includes("client.readContract")),
        [],
      );
      assert.deepEqual(
        offenders.map((line) => line.slice(0, line.indexOf(":"))).sort(),
        [
          "src/CollateralPolicy.ts",
          "src/FarmentaMarket.ts",
          "src/handlers/collateralPolicy.ts",
          "src/handlers/farmentaMarket.ts",
          "src/handlers/farmentaMarket.ts",
        ],
      );
      assert.equal(offenders.filter((line) => line.includes("context.client")).length, 2);
      assert.equal(offenders.filter((line) => line.includes("client.readContract")).length, 3);
    });

    it("the scan is not blind: it flags each way of reaching a client", () => {
      for (const line of [
        "await context.client.readContract({ abi, address, functionName })",
        "ponder.on(name, ({ event, context: { db, client } }) => {})",
        "const { client, db } = context;",
        'import { db, publicClients } from "ponder:api";',
        "await publicClient.multicall({ contracts })",
      ]) {
        assert.ok(FORBIDDEN.test(line), line);
      }
    });
  });

  describe("edge case", () => {
    it("the registrations hand the handlers the store and the event, nothing else", () => {
      for (const name of ["PoolManager.ts", "PositionManager.ts", "CollateralPolicy.ts", "TwapRecorder.ts", "FarmentaMarket.ts"]) {
        const calls = readFileSync(join(ROOT, "src", name), "utf8").match(/ponder\.on\([^;]+;/g) ?? [];
        assert.ok(calls.length > 0, name);
        for (const call of calls) {
          if (call.includes("PoolListed") || call.includes("CollateralDeposited")) {
            assert.match(call, /\(\{ event, context \}\) => on\w+\(context\.db, event, context\.client\)\);$/, `${name}: ${call}`);
          } else {
            assert.match(call, /\(\{ event, context \}\) => on\w+\(context\.db, event\)\);$/, `${name}: ${call}`);
          }
        }
      }
    });
  });
});
