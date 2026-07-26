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

/** The top of the AASHTO friction table — see MAX_TABULATED_SPEED_KPH. */
const LAST_TABLE_ENTRY = FRICTION_TABLE[FRICTION_TABLE.length - 1]!

/**
 * The highest speed the AASHTO friction table covers. Above this, side
 * friction factor is unknown (sideFrictionFactor clamps to the table's last
 * value) so any computed design speed is capped here rather than trusted.
 */
export const MAX_TABULATED_SPEED_KPH = LAST_TABLE_ENTRY[0]

/**
 * The fixed-point iteration converges in a damped oscillation (e.g. at R=50
 * the sequence runs 38.2, 43.6, 41.8, 42.4 km/h). The contraction ratio is
 * strong — roughly 0.28 or tighter across the whole table — so a handful of
 * passes is already enough to converge. 12 is chosen generously anyway:
 * each iteration is a few floating-point operations, so the extra margin
 * is essentially free.
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
 *
 * Clamped to MAX_TABULATED_SPEED_KPH: above that, the AASHTO friction table
 * has no data, so the "true" computed value (which would otherwise grow
 * without bound as radius increases) is not meaningful. A result equal to
 * the cap means the curve is not the limiting factor for design speed — real
 * road design would pick the design speed from the road's class and check
 * this radius against it, not the other way round. Callers rendering this to
 * a player should show it as "≥120 km/h" (or similar) rather than an exact
 * figure, since the exact figure is not physically meaningful past the cap.
 */
export const designSpeedForRadius = (
  radiusMetres: number,
  superelevation: number = DEFAULT_SUPERELEVATION,
): number => {
  if (radiusMetres <= 0) {
    throw new RangeError('radius must be positive')
  }
  if (!Number.isFinite(superelevation) || superelevation < 0) {
    throw new RangeError('superelevation must be a non-negative finite number')
  }

  let speed = 60 // seed
  for (let i = 0; i < SOLVE_ITERATIONS; i++) {
    const f = sideFrictionFactor(speed)
    speed = Math.sqrt(127 * radiusMetres * (superelevation + f))
  }
  return Math.min(speed, MAX_TABULATED_SPEED_KPH)
}

/**
 * The tightest radius allowed at this speed, in metres.
 *
 * Unlike designSpeedForRadius, this is intentionally left unclamped above
 * MAX_TABULATED_SPEED_KPH. Speed here is a design input chosen by the
 * caller (e.g. "what radius does a 140 km/h highway need?"), not a computed
 * readout of an ambiguous physical quantity — asking the question above the
 * tabulated range is legitimate, it just extrapolates the last table entry's
 * friction factor. This asymmetry with designSpeedForRadius is deliberate.
 */
export const minimumRadiusForSpeed = (
  speedKph: number,
  superelevation: number = DEFAULT_SUPERELEVATION,
): number => {
  if (speedKph <= 0) {
    throw new RangeError('speed must be positive')
  }
  if (!Number.isFinite(superelevation) || superelevation < 0) {
    throw new RangeError('superelevation must be a non-negative finite number')
  }
  const f = sideFrictionFactor(speedKph)
  return (speedKph * speedKph) / (127 * (superelevation + f))
}
