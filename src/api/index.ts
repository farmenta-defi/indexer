import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { eq, graphql } from "ponder";
import { isHex } from "viem";

import { observationAgeAt, parseTime, rampStatusAt, toJson } from "../lib/poolView";

// Ponder serves /health, /ready and /status itself. /status carries the last indexed block
// and its timestamp per chain, which is what the lag watchdog reads (FAR-36). Routes for
// positions and loans arrive with their tables (FAR-35).
const app = new Hono();

// Every table, as stored.
app.use("/graphql", graphql({ db, schema }));

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

export default app;
