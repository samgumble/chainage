import type { ProfilePoint } from '../../terrain/groundProfile'
import type { StationSupport } from '../../terrain/gradeSolver'

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
