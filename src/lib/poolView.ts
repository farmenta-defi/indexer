import { effectiveLtBps, isRampRunning, type LtRamp } from "./ramp.ts";

// What the API adds to a `pool` row: everything that depends on the time of reading, which
// is why none of it is a column.

type RampColumns = {
  ltBps: number;
  rampLtFromBps: number | null;
  rampLtTargetBps: number | null;
  rampStart: bigint | null;
  rampDuration: bigint | null;
};

/** The ramp held in a `pool` row, or null when none is set. The four columns move together. */
export function rampOf(row: RampColumns): LtRamp | null {
  if (row.rampLtFromBps === null || row.rampLtTargetBps === null) return null;
  if (row.rampStart === null || row.rampDuration === null) return null;
  return {
    ltFromBps: row.rampLtFromBps,
    ltTargetBps: row.rampLtTargetBps,
    start: row.rampStart,
    duration: row.rampDuration,
  };
}

/** Ramp status and effective LT of a pool at time `t` (unix seconds). */
export function rampStatusAt(row: RampColumns, t: bigint) {
  const ramp = rampOf(row);
  return {
    t,
    rampRunning: isRampRunning(ramp, t),
    rampEndsAt: ramp ? ramp.start + ramp.duration : null,
    effectiveLtBps: effectiveLtBps(row.ltBps, ramp, t),
  };
}

/**
 * Seconds since the pool's newest TWAP observation, null when it has none. Compared with
 * 600 by the alert (spec §13). Never negative: `t` defaults to the server clock, which can
 * trail the chain's by a moment.
 */
export function observationAgeAt(lastObservationAt: bigint | null, t: bigint): bigint | null {
  if (lastObservationAt === null) return null;
  return t > lastObservationAt ? t - lastObservationAt : 0n;
}

/** `?t=` as unix seconds; the current time when absent; null when it is not a whole number. */
export function parseTime(raw: string | undefined, now: () => number = Date.now): bigint | null {
  if (raw === undefined) return BigInt(Math.floor(now() / 1000));
  return /^\d{1,15}$/.test(raw) ? BigInt(raw) : null;
}

/** JSON has no bigint; they go out as decimal strings, like Ponder's GraphQL does. */
export function toJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}
