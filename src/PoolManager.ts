import { ponder } from "ponder:registry";

import { onInitialize } from "./handlers/poolManager.ts";

ponder.on("PoolManager:Initialize", ({ event, context }) => onInitialize(context.db, event));
