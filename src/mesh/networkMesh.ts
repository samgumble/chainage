import type { RoadNetwork, RoadId, NodeId } from '../network/graph'
import { junctionLegs } from './junctionLegs'
import { solveJunction, type JunctionGeometry } from './junctionCorners'
import { buildJunctionMesh } from './junctionMesh'
import {
  buildRoadMesh, type RoadMesh, type RoadExtent, type LayerStations,
} from './roadMesh'
import { ROAD_CLASSES } from './roadClass'
import { type ProfilePoint, designElevationAtStation } from '../terrain/groundProfile'
import type { MeshData } from './ribbon'

export type NetworkMeshOptions = {
  readonly spacing?: number
  /** Per-road construction stations. A road not listed is fully built. */
  readonly stations?: ReadonlyMap<RoadId, LayerStations>
}

export type NetworkMesh = {
  readonly roads: ReadonlyMap<RoadId, RoadMesh>
  readonly junctions: ReadonlyMap<NodeId, MeshData>
  /** Nodes whose junction could not be solved, and why. */
  readonly infeasibleJunctions: ReadonlyMap<NodeId, string>
}

/**
 * Build every road and junction in a network.
 *
 * Each road is trimmed by whatever its two end nodes demand, so its ribbon
 * stops short of every junction surface it runs into. A road at a dead end is
 * not trimmed there — there is nothing to clear.
 *
 * A junction that cannot be solved produces no surface and an entry in
 * `infeasibleJunctions` naming the reason, rather than a plausible-looking
 * wrong shape. Roads still trim by whatever the failed solve managed, which
 * is nothing, so they run to their full length and visibly overlap — a
 * legible symptom rather than a silent one.
 */
export const buildNetworkMesh = (
  network: RoadNetwork,
  designs: ReadonlyMap<RoadId, readonly ProfilePoint[]>,
  options: NetworkMeshOptions = {},
): NetworkMesh => {
  const { spacing = 4, stations } = options

  const junctions = new Map<NodeId, MeshData>()
  const infeasibleJunctions = new Map<NodeId, string>()
  /** roadId -> { from, to } accumulated from both its end nodes. */
  const trims = new Map<RoadId, { from: number; to: number }>()

  for (const road of network.roads) {
    trims.set(road.id, { from: 0, to: road.alignment.length })
  }

  for (const node of network.nodes) {
    if (!network.isJunction(node.id)) continue

    const legs = junctionLegs(network, node.id)
    const geometry: JunctionGeometry = solveJunction(legs)

    if (!geometry.feasible) {
      infeasibleJunctions.set(node.id, geometry.reason)
      continue
    }

    // Elevation from any leg's design profile at the node.
    const firstLeg = legs[0]!
    const firstRoad = network.road(firstLeg.roadId)
    const design = designs.get(firstLeg.roadId) ?? []
    const stationAtNode =
      firstLeg.end === 'start' ? 0 : firstRoad.alignment.length
    const elevation = designElevationAtStation(design, stationAtNode)

    junctions.set(
      node.id,
      buildJunctionMesh(node.position, elevation, legs, geometry),
    )

    legs.forEach((leg, i) => {
      const trim = geometry.trims[i]!
      const current = trims.get(leg.roadId)!
      const alignment = network.road(leg.roadId).alignment
      if (leg.end === 'start') {
        current.from = Math.max(current.from, trim)
      } else {
        current.to = Math.min(current.to, alignment.length - trim)
      }
    })
  }

  const roads = new Map<RoadId, RoadMesh>()
  for (const road of network.roads) {
    const trim = trims.get(road.id)!
    // A road trimmed past itself has been swallowed by its junctions.
    const extent: RoadExtent = {
      from: trim.from,
      to: Math.max(trim.from, trim.to),
    }

    roads.set(
      road.id,
      buildRoadMesh(
        road.alignment,
        designs.get(road.id) ?? [],
        ROAD_CLASSES[road.className],
        stations?.get(road.id),
        { spacing },
        extent,
      ),
    )
  }

  return { roads, junctions, infeasibleJunctions }
}
