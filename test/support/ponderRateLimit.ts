// Ponder's request limiter, as far as its arithmetic goes (FAR-84). Ponder keeps one
// requests-per-second limit per RPC: every 429 multiplies it by RPS_DECREASE_FACTOR, down to
// MIN_RPS, and it is multiplied by RPS_INCREASE_FACTOR only when every second of the last ten
// carried at least RPS_INCREASE_QUALIFIER of it. The constants are not exported, so they are
// read from the source text.

export type RateLimit = {
  initialMaxRps: number;
  minRps: number;
  maxRps: number;
  increaseFactor: number;
  decreaseFactor: number;
  increaseQualifier: number;
};

const NAMES: Record<keyof RateLimit, string> = {
  initialMaxRps: "INITIAL_MAX_RPS",
  minRps: "MIN_RPS",
  maxRps: "MAX_RPS",
  increaseFactor: "RPS_INCREASE_FACTOR",
  decreaseFactor: "RPS_DECREASE_FACTOR",
  increaseQualifier: "RPS_INCREASE_QUALIFIER",
};

function readConstant(source: string, name: string): number {
  const found = [...source.matchAll(new RegExp(`^const ${name} = ([0-9][0-9_.]*);$`, "gm"))];
  const value = found[0]?.[1];
  if (found.length !== 1 || value === undefined) {
    throw new Error(`${name}: expected one declaration, found ${found.length}`);
  }
  return Number(value.replaceAll("_", ""));
}

/** The six constants of the limiter. Throws when one is missing, which is what an upgrade that renames it looks like. */
export function readRateLimit(source: string): RateLimit {
  const limits = {} as RateLimit;
  for (const key of Object.keys(NAMES) as (keyof RateLimit)[]) {
    limits[key] = readConstant(source, NAMES[key]);
  }
  if (!(limits.increaseFactor > 1) || !(limits.decreaseFactor > 0 && limits.decreaseFactor < 1)) {
    throw new Error("the limit must rise by a factor above 1 and fall by one between 0 and 1");
  }
  return limits;
}

/**
 * Whether a limit can ever rise. Ponder refuses a request once `count + 1 > limit`, so a second
 * carries `floor(limit)` requests at most, and the limit rises only when that reaches
 * `limit * RPS_INCREASE_QUALIFIER`. At 3.47 that is 3 against 3.13: never.
 */
export function canRise(limits: RateLimit, limit: number): boolean {
  return Math.floor(limit) >= limit * limits.increaseQualifier;
}

/** The limits a run of 429s passes through, from INITIAL_MAX_RPS down to the floor. */
export function descent(limits: RateLimit): number[] {
  const passed = [limits.initialMaxRps];
  for (let limit = limits.initialMaxRps; limit > limits.minRps; ) {
    limit = Math.max(limit * limits.decreaseFactor, limits.minRps);
    passed.push(limit);
  }
  return passed;
}

/**
 * Climbing from `from` once the 429s have stopped: the limit it stalls at, or null when it
 * gets back to INITIAL_MAX_RPS. A stalled limit stays until the process restarts.
 */
export function stallAbove(limits: RateLimit, from: number): number | null {
  for (let limit = from; limit < limits.initialMaxRps; limit *= limits.increaseFactor) {
    if (!canRise(limits, limit)) return limit;
  }
  return null;
}
