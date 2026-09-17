import { index, onchainTable, primaryKey } from "ponder";

// Every table is written from events alone, never from an `eth_call`, so a reindex from
// zero rebuilds the same rows (FAR-34). Positions, loans and liquidations arrive in FAR-35.

// Every pool ever initialized on the PoolManager, listed by Farmenta or not. It exists only
// because `PoolListed` does not carry the PoolKey: currencies, fee, tick spacing and hooks
// are in `Initialize` alone, often emitted long before Farmenta was deployed. If `PoolListed`
// ever carries the key (market-id R5, undecided), this table can go.
export const uniswapPool = onchainTable("uniswap_pool", (t) => ({
  id: t.hex().primaryKey(),
  currency0: t.hex().notNull(),
  currency1: t.hex().notNull(),
  fee: t.integer().notNull(),
  tickSpacing: t.integer().notNull(),
  hooks: t.hex().notNull(),
  initializedBlock: t.bigint().notNull(),
  initializedAt: t.bigint().notNull(),
}));

// A pool listed in CollateralPolicy: the key from `uniswap_pool`, the tier, the terms in
// force, the freeze flag and the current LT ramp. The frontend's `marketId` is this `id`.
export const pool = onchainTable(
  "pool",
  (t) => ({
    id: t.hex().primaryKey(),
    // Null only while `Initialize` has not been seen: `list` does not require the pool to
    // exist yet, and START_BLOCK_FLOOR can skip the event in local development.
    currency0: t.hex(),
    currency1: t.hex(),
    fee: t.integer(),
    tickSpacing: t.integer(),
    hooks: t.hex(),
    // ICollateralPolicy.Tier as emitted.
    tier: t.integer().notNull(),
    maxLtvBps: t.integer().notNull(),
    // LT from `list` or the last `updateTerms`. While a ramp is set the threshold in force
    // comes from the ramp columns instead; see `effectiveLtBps` in src/lib/ramp.ts.
    ltBps: t.integer().notNull(),
    liquidatorBonusBps: t.integer().notNull(),
    removeHaircutBps: t.integer().notNull(),
    // USDG, 6 decimals (spec §6.5). Not the same unit as `minPositionUsd`.
    debtCapUsdg: t.bigint().notNull(),
    // USD, 1e18.
    minPositionUsd: t.bigint().notNull(),
    frozen: t.boolean().notNull(),
    // Current ramp, null when none. The effective LT is not stored: it depends on the time
    // it is read at (linear interpolation, spec §6.5).
    rampLtFromBps: t.integer(),
    rampLtTargetBps: t.integer(),
    rampStart: t.bigint(),
    rampDuration: t.bigint(),
    listedBlock: t.bigint().notNull(),
    listedAt: t.bigint().notNull(),
    updatedAt: t.bigint().notNull(),
  }),
  (table) => ({
    tierIdx: index().on(table.tier),
  }),
);

// One row per `PoolListed` and `PoolTermsUpdated`, so earlier terms survive an update.
export const poolTermsChange = onchainTable(
  "pool_terms_change",
  (t) => ({
    poolId: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
    // "listed" for the terms a pool was listed with, "updated" for every `updateTerms`.
    source: t.text().notNull(),
    maxLtvBps: t.integer().notNull(),
    ltBps: t.integer().notNull(),
    liquidatorBonusBps: t.integer().notNull(),
    removeHaircutBps: t.integer().notNull(),
    debtCapUsdg: t.bigint().notNull(),
    minPositionUsd: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.poolId, table.blockNumber, table.logIndex] }),
  }),
);

// One row per `LtRampScheduled`. `pool` holds only the ramp in force; `updateTerms` clears
// it there, and the schedule that was cleared stays readable here.
export const ltRamp = onchainTable(
  "lt_ramp",
  (t) => ({
    poolId: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
    ltFromBps: t.integer().notNull(),
    ltTargetBps: t.integer().notNull(),
    start: t.bigint().notNull(),
    duration: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.poolId, table.blockNumber, table.logIndex] }),
  }),
);

// Latest `TokenConfigured` per currency, for the owner console (FAR-41).
export const token = onchainTable("token", (t) => ({
  currency: t.hex().primaryKey(),
  enabled: t.boolean().notNull(),
  tier: t.integer().notNull(),
  decimals: t.integer().notNull(),
  priceFeed: t.hex().notNull(),
  updatedAt: t.bigint().notNull(),
}));

// Latest `HookAllowlisted` per hook address, for the owner console (FAR-41).
export const hook = onchainTable("hook", (t) => ({
  address: t.hex().primaryKey(),
  allowed: t.boolean().notNull(),
  updatedAt: t.bigint().notNull(),
}));

// One row per `Recorded`. The recorder writes at most one observation per pool per second
// (spec §5.3), and `index` wraps at the ring-buffer capacity, so the key is the timestamp.
export const twapObservation = onchainTable(
  "twap_observation",
  (t) => ({
    poolId: t.hex().notNull(),
    timestamp: t.bigint().notNull(),
    index: t.integer().notNull(),
    tickCumulative: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.poolId, table.timestamp] }),
  }),
);

// Newest observation per pool: what the `recordBatch` scheduler (FAR-18) and the 600-second
// alert read. Kept apart from `pool` because `record` is permissionless and may be called
// for a pool that is not listed.
export const twapPool = onchainTable("twap_pool", (t) => ({
  poolId: t.hex().primaryKey(),
  lastObservationAt: t.bigint().notNull(),
  lastIndex: t.integer().notNull(),
  lastTickCumulative: t.bigint().notNull(),
  observationCount: t.integer().notNull(),
}));
