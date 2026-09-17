import type { Context } from "ponder:registry";
import type { Address, Hex } from "viem";

// The slice of Ponder's handler arguments the indexing functions use. They take the store
// and nothing else from the context, so none of them can reach `context.client`: every
// table is rebuilt from events alone, with no `eth_call` (FAR-34).
export type Db = Context["db"];

export type Log<Args> = {
  args: Args;
  block: { number: bigint; timestamp: bigint };
  // `address` is the emitting contract: what tells the two markets apart (ponder.config.ts).
  log: { logIndex: number; address: Address };
  transaction: { hash: Hex };
};

/** Addresses as the tables key them. A decoded event argument is checksummed, `log.address` is not. */
export const lower = (address: Address) => address.toLowerCase() as Address;
