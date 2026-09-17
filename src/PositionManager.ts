import { ponder } from "ponder:registry";

import { onTransfer } from "./handlers/positionManager.ts";

ponder.on("PositionManager:Transfer", ({ event, context }) => onTransfer(context.db, event));
