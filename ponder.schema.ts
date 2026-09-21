import { index, onchainTable, primaryKey } from "ponder";

// Every table is written from events alone, never from an `eth_call`, so a reindex from
// zero rebuilds the same rows (FAR-34, FAR-35).

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
  // `Recorded` events seen for the pool. Not the contract's `observationCount`, which stops at
  // the ring-buffer capacity (2048): that one is `min(recordedCount, 2048)`.
  recordedCount: t.integer().notNull(),
}));

// Every position NFT ever minted by the PositionManager, in a Farmenta pool or not, since its
// deploy block: `PositionManager` has no `ERC721Enumerable` (spec §12), and a position that
// becomes collateral was usually minted long before.
export const position = onchainTable(
  "position",
  (t) => ({
    tokenId: t.bigint().primaryKey(),
    // Holder of the NFT: the market while the position is collateral (the depositor is
    // `loan.owner`), the zero address once burned.
    owner: t.hex().notNull(),
    // From `ModifyLiquidity`, which the PositionManager salts with the tokenId. Null only
    // between a mint's `Transfer` and its `ModifyLiquidity`, a few logs later in the same
    // transaction.
    poolId: t.hex(),
    tickLower: t.integer(),
    tickUpper: t.integer(),
    // Sum of every `liquidityDelta`: what `getPositionLiquidity` returns.
    liquidity: t.bigint().notNull(),
    burned: t.boolean().notNull(),
    mintedBlock: t.bigint().notNull(),
    mintedAt: t.bigint().notNull(),
    updatedAt: t.bigint().notNull(),
  }),
  (table) => ({
    ownerIdx: index().on(table.owner),
    poolIdx: index().on(table.poolId),
  }),
);

// One row per PositionManager `Transfer`, mint and burn included: who held a position when.
export const positionTransfer = onchainTable(
  "position_transfer",
  (t) => ({
    tokenId: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
    from: t.hex().notNull(),
    to: t.hex().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.tokenId, table.blockNumber, table.logIndex] }),
  }),
);

// A position taken into custody by a market: the only list of loans there is, since the
// market keeps no enumeration on chain (spec §13). There is no debt column. `Borrow` and
// `Repay` carry USDG amounts, not shares, and interest accrues without an event, so the
// exact debt is `debtOf(tokenId)`, read by the backend and the keeper.
export const loan = onchainTable(
  "loan",
  (t) => ({
    // The FarmentaMarket proxy holding the position. One row per market and tokenId: a
    // redeposit starts the row over, as `withdrawCollateral` deletes the loan on chain. What
    // happened in an earlier custody stays in `loan_activity`.
    market: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    // The depositor, who alone may borrow against and withdraw the position.
    owner: t.hex().notNull(),
    // From `position`, until the market events carry `poolId` themselves (FAR-42). Null only
    // when START_BLOCK_FLOOR skipped the position's mint.
    poolId: t.hex(),
    // "in_custody", "withdrawn" or "liquidated" (src/lib/loan.ts).
    status: t.text().notNull(),
    // True from the first `Borrow` of this custody. A candidate for debt, not proof of it:
    // consumers must confirm with `debtOf`, because a repaid loan stays flagged.
    everBorrowed: t.boolean().notNull(),
    // Running totals for this custody, USDG with 6 decimals. `repaidUsdg` is the borrower's
    // `Repay`; what liquidators repaid is kept apart. Neither includes interest still owed.
    borrowedUsdg: t.bigint().notNull(),
    repaidUsdg: t.bigint().notNull(),
    liquidatedUsdg: t.bigint().notNull(),
    depositedBlock: t.bigint().notNull(),
    depositedAt: t.bigint().notNull(),
    lastActivityAt: t.bigint().notNull(),
    // When the position left custody, null while it is held.
    closedAt: t.bigint(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.market, table.tokenId] }),
    ownerIdx: index().on(table.owner),
    statusIdx: index().on(table.status),
    poolIdx: index().on(table.poolId),
  }),
);

