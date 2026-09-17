import { zeroAddress, type Address, type Hex } from "viem";

import type { Log } from "../../src/handlers/event.ts";

// The n-th event of a test sits in block 100 + n, at timestamp 1_000_100 + n, with log index
// 10 + n. The three differ on purpose: on this chain `block.number` and time are easy to mix
// up (spec §14), and a handler that swapped any two would still pass with equal values.
export const blockOf = (n: number) => 100n + BigInt(n);
export const timeOf = (n: number) => 1_000_100n + BigInt(n);
export const logIndexOf = (n: number) => 10 + n;
export const txOf = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

/** A source of events in chain order. `emitter` is the contract the log comes from. */
export function chain() {
  let n = 0;
  return <Args>(args: Args, emitter: Address = zeroAddress): Log<Args> => {
    n += 1;
    return {
      args,
      block: { number: blockOf(n), timestamp: timeOf(n) },
      log: { logIndex: logIndexOf(n), address: emitter },
      transaction: { hash: txOf(n) },
    };
  };
}

/** The log right after `previous` in the same transaction, as consecutive `emit`s produce. */
export function nextLog<Args>(previous: Log<unknown>, args: Args, emitter: Address = previous.log.address): Log<Args> {
  return { ...previous, args, log: { logIndex: previous.log.logIndex + 1, address: emitter } };
}
