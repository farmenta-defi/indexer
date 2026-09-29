import type { Context } from "ponder:registry";
import type { Address, Hex } from "viem";

// Most indexing functions take only the store. The two historical recovery handlers also
// receive Ponder's event-scoped client, which caches reads at the event block unless a read
// uses an explicit immutable latest-state override.
export type Db = Context["db"];

// Only handlers that must recover history skipped by START_BLOCK_FLOOR receive this client.
export type ChainClient = Context["client"];

export type Log<Args> = {
  args: Args;
  block: { number: bigint; timestamp: bigint };
  // `address` is the emitting contract: what tells the two markets apart (ponder.config.ts).
  log: { logIndex: number; address: Address };
  transaction: { hash: Hex };
};

/** Addresses as the tables key them. A decoded event argument is checksummed, `log.address` is not. */
export const lower = (address: Address) => address.toLowerCase() as Address;

/** Key and provenance of a row that is one log of a market: both markets share every table. */
export const marketLogKey = (event: Log<unknown>) => ({
  market: lower(event.log.address),
  blockNumber: event.block.number,
  logIndex: event.log.logIndex,
  timestamp: event.block.timestamp,
  transactionHash: event.transaction.hash,
});
