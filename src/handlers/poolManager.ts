import type { Address, Hex } from "viem";

import { UNISWAP } from "../../config/uniswap.ts";
import { pool, position, uniswapPool } from "../../ponder.schema.ts";
import { poolIdOf } from "../lib/poolKey.ts";
import { lower, type Db, type Log } from "./event.ts";

type Initialize = Log<{
  id: Hex;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}>;

// `PoolListed` does not carry the PoolKey, so `Initialize` events in the indexed range are
// kept and a listing joins by id (collateralPolicy.ts). FAR-82 recovers keys for earlier
// listed pools directly in the listing handler.
export async function onInitialize(db: Db, event: Initialize) {
  const { id, currency0, currency1, fee, tickSpacing, hooks } = event.args;
  const key = { currency0, currency1, fee, tickSpacing, hooks };

  // The join is only sound if the key hashes to the id it is stored under. The PoolManager
  // guarantees it; a mismatch means the ABI or the encoding here has drifted.
  const derived = poolIdOf(key);
  if (derived !== id.toLowerCase()) throw new Error(`Initialize ${id}: PoolKey hashes to ${derived}`);

  await db.insert(uniswapPool).values({
    id,
    ...key,
    initializedBlock: event.block.number,
    initializedAt: event.block.timestamp,
  });

  // `list` does not require the pool to exist, so a listing can come first. Its key is
  // filled in here.
  const listed = await db.find(pool, { id });
  if (listed) await db.update(pool, { id }).set(key);
}

type ModifyLiquidity = Log<{
  id: Hex;
  sender: Address;
  tickLower: number;
  tickUpper: number;
  liquidityDelta: bigint;
  salt: Hex;
}>;

// The PositionManager always calls `modifyLiquidity` with `salt = bytes32(tokenId)`, so this
// event alone maps a tokenId to its pool, ticks and liquidity, where the contracts would
// read `getPoolAndPositionInfo` and `getPositionLiquidity`. Liquidity added through any other
// sender is not an NFT position; ponder.config.ts already filters on `sender`, and the
// check here holds without that filter.
export async function onModifyLiquidity(db: Db, event: ModifyLiquidity) {
  const { id, sender, tickLower, tickUpper, liquidityDelta, salt } = event.args;
  if (lower(sender) !== UNISWAP.positionManager.address) return;

  const tokenId = BigInt(salt);
  // The mint's `Transfer` comes first in the same transaction. No row means START_BLOCK_FLOOR
  // skipped it (local development only); see `onTransfer`.
  const row = await db.find(position, { tokenId });
  if (!row) return;

  // A position never changes pool or range. A mismatch means the salt is not the tokenId
  // after all, and every row written from here would be wrong.
  if (row.poolId !== null && (row.poolId !== id || row.tickLower !== tickLower || row.tickUpper !== tickUpper)) {
    throw new Error(`ModifyLiquidity for position ${tokenId}: pool or range differs from the mint`);
  }
  const liquidity = row.liquidity + liquidityDelta;
  if (liquidity < 0n) throw new Error(`ModifyLiquidity for position ${tokenId}: liquidity would be ${liquidity}`);

  await db.update(position, { tokenId }).set({
    poolId: id,
    tickLower,
    tickUpper,
    liquidity,
    updatedAt: event.block.timestamp,
  });
}
