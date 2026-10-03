# Farmenta · Indexer

[Ponder](https://ponder.sh) indexer for Farmenta — borrow USDG against Uniswap v4 LP position
NFTs on Robinhood Chain (chain id 4663).

Public protocol and indexer documentation: [Farmenta technical documentation](https://docs.farmenta.fun/), including the [indexer data reference](https://docs.farmenta.fun/docs/reference/indexer) and [event reference](https://docs.farmenta.fun/docs/reference/events). This README describes how to run and operate this repository; the public reference describes the data model and API.

The indexer is an event logbook: it records on-chain events and does not compute current values such as debt or health factors. The public [indexer reference](https://docs.farmenta.fun/docs/reference/indexer) describes the data model and API. This implementation makes two narrowly scoped contract reads to recover PoolKeys and deposited positions whose creating events predate the configured start block. `PositionManager` has no `ERC721Enumerable`, and `FarmentaMarket` keeps no list of loans, so the list of active loans exists only here, rebuilt from events. PoolKeys are read at `latest` because they never change; position state is read at the deposit block because liquidity changes.

> This indexer records pools and listings, positions, loans, liquidations and vault activity.
> Exact debt and health factors are not stored here; see [Loans](#loans).

## Layout

| Path | What |
|---|---|
| `ponder.config.ts` | Chain, RPC, database, contracts and start blocks |
| `config/uniswap.ts` | Uniswap v4 addresses and their deployment blocks |
| `config/deployment.ts`, `deployments/` | Farmenta addresses, one JSON file per deployment |
| `abis/` | Event ABIs, **generated** — see [Regenerating ABIs](#regenerating-abis) |
| `abis/source.json` | The `smart-contract` commit the ABIs were built from |
| `ponder.schema.ts` | Tables — see [Tables](#tables) |
| `src/PoolManager.ts`, `src/PositionManager.ts`, `src/CollateralPolicy.ts`, `src/TwapRecorder.ts`, `src/FarmentaMarket.ts` | Registers the indexing functions with Ponder, one file per contract |
| `src/handlers/` | What those functions do. Only PoolListed and CollateralDeposited receive the chain client; `pnpm test` runs handlers against an in-memory store |
| `src/lib/` | Pure helpers (pool id, LT ramp, API view), unit-tested without Ponder |
| `src/api/app.ts`, `src/api/index.ts` | HTTP routes on top of Ponder's built-in ones — see [Queries](#queries). `app.ts` holds the routes and takes the store as an argument, so `pnpm test` runs them against an in-memory Postgres; `index.ts` hands it Ponder's |
| `test/fixtures/` | Real position logs, replayed by `test/realPositions.test.ts` |
| `scripts/create-db-role.sql` | Database and role on the shared Postgres server |
| `patches/` | The one change made to Ponder itself, applied by `pnpm install`: see [Ponder patch](#ponder-patch) |
| `ecosystem.config.cjs` | pm2 process file |

## Local setup

Needs Node ≥ 22, pnpm 10 and Docker. `corepack pnpm` runs the pnpm that `packageManager` in
`package.json` names, whatever `pnpm` is on the `PATH`; pnpm 9 cannot install this repo
([Ponder patch](#ponder-patch)), and every `pnpm` command below needs pnpm 10 as well.

```sh
corepack pnpm install
cp .env.example .env            # then fill it in
pnpm db:up                      # Postgres 16 on 127.0.0.1:5434
pnpm dev
```

`pnpm lint`, `pnpm typecheck` and `pnpm test` need neither a database nor an RPC.

`.env` is gitignored, and `.env.example` is the only env file in the repo. Node loads `.env`
itself (`--env-file`, in the package scripts and the pm2 file) before Ponder starts, which
is what lets `PORT` live there too; Ponder's warning about a missing `.env.local` is harmless.

Every secret lives in `.env` and nowhere else: `DATABASE_URL` carries a password and
`PONDER_RPC_URL` carries an API key, so neither is ever written out in this README, an
issue, a commit message or the pm2 process file. `.env.example` describes the shape of each
value. The Docker database has no built-in password either: `pnpm db:up` refuses to start
until `POSTGRES_PASSWORD` is set in `.env`.

`DATABASE_URL` must name database `farmenta`; the config refuses anything else, so a pasted
lp-monitor-v2 URL fails at startup instead of writing into `lpmon`.

**RPC.** `PONDER_RPC_URL` is required and has no fallback. Production follows the chain on
dRPC since 2 Oct 2026, with `ETH_GET_LOGS_BLOCK_RANGE=100`: dRPC's free plan rejects
`eth_getLogs` ranges above about 100 blocks with a message Ponder 0.17.10 does not recognise,
so without the setting the sync fails instead of shrinking the range. Before that it ran on
the public RPC endpoint, which on 2 Oct 2026 took 1.3 to 1.7 seconds per request and left
the indexer 50 minutes behind. `START_BLOCK_FLOOR=77197166` is the first block of the Farmenta
deployment of 1 Oct 2026 (the deployment it replaced started at 74,901,824);
the floor was chosen because starting Uniswap history at block 9,070 was estimated to take
about 60 days. The public RPC has been measured to follow the chain at 1.06 requests per
block; the floor keeps the initial backfill tractable. Locally, leave the floor unset for full
history or set it to a recent block to test current events.

**RPC cost.** Robinhood Chain makes about 10 blocks a second, and Ponder's realtime sync reads
every block with `eth_getBlockByNumber`: about 850,000 calls a day, 93% of the indexer's
traffic. At dRPC's flat $6 per million calls that came to about $5.50 a day. Since 3 Oct 2026
production sets `PONDER_FREE_RPC_URL` to the public RPC: block reads go there first, and a
failure, a 429, an answer slower than 3 seconds or a block it has not seen yet goes to
`PONDER_RPC_URL` (`config/rpc.ts`). Everything else, `eth_getLogs` above all, stays on dRPC.
Every 10 minutes the indexer logs `rpc split, last 10 min: free=… paid=… (fallback=…)`; `paid`
is what dRPC bills.

The floor skips Uniswap events before block 77,197,166. In particular, the listed ETH/USDG
pool `0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551` was initialized at
block 41,259,014. When `PoolListed` finds no `uniswap_pool` row, it reads
`PositionManager.poolKeys(bytes25(poolId))` at `latest`, checks that the key hashes to the
pool id, and stores the key on `pool`. An empty key (`tickSpacing == 0`) means the
PositionManager has not minted a position in that pool; the pool may still be initialized and
traded. Its key columns stay null without stopping indexing.

Position mints before the floor have no `position` row. When one of those NFTs is deposited
as collateral, the handler reads `getPoolAndPositionInfo(tokenId)` and
`getPositionLiquidity(tokenId)` at the deposit block to create its row. Mint block/time stay
null because their events were skipped; later `ModifyLiquidity` and `Transfer` events update
the row normally. If the RPC has no state for that block, the handler warns with the token id
and block, omits the position row, keeps the loan, and continues indexing. Other read errors
still stop indexing. Same-block `ModifyLiquidity` events are not added again because the
recovered state includes the full block.
Rows already rebuilt from history do not trigger chain reads. Older positions never deposited
remain absent, while loan pool ids still come from market events and remain available to the
keeper. Existing backend `/pools/{poolId}` and keeper `pools()` responses then receive the
same five populated key columns from `pool` without code changes.

Events before the floor are still outside the backfill: loans deposited before block
77,197,166 have no `loan` row, so a later loan event that requires custody state cannot be
reconstructed; vault transfers whose initial share mint was skipped likewise lack its earlier
balance history. The production deployment was started at the first block of the Farmenta
deployment it indexes, so none of its markets has an event before the floor; these remain the
consequences if that floor is raised further.

**Farmenta addresses.** None is written in code: deployed addresses are network-specific, and
a fork or redeploy moves all of them. Copy `deployments/example.json` to
`deployments/<name>.json`, fill in each address and the block it was deployed in, and set
`FARMENTA_DEPLOYMENT=<name>`. The loader refuses the zero address, so the example cannot be
used unedited. With `FARMENTA_DEPLOYMENT` empty only the Uniswap contracts are indexed. A market's
`startBlock` must not be later than the block it was really deployed in: the first `Borrow`,
`CollateralWithdrawn` or share burn for something deposited before it stops the indexer.

Time is always `block.timestamp`. On this chain `block.number` inside a contract is the L1
Ethereum L1 block, so nothing here derives time from block numbers. See the public [Robinhood Chain
reference](https://docs.farmenta.fun/docs/reference/network).

## Tables

Most tables are written from events alone. `PoolListed` and `CollateralDeposited` also make
`eth_call`s to recover data whose source events predate the configured start block. The
immutable pool key is read at `latest`; the position is read at its deposit block. Ponder
caches the reads in its sync store.

| Table | Written by | Holds |
|---|---|---|
| `uniswap_pool` | PoolManager `Initialize` | PoolKeys initialized within the indexed block range, listed or not |
| `pool` | CollateralPolicy events; reads PoolKey on `PoolListed` if its `Initialize` predates the range | Listed pools only: key, tier, terms in force, `frozen`, current ramp. `id` is the frontend's `marketId` |
| `pool_terms_change` | `PoolListed`, `PoolTermsUpdated` | Every set of terms a pool has had |
| `lt_ramp` | `LtRampScheduled` | Every ramp ever scheduled |
| `token`, `hook` | `TokenConfigured`, `HookAllowlisted` | Latest config per currency and per hook (owner console) |
| `twap_observation` | TwapRecorder `Recorded` | One row per observation, keyed by pool and timestamp |
| `twap_pool` | `Recorded` | Newest observation per pool: `last_observation_at` |
| `position` | PositionManager `Transfer`, PoolManager `ModifyLiquidity`; reads position state on `CollateralDeposited` if its mint predates the range | Observed positions and older positions deposited as collateral: holder, pool, ticks, liquidity, `burned` |
| `position_transfer` | PositionManager `Transfer` | Every transfer, mint and burn included |
| `loan` | FarmentaMarket `CollateralDeposited`, `CollateralWithdrawn`, `Borrow`, `Repay`, `Liquidate` | One row per market and tokenId: depositor, pool, `status`, `everBorrowed`, running totals |
| `loan_activity` | `CollateralDeposited`, `CollateralWithdrawn`, `Borrow`, `Repay`, `LiquidityChanged`, `CollectFees` | The borrower side of the transaction history, with `poolId` indexed for pool activity queries |
| `liquidation` | `Liquidate`, `BadDebtSocialized` | One row per liquidation, partial or full, with an index on `poolId` |
| `bad_debt_socialized` | `BadDebtSocialized` | Every loss written off against lenders |
| `pending_burn` | PositionManager `Transfer` to zero, `Liquidate` | A market's burn waiting for its full-seizure `Liquidate`; empty whenever the indexer runs |
| `vault_activity` | ERC-4626 `Deposit`, `Withdraw`, share `Transfer` | The lender side of the transaction history |
| `vault_balance` | share `Transfer` | Shares per market and holder: what `balanceOf` returns |

`PoolListed` does not carry the PoolKey, which exists only in `Initialize`, often emitted long
before Farmenta was deployed. `uniswap_pool` records `Initialize` events within the configured
range. If a listed pool's `Initialize` predates that range, the `PoolListed` handler reads its
PoolKey at `latest` and writes the key directly to `pool`. Key columns remain null if the
PositionManager has never minted a position for the pool; this does not mean the pool is
uninitialized.

A pool's first observation has `index 0` and `tickCumulative 0`. That is the recorder
initializing the pool, not broken data. `record` is permissionless, so `twap_pool` may hold
pools that are not listed.

The effective LT is **not** a column: during a ramp it depends on the time it is read at.
`updateTerms` clears the ramp on `pool`; the cleared schedule stays in `lt_ramp`.

### Positions

`PositionManager` has no `ERC721Enumerable`. Within the indexed range, the
PositionManager's `Transfer` and PoolManager's `ModifyLiquidity` events provide position
history. A position first deposited as collateral after the range starts may have been minted
earlier, so `CollateralDeposited` reads its pool, ticks and liquidity at that event's block and
creates the missing row. An older position never deposited as collateral remains unknown.
`ponder.config.ts` filters `ModifyLiquidity` on `sender = PositionManager`.
`test/realPositions.test.ts` replays the real logs of two fixture positions and gets the figures
the contracts' fork tests read from `getPoolAndPositionInfo` and `getPositionLiquidity`.

`position.owner` is whoever holds the NFT: **the market** while the position is collateral
(the depositor is `loan.owner`), the zero address once burned. A burned row stays, with
`liquidity` 0. With `START_BLOCK_FLOOR` set, an older position is only indexed if it is
deposited as collateral after the floor; positions never deposited after the floor remain
unknown.

### Loans

The market keeps no list of loans on chain, so `loan` is the only one. A row is a position in
custody of one market; `status` is `in_custody`, `withdrawn` or `liquidated`. A position leaves
custody in exactly two ways: the depositor withdraws it, or a full liquidation burns it, and
the `Liquidate` with `fullSeizure` set is what closes the loan, not the burn. A redeposit starts the row over,
as the contract deletes the loan on withdrawal; the earlier custody stays in `loan_activity`.

**`loan` and `/loans?owner=` hold the current or the last custody only.** When Alice withdraws a
position to Bob and Bob deposits it in the same market, the row becomes Bob's, with
`everBorrowed` and every total back at zero, and `/loans?owner=<alice>` no longer returns it.
What Alice did is in `loan_activity`, which names the `owner` on every row; `depositedBlock`
cuts that history per custody (rows before it belong to an earlier one). Liquidations keep
their `owner` in `liquidation`.

**There is no debt column, and `everBorrowed` is not "has debt".** `Borrow` and `Repay` carry
USDG amounts, not shares, and interest accrues without an event, so exact debt cannot be
rebuilt from events. `everBorrowed` marks a *candidate*: it stays true after the loan is repaid in full. Consumers **must** confirm every candidate with `debtOf(tokenId)`.
`borrowedUsdg`, `repaidUsdg` and `liquidatedUsdg` are running totals of event amounts for the current custody; their difference is not the debt.

**A loan's pool always comes from the market's events; `position` only confirms it.** Every
event of a loan names its pool (`CollateralDeposited`, `CollateralWithdrawn`, `Borrow`, `Repay`,
`LiquidityChanged`, `CollectFees`, `Liquidate`). `loan.poolId` is the one
`CollateralDeposited` named, and `liquidation.poolId` the one `Liquidate` named; neither is ever
null. The indexer **stops** when a deposit names another pool than the `position` row, which
would mean the salt-to-tokenId join is wrong, and when any later event names another pool than
the loan's.

`LiquidityChanged` and `CollectFees` are history rows in `loan_activity` and nothing more. A
position's liquidity always comes from the PoolManager's `ModifyLiquidity`, which also sees the
partial liquidations and the burn that emit no `LiquidityChanged`.

**`collect_fees` rows are the fees each position was paid**. `CollectFees` comes from
`collectFees` and from the fee claims inside `increaseLiquidity` and `decreaseLiquidity`, and
`amount0`/`amount1` are the fees the position realised, which the contract reads from its fee
growth just before the payout, not a balance change of the recipient. Summing a position's rows
gives the fees it has paid out while in custody, in raw token units; USD values are the
backend's. Not included: fees realised by a liquidation, partial or full, and fees a
position paid out before it was deposited.

### Liquidations

`liquidation.full` is `Liquidate.fullSeizure`: true when the position was seized whole and
burned, with or without bad debt. The PositionManager burn that comes first in the same
transaction is held in `pending_burn` until that `Liquidate` confirms it. The indexer **stops**
when a full-seizure `Liquidate` finds no burn of its position before it in its transaction, when
a partial one finds a burn waiting, or when a market emits anything in a later transaction while
its burn still waits: a burn no full liquidation explains is an error, never a liquidation, so
a burn on some future path cannot drop a loan from the keeper's list unnoticed.

`repaidUsdg` and
`badDebtUsdg` are exact ledger figures. `socializedUsdg` is the `BadDebtSocialized` of the same
transaction, matched as the log right before `Liquidate`, which is how `liquidate` emits them.

**`out0`/`out1` are not the amount seized.** Per the contract's NatSpec they are what the
liquidator's `to` received, and on the full branch they are *measured* as `to`'s balance change
across the burn, because the PositionManager pays `to` directly. A contract `to` can distort
that (redeem vault shares when the ETH lands, or pass the ETH on). The ledger never reads
them; neither should accounting built on this table.

### Vault

`vault_balance` follows every share `Transfer`, mints and burns included, so it equals
`balanceOf`. What the shares are worth in USDG is `convertToAssets`, which moves with interest
and without an event, so it is not stored. `vault_activity` has one row per `Deposit`, per
`Withdraw` and per transfer between two holders; the mint or burn inside a deposit or a
withdrawal is not repeated as a row.

## Queries

`/graphql` serves every table as stored. `/pools` and `/pools/:id` add what depends on the
time of reading, at `?t=<unix seconds>` (default: now):

| Field | Meaning |
|---|---|
| `rampRunning` | `t < rampStart + rampDuration`. True from the moment a ramp is scheduled, which may affect a keeper's configured delay |
| `rampEndsAt` | `rampStart + rampDuration`, null with no ramp |
| `effectiveLtBps` | Same arithmetic as `CollateralPolicy.effectiveLt`, truncation included |
| `lastObservationAt`, `observationAgeSeconds` | Newest TWAP observation and its age at `t`; the age of the latest observation, in seconds |

```sh
$ curl -s "localhost:42069/pools/0x52b9…34f6?t=1789657500" | jq '{effectiveLtBps, rampRunning, observationAgeSeconds}'
{ "effectiveLtBps": 7078, "rampRunning": true, "observationAgeSeconds": "1506" }
```

**Read the LT from `/pools`, never from the `ltBps` column.** `ltBps` is the LT from `list` or
the last `updateTerms`. Once a ramp is scheduled the threshold in force comes from the ramp,
and after `rampStart + rampDuration` it stays at `rampLtTargetBps` until the next
`updateTerms`, while `ltBps` still holds the value from before the ramp. GraphQL serves the
raw columns, so a GraphQL consumer has to apply `effectiveLtBps` (src/lib/ramp.ts) itself.

**`t` is the reader's clock, the rows are the last indexed block.** `t` defaults to the
server's time, and the response does not say how far the indexer has got. If the indexer lags,
`observationAgeSeconds` grows although nothing on chain is stale (a false 600-second alert),
and `rampRunning` is `false` for a ramp scheduled in a block not indexed yet, so a keeper
may act on incomplete state. Consumers that depend on current indexed state should read
`/status` first and account for indexer lag.

A pool whose `currency0` is null is listed but not initialized yet: nothing can be recorded
or deposited for it, so treat it as not active.

`twap_pool.recordedCount` counts `Recorded` events. It is not the contract's
`observationCount`, which stops at the ring-buffer capacity: that is `min(recordedCount, 2048)`.

Positions and loans:

| Route | Returns |
|---|---|
| `/portfolio/:address` | Not the zero address. `positions`: the NFTs in the address's wallet. `loans`: the ones a market holds for it (`status = in_custody`). `vaultShares`: its `vault_balance` rows, one per market. Meant for users: a market's own address returns every position in its custody, unpaginated |
| `/loans?owner=&market=&status=` | Loans, every filter optional. One row per market and tokenId, the current or last custody only: a past depositor is found in `loan_activity`, not here. `/loans?status=in_custody` is the list consumers use to check current loan state |
| `/loans/keeper-candidates` | Loans still in custody, on a meme pool (`pool.tier = 2`), that have ever borrowed |

Every loan comes with its position's `tickLower`, `tickUpper` and `liquidity` and its pool's
`tier`, ordered by market and tokenId. Addresses are accepted in any case. Nothing is
paginated: a keeper that silently got half the candidates would be worse than a slow answer.

```sh
$ curl -s localhost:42069/loans/keeper-candidates | jq '.[0] | {market, tokenId, owner, poolId, everBorrowed, liquidity, tier}'
```

**Keeper candidates are candidates.** A loan repaid in full stays on the list, so confirm each
with `debtOf`. The list is as of the last indexed block: a loan deposited and borrowed against
in a block not indexed yet is missing, so read `/status` first, as for `/pools`.

Transfers, activity, liquidations and vault balances are served as stored by `/graphql`.

`uint128` values and timestamps are decimal strings, as in GraphQL. `debtCapUsdg` is USDG
with 6 decimals; `minPositionUsd` is USD scaled by 1e18.

## Status endpoint

Ponder serves these itself, on `PORT` (default 42069):

| Route | Meaning |
|---|---|
| `/health` | 200 as soon as the process is up |
| `/ready` | 200 once the backfill has reached head, 503 before |
| `/status` | Last indexed block and its timestamp, per chain |
| `/metrics` | Prometheus metrics exposed by Ponder |

```sh
$ curl -s localhost:42069/status
{"robinhood":{"id":4663,"block":{"number":65402474,"timestamp":1789651692}}}
```

Indexer lag is `now - block.timestamp`, or the chain head's timestamp minus it. Consumers can compare the indexed timestamp with the chain head timestamp to estimate lag.

## Regenerating ABIs

The contracts live in another repo, so ABIs here can fall behind them without anything
failing. `abis/source.json` pins the `smart-contract` commit, and one command rebuilds
every file in `abis/` from exactly that commit. Needs `git` and `forge` on `PATH`.

```sh
pnpm abi:sync                 # rebuild from the pinned commit
pnpm abi:sync --pin <sha>     # move the pin (full 40-char sha), then rebuild
```

The first run clones the repo and its submodules into `.cache/`, which takes a few minutes.
To reuse a checkout you already have:

```sh
SMART_CONTRACT_DIR=../smart-contract pnpm abi:sync
```

That checkout must be on the pinned commit with a clean tree; the script refuses otherwise.
Only `event` entries are kept, since the indexer decodes logs and never calls contracts.
Commit the pin and the regenerated files together.

## Ponder patch

`patches/ponder@0.17.10.patch` raises the floor of Ponder's request limiter, `MIN_RPS`, from 3
to 15. `pnpm install` applies it, from `pnpm.patchedDependencies` in `package.json`, to
the file that runs (`dist/esm/rpc/index.js`) and to `src/rpc/index.ts`. Never edit
`node_modules` by hand, on the VPS or anywhere else.

**Why.** Ponder starts at 20 requests per second, multiplies that limit by 0.95 on every 429,
down to `MIN_RPS`, and raises it only when each of the last ten seconds carried 90% of it. A
second carries `floor(limit)` requests at most, so at 3.47 it lets 3 through, asks for 3.13 and
never rises again; only from 10 up can a limit always rise. Live mode needs about 10 requests
per second, one per block. On 29 Sep 2026 the production limit sat at 3.47 and the indexer was
more than 5 hours behind, while the public RPC served 20 requests per second.

**Why 15.** Above the 10 that live mode needs, below the 20 the public RPC was measured to
serve. The limiter stays: a 429 still lowers the rate, so the IP of the VPS, which other
processes use against the same RPC, does not get blocked.

**Reading `rate_limit`.** Ponder logs the limit when a request has waited 15 seconds for a
slot. With the patch it is never below 15. This is the stalled limit of 29 Sep 2026:

```
WARN  Unable to find available JSON-RPC provider within expected time action=fetch_missing_blocks chain=robinhood rate_limit=[3.4728750000000006] is_active=[true] is_warming_up=[false] (15s)
```

```sh
pm2 logs farmenta-indexer --nostream --lines 100000 | grep -o 'rate_limit=\[[^]]*\]' | sort | uniq -c
```

**Upgrading Ponder means reviewing the patch.** It is written for 0.17.10: `pnpm install`
refuses another version while the patch is registered (`ERR_PNPM_UNUSED_PATCH`),
`test/ponderPatch.test.ts` fails when the installed floor is not 15, and
`test/ponderLimiter.test.ts` runs the installed limiter against 429s. Read the limiter in the
new `src/rpc/index.ts`, make the patch again with `pnpm patch ponder@<version>` and
`pnpm patch-commit`, and keep its entry in `package.json`: pnpm 10.15 writes it to a new
`pnpm-workspace.yaml`.

**The patch makes pnpm 10 a requirement.** pnpm 10 writes the patch hash to the lockfile in a
form pnpm 9 rejects, so `engines.pnpm` in `package.json` stops an older pnpm with a message
that names the version. Install with `corepack pnpm install --frozen-lockfile`, and never with
`--no-frozen-lockfile` on the server: that rewrites the lockfile.

## Deploy (VPS, pm2)

The indexer runs on the lp-monitor-v2 VPS and shares its Postgres **server**, but not its
database: it gets database `farmenta` and its own role.

**1. Database and role — once.** On the VPS, as a Postgres superuser:

```sh
psql -U postgres -f scripts/create-db-role.sql
psql -U postgres -c '\password farmenta_indexer'     # prompts; nothing lands in shell history
```

The script creates the role without a password, so no secret passes through argv or a file;
the role cannot log in until the second command sets one.

Postgres lets every role connect to every database by default, so the script also revokes
that default on `lpmon`, after granting `CONNECT` back to the roles that own tables there.
Prove the isolation; this must be refused:

```sh
$ psql -h 127.0.0.1 -U farmenta_indexer -d lpmon -c 'select 1'
Password for user farmenta_indexer:
psql: error: ... FATAL:  permission denied for database "lpmon"
```

**2. Code and environment.**

```sh
git clone https://github.com/farmenta-defi/indexer.git && cd indexer
corepack pnpm install --frozen-lockfile
cp .env.example .env && chmod 600 .env
```

`corepack pnpm`, not the `pnpm` on the `PATH`: on this VPS that one is 9.15.9, which cannot
install this repo ([Ponder patch](#ponder-patch)).

`chmod 600` because the file holds the database password and the RPC key. Fill it in: the
production `PONDER_RPC_URL`, `DATABASE_URL` for the `farmenta_indexer` role (shape in
`.env.example`), `FARMENTA_DEPLOYMENT` for the target deployment, and a `PORT` that is free on the
VPS — 42070 already belongs to the lp-monitor-v2 indexer. Leave `START_BLOCK_FLOOR` and
`POSTGRES_PASSWORD` empty; the latter is only for the local Docker database.

pm2 must run under Node ≥ 22 (on this VPS: nvm), since it starts the indexer with its own
`node`.

**3. Start.**

```sh
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs farmenta-indexer
curl -s localhost:<PORT>/status
```

Ponder logs the database as host, port and name, without credentials. It does print the full
RPC URL when a request fails, and configured RPC URLs may contain API keys: treat `pm2 logs`
output as secret and strip the key before pasting it anywhere.

**4. Update.** `git pull && corepack pnpm install --frozen-lockfile && pm2 restart farmenta-indexer`.
Ponder keeps its RPC cache in the `ponder_sync` schema, so a change to the schema or to the
handlers re-runs indexing from cached logs rather than from the RPC. The Ponder version is
pinned exactly in `package.json`, and the [Ponder patch](#ponder-patch) is written for that
version; upgrade it deliberately, not as a side effect.

Run exactly one instance per database schema.

## License

MIT
