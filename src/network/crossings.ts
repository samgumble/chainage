import type { RoadNetwork, RoadId } from './graph'
import { type Vec2, sub, cross, add, scale } from '../geometry/vec2'
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
 * Where two roads cross in plan without sharing a node.
 *
 * Roads that share a node meet at a junction and are excluded — a junction is
 * a crossing at the same level, deliberately. What is left is roads that pass
 * over or under one another, which is the overpass trigger.
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

      // Sharing a node means they meet at a junction, not an overpass.
      if (
        roadA.startNode === roadB.startNode || roadA.startNode === roadB.endNode ||
        roadA.endNode === roadB.startNode || roadA.endNode === roadB.endNode
      ) {
        continue
      }

      const hit = firstIntersection(polylines.get(roadA.id)!, polylines.get(roadB.id)!)
      if (!hit) continue

      const zA = designElevationAtStation(designs.get(roadA.id) ?? [], hit.sA)
      const zB = designElevationAtStation(designs.get(roadB.id) ?? [], hit.sB)
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

  return crossings
}

/** The first place two polylines cross, with the station on each. */
const firstIntersection = (
  a: readonly { point: Vec2; s: number }[],
  b: readonly { point: Vec2; s: number }[],
): { position: Vec2; sA: number; sB: number } | null => {
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

      return {
        position: add(p.point, scale(u, tA)),
        sA: p.s + (q.s - p.s) * tA,
        sB: r.s + (t.s - r.s) * tB,
      }
    }
  }
  return null
}
