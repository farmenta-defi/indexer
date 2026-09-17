import { ponder } from "ponder:registry";
import { twapObservation, twapPool } from "ponder:schema";

// A pool's first observation is emitted with `index 0` and `tickCumulative 0`: that is the
// recorder initializing the pool, not broken data, and it is stored like any other.
ponder.on("TwapRecorder:Recorded", async ({ event, context }) => {
  const { poolId, index, timestamp, tickCumulative } = event.args;

  await context.db.insert(twapObservation).values({
    poolId,
    timestamp,
    index,
    tickCumulative,
    blockNumber: event.block.number,
  });

  const latest = { lastObservationAt: timestamp, lastIndex: index, lastTickCumulative: tickCumulative };
  await context.db
    .insert(twapPool)
    .values({ poolId, ...latest, observationCount: 1 })
    .onConflictDoUpdate((row) => ({ ...latest, observationCount: row.observationCount + 1 }));
});
