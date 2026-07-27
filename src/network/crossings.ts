import { type RoadNetwork, type RoadId, NODE_SNAP_DISTANCE } from './graph'
import { type Vec2, sub, cross, add, scale, distance } from '../geometry/vec2'
import {
  type ProfilePoint, designElevationAtStation,
} from '../terrain/groundProfile'

export type Crossing = {
  /** The road passing over. */
  readonly upper: RoadId
  /** The road passing under. */
  readonly lower: RoadId
  readonly position: Vec2
  readonly upperStation: number
  readonly lowerStation: number
  /** Vertical gap between the two design lines, metres. Never negative. */
  readonly clearance: number
}

/**
 * Least vertical gap for one road to pass over another, metres.
 *
 * Five metres clears a lorry with room for the deck. Below it, a crossing is a
 * collision rather than an overpass, and the caller should say so rather than
 * build a structure that passes through another road.
 */
export const MIN_OVERPASS_CLEARANCE = 5.0

/**
 * Where two roads cross in plan without meeting at a junction.
 *
 * A crossing that lands at a node the two roads share is a junction — a
 * crossing at the same level, deliberately — and is excluded. That exclusion
 * is per-crossing, not per-pair: two roads connected at one junction can
 * still cross again elsewhere, and that second crossing is a genuine
 * overpass. Skipping the whole pair because they share a node anywhere would
 * silently lose it, so every intersection is computed first and only the
 * ones sitting on a shared node are discarded.
 *
 * A pair where either road has no design profile is omitted entirely: without
 * a profile there is no elevation, so there is no clearance to report.
 *
 * Detection is by sampling: each alignment becomes a polyline and every pair
 * of segments is tested. That is quadratic in sample count and fine for the
 * network sizes this game reaches; a spatial index belongs with the
 * interactive tool, where networks get large and get rebuilt during a drag.
 */
export const findCrossings = (
  network: RoadNetwork,
  designs: ReadonlyMap<RoadId, readonly ProfilePoint[]>,
  spacing: number = 5,
): Crossing[] => {
  if (spacing <= 0) {
    throw new RangeError('spacing must be positive')
  }

  const roads = network.roads
  const polylines = new Map<RoadId, { point: Vec2; s: number }[]>()

  for (const road of roads) {
    const points: { point: Vec2; s: number }[] = []
    const steps = Math.max(1, Math.ceil(road.alignment.length / spacing))
    for (let i = 0; i <= steps; i++) {
      const s = (road.alignment.length * i) / steps
      points.push({ point: road.alignment.poseAt(s).position, s })
    }
    polylines.set(road.id, points)
  }

  const crossings: Crossing[] = []

  for (let ia = 0; ia < roads.length; ia++) {
    for (let ib = ia + 1; ib < roads.length; ib++) {
      const roadA = roads[ia]!
      const roadB = roads[ib]!

      // Positions of nodes the two roads attach to in common. A crossing
      // landing within NODE_SNAP_DISTANCE of one of these is the junction
      // itself, not a second overpass.
      const sharedNodeIds = new Set<number>()
      for (const nodeId of [roadA.startNode, roadA.endNode]) {
        if (nodeId === roadB.startNode || nodeId === roadB.endNode) {
          sharedNodeIds.add(nodeId)
        }
      }
      const sharedNodePositions = [...sharedNodeIds].map((id) => network.node(id).position)

      // A road with no design profile has no elevation to compare.
      // `designElevationAtStation` answers 0 for an empty profile, so two
      // ungraded roads would read a 0m gap and be reported as a collision —
      // a measurement fabricated out of missing information. Report rather
      // than approximate cuts the other way here: the honest answer is that
      // there is no clearance to report, so the crossing is omitted rather
      // than pushed into a channel that means "measured, and too tight".
      // Nothing is lost by it — every caller holds the `designs` map and can
      // see for itself which roads are ungraded.
      const designA = designs.get(roadA.id)
      const designB = designs.get(roadB.id)
      if (!designA || designA.length === 0) continue
      if (!designB || designB.length === 0) continue

      const hits = allIntersections(polylines.get(roadA.id)!, polylines.get(roadB.id)!)

      for (const hit of hits) {
        const atSharedNode = sharedNodePositions.some(
          (nodePosition) => distance(nodePosition, hit.position) <= NODE_SNAP_DISTANCE,
        )
        if (atSharedNode) continue

        const zA = designElevationAtStation(designA, hit.sA)
        const zB = designElevationAtStation(designB, hit.sB)
        const aIsUpper = zA >= zB

        crossings.push({
          upper: aIsUpper ? roadA.id : roadB.id,
          lower: aIsUpper ? roadB.id : roadA.id,
          position: hit.position,
          upperStation: aIsUpper ? hit.sA : hit.sB,
          lowerStation: aIsUpper ? hit.sB : hit.sA,
          clearance: Math.abs(zA - zB),
        })
      }
    }
  }

  return crossings
}

/** Every place two polylines cross, with the station on each. */
const allIntersections = (
  a: readonly { point: Vec2; s: number }[],
  b: readonly { point: Vec2; s: number }[],
): { position: Vec2; sA: number; sB: number }[] => {
  const hits: { position: Vec2; sA: number; sB: number }[] = []

  for (let i = 1; i < a.length; i++) {
    const p = a[i - 1]!
    const q = a[i]!
    const u = sub(q.point, p.point)

    for (let j = 1; j < b.length; j++) {
      const r = b[j - 1]!
      const t = b[j]!
      const v = sub(t.point, r.point)

      const denominator = cross(u, v)
      if (denominator === 0) continue

      const w = sub(r.point, p.point)
      const tA = cross(w, v) / denominator
      const tB = cross(w, u) / denominator

      if (tA < 0 || tA > 1 || tB < 0 || tB > 1) continue

      const hit = {
        position: add(p.point, scale(u, tA)),
        sA: p.s + (q.s - p.s) * tA,
        sB: r.s + (t.s - r.s) * tB,
      }

      // A crossing that falls exactly on a shared polyline vertex is found
      // twice — once from the segment ending at that vertex, once from the
      // segment starting there. NODE_SNAP_DISTANCE (0.5m) is reused as the
      // dedup tolerance for the same reason it works for node snapping: it
      // is comfortably below any real road separation, so two genuinely
      // distinct crossings on the same road pair are never merged, and
      // comfortably above floating-point noise, so a same-vertex duplicate
      // always collapses.
      const isDuplicate = hits.some(
        (existing) => distance(existing.position, hit.position) <= NODE_SNAP_DISTANCE,
      )
      if (!isDuplicate) hits.push(hit)
    }
  }

  return hits
}
