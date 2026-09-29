import { zeroAddress, type Address } from "viem";

import { position, positionTransfer } from "../../ponder.schema.ts";
import { lower, type Db, type Log } from "./event.ts";
import { holdBurn } from "./pendingBurn.ts";

// The PositionManager mints with `Transfer` first and `ModifyLiquidity` after, and burns in
// the same order, so the row exists before its pool and ticks do, and outlives its liquidity.
export async function onTransfer(db: Db, event: Log<{ from: Address; to: Address; tokenId: bigint }>) {
  const { tokenId } = event.args;
  const from = lower(event.args.from);
  const to = lower(event.args.to);

  // The loan stays open until the `Liquidate` that must follow (pendingBurn.ts).
  if (to === zeroAddress) await holdBurn(db, event);

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
    // No row means the mint was skipped by START_BLOCK_FLOOR. A later collateral deposit
    // may recover the position's current state.
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
