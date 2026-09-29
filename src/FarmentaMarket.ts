import { ponder } from "ponder:registry";

import {
  onBadDebtSocialized,
  onBorrow,
  onCollateralDeposited,
  onCollateralWithdrawn,
  onCollectFees,
  onLiquidate,
  onLiquidityChanged,
  onRepay,
} from "./handlers/farmentaMarket.ts";
import { onDeposit, onShareTransfer, onWithdraw } from "./handlers/vault.ts";

ponder.on("FarmentaMarket:CollateralDeposited", ({ event, context }) => onCollateralDeposited(context.db, event, context.client));
ponder.on("FarmentaMarket:CollateralWithdrawn", ({ event, context }) => onCollateralWithdrawn(context.db, event));
ponder.on("FarmentaMarket:Borrow", ({ event, context }) => onBorrow(context.db, event));
ponder.on("FarmentaMarket:Repay", ({ event, context }) => onRepay(context.db, event));
ponder.on("FarmentaMarket:LiquidityChanged", ({ event, context }) => onLiquidityChanged(context.db, event));
ponder.on("FarmentaMarket:CollectFees", ({ event, context }) => onCollectFees(context.db, event));
ponder.on("FarmentaMarket:BadDebtSocialized", ({ event, context }) => onBadDebtSocialized(context.db, event));
ponder.on("FarmentaMarket:Liquidate", ({ event, context }) => onLiquidate(context.db, event));

// The vault side (ERC-4626). `Transfer` here is the share token, not the position NFT.
ponder.on("FarmentaMarket:Deposit", ({ event, context }) => onDeposit(context.db, event));
ponder.on("FarmentaMarket:Withdraw", ({ event, context }) => onWithdraw(context.db, event));
ponder.on("FarmentaMarket:Transfer", ({ event, context }) => onShareTransfer(context.db, event));
