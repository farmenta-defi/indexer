import { zeroAddress, type Address } from "viem";

import { vaultActivity, vaultBalance } from "../../ponder.schema.ts";
import { lower, marketLogKey, type Db, type Log } from "./event.ts";
import { noStaleBurn } from "./pendingBurn.ts";

// The ERC-4626 side of FarmentaMarket. Apart from the loan handlers (farmentaMarket.ts)
// because the two share nothing but the emitting address.

export async function onDeposit(
  db: Db,
  event: Log<{ sender: Address; owner: Address; assets: bigint; shares: bigint }>,
) {
  await noStaleBurn(db, event);
  const { sender, owner, assets, shares } = event.args;
  await db.insert(vaultActivity).values({
    ...marketLogKey(event),
    kind: "deposit",
    sender: lower(sender),
    owner: lower(owner),
    receiver: null,
    assetsUsdg: assets,
    shares,
  });
}

export async function onWithdraw(
  db: Db,
  event: Log<{ sender: Address; receiver: Address; owner: Address; assets: bigint; shares: bigint }>,
) {
  await noStaleBurn(db, event);
  const { sender, receiver, owner, assets, shares } = event.args;
  await db.insert(vaultActivity).values({
    ...marketLogKey(event),
    kind: "withdraw",
    sender: lower(sender),
    owner: lower(owner),
    receiver: lower(receiver),
    assetsUsdg: assets,
    shares,
  });
}

async function moveShares(db: Db, event: Log<unknown>, account: Address, delta: bigint) {
  const market = lower(event.log.address);
  const held = await db.find(vaultBalance, { market, account });
  const shares = (held?.shares ?? 0n) + delta;
  if (shares < 0n) throw new Error(`share Transfer on ${market}: ${account} would hold ${shares}`);

  const row = { shares, updatedAt: event.block.timestamp };
  await db.insert(vaultBalance).values({ market, account, ...row }).onConflictDoUpdate(row);
}

// Every share movement, so balances need nothing else: a deposit mints from the zero
// address, a withdrawal burns to it. The zero address itself holds no balance.
export async function onShareTransfer(db: Db, event: Log<{ from: Address; to: Address; value: bigint }>) {
  await noStaleBurn(db, event);
  const { value } = event.args;
  const from = lower(event.args.from);
  const to = lower(event.args.to);

  if (from !== zeroAddress) await moveShares(db, event, from, -value);
  if (to !== zeroAddress) await moveShares(db, event, to, value);

  if (from !== zeroAddress && to !== zeroAddress) {
    await db.insert(vaultActivity).values({
      ...marketLogKey(event),
      kind: "transfer",
      sender: null,
      owner: from,
      receiver: to,
      assetsUsdg: null,
      shares: value,
    });
  }
}
