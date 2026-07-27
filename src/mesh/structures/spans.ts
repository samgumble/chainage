import type { Alignment } from '../../geometry/alignment'
import type { TerrainSampler } from '../../terrain/heightmap'
import {
  type ProfilePoint,
  designElevationAtStation,
  sampleGroundProfile,
} from '../../terrain/groundProfile'
import { classifySupport, type StationSupport } from '../../terrain/gradeSolver'

/**
 * Floating-point slack when deciding whether a station falls within half a
 * sample spacing of a required one. Guards the exact-half-spacing case, where
 * the arithmetic that produced the required station and the arithmetic that
 * produced the sample station agree mathematically and differ in the last bit.
 */
const STATION_EPSILON = 1e-9

export type StructureSpan = {
  readonly fromStation: number
  readonly toStation: number
  /** Greatest height of the design line above natural ground within the span. */
  readonly maxHeight: number
}

export type SpanOptions = {
  readonly minLength?: number
  readonly abutmentExtension?: number
}

/**
 * Shortest run that counts as a bridge, metres.
 *
 * One or two stations poking above the fill allowance is terrain noise, not a
 * structure. Building a bridge for every bump would litter the map.
 */
export const MIN_SPAN_LENGTH = 12

/**
 * How far a span reaches past its structure stations, metres.
 *
 * Abutments have to land on ground the earthworks actually supports, which is
 * the earthwork station either side of the run — not the first station that
 * needed a structure.
 */
export const ABUTMENT_EXTENSION = 3

/**
 * Group per-station structure flags into spans a bridge can be built over.
 *
 * `classifySupport` answers one station at a time; a bridge is a contiguous
 * run of them. Runs shorter than the minimum are discarded, and each surviving
 * run is extended at both ends so its abutments sit on solid ground.
 */
export const structureSpans = (
  stations: readonly ProfilePoint[],
  support: readonly StationSupport[],
  ground: readonly ProfilePoint[],
  options: SpanOptions = {},
): StructureSpan[] => {
  const {
    minLength = MIN_SPAN_LENGTH,
    abutmentExtension = ABUTMENT_EXTENSION,
  } = options

  if (stations.length !== support.length || stations.length !== ground.length) {
    throw new RangeError('stations, support and ground must have the same length')
  }
  if (stations.length === 0) return []

  const first = stations[0]!.s
  const last = stations[stations.length - 1]!.s

  const spans: StructureSpan[] = []
  let runStart = -1

  const closeRun = (endIndex: number) => {
    if (runStart < 0) return
    const from = stations[runStart]!.s
    const to = stations[endIndex]!.s

    if (to - from >= minLength) {
      let maxHeight = 0
      for (let i = runStart; i <= endIndex; i++) {
        maxHeight = Math.max(maxHeight, stations[i]!.z - ground[i]!.z)
      }
      spans.push({
        fromStation: Math.max(first, from - abutmentExtension),
        toStation: Math.min(last, to + abutmentExtension),
        maxHeight,
      })
    }
    runStart = -1
  }

  for (let i = 0; i < support.length; i++) {
    if (support[i] === 'structure') {
      if (runStart < 0) runStart = i
    } else {
      closeRun(i - 1)
    }
  }
  closeRun(support.length - 1)

  // Merge overlapping or touching spans. Two bridges whose abutments overlap
  // are one bridge, and the merged span's height is the greater of the two.
  const merged: StructureSpan[] = []
  for (const span of spans) {
    if (merged.length === 0) {
      merged.push(span)
    } else {
      const prev = merged[merged.length - 1]!
      if (span.fromStation <= prev.toStation) {
        // Spans overlap or touch; merge them.
        merged[merged.length - 1] = {
          fromStation: prev.fromStation,
          toStation: Math.max(prev.toStation, span.toStation),
          maxHeight: Math.max(prev.maxHeight, span.maxHeight),
        }
      } else {
        merged.push(span)
      }
    }
  }

  return merged
}

