import type { Alignment } from '../geometry/alignment'
import type { TerrainSampler } from './heightmap'

/**
 * A station along an alignment paired with an elevation, metres.
 *
 * Used both for natural ground — the raw output of `sampleGroundProfile` —
 * and for the design profile `solveGradeProfile` returns, which shares the
 * same station/elevation shape.
 */
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
 *
 * Also the floor on `spacing` itself: a caller passing a sub-gap spacing
 * would produce interior stations that are just as thin, regardless of the
 * final-point handling below.
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
  terrain: TerrainSampler,
  spacing: number,
): ProfilePoint[] => {
  if (spacing <= 0) {
    throw new RangeError('spacing must be positive')
  }
  if (spacing < MIN_STATION_GAP) {
    throw new RangeError(`spacing must be at least ${MIN_STATION_GAP} metres`)
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
