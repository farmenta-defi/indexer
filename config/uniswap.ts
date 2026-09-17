// Uniswap v4 on Robinhood Chain. Addresses are copied verbatim from docs/ARCHITECTURE.md §18,
// the single source of truth. Never rebuild an address from a truncated form (§18, incident
// of 26 Aug 2026).
//
// startBlock is the block the contract was deployed in, so pools and positions created
// before Farmenta existed are still seen (FAR-34, FAR-35). Found on 17 Sep 2026 by bisecting
// `eth_getCode` on an archive RPC: no code at the block before, code at the block named.
export const UNISWAP = {
  poolManager: {
    address: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    startBlock: 9_070,
  },
  positionManager: {
    address: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
    startBlock: 9_073,
  },
} as const;
