import type { Alignment } from '../geometry/alignment'
import type { Heightmap } from './heightmap'

/** Natural ground elevation at a station along an alignment. */
export type ProfilePoint = {
  /** Distance along the alignment, metres. */
  readonly s: number
  /** Elevation, metres. */
  readonly z: number
}

/**
 * Minimum allowed gap between consecutive stations, in metres.
 *
 * `alignment.length` is a sum of primitive lengths and can land one ULP
 * above an exact multiple of `spacing`. Without a guard, the stepped loop
 * would then reach that multiple and the final-point check would append a
 * second point a hair past it, producing a station gap of ~1e-14 metres
 * that blows up the downstream grade calculation (which divides by the gap
 * between stations). One micron is far below any meaningful road station
 * and comfortably above floating-point noise at road-scale magnitudes.
 */
const MIN_STATION_GAP = 1e-6

/**
 * Walk an alignment and record the ground beneath it.
 *
 * Stations are computed as `i * spacing` rather than accumulated, so they are
 * exact and cannot drift over a long alignment. The final station is always
 * the alignment's full length; if that would land within `MIN_STATION_GAP`
 * of the last stepped station, the last stepped point is replaced by it
 * rather than appended as a near-duplicate.
 */
export const sampleGroundProfile = (
  alignment: Alignment,
  terrain: Heightmap,
  spacing: number,
): ProfilePoint[] => {
  if (spacing <= 0) {
    throw new RangeError('spacing must be positive')
  }
  if (alignment.isEmpty) return []

  const points: ProfilePoint[] = []
  const steps = Math.floor(alignment.length / spacing)

  for (let i = 0; i <= steps; i++) {
    const s = i * spacing
    const p = alignment.poseAt(s).position
    points.push({ s, z: terrain.sample(p.x, p.y) })
  }

  const last = points[points.length - 1]
  const finalPoint = (): ProfilePoint => {
    const p = alignment.poseAt(alignment.length).position
    return { s: alignment.length, z: terrain.sample(p.x, p.y) }
  }

  if (!last) {
    points.push(finalPoint())
  } else if (alignment.length - last.s > MIN_STATION_GAP) {
    points.push(finalPoint())
  } else if (last.s !== alignment.length) {
    points[points.length - 1] = finalPoint()
  }

  return points
}
