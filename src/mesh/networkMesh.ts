import type { RoadNetwork, RoadId, NodeId } from '../network/graph'
import { junctionLegs } from './junctionLegs'
import { solveJunction, type JunctionGeometry, type JunctionInfeasibility } from './junctionCorners'
import { buildJunctionMesh } from './junctionMesh'
import {
  buildRoadMesh, type RoadMesh, type RoadExtent, type LayerStations,
} from './roadMesh'
import { ROAD_CLASSES, formationHalfWidth } from '../network/roadClass'
import { type ProfilePoint, designElevationAtStation } from '../terrain/groundProfile'
import type { MeshData } from './ribbon'
import type { TerrainSampler } from '../terrain/heightmap'
import { type CorridorBatters } from '../terrain/corridor'
import { roadStructureSpans, type StructureSpan } from './structures/spans'
import { buildBridgeMesh } from './structures/bridgeMesh'
import { wallSegments, buildRetainingWallMesh } from './structures/retainingWallMesh'
import { findCrossings, MIN_OVERPASS_CLEARANCE, type Crossing } from '../network/crossings'

type NetworkMeshCommon = {
  readonly spacing?: number
  /** Per-road construction stations. A road not listed is fully built. */
  readonly stations?: ReadonlyMap<RoadId, LayerStations>
  /**
   * Batters and wall limit for the whole network. Required for retaining
   * walls; bridges do not need it.
   *
   * Deliberately not a full `CorridorTemplate`: formation width is a property
   * of the road class, and a network holds several. Each road's own width is
   * filled in here from `ROAD_CLASSES`, so a gravel branch cannot have its
   * walls measured against a rural road's formation.
   */
  readonly corridorBatters?: CorridorBatters
  /**
   * Per-road structure spans, if the caller already has them.
   *
   * A caller that excavates terrain must derive these BEFORE it excavates —
   * earthwork has to stop at the abutment face, and it cannot ask a mesh that
   * has not been built yet where that is. Passing the very list it used here
   * is what guarantees the bridge sits on the ground the earthworks left it,
   * rather than on a second derivation that agrees only by luck (it did not:
   * the two disagreed by seven stations at each end of the demo scene's span).
   *
   * A road absent from the map has its spans derived here from the same
   * `roadStructureSpans`, so omitting this option costs nothing but the
   * duplicated work.
   */
  readonly structureSpans?: ReadonlyMap<RoadId, readonly StructureSpan[]>
}

/**
 * Natural ground for structures, and the fill allowance it was graded to.
 *
 * The two travel together deliberately. Whether a station is carried on earth
 * or on a structure is `design − ground > maxFillHeight`, and `maxFillHeight`
 * is not the mesh layer's to choose: it is whatever the caller handed
 * `solveGradeProfile`. Restating it here as a constant — which is what this
 * used to do — means any caller who grades to a different allowance silently
 * gets the wrong answer, fabricating bridges under ordinary embankments or
 * suppressing real ones. Supplying a terrain without it is therefore a type
 * error, not a defaulted-away detail.
 *
 * `terrain` must be NATURAL ground, before any corridor excavation. Ground
 * already cut and filled to the design surface sits at the design line by
 * construction, so every station reads as level and neither trigger can fire.
 */
type StructureGround =
  | { readonly terrain: TerrainSampler; readonly maxFillHeight: number }
  | { readonly terrain?: never; readonly maxFillHeight?: never }

export type NetworkMeshOptions = NetworkMeshCommon & StructureGround

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
   * `"upperId:lowerId@upperStation"`, with the measured clearance in metres.
   * Keyed per crossing, not per road pair: a pair that crosses twice, both
   * times too tight, is two entries.
   *
   * A crossing between roads with no design profile is not reported at all —
   * there is no elevation to measure a gap between.
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

  const terrain: TerrainSampler | undefined = options.terrain
  const maxFillHeight: number | undefined = options.maxFillHeight
  if (terrain !== undefined && maxFillHeight === undefined) {
    throw new RangeError(
      'maxFillHeight is required with terrain: structures are classified ' +
        'against the fill allowance the design line was graded to',
    )
  }

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

  // Bridges need ground and a fill allowance; walls additionally need a
  // corridor cross-section to know where a batter runs out of room. Gating
  // both on the template would silently cost a terrain-only caller its
  // bridges, so the two triggers are gated independently.
  if (terrain !== undefined && maxFillHeight !== undefined) {
    const batters = options.corridorBatters

    for (const road of network.roads) {
      const design = designs.get(road.id) ?? []
      const parts: MeshData[] = []

      if (design.length >= 2) {
        const halfWidth = formationHalfWidth(ROAD_CLASSES[road.className])

        // The caller's spans if it has any — the corridor excavation needs
        // the same list, and handing it down is what stops the two from
        // drifting apart. Derived here otherwise, by the same function the
        // caller would have used, so there is one derivation either way and
        // a caller with no interest in earthworks still gets its bridges.
        const spans =
          options.structureSpans?.get(road.id) ??
          roadStructureSpans({ alignment: road.alignment, design, terrain, maxFillHeight, spacing })

        for (const span of spans) {
          parts.push(buildBridgeMesh(road.alignment, terrain, design, span, halfWidth))
        }

        if (batters !== undefined) {
          // This road's own formation width, not the network's — the wall
          // stands at `formationHalfWidth + maxBatterWidth` from the
          // centreline, so borrowing another class's width puts it in the
          // wrong place.
          const template = { ...batters, formationHalfWidth: halfWidth }
          // Stations inside a span are dropped: a retaining wall holds back
          // an earthwork, and where a bridge carries the road there is no
          // earthwork to hold. `retainingWall()` cannot know that — it is
          // handed one station's design and ground elevation and nothing
          // else, and a design line standing 17m over a valley floor looks
          // to it exactly like one standing on a 17m embankment. Only here,
          // where the spans are already in hand, is the difference visible.
          const carried = (s: number) =>
            spans.some((span) => s >= span.fromStation && s <= span.toStation)
          parts.push(
            buildRetainingWallMesh(
              road.alignment,
              wallSegments(road.alignment, terrain, design, template, spacing)
                .filter((segment) => !carried(segment.s)),
            ),
          )
        }
      }

      structures.set(road.id, mergeMeshes(parts))
    }
  }

  const tightCrossings = new Map<string, number>()
  for (const crossing of findCrossings(network, designs)) {
    if (crossing.clearance < MIN_OVERPASS_CLEARANCE) {
      tightCrossings.set(tightCrossingKey(crossing), crossing.clearance)
    }
  }

  return {
    roads, junctions, infeasibleJunctions, elevationMismatches, structures, tightCrossings,
  }
}

/**
 * Report key for one tight crossing: `"upperId:lowerId@upperStation"`.
 *
 * The station is what makes it a crossing rather than a pair. Two roads can
 * cross twice — `findCrossings` reports both, deliberately — and keying on the
 * road pair alone silently discards all but one of them, which is the bug the
 * layer below was fixed for. The upper road's station identifies the crossing
 * on its own: a station is one point on one alignment, so no two crossings of
 * the same pair can share it.
 */
const tightCrossingKey = (crossing: Crossing): string =>
  `${crossing.upper}:${crossing.lower}@${crossing.upperStation.toFixed(2)}`

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
