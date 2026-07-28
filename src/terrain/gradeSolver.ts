import type { ProfilePoint } from './groundProfile'
import { clampNumber } from './heightmap'

/**
 * A hard floor under one station's design elevation, metres.
 *
 * The vertical half of a grade separation: an overpass needs its design line
 * to stand a given height above whatever it passes over at exactly one
 * station, and everything else about the profile — how it climbs to that
 * height and comes back down — is the solver's business, not the caller's.
 *
 * `station` must match a station of the ground profile to within
 * `STATION_TOLERANCE`. It is not interpolated, and an unmatched station
 * throws rather than being quietly dropped: a clearance requirement that
 * silently did not apply is a road built through another road, which is the
 * exact failure this type exists to prevent. Callers whose crossing falls
 * between two stations should floor BOTH stations bracketing it — the profile
 * is piecewise linear between stations, so both endpoints clearing the floor
 * is what makes every point in between clear it too.
 */
export type ClearanceFloor = {
  /** Station along the alignment, metres. Must match a ground station. */
  readonly station: number
  /** Least design elevation permitted at that station, metres. */
  readonly minimumElevation: number
}

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
  /**
   * Stations whose design elevation must be at least a given height —
   * grade separation, expressed as a constraint on the solve rather than as
   * something done to its answer afterwards. See `ClearanceFloor`, and the
   * phase 1 comment in `solveGradeProfile` for why it is applied there.
   */
  readonly clearanceFloors?: readonly ClearanceFloor[]
}

/** How a station is held up. */
export type StationSupport = 'earthwork' | 'structure'

export type GradeSolution =
  | { readonly feasible: true; readonly profile: ProfilePoint[] }
  | { readonly feasible: false; readonly failedAtStation: number }

/** Interval comparisons tolerate this much floating-point slack. */
const EPSILON = 1e-9

/**
 * Largest allowed difference between a ground station and its corresponding
 * design station before they are considered mismatched, metres. Matches the
 * `MIN_STATION_GAP` floor `groundProfile.ts` enforces between stations, so
 * anything larger than this tolerance cannot be floating-point noise from
 * that pipeline — it means the two profiles were not built over the same
 * stations.
 */
export const STATION_TOLERANCE = 1e-6

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
  const {
    maxGrade, maxCutDepth, maxFillHeight, maxStructureHeight, fixedStart, fixedEnd,
    clearanceFloors = [],
  } = constraints

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
  if (n === 0) {
    if (clearanceFloors.length > 0) {
      throw new RangeError('clearanceFloors were given for an empty ground profile')
    }
    return { feasible: true, profile: [] }
  }

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
  //
  // Clearance floors are raised into the bands HERE, before either pass runs,
  // and that placement is the whole point rather than an implementation
  // detail. A floor is nothing more exotic than a station whose band starts
  // higher than the cut/fill envelope alone would allow; once it is in the
  // band, the two propagation passes below spread the consequence outwards in
  // both directions at the grade limit, the emptiness check afterwards reports
  // an unreachable floor as an infeasible alignment, and the greedy sweep in
  // phase 2 climbs to it and back down without any further help. Reachability,
  // the grade limit and the infeasibility report all come free from machinery
  // that already exists.
  //
  // Lifting the profile AFTER the solve instead would satisfy the clearance
  // and silently break the grade limit getting there: a 5m step inserted
  // between two stations 10m apart is a 50% grade on a road solved to 7%,
  // returned as `feasible: true` with no mention of it anywhere. That is
  // precisely the class of defect this codebase reports rather than commits,
  // and `gradeSolver.test.ts` pins it — the "reports infeasible" case passes
  // under a no-op floor but fails under a post-solve lift.
  //
  // Only `min` is raised, never `max`. A floor above the station's structure
  // ceiling therefore empties the band rather than quietly widening it, which
  // is the honest answer: that clearance cannot be had within the height this
  // alignment is allowed to stand.
  for (const floor of clearanceFloors) {
    const i = stationIndex(ground, floor.station)
    if (i === undefined) {
      throw new RangeError(
        `clearance floor at station ${floor.station} matches no station of the ` +
          'ground profile; floors are applied to stations, not interpolated between them',
      )
    }
    min[i] = Math.max(min[i]!, floor.minimumElevation)
  }

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
 * Index of the profile station matching `station`, or `undefined`.
 *
 * `STATION_TOLERANCE` rather than exact equality for the same reason
 * `classifySupport` uses it: stations arrive as `i * spacing` from one
 * profile and as a copied `s` from another, and the two agree to the last
 * bit in practice but are not required to. Anything larger than a micron
 * apart is not floating-point noise — it is a different station.
 */
const stationIndex = (
  ground: readonly ProfilePoint[],
  station: number,
): number | undefined => {
  for (let i = 0; i < ground.length; i++) {
    if (Math.abs(ground[i]!.s - station) <= STATION_TOLERANCE) return i
  }
  return undefined
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
  for (let i = 0; i < ground.length; i++) {
    const gs = ground[i]!.s
    const ds = design[i]!.s
    if (Math.abs(gs - ds) > STATION_TOLERANCE) {
      throw new RangeError(
        `ground and design profiles must share stations: station ${i} is ${gs} on ` +
          `ground but ${ds} on design`,
      )
    }
  }
  return design.map((d, i) =>
    d.z - ground[i]!.z > maxFillHeight ? 'structure' : 'earthwork',
  )
}
