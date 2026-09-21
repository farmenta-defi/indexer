import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as schema from "../../ponder.schema.ts";
import type { Db } from "../../src/handlers/event.ts";

// An in-memory stand-in for Ponder's indexing store, holding the three rules the handlers
// lean on: `insert` refuses a duplicate primary key, `update` refuses a missing row, and
// `find` answers null. `delete` answers whether there was a row, as Ponder's does. It has no `client`, so a handler cannot make an `eth_call` here.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

type Row = Record<string, unknown>;
type Patch = Row | ((row: any) => Row);

// Primary keys come from the schema itself, through the drizzle that Ponder depends on, so
// a key changed in ponder.schema.ts changes here too. pnpm does not link drizzle at the root.
const ponderRequire = createRequire(join(realpathSync(join(ROOT, "node_modules/ponder")), "package.json"));
const { getTableConfig } = ponderRequire("drizzle-orm/pg-core") as {
  getTableConfig: (table: object) => {
    name: string;
    columns: { name: string; primary: boolean }[];
    primaryKeys: { columns: { name: string }[] }[];
  };
};

const TABLES = Object.values(schema).map((table) => {
  const config = getTableConfig(table);
  // Rows are keyed by property name (`poolId`), the config by column name (`pool_id`).
  const property = new Map(Object.entries(table).map(([key, column]) => [(column as { name: string }).name, key]));
  const columns = config.primaryKeys[0]?.columns ?? config.columns.filter((column) => column.primary);
  return { table: table as object, name: config.name, primaryKey: columns.map((column) => property.get(column.name)!) };
});
const PRIMARY_KEYS = new Map(TABLES.map(({ table, primaryKey }) => [table, primaryKey]));

export function fakeDb() {
  const tables = new Map<object, Map<string, Row>>();

  const rowsOf = (table: object) => {
    if (!tables.has(table)) tables.set(table, new Map());
    return tables.get(table)!;
  };
  const keyOf = (table: object, row: Row) => {
    const columns = PRIMARY_KEYS.get(table);
    if (!columns) throw new Error("fakeDb: unknown table");
    return columns.map((column) => String(row[column])).join("|");
  };
  const apply = (row: Row, patch: Patch) => ({ ...row, ...(typeof patch === "function" ? patch(row) : patch) });

  const sorted = (rows: Map<string, Row>) =>
    [...rows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);

  const db = {
    insert: (table: object) => ({
      values: (row: Row) => {
        const rows = rowsOf(table);
        const key = keyOf(table, row);
        const run = (onConflict?: Patch) => {
          const existing = rows.get(key);
          if (existing && onConflict === undefined) throw new Error(`fakeDb: duplicate key ${key}`);
          rows.set(key, existing ? apply(existing, onConflict!) : row);
        };
        return {
          // Awaiting `values()` directly is a plain insert.
          then: (resolve: () => void, reject: (error: unknown) => void) => {
            try {
              run();
              resolve();
            } catch (error) {
              reject(error);
            }
          },
          onConflictDoUpdate: async (patch: Patch) => run(patch),
        };
      },
    }),
    find: async (table: object, key: Row) => rowsOf(table).get(keyOf(table, key)) ?? null,
    delete: async (table: object, key: Row) => rowsOf(table).delete(keyOf(table, key)),
    update: (table: object, key: Row) => ({
      set: async (patch: Patch) => {
        const rows = rowsOf(table);
        const id = keyOf(table, key);
        const existing = rows.get(id);
        if (!existing) throw new Error(`fakeDb: no row ${id} to update`);
        rows.set(id, apply(existing, patch));
      },
    }),
  };

  return {
    db: db as unknown as Db,
    /** Rows of a table, in primary-key order. */
    rows: (table: object) => sorted(rowsOf(table)),
    /** Every table's rows by SQL name: what a reindex must reproduce. */
    dump: () => Object.fromEntries(TABLES.map(({ table, name }) => [name, sorted(rowsOf(table))])),
  };
}
