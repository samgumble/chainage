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
 */
export const buildRetainingWallMesh = (
  alignment: Alignment,
  segments: readonly WallSegment[],
): MeshData => {
  const builder = new MeshBuilder()

  for (const side of ['left', 'right'] as const) {
    const run = segments
      .filter((w) => w.side === side)
      .sort((a, b) => a.s - b.s)

    // The caller (networkMesh.ts) drops any segment that falls inside a
    // bridge span before handing segments here, and `wallSegments` itself
    // only emits a segment where a wall is actually needed — so a run can
    // have gaps for either reason, and joining across one paints a solid
    // panel over ground that has no wall at all. The fix needs to know how
    // far apart two adjacent samples are SUPPOSED to be, which is the
    // sampling spacing the caller used — but that value isn't passed in and
    // hardcoding it would silently misjudge every caller who samples at a
    // different spacing. So it's derived from the run itself: the median of
    // the gaps between consecutive stations. Median rather than the minimum,
    // because the last sample can legitimately be a shorter partial step
    // (see `wallSegments`, which appends the alignment's own end station
    // even when it doesn't land on a multiple of the sampling spacing) — the
    // minimum gap would then be that partial step, not the regular cadence,
    // and would wrongly reject every ordinary join as "too far apart".
    // Median is only meaningful with at least two gaps (three segments); a
    // run of exactly two segments has nothing else to compare its one gap
    // against and is always joined — see retainingWallMesh.test.ts for that
    // limitation made explicit.
    const gaps: number[] = []
    for (let i = 1; i < run.length; i++) gaps.push(run[i]!.s - run[i - 1]!.s)
    const sortedGaps = [...gaps].sort((a, b) => a - b)
    const mid = Math.floor(sortedGaps.length / 2)
    const expectedSpacing = sortedGaps.length === 0
      ? 0
      : sortedGaps.length % 2 === 0
        ? (sortedGaps[mid - 1]! + sortedGaps[mid]!) / 2
        : sortedGaps[mid]!
    // Any gap opened by a dropped segment skips at least one whole sample,
    // so it is at least twice the regular spacing; 1.5x the median cleanly
    // separates that from a genuine step while absorbing a shorter final
    // partial step and ordinary floating-point noise.
    const maxJoinGap = expectedSpacing * 1.5

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
