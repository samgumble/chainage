import type { RoadNetwork, RoadId, NodeId } from '../network/graph'
import { junctionLegs } from './junctionLegs'
import { solveJunction, type JunctionGeometry, type JunctionInfeasibility } from './junctionCorners'
import { buildJunctionMesh } from './junctionMesh'
import {
  buildRoadMesh, type RoadMesh, type RoadExtent, type LayerStations,
} from './roadMesh'
import { ROAD_CLASSES, formationHalfWidth } from './roadClass'
import { type ProfilePoint, designElevationAtStation } from '../terrain/groundProfile'
import type { MeshData } from './ribbon'
import type { TerrainSampler } from '../terrain/heightmap'
import { type CorridorTemplate } from '../terrain/corridor'
import { classifySupport } from '../terrain/gradeSolver'
import { sampleGroundProfile } from '../terrain/groundProfile'
import { structureSpans } from './structures/spans'
import { buildBridgeMesh } from './structures/bridgeMesh'
import { wallSegments, buildRetainingWallMesh } from './structures/retainingWallMesh'
import { findCrossings, MIN_OVERPASS_CLEARANCE } from '../network/crossings'

export type NetworkMeshOptions = {
  readonly spacing?: number
  /** Per-road construction stations. A road not listed is fully built. */
  readonly stations?: ReadonlyMap<RoadId, LayerStations>
  /** Required for structures — walls and bridges both need ground elevation. */
  readonly terrain?: TerrainSampler
  readonly corridorTemplate?: CorridorTemplate
}

export type NetworkMesh = {
  readonly roads: ReadonlyMap<RoadId, RoadMesh>
  readonly junctions: ReadonlyMap<NodeId, MeshData>
  /** Nodes whose junction could not be solved, and why. */
  readonly infeasibleJunctions: ReadonlyMap<NodeId, JunctionInfeasibility>
  /** Nodes whose legs disagree about elevation, and by how much (metres). */
  readonly elevationMismatches: ReadonlyMap<NodeId, number>
  /** Walls and bridges per road. Empty when no terrain was supplied. */
  readonly structures: ReadonlyMap<RoadId, MeshData>
  /**
   * Crossings too tight for one road to pass over the other, keyed
   * `"upperId:lowerId"`, with the measured clearance in metres.
   */
  readonly tightCrossings: ReadonlyMap<string, number>
}

