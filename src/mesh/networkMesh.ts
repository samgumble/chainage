import type { RoadNetwork, RoadId, NodeId } from '../network/graph'
import { junctionLegs } from './junctionLegs'
import { solveJunction, type JunctionGeometry, type JunctionInfeasibility } from './junctionCorners'
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
  readonly infeasibleJunctions: ReadonlyMap<NodeId, JunctionInfeasibility>
  /** Nodes whose legs disagree about elevation, and by how much (metres). */
  readonly elevationMismatches: ReadonlyMap<NodeId, number>
}

/**
 * Largest tolerable spread between legs' design elevations at a junction,
 * metres, before it's recorded in `elevationMismatches`.
 *
 * A quarter of a metre is a step a player would see; below that the join
 * reads as flush.
 */
export const MAX_JUNCTION_ELEVATION_SPREAD = 0.25

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
  const infeasibleJunctions = new Map<NodeId, JunctionInfeasibility>()
  const elevationMismatches = new Map<NodeId, number>()
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

    // Elevation is the mean of every leg's own design elevation at the node,
    // not one leg's arbitrarily — roads graded independently routinely
    // disagree, and averaging halves the worst step instead of handing one
    // leg a perfect join and the rest the whole error. Legs with an empty
    // design profile are skipped: `designElevationAtStation` returns 0 for
    // those, and treating that as a real elevation would fabricate a huge
    // spread.
    const legElevations: number[] = []
    for (const leg of legs) {
      const design = designs.get(leg.roadId)
      if (!design || design.length === 0) continue
      const road = network.road(leg.roadId)
      const stationAtNode = leg.end === 'start' ? 0 : road.alignment.length
      legElevations.push(designElevationAtStation(design, stationAtNode))
    }

    let elevation = 0
    if (legElevations.length > 0) {
      elevation =
        legElevations.reduce((sum, z) => sum + z, 0) / legElevations.length
      const spread = Math.max(...legElevations) - Math.min(...legElevations)
      if (spread > MAX_JUNCTION_ELEVATION_SPREAD) {
        elevationMismatches.set(node.id, spread)
      }
    }

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

  return { roads, junctions, infeasibleJunctions, elevationMismatches }
}
