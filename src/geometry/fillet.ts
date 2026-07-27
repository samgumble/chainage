import {
  type Vec2, add, scale, normalize, signedAngleBetween, angleOf,
} from './vec2'
import { Arc } from './primitives'

export type Fillet = {
  readonly arc: Arc
  /** Where the incoming tangent leaves the straight and enters the curve. */
  readonly tangentIn: Vec2
  /** Where the curve rejoins the outgoing straight. */
  readonly tangentOut: Vec2
  /** Distance from the corner to each tangent point. */
  readonly tangentDistance: number
  /** Signed turn angle, positive counter-clockwise. */
  readonly deflection: number
}

/**
 * Below this deflection the corner is treated as straight and needs no curve.
 *
 * Exported because `buildPolylineAlignment` must distinguish `filletCorner`'s
 * two `null` results — "straight, no curve needed" from "too sharp to fillet"
 * — by measuring the deflection itself before calling. Two thresholds that
 * drifted apart would produce corners that are straight to one and turning to
 * the other.
 */
export const MIN_DEFLECTION = 1e-6

/**
 * Default bound on tangent distance, as a multiple of radius.
 *
 * T = R * tan(|deflection| / 2), which diverges as the deflection approaches
 * a full reversal (pi radians). T = 100R corresponds to a deflection of about
 * 178.85 degrees - far sharper than any real road corner. Genuine hairpins
 * are built as two curves joined by a straight, not one fillet, so a corner
 * that needs more tangent distance than this is rejected rather than
 * returning a curve whose tangent points and arc length dwarf the road.
 */
const DEFAULT_MAX_TANGENT_DISTANCE_FACTOR = 100

/**
 * Insert a circular curve of the given radius into a corner.
 *
 * `incoming` is the direction of travel arriving at the corner, `outgoing`
 * the direction leaving it. Both are normalized internally. If either is the
 * zero vector, it normalizes to `{x:0, y:0}`, `atan2(0,0)` is 0, the computed
 * deflection is 0, and the function returns `null` - the same result as a
 * legitimately straight corner. This is intended: a degenerate direction
 * input is treated as "no turn" rather than as an error.
 *
 * Standard curve geometry: T = R * tan(deflection / 2).
 * A 90 degree deflection gives T = R.
 *
 * `maxTangentDistance` bounds how sharp a corner may be filleted at the
 * given radius. T grows without bound as the deflection approaches a full
 * reversal, so near-hairpin corners are rejected (return `null`) once the
 * computed tangent distance would exceed this bound, rather than returning
 * a technically-valid but absurdly oversized curve. Defaults to
 * `100 * radius` (see `DEFAULT_MAX_TANGENT_DISTANCE_FACTOR`).
 */
export const filletCorner = (
  corner: Vec2,
  incoming: Vec2,
  outgoing: Vec2,
  radius: number,
  maxTangentDistance?: number,
): Fillet | null => {
  if (radius <= 0) {
    throw new RangeError('fillet radius must be positive')
  }
  if (maxTangentDistance !== undefined && maxTangentDistance <= 0) {
    throw new RangeError('fillet maxTangentDistance must be positive')
  }

  const tangentDistanceBound =
    maxTangentDistance ?? DEFAULT_MAX_TANGENT_DISTANCE_FACTOR * radius

  const dIn = normalize(incoming)
  const dOut = normalize(outgoing)
  const deflection = signedAngleBetween(dIn, dOut)
  const magnitude = Math.abs(deflection)

  // Straight through, or a reversal that no finite arc can round.
  if (magnitude < MIN_DEFLECTION) return null
  if (Math.PI - magnitude < MIN_DEFLECTION) return null

  const tangentDistance = radius * Math.tan(magnitude / 2)

  // Near-reversal corner: technically finite, but too sharp to be a sane fillet.
  if (tangentDistance > tangentDistanceBound) return null

  const tangentIn = add(corner, scale(dIn, -tangentDistance))
  const tangentOut = add(corner, scale(dOut, tangentDistance))

  const curvature = (deflection > 0 ? 1 : -1) / radius
  const arcLength = radius * magnitude

  const arc = new Arc(tangentIn, angleOf(dIn), arcLength, curvature)

  return { arc, tangentIn, tangentOut, tangentDistance, deflection }
}
