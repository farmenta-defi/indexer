import { ponder } from "ponder:registry";
import { hook, ltRamp, pool, poolTermsChange, token, uniswapPool } from "ponder:schema";

ponder.on("CollateralPolicy:PoolListed", async ({ event, context }) => {
  const { poolId, tier, params } = event.args;
  const key = await context.db.find(uniswapPool, { id: poolId });

  // A pool can be listed once (`PoolAlreadyListed`), so this never overwrites a row.
  await context.db.insert(pool).values({
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

  await context.db.insert(poolTermsChange).values({
    poolId,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    source: "listed",
    ...params,
  });
});

ponder.on("CollateralPolicy:PoolTermsUpdated", async ({ event, context }) => {
  const { poolId, params } = event.args;

  // `updateTerms` clears any active ramp: "the new terms are the schedule now".
  await context.db.update(pool, { id: poolId }).set({
    ...params,
    rampLtFromBps: null,
    rampLtTargetBps: null,
    rampStart: null,
    rampDuration: null,
    updatedAt: event.block.timestamp,
  });

  await context.db.insert(poolTermsChange).values({
    poolId,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    source: "updated",
    ...params,
  });
});

ponder.on("CollateralPolicy:PoolFrozen", async ({ event, context }) => {
  const { poolId, frozen } = event.args;
  await context.db.update(pool, { id: poolId }).set({ frozen, updatedAt: event.block.timestamp });
});

ponder.on("CollateralPolicy:LtRampScheduled", async ({ event, context }) => {
  const { poolId, ltFromBps, ltTargetBps, start, duration } = event.args;

  // A second ramp replaces the first; it starts from the LT in force when it was scheduled.
  await context.db.update(pool, { id: poolId }).set({
    rampLtFromBps: ltFromBps,
    rampLtTargetBps: ltTargetBps,
    rampStart: BigInt(start),
    rampDuration: BigInt(duration),
    updatedAt: event.block.timestamp,
  });

  await context.db.insert(ltRamp).values({
    poolId,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    ltFromBps,
    ltTargetBps,
    start: BigInt(start),
    duration: BigInt(duration),
  });
});

ponder.on("CollateralPolicy:TokenConfigured", async ({ event, context }) => {
  const { currency, enabled, tier, decimals, priceFeed } = event.args;
  const row = { enabled, tier, decimals, priceFeed, updatedAt: event.block.timestamp };
  await context.db.insert(token).values({ currency, ...row }).onConflictDoUpdate(row);
});

ponder.on("CollateralPolicy:HookAllowlisted", async ({ event, context }) => {
  const { hooks, allowed } = event.args;
  const row = { allowed, updatedAt: event.block.timestamp };
  await context.db.insert(hook).values({ address: hooks, ...row }).onConflictDoUpdate(row);
});
