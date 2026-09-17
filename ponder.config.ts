import { createConfig } from "ponder";
import { zeroAddress, type Address } from "viem";

import { collateralPolicyAbi } from "./abis/CollateralPolicy";
import { farmentaMarketAbi } from "./abis/FarmentaMarket";
import { poolManagerAbi } from "./abis/PoolManager";
import { positionManagerAbi } from "./abis/PositionManager";
import { twapRecorderAbi } from "./abis/TwapRecorder";
import { loadDeployment } from "./config/deployment";
import { UNISWAP } from "./config/uniswap";

// Environment comes from .env, loaded by Node itself (`--env-file`, see package.json and
// ecosystem.config.cjs) before Ponder starts. Loading it from here would be too late for
// the variables Ponder reads at startup, such as PORT.

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

// No default RPC on purpose. Alchemy's free tier caps eth_getLogs at 10 blocks and the
// public RPC answers 429 (spec §13, §14), so a silent fallback would turn a missing key
// into a backfill that never finishes.
const rpc = requireEnv("PONDER_RPC_URL");

// Local development only: lifts every startBlock to at least this block, so `pnpm dev` does
// not backfill the chain from block 9,070. Production leaves it unset.
const startBlockFloor = Number(process.env.START_BLOCK_FLOOR || 0);
const from = (startBlock: number) => Math.max(startBlock, startBlockFloor);

const deployment = loadDeployment(process.env.FARMENTA_DEPLOYMENT);
const markets = Object.values(deployment?.markets ?? {});

// Without a deployment the Farmenta contracts stay in the config, so their handlers still
// build and keep their types. Ponder rejects an empty address list, so they point at the
// zero address from "latest": no code lives there, so it never emits a log.
const NONE: Address[] = [zeroAddress];

// The indexer shares a Postgres server with lp-monitor-v2 and must only ever use database
// `farmenta` (spec §13). The role is locked out of `lpmon` on the server as well
// (scripts/create-db-role.sql); this catches the mistake before a connection is made.
// The URL holds a password, so the error never echoes it.
function farmentaDatabaseUrl(): string {
  const url = requireEnv("DATABASE_URL");
  let database: string;
  try {
    database = decodeURIComponent(new URL(url).pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL is not a valid postgres:// URL");
  }
  if (database !== "farmenta") throw new Error(`DATABASE_URL must point at database "farmenta", not "${database}"`);
  return url;
}

export default createConfig({
  database: {
    kind: "postgres",
    connectionString: farmentaDatabaseUrl(),
  },
  chains: {
    robinhood: {
      id: 4663,
      rpc,
      pollingInterval: Number(process.env.POLLING_MS || 2_000),
    },
  },
  contracts: {
    PoolManager: {
      chain: "robinhood",
      abi: poolManagerAbi,
      address: UNISWAP.poolManager.address,
      startBlock: from(UNISWAP.poolManager.startBlock),
      // Only liquidity that belongs to a position NFT (FAR-35). `Initialize` stays unfiltered.
      filter: { event: "ModifyLiquidity", args: { sender: UNISWAP.positionManager.address } },
    },
    PositionManager: {
      chain: "robinhood",
      abi: positionManagerAbi,
      address: UNISWAP.positionManager.address,
      startBlock: from(UNISWAP.positionManager.startBlock),
    },
    CollateralPolicy: {
      chain: "robinhood",
      abi: collateralPolicyAbi,
      address: deployment ? [deployment.collateralPolicy.address] : NONE,
      startBlock: deployment ? from(deployment.collateralPolicy.startBlock) : "latest",
    },
    TwapRecorder: {
      chain: "robinhood",
      abi: twapRecorderAbi,
      address: deployment ? [deployment.twapRecorder.address] : NONE,
      startBlock: deployment ? from(deployment.twapRecorder.startBlock) : "latest",
    },
    // Both isolated markets share one ABI, so they are one Ponder contract with two
    // addresses; handlers tell them apart by `event.log.address`.
    FarmentaMarket: {
      chain: "robinhood",
      abi: farmentaMarketAbi,
      address: markets.length > 0 ? markets.map((market) => market.address) : NONE,
      startBlock: markets.length > 0 ? from(Math.min(...markets.map((market) => market.startBlock))) : "latest",
    },
  },
});