/**
 * Largest tolerable spread between legs' design elevations at a junction,
 * metres, before it's recorded in `elevationMismatches`.
 *
 * Measured at each leg's trim station — where its ribbon actually meets the
 * junction plate — not at the node, so the figure reflects the real join.
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

    // Elevation is the mean of every leg's own design elevation, not one
    // leg's arbitrarily — roads graded independently routinely disagree, and
    // averaging halves the worst step instead of handing one leg a perfect
    // join and the rest the whole error. Legs with an empty design profile
    // are skipped: `designElevationAtStation` returns 0 for those, and
    // treating that as a real elevation would fabricate a huge spread.
    //
    // Sampled at the leg's TRIM station, not the node station. The ribbon
    // does not reach the node — it stops `trim` metres short of it (or
    // `length - trim` for an `end`-attached leg) — so sampling at the node
    // reads a grade-line elevation the ribbon never actually has at the
    // point where it meets the plate. On a graded approach that mismatch
    // grows with both the grade and the trim distance.
    //
    // A flat plate also cannot match a cross-sectioned ribbon exactly: the
    // ribbon's trimmed end presents a crown in the middle and two edges sat
    // `formationHalfWidth * crossfall` below it, while the plate is one flat
    // surface. Sitting the plate at crown height would put the *whole* of
    // that drop at the edges as a visible lip; subtracting half the drop
    // here instead splits the difference, so the worst-case step at the
    // plate/ribbon join is bounded by half the crossfall drop rather than
    // all of it. Fully removing this residual would mean running the
    // crossfall out to flat over the last few metres of each approach — real
    // junction design does exactly that — but that's a shaping change to the
    // ribbon itself, deferred to a later plan.
    const legElevations: number[] = []
    legs.forEach((leg, i) => {
      const design = designs.get(leg.roadId)
      if (!design || design.length === 0) return
      const road = network.road(leg.roadId)
      const trim = geometry.trims[i]!
      const trimStation = leg.end === 'start' ? trim : road.alignment.length - trim
      const rc = ROAD_CLASSES[road.className]
      const crossfallDrop = (formationHalfWidth(rc) * rc.crossfall) / 2
      legElevations.push(designElevationAtStation(design, trimStation) - crossfallDrop)
    })

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

  const structures = new Map<RoadId, MeshData>()

  if (options.terrain && options.corridorTemplate) {
    const terrain = options.terrain
    const template = options.corridorTemplate

    for (const road of network.roads) {
      const design = designs.get(road.id) ?? []
      const parts: MeshData[] = []

      if (design.length >= 2) {
        const halfWidth = formationHalfWidth(ROAD_CLASSES[road.className])
        const ground = sampleGroundProfile(road.alignment, terrain, spacing)

        // Resample the design onto the ground profile's own stations, so
        // classifySupport compares like with like. The two profiles are
        // sampled independently and will not otherwise share stations.
        const designAtGround = ground.map((g) => ({
          s: g.s,
          z: designElevationAtStation(design, g.s),
        }))

        const support = classifySupport(ground, designAtGround, MAX_FILL_FOR_STRUCTURE)
        for (const span of structureSpans(designAtGround, support, ground)) {
          parts.push(buildBridgeMesh(road.alignment, terrain, design, span, halfWidth))
        }

        parts.push(
          buildRetainingWallMesh(
            road.alignment,
            wallSegments(road.alignment, terrain, design, template, spacing),
          ),
        )
      }

      structures.set(road.id, mergeMeshes(parts))
    }
  }

  const tightCrossings = new Map<string, number>()
  for (const crossing of findCrossings(network, designs)) {
    if (crossing.clearance < MIN_OVERPASS_CLEARANCE) {
      tightCrossings.set(`${crossing.upper}:${crossing.lower}`, crossing.clearance)
    }
  }

  return {
    roads, junctions, infeasibleJunctions, elevationMismatches, structures, tightCrossings,
  }
}

/**
 * How high the design line may stand above ground on fill before it becomes a
 * structure, metres.
 *
 * Above this an embankment stops being economic and starts looking absurd.
 * This mirrors the `maxFillHeight` a caller passes to the grade solver; it is
 * restated here because the network builder is not given those constraints.
 */
export const MAX_FILL_FOR_STRUCTURE = 10

/**
 * Concatenate several meshes into one, renumbering indices.
 *
 * Typed arrays are copied with `set` rather than spread — spreading a large
 * `Float32Array` into a function call blows the argument limit, and these
 * meshes are unbounded in size.
 */
const mergeMeshes = (meshes: readonly MeshData[]): MeshData => {
  let vertexCount = 0
  let indexCount = 0
  for (const mesh of meshes) {
    vertexCount += mesh.vertexCount
    indexCount += mesh.indices.length
  }

  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  const indices = new Uint32Array(indexCount)

  let vertexBase = 0
  let indexBase = 0
  for (const mesh of meshes) {
    positions.set(mesh.positions, vertexBase * 3)
    normals.set(mesh.normals, vertexBase * 3)
    uvs.set(mesh.uvs, vertexBase * 2)
    for (let i = 0; i < mesh.indices.length; i++) {
      indices[indexBase + i] = mesh.indices[i]! + vertexBase
    }
    vertexBase += mesh.vertexCount
    indexBase += mesh.indices.length
  }

  return {
    positions, normals, uvs, indices,
    vertexCount,
    triangleCount: indexCount / 3,
  }
}
