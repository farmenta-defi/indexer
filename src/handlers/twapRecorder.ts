import type { Hex } from "viem";

import { twapObservation, twapPool } from "../../ponder.schema.ts";
import type { Db, Log } from "./event.ts";

// A pool's first observation is emitted with `index 0` and `tickCumulative 0`: that is the
// recorder initializing the pool, not broken data, and it is stored like any other.
export async function onRecorded(
  db: Db,
  event: Log<{ poolId: Hex; index: number; timestamp: bigint; tickCumulative: bigint }>,
) {
  const { poolId, index, timestamp, tickCumulative } = event.args;

  await db.insert(twapObservation).values({
    poolId,
    timestamp,
    index,
    tickCumulative,
    blockNumber: event.block.number,
  });

  const latest = { lastObservationAt: timestamp, lastIndex: index, lastTickCumulative: tickCumulative };
  await db
    .insert(twapPool)
    .values({ poolId, ...latest, observationCount: 1 })
    .onConflictDoUpdate((row) => ({ ...latest, observationCount: row.observationCount + 1 }));
}
