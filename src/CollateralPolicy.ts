import { ponder } from "ponder:registry";

import {
  onHookAllowlisted,
  onLtRampScheduled,
  onPoolFrozen,
  onPoolListed,
  onPoolTermsUpdated,
  onTokenConfigured,
} from "./handlers/collateralPolicy.ts";

ponder.on("CollateralPolicy:PoolListed", ({ event, context }) => onPoolListed(context.db, event));
ponder.on("CollateralPolicy:PoolTermsUpdated", ({ event, context }) => onPoolTermsUpdated(context.db, event));
ponder.on("CollateralPolicy:PoolFrozen", ({ event, context }) => onPoolFrozen(context.db, event));
ponder.on("CollateralPolicy:LtRampScheduled", ({ event, context }) => onLtRampScheduled(context.db, event));
ponder.on("CollateralPolicy:TokenConfigured", ({ event, context }) => onTokenConfigured(context.db, event));
ponder.on("CollateralPolicy:HookAllowlisted", ({ event, context }) => onHookAllowlisted(context.db, event));
