import { Hono } from "hono";
import { and, asc, eq, type ReadonlyDrizzle } from "ponder";
import { isAddress, isHex, type Address } from "viem";

import { LOAN_STATUS, TIER } from "../lib/loan.ts";
import { observationAgeAt, parseTime, rampStatusAt, toJson } from "../lib/poolView.ts";

type Schema = typeof import("../../ponder.schema.ts");

const STATUSES: string[] = Object.values(LOAN_STATUS);

/** `raw` as the lowercase address the tables hold, or null when it is not an address. */
const parseAddress = (raw: string): Address | null => {
  const address = raw.toLowerCase();
  return isAddress(address, { strict: false }) ? address : null;
};

// The routes, given a store to read. Apart from index.ts, which can only be loaded inside
// Ponder (`ponder:api`), so that the tests can run them against a database of their own.
export function createApp(db: ReadonlyDrizzle<Schema>, schema: Schema) {
  const app = new Hono();

  // What a column cannot hold because it depends on the time of reading: whether the LT ramp
  // is still running (the keeper's 60-second wait, FAR-19), the effective LT (spec §6.5) and
  // the age of the newest TWAP observation (FAR-18, 600-second alert). `?t=` is unix seconds
  // and defaults to now.
  const listedPools = () =>
    db
      .select({ pool: schema.pool, lastObservationAt: schema.twapPool.lastObservationAt })
      .from(schema.pool)
      .leftJoin(schema.twapPool, eq(schema.twapPool.poolId, schema.pool.id));

  type ListedPool = Awaited<ReturnType<typeof listedPools>>[number];

  const view = ({ pool, lastObservationAt }: ListedPool, t: bigint) => ({
    ...pool,
    ...rampStatusAt(pool, t),
    lastObservationAt,
    observationAgeSeconds: observationAgeAt(lastObservationAt, t),
  });

  app.get("/pools", async (c) => {
    const t = parseTime(c.req.query("t"));
    if (t === null) return c.json({ error: "t must be unix seconds" }, 400);

    const rows = await listedPools();
    return c.json(toJson(rows.map((row) => view(row, t))));
  });

  app.get("/pools/:id", async (c) => {
    const t = parseTime(c.req.query("t"));
    if (t === null) return c.json({ error: "t must be unix seconds" }, 400);

    const id = c.req.param("id").toLowerCase();
    if (!isHex(id) || id.length !== 66) return c.json({ error: "id must be a 32-byte pool id" }, 400);

    const [row] = await listedPools().where(eq(schema.pool.id, id));
    if (!row) return c.json({ error: "pool is not listed" }, 404);
    return c.json(toJson(view(row, t)));
  });

  // A loan with what its consumers would otherwise join by hand: the position's range and
  // liquidity, and the tier of its pool. Both are null when START_BLOCK_FLOOR skipped the
  // mint; `tier` is also null for a pool that is not listed, which a market never accepts.
  const loans = () =>
    db
      .select({
        loan: schema.loan,
        tickLower: schema.position.tickLower,
        tickUpper: schema.position.tickUpper,
        liquidity: schema.position.liquidity,
        tier: schema.pool.tier,
      })
      .from(schema.loan)
      .leftJoin(schema.position, eq(schema.position.tokenId, schema.loan.tokenId))
      .leftJoin(schema.pool, eq(schema.pool.id, schema.loan.poolId));

  type LoanRow = Awaited<ReturnType<typeof loans>>[number];
  const loanView = ({ loan, ...joined }: LoanRow) => ({ ...loan, ...joined });
  const inOrder = [asc(schema.loan.market), asc(schema.loan.tokenId)];

  // There is no debt here, and there cannot be: see `loan` in ponder.schema.ts. Every
  // consumer confirms with `debtOf(tokenId)`.
  app.get("/loans", async (c) => {
    const { owner, market, status } = c.req.query();
    const ownerAddress = owner === undefined ? undefined : parseAddress(owner);
    const marketAddress = market === undefined ? undefined : parseAddress(market);
    if (ownerAddress === null) return c.json({ error: "owner must be an address" }, 400);
    if (marketAddress === null) return c.json({ error: "market must be an address" }, 400);
    if (status !== undefined && !STATUSES.includes(status)) {
      return c.json({ error: `status must be one of ${STATUSES.join(", ")}` }, 400);
    }

    const rows = await loans()
      .where(
        and(
          ownerAddress && eq(schema.loan.owner, ownerAddress),
          marketAddress && eq(schema.loan.market, marketAddress),
          status === undefined ? undefined : eq(schema.loan.status, status),
        ),
      )
      .orderBy(...inOrder);
    return c.json(toJson(rows.map(loanView)));
  });

  // What the keeper watches (FAR-18, FAR-19): loans still in custody, on a meme pool, that
  // have ever borrowed. Candidates only: a repaid loan stays on the list, so the keeper
  // confirms each with `debtOf`. Like `/pools`, the answer is as of the last indexed block;
  // read `/status` first.
  app.get("/loans/keeper-candidates", async (c) => {
    const rows = await loans()
      .where(
        and(
          eq(schema.loan.status, LOAN_STATUS.inCustody),
          eq(schema.loan.everBorrowed, true),
          eq(schema.pool.tier, TIER.meme),
        ),
      )
      .orderBy(...inOrder);
    return c.json(toJson(rows.map(loanView)));
  });

  // An address's positions: the NFTs in its wallet, and the ones a market holds for it.
  // `PositionManager` has no `ERC721Enumerable`, so this is the only list (spec §12).
  app.get("/portfolio/:address", async (c) => {
    const address = parseAddress(c.req.param("address"));
    if (address === null) return c.json({ error: "address must be an address" }, 400);

    const positions = await db
      .select()
      .from(schema.position)
      .where(eq(schema.position.owner, address))
      .orderBy(asc(schema.position.tokenId));
    const inCustody = await loans()
      .where(and(eq(schema.loan.owner, address), eq(schema.loan.status, LOAN_STATUS.inCustody)))
      .orderBy(...inOrder);
    return c.json(toJson({ address, positions, loans: inCustody.map(loanView) }));
  });

  return app;
}
