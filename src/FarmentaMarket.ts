import { ponder } from "ponder:registry";

import { onBorrow, onCollateralDeposited, onCollateralWithdrawn, onRepay } from "./handlers/farmentaMarket.ts";

ponder.on("FarmentaMarket:CollateralDeposited", ({ event, context }) => onCollateralDeposited(context.db, event));
ponder.on("FarmentaMarket:CollateralWithdrawn", ({ event, context }) => onCollateralWithdrawn(context.db, event));
ponder.on("FarmentaMarket:Borrow", ({ event, context }) => onBorrow(context.db, event));
ponder.on("FarmentaMarket:Repay", ({ event, context }) => onRepay(context.db, event));
