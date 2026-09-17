import * as schema from "../../ponder.schema.ts";
import type { Db } from "../../src/handlers/event.ts";

// An in-memory stand-in for Ponder's indexing store, holding the three rules the handlers
// lean on: `insert` refuses a duplicate primary key, `update` refuses a missing row, and
// `find` answers null. It has no `client`, so a handler cannot make an `eth_call` here.

type Row = Record<string, unknown>;
type Patch = Row | ((row: any) => Row);

const PRIMARY_KEYS = new Map<object, string[]>([
  [schema.uniswapPool, ["id"]],
  [schema.pool, ["id"]],
  [schema.poolTermsChange, ["poolId", "blockNumber", "logIndex"]],
  [schema.ltRamp, ["poolId", "blockNumber", "logIndex"]],
  [schema.token, ["currency"]],
  [schema.hook, ["address"]],
  [schema.twapObservation, ["poolId", "timestamp"]],
  [schema.twapPool, ["poolId"]],
]);

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
    rows: (table: object) => [...rowsOf(table).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row),
    /** Every table's rows: what a reindex must reproduce. */
    dump: () => [...PRIMARY_KEYS.keys()].map((table) => [...rowsOf(table).entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}
