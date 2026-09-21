// `loan.status`. A position leaves custody in exactly two ways: the depositor withdraws it,
// or a full liquidation burns it (spec §8 step 4), which `Liquidate.fullSeizure` reports and
// which alone closes the loan (FAR-51). A partial liquidation leaves it in custody.
export const LOAN_STATUS = {
  inCustody: "in_custody",
  withdrawn: "withdrawn",
  liquidated: "liquidated",
} as const;

// ICollateralPolicy.Tier as emitted in `PoolListed`, stored in `pool.tier`.
export const TIER = { blueChip: 1, meme: 2 } as const;
