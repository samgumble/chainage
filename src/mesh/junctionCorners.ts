import type { JunctionLeg } from './junctionLegs'
import { type Vec2, add, sub, scale, dot, cross, fromAngle } from '../geometry/vec2'

/** Where two adjacent legs' facing edges cross. */
export type JunctionCorner = {
  readonly position: Vec2
  /** Index into the sorted leg array of the leg clockwise of this corner. */
  readonly beforeLeg: number
  /** Index of the leg counter-clockwise of it. */
  readonly afterLeg: number
}

export type JunctionGeometry =
  | {
      readonly feasible: true
      readonly corners: JunctionCorner[]
      /** trims[i] is how far leg i must be pulled back from the node, metres. */
      readonly trims: number[]
    }
  | {
      readonly feasible: false
      readonly reason: 'too-few-legs' | 'near-parallel-legs' | 'trim-too-long'
    }

/**
 * Beyond this a junction is absurd, metres.
 *
 * The corner between two legs runs away to infinity as they approach
 * parallel, so an unbounded solve will happily produce a junction kilometres
 * across. Sixty metres is already larger than any real intersection.
 */
export const MAX_TRIM_DISTANCE = 60

/** The smallest usable |cross(d_i, d_j)|. Below this the legs are parallel. */
export const PARALLEL_TOLERANCE = 1e-3

/**
 * Intersect two lines given as point plus direction.
 * Returns null when they are parallel within tolerance.
 */
const intersectLines = (
  a: Vec2, u: Vec2, b: Vec2, v: Vec2,
): Vec2 | null => {
  const denominator = cross(u, v)
  if (Math.abs(denominator) < PARALLEL_TOLERANCE) return null
  const t = cross(sub(b, a), v) / denominator
  return add(a, scale(u, t))
}

/**
 * Are two legs opposite rather than coincident?
 *
 * `cross` vanishes for both, so it cannot tell them apart on its own. Opposite
 * legs are a road passing straight through — the commonest junction there is —
 * while coincident legs are two roads leaving on top of each other, which has
 * no sensible junction at all.
 */
const isThroughPair = (a: JunctionLeg, b: JunctionLeg): boolean =>
  dot(a.direction, b.direction) < 0

/**
 * Work out where a junction's corners sit and how far each leg pulls back.
 *
 * Legs must already be sorted counter-clockwise. The corner between leg i and
 * the next leg counter-clockwise is the intersection of leg i's LEFT edge with
 * that leg's RIGHT edge — those are the two edges bounding the sector swept
 * between them.
 *
 * Reports infeasible rather than emitting garbage. Two legs approaching
 * parallel send their corner toward infinity, and an unbounded solve produces
 * a junction the size of a town. A junction that cannot be built is something
 * the tool can show the player; one that is silently wrong is a bug nobody
 * finds until it is on screen.
 */
export const solveJunction = (
  legs: readonly JunctionLeg[],
  maxTrim: number = MAX_TRIM_DISTANCE,
): JunctionGeometry => {
  if (legs.length < 3) {
    return { feasible: false, reason: 'too-few-legs' }
  }

  const n = legs.length
  const corners: JunctionCorner[] = []

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const legI = legs[i]!
    const legJ = legs[j]!

    // Left of a direction is that direction rotated +90 degrees.
    const leftI = fromAngle(legI.bearing + Math.PI / 2)
    const leftJ = fromAngle(legJ.bearing + Math.PI / 2)

    // Leg i's left edge, and leg j's right edge, both offset from the node.
    const originI = scale(leftI, legI.halfWidth)
    const originJ = scale(leftJ, -legJ.halfWidth)

    const position = intersectLines(originI, legI.direction, originJ, legJ.direction)

    if (!position) {
      // No unique intersection. Which of the two degenerate cases is it?
      if (!isThroughPair(legI, legJ)) {
        // Coincident: two roads leaving on top of each other. No junction.
        return { feasible: false, reason: 'near-parallel-legs' }
      }
      // Opposite: a road running straight through. The facing edges are
      // parallel — coincident when the widths match — so there is no unique
      // crossing point, but nothing is wrong. Put the corner at the foot of
      // the perpendicular, laterally at the wider of the two. Being
      // perpendicular to both legs, it contributes zero trim, which is right:
      // a through road needs no pulling back on its outer side.
      corners.push({
        position: scale(leftI, Math.max(legI.halfWidth, legJ.halfWidth)),
        beforeLeg: i,
        afterLeg: j,
      })
      continue
    }

    corners.push({ position, beforeLeg: i, afterLeg: j })
  }

  // Each leg must clear the corner on either side of it.
  const trims = legs.map((leg, i) => {
    const after = corners[i]!
    const before = corners[(i - 1 + n) % n]!
    return Math.max(
      0,
      dot(after.position, leg.direction),
      dot(before.position, leg.direction),
    )
  })

  if (trims.some((t) => t > maxTrim)) {
    return { feasible: false, reason: 'trim-too-long' }
  }

  return { feasible: true, corners, trims }
}
