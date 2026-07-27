export type IdmState = {
  /** Metres per second. */
  readonly speed: number
  /** Bumper-to-bumper gap to the leader, metres. `Infinity` for open road. */
  readonly gap: number
  /** Leader's speed, metres per second. `Infinity` for open road. */
  readonly leaderSpeed: number
}

export type IdmParams = {
  /** `a`, metres per second squared. */
  readonly maxAcceleration: number
  /** `b`, metres per second squared. Positive. */
  readonly comfortableDeceleration: number
  /** `v0`, metres per second. */
  readonly desiredSpeed: number
  /** `s0`, metres. The gap kept when stopped. */
  readonly minimumGap: number
  /** `T`, seconds. */
  readonly headwayTime: number
}

/**
 * Free-road exponent.
 *
 * Four, per the spec. It controls how sharply acceleration tapers approaching
 * the desired speed: at 90% of `v0` a vehicle still has 34% of its
 * acceleration left, where a linear taper would leave 10%.
 */
const DELTA = 4

/**
 * Smallest gap the interaction term is evaluated at, metres.
 *
 * The term divides by the gap, so a vehicle exactly on top of another — a
 * spawn overlap, or a phantom obstacle inserted where a car already is —
 * would produce `Infinity` and then `NaN` in the position update, which is
 * silent and lands in a vertex buffer. Clamping instead yields a very large
 * braking deceleration, which is the physically sensible answer.
 */
const MIN_GAP_FOR_INTERACTION = 1e-3

/**
 * One vehicle's acceleration under the Intelligent Driver Model.
 *
 * Two terms. The free-road term accelerates toward `desiredSpeed` and vanishes
 * on reaching it. The interaction term brakes for the leader, and is built
 * from a *desired* gap that grows with both speed and closing speed — which is
 * what makes a driver brake for a much slower leader while the gap is still
 * generous, rather than waiting until it is small.
 *
 * The `max(0, …)` on the desired gap is load-bearing: without it a leader
 * pulling away would produce a negative desired gap and the term would reward
 * the driver for the leader's departure, accelerating harder than an open road
 * would.
 */
export const idmAcceleration = (state: IdmState, params: IdmParams): number => {
  const { maxAcceleration: a, comfortableDeceleration: b } = params
  const { desiredSpeed: v0, minimumGap: s0, headwayTime: T } = params

  if (!(v0 > 0)) throw new RangeError('desiredSpeed must be positive')
  if (!(a > 0)) throw new RangeError('maxAcceleration must be positive')
  if (!(b > 0)) throw new RangeError('comfortableDeceleration must be positive')

  const v = state.speed
  const freeTerm = 1 - (v / v0) ** DELTA

  if (!Number.isFinite(state.gap)) return a * freeTerm

  const closingSpeed = v - state.leaderSpeed
  const desiredGap =
    s0 + Math.max(0, v * T + (v * closingSpeed) / (2 * Math.sqrt(a * b)))

  const gap = Math.max(state.gap, MIN_GAP_FOR_INTERACTION)
  const interactionTerm = (desiredGap / gap) ** 2

  return a * (freeTerm - interactionTerm)
}

/**
 * Presets. Spec 4.3 calls stability a design knob rather than a correctness
 * constraint: low `a` and low `T` produce the dramatic stop-and-go waves that
 * make traffic readable, high values produce calm flow.
 */
export const HIGHWAY_PARAMS: IdmParams = {
  maxAcceleration: 2.0,
  comfortableDeceleration: 2.0,
  desiredSpeed: 100 / 3.6,
  minimumGap: 2,
  headwayTime: 1.5,
}

export const TOWN_PARAMS: IdmParams = {
  maxAcceleration: 1.0,
  comfortableDeceleration: 1.5,
  desiredSpeed: 50 / 3.6,
  minimumGap: 2,
  headwayTime: 1.0,
}
