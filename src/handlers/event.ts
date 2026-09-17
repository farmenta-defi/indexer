import type { Context } from "ponder:registry";
import type { Hex } from "viem";

// The slice of Ponder's handler arguments the indexing functions use. They take the store
// and nothing else from the context, so none of them can reach `context.client`: every
// table is rebuilt from events alone, with no `eth_call` (FAR-34).
export type Db = Context["db"];

export type Log<Args> = {
  args: Args;
  block: { number: bigint; timestamp: bigint };
  log: { logIndex: number };
  transaction: { hash: Hex };
};
