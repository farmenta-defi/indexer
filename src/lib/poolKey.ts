import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

// PoolKey is five static words, so `abi.encode` of the struct equals `abi.encode` of its
// fields in order. Same layout as `PoolIdLibrary.toId` in v4-core.
const POOL_KEY_ABI = [
  { type: "address" },
  { type: "address" },
  { type: "uint24" },
  { type: "int24" },
  { type: "address" },
] as const;

/** `keccak256(abi.encode(PoolKey))`, the id the PoolManager and CollateralPolicy emit. */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(POOL_KEY_ABI, [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]),
  );
}
