import type { Address, Hex } from "viem";

import { hook, ltRamp, pool, poolTermsChange, token, uniswapPool } from "../../ponder.schema.ts";
import type { Db, Log } from "./event.ts";

type ListingParams = {
  maxLtvBps: number;
  ltBps: number;
  liquidatorBonusBps: number;
  removeHaircutBps: number;
  debtCapUsdg: bigint;
  minPositionUsd: bigint;
};

const logKey = (poolId: Hex, event: Log<unknown>) => ({
  poolId,
  blockNumber: event.block.number,
  logIndex: event.log.logIndex,
  timestamp: event.block.timestamp,
  transactionHash: event.transaction.hash,
});

export async function onPoolListed(db: Db, event: Log<{ poolId: Hex; tier: number; params: ListingParams }>) {
  const { poolId, tier, params } = event.args;
  const key = await db.find(uniswapPool, { id: poolId });

  // A pool can be listed once (`PoolAlreadyListed`), so this never overwrites a row.
  await db.insert(pool).values({
    id: poolId,
    currency0: key?.currency0 ?? null,
    currency1: key?.currency1 ?? null,
    fee: key?.fee ?? null,
    tickSpacing: key?.tickSpacing ?? null,
    hooks: key?.hooks ?? null,
    tier,
    ...params,
    frozen: false, // a pool is never listed already frozen
    listedBlock: event.block.number,
    listedAt: event.block.timestamp,
    updatedAt: event.block.timestamp,
  });

  await db.insert(poolTermsChange).values({ ...logKey(poolId, event), source: "listed", ...params });
}

export async function onPoolTermsUpdated(db: Db, event: Log<{ poolId: Hex; params: ListingParams }>) {
  const { poolId, params } = event.args;

  // `updateTerms` clears any active ramp: "the new terms are the schedule now".
  await db.update(pool, { id: poolId }).set({
    ...params,
    rampLtFromBps: null,
    rampLtTargetBps: null,
    rampStart: null,
    rampDuration: null,
    updatedAt: event.block.timestamp,
  });

  await db.insert(poolTermsChange).values({ ...logKey(poolId, event), source: "updated", ...params });
}

export async function onPoolFrozen(db: Db, event: Log<{ poolId: Hex; frozen: boolean }>) {
  const { poolId, frozen } = event.args;
  await db.update(pool, { id: poolId }).set({ frozen, updatedAt: event.block.timestamp });
}

export async function onLtRampScheduled(
  db: Db,
  event: Log<{ poolId: Hex; ltFromBps: number; ltTargetBps: number; start: number; duration: number }>,
) {
  const { poolId, ltFromBps, ltTargetBps } = event.args;
  const start = BigInt(event.args.start);
  const duration = BigInt(event.args.duration);

  // A second ramp replaces the first; it starts from the LT in force when it was scheduled.
  await db.update(pool, { id: poolId }).set({
    rampLtFromBps: ltFromBps,
    rampLtTargetBps: ltTargetBps,
    rampStart: start,
    rampDuration: duration,
    updatedAt: event.block.timestamp,
  });

  await db.insert(ltRamp).values({ ...logKey(poolId, event), ltFromBps, ltTargetBps, start, duration });
}

export async function onTokenConfigured(
  db: Db,
  event: Log<{ currency: Address; enabled: boolean; tier: number; decimals: number; priceFeed: Address }>,
) {
  const { currency, enabled, tier, decimals, priceFeed } = event.args;
  const row = { enabled, tier, decimals, priceFeed, updatedAt: event.block.timestamp };
  await db.insert(token).values({ currency, ...row }).onConflictDoUpdate(row);
}

export async function onHookAllowlisted(db: Db, event: Log<{ hooks: Address; allowed: boolean }>) {
  const { hooks, allowed } = event.args;
  const row = { allowed, updatedAt: event.block.timestamp };
  await db.insert(hook).values({ address: hooks, ...row }).onConflictDoUpdate(row);
}
