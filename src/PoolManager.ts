import { ponder } from "ponder:registry";

import { onInitialize, onModifyLiquidity } from "./handlers/poolManager.ts";

ponder.on("PoolManager:Initialize", ({ event, context }) => onInitialize(context.db, event));
ponder.on("PoolManager:ModifyLiquidity", ({ event, context }) => onModifyLiquidity(context.db, event));
