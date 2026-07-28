import type { Alignment } from '../../geometry/alignment'
import { leftNormal, add, scale } from '../../geometry/vec2'
import type { TerrainSampler } from '../../terrain/heightmap'
import {
  type ProfilePoint, designElevationAtStation,
} from '../../terrain/groundProfile'
import {
  type CorridorTemplate, retainingWall, designSurfaceAtOffset,
} from '../../terrain/corridor'
import { MeshBuilder } from '../meshBuilder'
import type { MeshData } from '../ribbon'

/** One station's worth of wall on one side. */
export type WallSegment = {
  readonly s: number
  readonly side: 'left' | 'right'
  /** Transverse offset from the centreline. Negative is left. */
  readonly offset: number
  readonly topZ: number
  readonly bottomZ: number
}

/**
 * Below this a wall is a kerb, metres.
 *
 * A twenty-centimetre step is a kerb, not a retaining structure, and emitting
 * a panel for one produces slivers that read as z-fighting.
 */
export const MIN_WALL_HEIGHT = 0.3

/**
 * Where a road needs retaining walls, and how tall they are.
 *
 * The terrain layer already answers this per station via `retainingWall()` —
 * this walks the alignment asking it, and records the wall's top and bottom
 * elevations so the mesh has something to extrude between.
 *
 * Walls are symmetric: where one is needed, it stands on both sides.
 */
export const wallSegments = (
  alignment: Alignment,
  terrain: TerrainSampler,
  design: readonly ProfilePoint[],
  template: CorridorTemplate,
  spacing: number = 4,
): WallSegment[] => {
  if (spacing <= 0) {
    throw new RangeError('spacing must be positive')
  }
  if (alignment.isEmpty) return []

  const segments: WallSegment[] = []
  const steps = Math.floor(alignment.length / spacing)

  for (let i = 0; i <= steps; i++) {
    const s = Math.min(i * spacing, alignment.length)
    const pose = alignment.poseAt(s)
    const groundZ = terrain.sample(pose.position.x, pose.position.y)
    const designZ = designElevationAtStation(design, s)

    const wall = retainingWall(designZ, groundZ, template)
    if (!wall || wall.height < MIN_WALL_HEIGHT) continue

    // The wall always spans between where the truncated batter ends and
    // natural ground, whichever is higher — in cut the batter ends below
    // ground and the wall holds the remainder up; in fill it ends above
    // ground and the wall holds the remainder down.
    const batterEnd = designSurfaceAtOffset(wall.offset, designZ, groundZ, template)
    const topZ = Math.max(batterEnd, groundZ)
    const bottomZ = Math.min(batterEnd, groundZ)

    for (const side of ['left', 'right'] as const) {
      segments.push({
        s,
        side,
        offset: side === 'left' ? -wall.offset : wall.offset,
        topZ,
        bottomZ,
      })
    }
  }

  // The stepped loop can stop short of the alignment end when spacing does
  // not divide the length evenly; include the end station in that case. Only
  // when at least one real step was taken — otherwise spacing is coarser
  // than the whole alignment and s=0 is the only meaningful sample, so a
  // lone segment per side correctly yields no panel.
  const last = segments[segments.length - 1]
  if (steps >= 1 && last && last.s < alignment.length) {
    const s = alignment.length
    const pose = alignment.poseAt(s)
    const groundZ = terrain.sample(pose.position.x, pose.position.y)
    const designZ = designElevationAtStation(design, s)
    const wall = retainingWall(designZ, groundZ, template)
    if (wall && wall.height >= MIN_WALL_HEIGHT) {
      const batterEnd = designSurfaceAtOffset(wall.offset, designZ, groundZ, template)
      const topZ = Math.max(batterEnd, groundZ)
      const bottomZ = Math.min(batterEnd, groundZ)
      for (const side of ['left', 'right'] as const) {
        segments.push({
          s, side,
          offset: side === 'left' ? -wall.offset : wall.offset,
          topZ, bottomZ,
        })
      }
    }
  }

  return segments
}

/**
 * Panels running between consecutive segments on each side.
 *
 * The face points away from the road, so its winding runs bottom-to-top on the
 * near station and top-to-bottom on the far one for the right side, and the
 * reverse for the left — that is what keeps the outward face frontmost on both.
 *
 * `spacing` is the station spacing the segments were SAMPLED at, and it is a
 * required argument rather than something recovered from the run. A run has
 * gaps in it — `networkMesh` drops every segment inside a bridge span, and
 * `wallSegments` only emits one where a wall is actually needed — and joining
 * across a gap paints a solid panel over ground with no wall under it. Telling
 * a gap from an ordinary step needs to know what an ordinary step is.
 *
 * This used to infer it, as the median of the run's own gaps, and the
 * inference is unsound in exactly the case it exists for: a gap inflates the
 * median it is then compared against. Two segments 200m apart give
 * `median([200]) = 200`, and 200 is not more than 300, so a 200m triangle got
 * emitted across the whole hole. One dropped sample on a 4m cadence gives
 * `median([4, 8]) = 6`, and `1.5 * 6 = 9` is not less than 8, so that one got
 * joined too. Both are confirmed defects, and both are tests now. The caller
 * knows the spacing — `networkMesh` passes the very number it sampled at — so
 * it is passed rather than guessed.
 */
export const buildRetainingWallMesh = (
  alignment: Alignment,
  segments: readonly WallSegment[],
  spacing: number,
): MeshData => {
  if (spacing <= 0) {
    throw new RangeError('spacing must be positive')
  }

  const builder = new MeshBuilder()

  // A gap opened by a dropped sample skips at least one whole sample, so it is
  // a whole multiple of the spacing and at least twice it. 1.5x separates that
  // from a genuine step while absorbing floating-point noise and the shorter
  // final partial step `wallSegments` appends at the alignment's own end.
  //
  // The one gap this cannot judge is a dropped sample immediately before that
  // final partial step, which measures `spacing + partial` and can land under
  // 1.5x. That joins a panel over at most one partial step of un-walled
  // ground, at the very end of a road, and closing it would mean carrying the
  // segment list's provenance rather than its stations.
  const maxJoinGap = spacing * 1.5

  for (const side of ['left', 'right'] as const) {
    const run = segments
      .filter((w) => w.side === side)
      .sort((a, b) => a.s - b.s)

    for (let i = 1; i < run.length; i++) {
      const from = run[i - 1]!
      const to = run[i]!
      if (to.s - from.s > maxJoinGap) continue

      const poseFrom = alignment.poseAt(from.s)
      const poseTo = alignment.poseAt(to.s)

      // Offsets are negative-is-left while leftNormal points left, so negate.
      const pFrom = add(poseFrom.position, scale(leftNormal(poseFrom.heading), -from.offset))
      const pTo = add(poseTo.position, scale(leftNormal(poseTo.heading), -to.offset))

      const a = { x: pFrom.x, y: pFrom.y, z: from.bottomZ }
      const b = { x: pTo.x, y: pTo.y, z: to.bottomZ }
      const c = { x: pTo.x, y: pTo.y, z: to.topZ }
      const d = { x: pFrom.x, y: pFrom.y, z: from.topZ }

      if (side === 'right') builder.addQuad(a, b, c, d)
      else builder.addQuad(b, a, d, c)
    }
  }

  return builder.build()
}
