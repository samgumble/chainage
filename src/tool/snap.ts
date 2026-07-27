import { type Vec2, distance } from '../geometry/vec2'
import type { NetworkNode, NodeId, RoadId, RoadNetwork } from '../network/graph'

export type SnapTarget =
  | { readonly kind: 'free'; readonly position: Vec2 }
  | { readonly kind: 'node'; readonly position: Vec2; readonly nodeId: NodeId }
  | {
      readonly kind: 'road'
      readonly position: Vec2
      readonly roadId: RoadId
      /** Station along that road, metres. */
      readonly station: number
    }

/**
 * How finely a road's centreline is walked when measuring pointer distance.
 *
 * Five metres is well inside the tool's snap radius, so a road cannot slip
 * between samples and read as further away than it is. The nearest sample is
 * then refined, so this spacing bounds the search rather than the answer.
 */
const CENTRELINE_SPACING = 5

/** Refinement passes around the nearest sampled station. */
const REFINEMENT_PASSES = 20

/** Nearest station on a road to a position, and how far away it is. */
const nearestStation = (
  network: RoadNetwork,
  roadId: RoadId,
  position: Vec2,
): { station: number; distance: number; position: Vec2 } => {
  const { alignment } = network.road(roadId)

  let best = 0
  let bestDistance = Infinity
  for (const pose of alignment.sample(CENTRELINE_SPACING)) {
    const d = distance(pose.position, position)
    if (d < bestDistance) {
      bestDistance = d
      best = pose.s
    }
  }

  // Golden-section-free bisection: halve the bracket around the best sample
  // repeatedly, keeping whichever side is nearer.
  let low = Math.max(0, best - CENTRELINE_SPACING)
  let high = Math.min(alignment.length, best + CENTRELINE_SPACING)
  for (let i = 0; i < REFINEMENT_PASSES; i++) {
    const mid = (low + high) / 2
    const quarter = (high - low) / 4
    const left = alignment.poseAt(mid - quarter)
    const right = alignment.poseAt(mid + quarter)
    if (distance(left.position, position) < distance(right.position, position)) {
      high = mid
    } else {
      low = mid
    }
  }

  const station = (low + high) / 2
  const pose = alignment.poseAt(station)
  return { station, distance: distance(pose.position, position), position: pose.position }
}

/**
 * What a pointer position means.
 *
 * Nodes beat roads: a node is itself a point on a road, and a player pointing
 * near a junction almost always means to connect to it rather than to split
 * one of its legs a metre away.
 *
 * `radius` is a usability threshold in metres of world space, deliberately far
 * larger than `NODE_SNAP_DISTANCE`. That constant answers whether two road
 * ends *are* the same node; this answers what a player is pointing at. Nodes
 * are ranked nearest-first here, where `nodeAt` resolves ties to the
 * earliest-created node — the right rule for identity, the wrong one for aim.
 */
export const resolveSnap = (
  network: RoadNetwork,
  position: Vec2,
  radius: number,
): SnapTarget => {
  const nodes: NetworkNode[] = network.nodesWithin(position, radius)
  const nearestNode = nodes[0]
  if (nearestNode) {
    return { kind: 'node', position: nearestNode.position, nodeId: nearestNode.id }
  }

  let best: { roadId: RoadId; station: number; position: Vec2; distance: number } | undefined
  for (const road of network.roads) {
    const candidate = nearestStation(network, road.id, position)
    if (candidate.distance <= radius && (!best || candidate.distance < best.distance)) {
      best = { roadId: road.id, ...candidate }
    }
  }

  if (best) {
    return {
      kind: 'road',
      position: best.position,
      roadId: best.roadId,
      station: best.station,
    }
  }

  return { kind: 'free', position }
}
