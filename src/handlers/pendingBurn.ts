import type { Address } from "viem";

import { loan, pendingBurn } from "../../ponder.schema.ts";
import { LOAN_STATUS } from "../lib/loan.ts";
import { lower, type Db, type Log } from "./event.ts";

// A market burns a position in custody only on the full branch of `liquidate`, and that
// branch emits `Liquidate` with `fullSeizure` set later in the same transaction (spec §8
// step 4, FAR-51). The burn is held here until that `Liquidate` confirms it. A burn the flag
// does not confirm is an error, not a liquidation: the loan must not leave the keeper's list
// on a path nobody indexed.

/** Called for every PositionManager burn. Holds it when a market burned a loan in custody. */
export async function holdBurn(db: Db, event: Log<{ from: Address; tokenId: bigint }>) {
  const market = lower(event.args.from);
  const { tokenId } = event.args;
  const held = await db.find(loan, { market, tokenId });
  if (held?.status !== LOAN_STATUS.inCustody) return;

  const earlier = await db.find(pendingBurn, { market });
  if (earlier) throw unconfirmed(market, earlier.tokenId, earlier.transactionHash);
  await db.insert(pendingBurn).values({
    market,
    tokenId,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    transactionHash: event.transaction.hash,
  });
}

/**
 * Called by `Liquidate`. A full seizure must release the burn of the same position in the
 * same transaction; a partial one must find no burn waiting at all.
 */
export async function releaseBurn(db: Db, event: Log<{ tokenId: bigint; fullSeizure: boolean }>) {
  const market = lower(event.log.address);
  const { tokenId, fullSeizure } = event.args;
  const burn = await db.find(pendingBurn, { market });
  const confirms = burn?.tokenId === tokenId && burn.transactionHash === event.transaction.hash;

  if (fullSeizure && !confirms) {
    throw new Error(`Liquidate on ${market} seized position ${tokenId} whole, but no burn of it came first in its transaction`);
  }
  if (!fullSeizure && burn) throw unconfirmed(market, burn.tokenId, burn.transactionHash);
  if (burn) await db.delete(pendingBurn, { market });
}

const unconfirmed = (market: Address, tokenId: bigint, transactionHash: string) =>
  new Error(`${market} burned position ${tokenId} in ${transactionHash} without a full-seizure Liquidate`);
