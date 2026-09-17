// LT ramp arithmetic, mirroring `CollateralPolicy._effectiveLt` (spec §6.5). The effective LT
// depends on the time it is read at, so it is computed here on read and never stored.

export type LtRamp = {
  ltFromBps: number;
  ltTargetBps: number;
  start: bigint;
  duration: bigint;
};

/**
 * Whether the ramp is still running at `t`: `t < start + duration`. A ramp that is
 * scheduled but has not started counts as running, because the keeper's 60-second wait
 * (FAR-19, spec §15 no. 18) applies from the moment the schedule is published.
 */
export function isRampRunning(ramp: LtRamp | null, t: bigint): boolean {
  return ramp !== null && t < ramp.start + ramp.duration;
}

/** LT in force at `t`: `ltBps` with no ramp, otherwise linear from `ltFromBps` to `ltTargetBps`. */
export function effectiveLtBps(ltBps: number, ramp: LtRamp | null, t: bigint): number {
  if (ramp === null || ramp.duration === 0n) return ltBps;
  if (t <= ramp.start) return ramp.ltFromBps;

  const elapsed = t - ramp.start;
  if (elapsed >= ramp.duration) return ramp.ltTargetBps;

  // Integer division truncates exactly as the contract's does.
  const fall = BigInt(ramp.ltFromBps - ramp.ltTargetBps);
  return ramp.ltFromBps - Number((fall * elapsed) / ramp.duration);
}
