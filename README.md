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

> **Status: scaffold (FAR-33).** Config, database, ABIs, deploy and the status endpoint.
> No tables yet: pools and listings arrive in FAR-34; positions, loans and liquidations in
> FAR-35.

## Layout

| Path | What |
|---|---|
| `ponder.config.ts` | Chain, RPC, database, contracts and start blocks |
| `config/uniswap.ts` | Uniswap v4 addresses (verbatim from spec §18) and their deploy blocks |
| `config/deployment.ts`, `deployments/` | Farmenta addresses, one JSON file per deployment |
| `abis/` | Event ABIs, **generated** — see [Regenerating ABIs](#regenerating-abis) |
| `abis/source.json` | The `smart-contract` commit the ABIs were built from |
| `src/index.ts` | Indexing functions |
| `src/api/index.ts` | HTTP routes on top of Ponder's built-in ones |
| `scripts/create-db-role.sql` | Database and role on the shared Postgres server |
| `ecosystem.config.cjs` | pm2 process file |

## Local setup

Needs Node ≥ 22, pnpm and Docker.

```sh
pnpm install
cp .env.example .env.local      # then fill it in
pnpm db:up                      # Postgres 16 on 127.0.0.1:5434
pnpm dev
```

`pnpm typecheck` and `pnpm test` need neither a database nor an RPC.

`.env.local` is the file the Ponder CLI loads; it is gitignored, and `.env.example` is the
only env file in the repo. Every secret lives there and nowhere else: `DATABASE_URL` carries
a password and `PONDER_RPC_URL` carries an API key, so neither is ever written out in this
README, an issue, a commit message or the pm2 process file. `.env.example` describes the
shape of each value. The Docker database has no built-in password either: `pnpm db:up`
refuses to start until `POSTGRES_PASSWORD` is set in `.env.local`.

**RPC.** `PONDER_RPC_URL` is required and has no fallback, on purpose. Alchemy's free tier
caps `eth_getLogs` at 10 blocks — about one second of this chain — and the public RPC
answers 429 (spec §13, §14), so neither can backfill from block 9,070. With a free-tier key
you can still run the indexer locally by setting `START_BLOCK_FLOOR` to a recent block, which
lifts every start block; expect 429 warnings while it catches up. Never set it in production.

**Farmenta addresses.** None is written in code: mainnet is not deployed yet (FAR-23), and
a fork or redeploy moves all of them. Copy `deployments/example.json` to
`deployments/<name>.json`, fill in each address and the block it was deployed in, and set
`FARMENTA_DEPLOYMENT=<name>`. The loader refuses the zero address, so the example cannot be
used unedited. With `FARMENTA_DEPLOYMENT` empty only the Uniswap contracts are indexed.

Time is always `block.timestamp`. On this chain `block.number` inside a contract is the L1
block (Arbitrum Orbit, spec §14), so nothing here derives time from block numbers.

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
cp .env.example .env.local && chmod 600 .env.local
```

`chmod 600` because the file holds the database password and the RPC key. Fill it in: the
paid `PONDER_RPC_URL`, `DATABASE_URL` for the `farmenta_indexer` role (shape in
`.env.example`), `FARMENTA_DEPLOYMENT` once there is one, and a `PORT` that is free on the
VPS. Leave `START_BLOCK_FLOOR` empty.

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
