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

// Live pools on Robinhood Chain, keys and ids as pinned by smart-contract's fork fixtures
// (test/base/Fixtures.sol), where `record` proves each key against the PoolManager. They
// cover native ETH, the dynamic-fee flag 0x800000 and hooked pools.
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const ROBINHOOD: [string, PoolKey, string][] = [
  [
    "ETH/USDG dynamic fee, tickSpacing 1, hooked",
    { currency0: zeroAddress, currency1: USDG, fee: 0x800000, tickSpacing: 1, hooks: "0x78257a554194C3ba10a59357B500788934F34080" },
    "0x80399a859416860c92785ff7f994e67ecbcda12d3f0adb75e0c2466b9bfacf30",
  ],
  [
    "ETH/USDG fee 460, no hook",
    { currency0: zeroAddress, currency1: USDG, fee: 460, tickSpacing: 9, hooks: zeroAddress },
    "0x54f7883914619af9105355bf83ed678bcf9f63560218ac61c9963b9503d0ba32",
  ],
  [
    "WETH/USDG fee 200, both ERC-20",
    { currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", currency1: USDG, fee: 200, tickSpacing: 4, hooks: zeroAddress },
    "0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6",
  ],
  [
    "ETH/USDG dynamic fee, tickSpacing 60, hooked",
    { currency0: zeroAddress, currency1: USDG, fee: 0x800000, tickSpacing: 60, hooks: "0x42554Fa546995A393D19B3880D3a4C6709298080" },
    "0x30dac7167c36242d1bacfd30561d444cf014529ee55978991d03e4ee178e725a",
  ],
  [
    "FIG/BALLS meme pool on the Doppler hook",
    {
      currency0: "0x41F4267525a8AFf329540eF24fD83d9044758B33",
      currency1: "0x7384d1F183526d83aad28bA5A5eD6dceeA211E18",
      fee: 0x800000,
      tickSpacing: 8,
      hooks: "0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544",
    },
    "0xc6451046bf06c20295032cf6e05e85bb1ca35fd7aebaf30c59c33350fe3c776e",
  ],
];

describe("poolIdOf", () => {
  describe("positive", () => {
    it("equals keccak256(abi.encode(PoolKey)) for a live v4 pool", () => {
      assert.equal(poolIdOf(ETH_USDC), ETH_USDC_ID);
    });

    for (const [name, key, id] of ROBINHOOD) {
      it(`matches Robinhood Chain: ${name}`, () => assert.equal(poolIdOf(key), id));
    }
  });

  describe("negative", () => {
    it("gives a different id when any one field of the key differs", () => {
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

    it("throws on a key that is not a PoolKey rather than hashing it", () => {
      assert.throws(() => poolIdOf({ ...ETH_USDC, hooks: "0x1234" as PoolKey["hooks"] }));
      assert.throws(() => poolIdOf({ ...ETH_USDC, fee: 2 ** 24 }));
    });
  });

  describe("edge case", () => {
    it("does not depend on address checksum casing, as event args and config differ in it", () => {
      const lower = { ...ETH_USDC, currency1: ETH_USDC.currency1.toLowerCase() as PoolKey["currency1"] };
      assert.equal(poolIdOf(lower), ETH_USDC_ID);
    });

    // Reference from `cast keccak $(cast abi-encode ...)`, not from this code.
    it("hashes the all-zero key instead of treating zero fields as missing", () => {
      const zero: PoolKey = { currency0: zeroAddress, currency1: zeroAddress, fee: 0, tickSpacing: 0, hooks: zeroAddress };
      assert.equal(poolIdOf(zero), "0xdfded4ed5ac76ba7379cfe7b3b0f53e768dca8d45a34854e649cfc3c18cbd9cd");
    });
  });
});
