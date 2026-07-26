/**
 * AASHTO horizontal curve design.
 *
 *   R_min = V^2 / (127 * (e + f))
 *
 * with V in km/h, R in metres, e the superelevation rate and f the side
 * friction factor. f falls with speed, so solving for V from R needs
 * iteration.
 */

/** AASHTO maximum side friction factors for horizontal curve design. */
const FRICTION_TABLE: ReadonlyArray<readonly [speedKph: number, f: number]> = [
  [30, 0.28],
  [40, 0.23],
  [50, 0.19],
  [60, 0.17],
  [70, 0.15],
  [80, 0.14],
  [90, 0.13],
  [100, 0.12],
  [110, 0.11],
  [120, 0.09],
]

const DEFAULT_SUPERELEVATION = 0.06

/**
 * The fixed-point iteration converges in a damped oscillation, so a handful
 * of passes is not enough at tight radii — at R=50 the sequence runs
 * 38.2, 43.6, 41.8, 42.4 km/h and is still ~0.5 m out on a round trip.
 * Iterations are a few floating-point operations each; buy convergence.
 */
const SOLVE_ITERATIONS = 12

export const sideFrictionFactor = (speedKph: number): number => {
  const first = FRICTION_TABLE[0]!
  const last = FRICTION_TABLE[FRICTION_TABLE.length - 1]!

  if (speedKph <= first[0]) return first[1]
  if (speedKph >= last[0]) return last[1]

  for (let i = 0; i < FRICTION_TABLE.length - 1; i++) {
    const [v0, f0] = FRICTION_TABLE[i]!
    const [v1, f1] = FRICTION_TABLE[i + 1]!
    if (speedKph >= v0 && speedKph <= v1) {
      const t = (speedKph - v0) / (v1 - v0)
      return f0 + t * (f1 - f0)
    }
  }

  return last[1]
}

/**
 * The speed a curve of this radius is comfortable at, in km/h.
 * Solved by fixed-point iteration because friction depends on the answer.
 */
export const designSpeedForRadius = (
  radiusMetres: number,
  superelevation: number = DEFAULT_SUPERELEVATION,
): number => {
  if (radiusMetres <= 0) {
    throw new RangeError('radius must be positive')
  }

  let speed = 60 // seed
  for (let i = 0; i < SOLVE_ITERATIONS; i++) {
    const f = sideFrictionFactor(speed)
    speed = Math.sqrt(127 * radiusMetres * (superelevation + f))
  }
  return speed
}

/** The tightest radius allowed at this speed, in metres. */
export const minimumRadiusForSpeed = (
  speedKph: number,
  superelevation: number = DEFAULT_SUPERELEVATION,
): number => {
  if (speedKph <= 0) {
    throw new RangeError('speed must be positive')
  }
  const f = sideFrictionFactor(speedKph)
  return (speedKph * speedKph) / (127 * (superelevation + f))
}
