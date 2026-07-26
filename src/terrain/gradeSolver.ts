import type { ProfilePoint } from './groundProfile'
import { clampNumber } from './heightmap'

export type GradeConstraints = {
  /** Maximum absolute grade as a rise-over-run fraction. 7% is 0.07. */
  readonly maxGrade: number
  /** How far below natural ground the road may be cut, metres. */
  readonly maxCutDepth: number
  /** How far above natural ground the road may be filled, metres. */
  readonly maxFillHeight: number
  /**
   * How far above natural ground the road may be carried on a STRUCTURE,
   * metres. Must be at least `maxFillHeight`; defaults to it, meaning no
   * structures are permitted.
   *
   * Without this the solver can never produce a design line standing high
   * above the ground, so a ravine that ought to become a bridge reads as an
   * impossible alignment instead. Below `maxFillHeight` the gap is closed with
   * earth; between the two it is a structure; beyond it, genuinely infeasible.
   * The cut side is unaffected — a bridge does not help you get through a hill.
   */
  readonly maxStructureHeight?: number
  /** Elevation the profile must start at, if tied to existing road. */
  readonly fixedStart?: number
  /** Elevation the profile must end at, if tied to existing road. */
  readonly fixedEnd?: number
}

/** How a station is held up. */
export type StationSupport = 'earthwork' | 'structure'

export type GradeSolution =
  | { readonly feasible: true; readonly profile: ProfilePoint[] }
  | { readonly feasible: false; readonly failedAtStation: number }

/** Interval comparisons tolerate this much floating-point slack. */
const EPSILON = 1e-9

/**
 * Find a vertical alignment that respects the maximum grade and stays as
 * close to natural ground as possible — or report that none exists.
 *
 * Two phases, both required:
 *
 * 1. Interval propagation. Each station starts with the elevation band its
 *    cut and fill allowance permits, then one forward and one backward pass
 *    tighten those bands so neighbours are mutually reachable within the
 *    grade limit. Two passes are sufficient and no loop is needed: the
 *    constraints form a path graph, and one pass each way achieves arc
 *    consistency on a path. An empty band means the alignment is infeasible.
 *
 * 2. Greedy forward selection. Non-empty bands prove a solution exists but do
 *    not make the obvious per-station choice valid — two adjacent bands of
 *    [0, 10] with a 1m grade allowance are perfectly consistent, yet picking
 *    0 then 10 is a 10m step. So each station is additionally narrowed by the
 *    reachable window from the station just chosen. After propagation that
 *    window is never empty, so the sweep cannot fail.
 *
 * Returning the corrected profile rather than merely rejecting is the point:
 * the player gets a workable vertical alignment instead of an error.
 */
export const solveGradeProfile = (
  ground: readonly ProfilePoint[],
  constraints: GradeConstraints,
): GradeSolution => {
  const { maxGrade, maxCutDepth, maxFillHeight, maxStructureHeight, fixedStart, fixedEnd } =
    constraints

  if (maxGrade <= 0) {
    throw new RangeError('maxGrade must be positive')
  }
  if (maxCutDepth < 0 || maxFillHeight < 0) {
    throw new RangeError('cut and fill allowances must not be negative')
  }

  const maxAbove = maxStructureHeight ?? maxFillHeight
  if (maxAbove < maxFillHeight) {
    throw new RangeError('maxStructureHeight must not be less than maxFillHeight')
  }

  const n = ground.length
  if (n === 0) return { feasible: true, profile: [] }

  // --- Initial bands from the cut and fill envelope ---
  const min = new Float64Array(n)
  const max = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const g = ground[i]!.z
    min[i] = g - maxCutDepth
    max[i] = g + maxAbove
  }

  if (fixedStart !== undefined) {
    min[0] = fixedStart
    max[0] = fixedStart
  }
  if (fixedEnd !== undefined) {
    min[n - 1] = fixedEnd
    max[n - 1] = fixedEnd
  }

  // --- Phase 1: interval propagation, one pass each way ---
  for (let i = 1; i < n; i++) {
    const d = ground[i]!.s - ground[i - 1]!.s
    const reach = d * maxGrade
    min[i] = Math.max(min[i]!, min[i - 1]! - reach)
    max[i] = Math.min(max[i]!, max[i - 1]! + reach)
  }

  for (let i = n - 2; i >= 0; i--) {
    const d = ground[i + 1]!.s - ground[i]!.s
    const reach = d * maxGrade
    min[i] = Math.max(min[i]!, min[i + 1]! - reach)
    max[i] = Math.min(max[i]!, max[i + 1]! + reach)
  }

  for (let i = 0; i < n; i++) {
    if (min[i]! > max[i]! + EPSILON) {
      return { feasible: false, failedAtStation: ground[i]!.s }
    }
  }

  // --- Phase 2: greedy forward selection, hugging natural ground ---
  const profile: ProfilePoint[] = []

  let previous = clampNumber(ground[0]!.z, min[0]!, max[0]!)
  profile.push({ s: ground[0]!.s, z: previous })

  for (let i = 1; i < n; i++) {
    const d = ground[i]!.s - ground[i - 1]!.s
    const reach = d * maxGrade
    const lo = Math.max(min[i]!, previous - reach)
    const hi = Math.min(max[i]!, previous + reach)
    previous = clampNumber(ground[i]!.z, lo, hi)
    profile.push({ s: ground[i]!.s, z: previous })
  }

  return { feasible: true, profile }
}

/**
 * Which stations are carried on earth and which need a structure.
 *
 * A station standing more than the fill allowance above natural ground is a
 * structure — beyond that height an embankment stops being economic and
 * starts looking absurd. Depth of cut is irrelevant: a bridge does not help
 * you get through a hill.
 */
export const classifySupport = (
  ground: readonly ProfilePoint[],
  design: readonly ProfilePoint[],
  maxFillHeight: number,
): StationSupport[] => {
  if (ground.length !== design.length) {
    throw new RangeError('ground and design profiles must have the same length')
  }
  return design.map((d, i) =>
    d.z - ground[i]!.z > maxFillHeight ? 'structure' : 'earthwork',
  )
}