/** Everything one road's spans are a function of. */
export type RoadSpanInputs = {
  readonly alignment: Alignment
  /** The road's solved design profile — the grade line, not natural ground. */
  readonly design: readonly ProfilePoint[]
  /**
   * NATURAL ground, before any corridor excavation.
   *
   * Ground already cut and filled to the design surface sits at the design
   * line by construction, so every station would read as level and no span
   * could ever be found. This is also what lets spans be derived before the
   * earthworks run: they never depend on the excavation's own output.
   */
  readonly terrain: TerrainSampler
  /** The fill allowance the design line was graded to. */
  readonly maxFillHeight: number
  /** Station spacing the ground and support profiles are sampled at. */
  readonly spacing: number
  /**
   * Station ranges that must be carried on a structure however low the design
   * line runs there, because something other than height demands it.
   *
   * Height alone cannot decide this. An overpass lifted just enough to clear
   * the road beneath it — five metres of clearance plus the depth of the deck,
   * so six or seven on flat ground — sits comfortably under `maxFillHeight`,
   * and `classifySupport` therefore calls it earthwork. The corridor sweep
   * then does exactly what it is told and builds an embankment across the
   * road below. The design lines are correctly separated and the graph is
   * correct; what gets built is a dam.
   *
   * Ranges rather than single stations, because the thing being cleared has
   * width. A deck forced onto the one or two samples nearest a crossing is
   * five or ten metres long, which is both shorter than `MIN_SPAN_LENGTH` —
   * so it would be discarded outright — and narrower than the corridor it is
   * supposed to bridge. The caller knows how wide the road underneath is and
   * says so; this function does not have to guess.
   */
  readonly requiredStructureRanges?: readonly {
    readonly fromStation: number
    readonly toStation: number
  }[]
}

/**
 * The structure spans on one road: sample natural ground, classify each
 * station, and group the structure stations into spans.
 *
 * The single derivation of a road's spans in this codebase. It exists as its
 * own function because two consumers need the answer — the mesh build, which
 * puts bridges on the spans and keeps retaining walls off them, and the
 * corridor excavation, which must stop earthworks at the abutment face — and
 * they used to derive it independently: the earthworks stopped where a
 * per-station fill test happened to trip (measured: stations 280-420) while
 * the structures covered 273-423. Everything wrong at the bridges lived in
 * that seven-station disagreement, so there is now one function, called once
 * per road, whose result is shared rather than recomputed.
 *
 * A road with fewer than two design stations has no spans: there is no design
 * line to measure against ground, which is a road that did not grade, not a
 * road whose spans are unknown.
 */
export const roadStructureSpans = (inputs: RoadSpanInputs): StructureSpan[] => {
  const { alignment, design, terrain, maxFillHeight, spacing } = inputs
  if (design.length < 2) return []

  const ground = sampleGroundProfile(alignment, terrain, spacing)
  if (ground.length === 0) return []

  // Resample the design onto the ground profile's own stations, so
  // `classifySupport` compares like with like. The two profiles are sampled
  // independently and will not otherwise share stations.
  const designAtGround = ground.map((g) => ({
    s: g.s,
    z: designElevationAtStation(design, g.s),
  }))

  const support = classifySupport(ground, designAtGround, maxFillHeight)

  // Bounds are inclusive: a sample sitting exactly on the end of a required
  // range is inside it, the same convention `structureRanges` uses in the
  // corridor sweep, so earthwork and structures continue to agree about who
  // owns a boundary station.
  const required = inputs.requiredStructureRanges ?? []
  if (required.length > 0) {
    for (let i = 0; i < ground.length; i++) {
      const s = ground[i]!.s
      const inRange = required.some(
        (r) => s >= r.fromStation - STATION_EPSILON && s <= r.toStation + STATION_EPSILON,
      )
      if (inRange) support[i] = 'structure'
    }
  }

  return structureSpans(designAtGround, support, ground)
}
