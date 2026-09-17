import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zeroAddress } from "viem";

import { poolIdOf, type PoolKey } from "../src/lib/poolKey.ts";

// Uniswap v4 ETH/USDC 0.05% on Ethereum mainnet: a pool id anyone can look up, so the
// vector does not come from the code under test.
const ETH_USDC: PoolKey = {
  currency0: zeroAddress,
  currency1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  fee: 500,
  tickSpacing: 10,
  hooks: zeroAddress,
};
const ETH_USDC_ID = "0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27";

describe("poolIdOf", () => {
  it("equals keccak256(abi.encode(PoolKey)) for a live v4 pool", () => {
    assert.equal(poolIdOf(ETH_USDC), ETH_USDC_ID);
  });

  it("does not depend on address checksum casing, as event args and config differ in it", () => {
    const lower = { ...ETH_USDC, currency1: ETH_USDC.currency1.toLowerCase() as PoolKey["currency1"] };
    assert.equal(poolIdOf(lower), ETH_USDC_ID);
  });

  it("changes with every field of the key", () => {
    const other = "0x1111111111111111111111111111111111111111";
    const variants: PoolKey[] = [
      { ...ETH_USDC, currency0: other },
      { ...ETH_USDC, currency1: other },
      { ...ETH_USDC, fee: 3000 },
      { ...ETH_USDC, tickSpacing: 60 },
      { ...ETH_USDC, hooks: other },
    ];
    const ids = new Set(variants.map(poolIdOf));
    assert.equal(ids.size, variants.length);
    assert.ok(!ids.has(ETH_USDC_ID));
  });
});
