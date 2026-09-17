import { zeroAddress, type Address } from "viem";

import { loan, position, positionTransfer } from "../../ponder.schema.ts";
import { LOAN_STATUS } from "../lib/loan.ts";
import { lower, type Db, type Log } from "./event.ts";

// The PositionManager mints with `Transfer` first and `ModifyLiquidity` after, and burns in
// the same order, so the row exists before its pool and ticks do, and outlives its liquidity.
export async function onTransfer(db: Db, event: Log<{ from: Address; to: Address; tokenId: bigint }>) {
  const { tokenId } = event.args;
  const from = lower(event.args.from);
  const to = lower(event.args.to);

  // A market only ever burns a position in a full liquidation (spec §8 step 4), which also
  // deletes the loan on chain. `Liquidate` follows later in the same transaction.
  if (to === zeroAddress) {
    const held = await db.find(loan, { market: from, tokenId });
    if (held?.status === LOAN_STATUS.inCustody) {
      await db.update(loan, { market: from, tokenId }).set({
        status: LOAN_STATUS.liquidated,
        lastActivityAt: event.block.timestamp,
        closedAt: event.block.timestamp,
      });
    }
  }

  if (from === zeroAddress) {
    await db.insert(position).values({
      tokenId,
      owner: to,
      poolId: null,
      tickLower: null,
      tickUpper: null,
      liquidity: 0n,
      burned: false,
      mintedBlock: event.block.number,
      mintedAt: event.block.timestamp,
      updatedAt: event.block.timestamp,
    });
  } else {
    // No row means the mint was skipped by START_BLOCK_FLOOR (local development only). Its
    // liquidity cannot be rebuilt from here on, so the position stays unknown.
    const known = await db.find(position, { tokenId });
    if (!known) return;
    await db.update(position, { tokenId }).set({ owner: to, burned: to === zeroAddress, updatedAt: event.block.timestamp });
  }

  await db.insert(positionTransfer).values({
    tokenId,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    from,
    to,
  });
}
