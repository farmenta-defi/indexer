import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAddress, zeroAddress, type Address } from "viem";

// Farmenta addresses are configuration, not code: there is no mainnet deployment yet
// (FAR-23), and a fork or a redeploy moves every address. FARMENTA_DEPLOYMENT names a file
// in deployments/, shaped like deployments/example.json.

export type DeployedContract = { address: Address; startBlock: number };

export type Deployment = {
  collateralPolicy: DeployedContract;
  twapRecorder: DeployedContract;
  // One FarmentaMarket per isolated market (spec §1 no. 8): blue-chip and meme.
  markets: Record<string, DeployedContract>;
};

const DEPLOYMENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../deployments");

function parseContract(value: unknown, path: string): DeployedContract {
  const { address, startBlock } = (value ?? {}) as Partial<DeployedContract>;
  if (typeof address !== "string" || !isAddress(address) || address === zeroAddress) {
    throw new Error(`${path}.address is not a deployed contract address: ${String(address)}`);
  }
  if (typeof startBlock !== "number" || !Number.isSafeInteger(startBlock) || startBlock < 0) {
    throw new Error(`${path}.startBlock must be the block the contract was deployed in`);
  }
  return { address, startBlock };
}

/** The deployment named by `name`, or `undefined` when none is configured. */
export function loadDeployment(name: string | undefined, dir = DEPLOYMENTS_DIR): Deployment | undefined {
  if (!name) return undefined;

  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) throw new Error(`FARMENTA_DEPLOYMENT=${name}, but ${file} does not exist`);

  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const markets = Object.entries((raw.markets ?? {}) as Record<string, unknown>).map(
    ([key, value]) => [key, parseContract(value, `${name}.markets.${key}`)] as const,
  );
  if (markets.length === 0) throw new Error(`${name}.markets lists no FarmentaMarket`);

  return {
    collateralPolicy: parseContract(raw.collateralPolicy, `${name}.collateralPolicy`),
    twapRecorder: parseContract(raw.twapRecorder, `${name}.twapRecorder`),
    markets: Object.fromEntries(markets),
  };
}
