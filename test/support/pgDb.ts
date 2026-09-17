import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ReadonlyDrizzle } from "ponder";

import * as schema from "../../ponder.schema.ts";

// A real Postgres for the API routes, in memory: PGlite and drizzle are the ones Ponder itself
// depends on (pnpm does not link them at the root), and the DDL is the one Ponder would run
// for ponder.schema.ts. Joins, filters and ordering are therefore Postgres's, not a fake's.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PONDER = realpathSync(join(ROOT, "node_modules/ponder"));
const ponderRequire = createRequire(join(PONDER, "package.json"));
const load = (path: string) => import(pathToFileURL(path).href);

type Row = Record<string, unknown>;

/** A database holding `rowsOf(table)` for every table of the schema. */
export async function pgDb(rowsOf: (table: object) => Row[]): Promise<ReadonlyDrizzle<typeof schema>> {
  const { PGlite } = await load(ponderRequire.resolve("@electric-sql/pglite"));
  const { drizzle } = await load(ponderRequire.resolve("drizzle-orm/pglite"));
  const { getSql } = await load(join(PONDER, "dist/esm/drizzle/kit/index.js"));

  const pglite = new PGlite();
  // Ponder pairs every table with a `_reorg__` shadow that needs its own sequence; the API
  // never reads those.
  for (const statement of getSql(schema).tables.sql as string[]) {
    if (!statement.includes("_reorg__")) await pglite.exec(statement);
  }

  const db = drizzle(pglite, { schema, casing: "snake_case" });
  for (const table of Object.values(schema)) {
    const rows = rowsOf(table);
    if (rows.length > 0) await db.insert(table).values(rows);
  }
  return db;
}
