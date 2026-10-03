import { custom, http, type Transport } from "viem";

// Robinhood Chain makes about 10 blocks a second and Ponder's realtime sync fetches every one
// of them with eth_getBlockByNumber, Farmenta events or not: about 850,000 calls a day, 93% of
// the indexer's RPC traffic. dRPC bills every call alike ($6 per million), so those block reads
// go to the free public RPC first. The public RPC is slow and answers 429 (spec §13, §14), so
// any failure, slow answer or missing block falls back to the paid RPC, and everything else
// (eth_getLogs above all) goes straight to it.

/** Methods the free RPC answers first. */
export const BLOCK_METHODS: ReadonlySet<string> = new Set(["eth_getBlockByNumber", "eth_getBlockByHash"]);

/** Past this, a block read from the free RPC is given up and asked of the paid one. */
export const FREE_TIMEOUT_MS = 3_000;

const REPORT_EVERY_MS = 10 * 60_000;

export type SplitCounts = { free: number; fallback: number; paid: number };

type Request = (args: { method: string; params?: unknown }) => Promise<unknown>;

/** The routing itself, apart from viem, so it can be tested without a network. */
export function splitRequest(paid: Request, free: Request, counts: SplitCounts): Request {
  return async ({ method, params }) => {
    if (BLOCK_METHODS.has(method)) {
      try {
        const block = await free({ method, params });
        // A null block is one the free RPC has not seen yet, not an answer.
        if (block !== null && block !== undefined) {
          counts.free++;
          return block;
        }
      } catch {
        // Rate limited, timed out or down: the paid RPC answers instead.
      }
      counts.fallback++;
    }
    counts.paid++;
    return paid({ method, params });
  };
}

/**
 * Block reads to `freeUrl` with `paidUrl` behind them, every other call to `paidUrl`.
 * Logs, every 10 minutes, how many calls each side answered, so the dRPC bill can be checked
 * against the indexer.
 */
export function blocksFromFreeRpc(paidUrl: string, freeUrl: string): Transport {
  const counts: SplitCounts = { free: 0, fallback: 0, paid: 0 };
  setInterval(() => {
    console.info(`rpc split, last 10 min: free=${counts.free} paid=${counts.paid} (fallback=${counts.fallback})`);
    counts.free = counts.fallback = counts.paid = 0;
  }, REPORT_EVERY_MS).unref();

  return (config) => {
    const { chain } = config;
    // Ponder hands every transport its own 10 second timeout, so the free one is built with
    // FREE_TIMEOUT_MS as its own option and without Ponder's.
    const paid = http(paidUrl)({ ...config, retryCount: 0 }).request as Request;
    const free = http(freeUrl, { timeout: FREE_TIMEOUT_MS })({ chain, retryCount: 0 }).request as Request;
    return custom({ request: splitRequest(paid, free, counts) })(config);
  };
}
