import type { IdmParams } from './idm'

/**
 * Driver perception–reaction time at a signal change, seconds.
 *
 * One second, per the spec, and deliberately *not* the 2.5s that AASHTO's
 * Green Book uses for stopping sight distance. That figure is a conservative
 * high-percentile allowance for a hazard the driver is not expecting; a driver
 * approaching a signalised junction is already looking at the signal. ITE's
 * change-interval practice uses 1.0s of perception–reaction for this exact
 * calculation, and measured responses to an anticipated amber cluster around
 * one second.
 *
 * The value sets the width of the dilemma zone directly — every extra second
 * adds `v` metres of "proceed", so at 14 m/s a second is 14m of road. It is
 * therefore a visible tuning knob rather than an internal detail: too large
 * and cars sail through ambers, too small and they emergency-brake at them.
 */
export const REACTION_TIME = 1.0

/** A vehicle's position relative to a stop line it is approaching. */
export type StopLineApproach = {
  /** Metres per second. Non-negative. */
  readonly speed: number
  /** Distance to the stop line, metres. Negative once the line is behind. */
  readonly distance: number
}

/**
 * Whether a vehicle approaching a stop line should proceed rather than stop.
 *
 * Spec 4.3's dilemma-zone rule, verbatim:
 *
 *     d < v²/(2b) + v·t_react  →  proceed
 *
 * The right-hand side is the road a vehicle needs to come to rest without
 * braking harder than it finds comfortable: `v·t_react` covered while the
 * driver is still reacting, then `v²/(2b)` of actual braking. Inside that
 * distance there is no way to stop at the line at deceleration `b`, so the
 * honest answer is to go through. A caller that placed the phantom anyway
 * would get an emergency stop, which is the failure this exists to prevent.
 *
 * The boundary belongs to stopping: at exactly the stopping distance the
 * vehicle can still make the line, so it stops. `d` and the threshold are both
 * measured from the same reference point, so a vehicle already past the line
 * (`d < 0`) always proceeds — including one at rest, for which the threshold
 * is zero.
 *
 * ## This cannot currently be composed with `Lane.setObstacle`
 *
 * This answers a PER-VEHICLE question — one speed, one distance, one verdict.
 * `Lane.setObstacle` sets ONE stop line for the WHOLE lane, and every vehicle
 * short of it brakes for it. The two do not meet, and there is no third
 * option: a lane cannot be told "stop, except for the car already committed".
 *
 * Measured on a lane with a line at station 1000, a leader 72m short of it
 * (this rule says proceed) and a follower 192m short (this rule says stop),
 * both at 20 m/s with a comfortable deceleration of 2.0:
 *
 *   setObstacle(1000)      the leader decelerates at 5.09 m/s² — 2.5x
 *                          comfortable, and precisely the emergency stop the
 *                          paragraph above says this function exists to
 *                          prevent.
 *   setObstacle(undefined) the follower crosses the line at full speed, having
 *                          been told nothing at all.
 *
 * So the honest state of things is that this function is correct and has no
 * caller that can act on its answer — `setObstacle` has no caller either.
 * Closing the gap needs a per-vehicle stopping mechanism inside `Lane`: a
 * phantom leader admitted only for the vehicles this rule says should stop,
 * rather than one parked in front of everybody. That is a signal-system change
 * and is deliberately not made here. `obstacle.test.ts` pins the numbers above
 * as characterised behaviour so this note cannot quietly stop being true.
 */
export const canClearBeforeStopping = (
  approach: StopLineApproach,
  params: IdmParams,
): boolean => {
  const { speed: v, distance: d } = approach
  const b = params.comfortableDeceleration

  if (!(b > 0)) throw new RangeError('comfortableDeceleration must be positive')
  if (!Number.isFinite(v) || v < 0) {
    throw new RangeError(`speed must be finite and non-negative, got ${v}`)
  }
  if (Number.isNaN(d)) throw new RangeError('distance must be a number')

  return d < (v * v) / (2 * b) + v * REACTION_TIME
}