// One row per `CollateralDeposited`, `CollateralWithdrawn`, `Borrow`, `Repay`,
// `LiquidityChanged` and `CollectFees`: the borrower side of the transaction history.
// Liquidations are in `liquidation`.
export const loanActivity = onchainTable(
  "loan_activity",
  (t) => ({
    market: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    // The loan's depositor. Only the two collateral events name anyone, and anyone may repay.
    owner: t.hex().notNull(),
    // "deposit", "withdraw", "borrow", "repay", "increase_liquidity", "decrease_liquidity"
    // or "collect_fees".
    kind: t.text().notNull(),
    // USDG, 6 decimals. Only for "borrow" and "repay".
    amountUsdg: t.bigint(),
    // `LiquidityChanged.liqDelta`, signed. Only for the two liquidity kinds. The position's
    // liquidity itself comes from `ModifyLiquidity`, never from this.
    liquidityDelta: t.bigint(),
    // Only for "collect_fees". NOT verified fee income: per the contract's NatSpec they are
    // `to`'s balance change across the claim, which counts anything else that reached `to`
    // meanwhile. Fees claimed inside `increaseLiquidity` and `decreaseLiquidity` emit no
    // `CollectFees` at all (spec §4.1, v0.48), so they are in no row here.
    amount0: t.bigint(),
    amount1: t.bigint(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.market, table.blockNumber, table.logIndex] }),
    ownerIdx: index().on(table.owner),
    tokenIdx: index().on(table.market, table.tokenId),
  }),
);

// One row per `Liquidate`, partial or full.
export const liquidation = onchainTable(
  "liquidation",
  (t) => ({
    market: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    // The liquidated loan's depositor and pool, copied from `loan`.
    owner: t.hex().notNull(),
    poolId: t.hex(),
    liquidator: t.hex().notNull(),
    // True when the position was seized whole and burned, which closes the loan. A partial
    // liquidation leaves it in custody.
    full: t.boolean().notNull(),
    // Exact ledger figures, USDG with 6 decimals.
    repaidUsdg: t.bigint().notNull(),
    badDebtUsdg: t.bigint().notNull(),
    // The part of `badDebtUsdg` the reserve could not cover, from the `BadDebtSocialized`
    // of the same transaction; 0 when there was none.
    socializedUsdg: t.bigint().notNull(),
    // NOT the amount seized. Per the contract's NatSpec these are what the liquidator's `to`
    // received, and on the full branch they are measured as `to`'s balance change across the
    // burn, which a contract `to` can distort (redeem vault shares, pass the ETH on). The
    // ledger never reads them; do not account with them.
    out0: t.bigint().notNull(),
    out1: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.market, table.blockNumber, table.logIndex] }),
    ownerIdx: index().on(table.owner),
    liquidatorIdx: index().on(table.liquidator),
    tokenIdx: index().on(table.market, table.tokenId),
  }),
);

// A market's burn of a position in custody, waiting for the `Liquidate` that must follow it
// in the same transaction with `fullSeizure` set (FAR-51). At most one per market: `liquidate`
// burns and emits before it returns. Empty whenever the indexer is consistent; a row that
// outlives its transaction is a burn no full liquidation explains, and stops the indexer.
export const pendingBurn = onchainTable("pending_burn", (t) => ({
  market: t.hex().primaryKey(),
  tokenId: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  transactionHash: t.hex().notNull(),
}));

// One row per `BadDebtSocialized`: a loss written off against lenders (spec §9). The event
// names no position; `liquidation.socializedUsdg` is where it is tied to one.
export const badDebtSocialized = onchainTable(
  "bad_debt_socialized",
  (t) => ({
    market: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
    amountUsdg: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.market, table.blockNumber, table.logIndex] }),
  }),
);

// The lender side of a market, which is an ERC-4626 vault over USDG: one row per `Deposit`,
// per `Withdraw`, and per share `Transfer` between two holders. The `Transfer` that mints or
// burns shares inside a deposit or a withdrawal is not repeated here; it moves `vault_balance`.
export const vaultActivity = onchainTable(
  "vault_activity",
  (t) => ({
    market: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
    // "deposit", "withdraw" or "transfer".
    kind: t.text().notNull(),
    // `msg.sender` of the deposit or the withdrawal. Null for "transfer".
    sender: t.hex(),
    // Whose shares: minted to on "deposit", burned from on "withdraw", sent by on "transfer".
    owner: t.hex().notNull(),
    // Who received: the USDG on "withdraw", the shares on "transfer". Null for "deposit".
    receiver: t.hex(),
    // USDG, 6 decimals. Null for "transfer", which moves shares only.
    assetsUsdg: t.bigint(),
    shares: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.market, table.blockNumber, table.logIndex] }),
    ownerIdx: index().on(table.owner),
    receiverIdx: index().on(table.receiver),
  }),
);

// Shares per holder, from every share `Transfer`, mints and burns included: what `balanceOf`
// returns. Their worth in USDG is `convertToAssets`, which moves with interest and without an
// event, so it is not a column.
export const vaultBalance = onchainTable(
  "vault_balance",
  (t) => ({
    market: t.hex().notNull(),
    account: t.hex().notNull(),
    shares: t.bigint().notNull(),
    updatedAt: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.market, table.account] }),
    accountIdx: index().on(table.account),
  }),
);
