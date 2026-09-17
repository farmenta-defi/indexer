import type { Address, Hex } from "viem";

import { pool, uniswapPool } from "../../ponder.schema.ts";
import { poolIdOf } from "../lib/poolKey.ts";
import type { Db, Log } from "./event.ts";

type Initialize = Log<{
  id: Hex;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}>;

// `PoolListed` does not carry the PoolKey, so every `Initialize` since the PoolManager's
// deploy block is kept, and a listing joins it by id (collateralPolicy.ts).
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
