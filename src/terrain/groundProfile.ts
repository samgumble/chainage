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
 * Walk an alignment and record the ground beneath it.
 *
 * Stations are computed as `i * spacing` rather than accumulated, so they are
 * exact and cannot drift over a long alignment. The final station is always
 * the alignment's full length; if that coincides with the last stepped
 * station it is not duplicated.
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
  if (!last || last.s < alignment.length) {
    const p = alignment.poseAt(alignment.length).position
    points.push({ s: alignment.length, z: terrain.sample(p.x, p.y) })
  }

  return points
}
