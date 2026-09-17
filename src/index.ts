import { ponder } from "ponder:registry";

// Ponder refuses to start with no indexing function, and it only fetches logs for events
// that have one. This handler is the scaffold's single subscription: it makes the backfill
// walk PoolManager `Initialize` from the deploy block to head, which is what /status then
// reports on. It writes nothing; FAR-34 replaces the body with the `pool` table.
ponder.on("PoolManager:Initialize", async () => {});
