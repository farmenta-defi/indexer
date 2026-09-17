# Farmenta · Indexer

[Ponder](https://ponder.sh) indexer for Farmenta — borrow USDG against Uniswap v4 LP position
NFTs on Robinhood Chain (chain id 4663).

Specification: [`farmenta-defi/docs`](https://github.com/farmenta-defi/docs) →
`ARCHITECTURE.md` §13. **The spec is the source of truth.**

The indexer records what happened on chain and nothing else. `PositionManager` has no
`ERC721Enumerable` and `FarmentaMarket` keeps no list of loans, so the list of active loans
only exists here, rebuilt from events. It does **not** compute health factors and does not
call contracts: HF moves with every price tick without any event, and a Ponder reindex
replays every `eth_call` (spec §13). HF belongs to the backend and the keeper.

> **Status: pools and listings (FAR-34).** Listed pools with their PoolKey, terms history,
> freeze, LT ramp, tokens, hooks and TWAP observations. Positions, loans and liquidations
> arrive in FAR-35.

## Layout

| Path | What |
|---|---|
| `ponder.config.ts` | Chain, RPC, database, contracts and start blocks |
| `config/uniswap.ts` | Uniswap v4 addresses (verbatim from spec §18) and their deploy blocks |
| `config/deployment.ts`, `deployments/` | Farmenta addresses, one JSON file per deployment |
| `abis/` | Event ABIs, **generated** — see [Regenerating ABIs](#regenerating-abis) |
| `abis/source.json` | The `smart-contract` commit the ABIs were built from |
| `ponder.schema.ts` | Tables — see [Tables](#tables) |
| `src/PoolManager.ts`, `src/CollateralPolicy.ts`, `src/TwapRecorder.ts` | Registers the indexing functions with Ponder, one file per contract |
| `src/handlers/` | What those functions do. They receive the store and nothing else, so they cannot make an `eth_call`, and `pnpm test` runs them against an in-memory store |
| `src/lib/` | Pure helpers (pool id, LT ramp, API view), unit-tested without Ponder |
| `src/api/index.ts` | HTTP routes on top of Ponder's built-in ones — see [Queries](#queries) |
| `scripts/create-db-role.sql` | Database and role on the shared Postgres server |
| `ecosystem.config.cjs` | pm2 process file |

## Local setup

Needs Node ≥ 22, pnpm and Docker.

```sh
pnpm install
cp .env.example .env            # then fill it in
pnpm db:up                      # Postgres 16 on 127.0.0.1:5434
pnpm dev
```

`pnpm typecheck` and `pnpm test` need neither a database nor an RPC.

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

**RPC.** `PONDER_RPC_URL` is required and has no fallback, on purpose. Alchemy's free tier
caps `eth_getLogs` at 10 blocks — about one second of this chain — and the public RPC
answers 429 (spec §13, §14), so neither can backfill from block 9,070. With a free-tier key
you can still run the indexer locally by setting `START_BLOCK_FLOOR` to a recent block, which
lifts every start block; expect 429 warnings while it catches up. Never set it in production.
Keep the floor at or below the block `CollateralPolicy` was deployed in: a `PoolTermsUpdated`,
`PoolFrozen` or `LtRampScheduled` for a pool whose `PoolListed` was skipped stops the indexer,
because a row that cannot be right is worse than no row.

**Farmenta addresses.** None is written in code: mainnet is not deployed yet (FAR-23), and
a fork or redeploy moves all of them. Copy `deployments/example.json` to
`deployments/<name>.json`, fill in each address and the block it was deployed in, and set
`FARMENTA_DEPLOYMENT=<name>`. The loader refuses the zero address, so the example cannot be
used unedited. With `FARMENTA_DEPLOYMENT` empty only the Uniswap contracts are indexed.

Time is always `block.timestamp`. On this chain `block.number` inside a contract is the L1
block (Arbitrum Orbit, spec §14), so nothing here derives time from block numbers.

## Tables

Every table is written from events alone, with no `eth_call`, so a reindex from zero rebuilds
identical rows.

| Table | Written by | Holds |
|---|---|---|
| `uniswap_pool` | PoolManager `Initialize` | PoolKey of every pool on the chain, listed or not |
| `pool` | CollateralPolicy `PoolListed`, `PoolTermsUpdated`, `PoolFrozen`, `LtRampScheduled` | Listed pools only: key, tier, terms in force, `frozen`, current ramp. `id` is the frontend's `marketId` |
| `pool_terms_change` | `PoolListed`, `PoolTermsUpdated` | Every set of terms a pool has had |
| `lt_ramp` | `LtRampScheduled` | Every ramp ever scheduled |
| `token`, `hook` | `TokenConfigured`, `HookAllowlisted` | Latest config per currency and per hook (owner console, FAR-41) |
| `twap_observation` | TwapRecorder `Recorded` | One row per observation, keyed by pool and timestamp |
| `twap_pool` | `Recorded` | Newest observation per pool: `last_observation_at` |

`PoolListed` does not carry the PoolKey, which exists only in `Initialize`, often emitted long
before Farmenta was deployed. That is why `Initialize` is indexed from the PoolManager's deploy
block, and why `uniswap_pool` exists at all. The key columns of `pool` are null only while
`Initialize` has not been seen: `list` does not require the pool to exist, and
`START_BLOCK_FLOOR` can skip the event locally. They are filled in when it arrives.

A pool's first observation has `index 0` and `tickCumulative 0`. That is the recorder
initializing the pool, not broken data. `record` is permissionless, so `twap_pool` may hold
pools that are not listed.

The effective LT is **not** a column: during a ramp it depends on the time it is read at
(spec §6.5). `updateTerms` clears the ramp on `pool`; the cleared schedule stays in `lt_ramp`.

## Queries

`/graphql` serves every table as stored. `/pools` and `/pools/:id` add what depends on the
time of reading, at `?t=<unix seconds>` (default: now):

| Field | Meaning |
|---|---|
| `rampRunning` | `t < rampStart + rampDuration`. True from the moment a ramp is scheduled, which is when the keeper's 60-second wait applies (FAR-19, spec §15 no. 18) |
| `rampEndsAt` | `rampStart + rampDuration`, null with no ramp |
| `effectiveLtBps` | Same arithmetic as `CollateralPolicy.effectiveLt`, truncation included |
| `lastObservationAt`, `observationAgeSeconds` | Newest TWAP observation and its age at `t`; the alert fires past 600 (spec §13) |

```sh
$ curl -s "localhost:42069/pools/0x52b9…34f6?t=1789657500" | jq '{effectiveLtBps, rampRunning, observationAgeSeconds}'
{ "effectiveLtBps": 7078, "rampRunning": true, "observationAgeSeconds": "1506" }
```

`uint128` values and timestamps are decimal strings, as in GraphQL. `debtCapUsdg` is USDG
with 6 decimals; `minPositionUsd` is USD 1e18 (spec §6.5).

## Status endpoint

Ponder serves these itself, on `PORT` (default 42069):

| Route | Meaning |
|---|---|
| `/health` | 200 as soon as the process is up |
| `/ready` | 200 once the backfill has reached head, 503 before |
| `/status` | Last indexed block and its timestamp, per chain |

```sh
$ curl -s localhost:42069/status
{"robinhood":{"id":4663,"block":{"number":65402474,"timestamp":1789651692}}}
```

Indexer lag is `now - block.timestamp`, or the chain head's timestamp minus it. That is what
the watchdog reads (FAR-36).

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

## Deploy (VPS, pm2)

The indexer runs on the lp-monitor-v2 VPS and shares its Postgres **server**, but not its
database: it gets database `farmenta` and its own role (spec §13).

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
pnpm install --frozen-lockfile
cp .env.example .env && chmod 600 .env
```

`chmod 600` because the file holds the database password and the RPC key. Fill it in: the
paid `PONDER_RPC_URL`, `DATABASE_URL` for the `farmenta_indexer` role (shape in
`.env.example`), `FARMENTA_DEPLOYMENT` once there is one, and a `PORT` that is free on the
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
RPC URL when a request fails, and most paid RPC URLs end in the API key: treat `pm2 logs`
output as secret and strip the key before pasting it anywhere.

**4. Update.** `git pull && pnpm install --frozen-lockfile && pm2 restart farmenta-indexer`.
Ponder keeps its RPC cache in the `ponder_sync` schema, so a change to the schema or to the
handlers re-runs indexing from cached logs rather than from the RPC. The Ponder version is
pinned exactly in `package.json`; upgrade it deliberately, not as a side effect.

Run exactly one instance per database schema.

## License

MIT
