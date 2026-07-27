import { describe, it, expect } from 'vitest'
import {
  buildSceneContent, solveNetwork, terrainBounds,
  CORRIDOR_MAX_BATTER_WIDTH, EXCAVATION_STATION_SPACING,
  DEFAULT_DRAW_CLASS, RIG_INITIAL_DISTANCE,
} from './roadScene'
import { buildNetworkMesh } from '../mesh/networkMesh'
import type { RoadMesh } from '../mesh/roadMesh'
import { RoadNetwork, type RoadId } from '../network/graph'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import { sampleGroundProfile, designElevationAtStation } from '../terrain/groundProfile'
import { solveGradeProfile } from '../terrain/gradeSolver'
import { Heightmap } from '../terrain/heightmap'
import type { TerrainEditLayer } from '../terrain/editLayer'
import { SelectTool } from '../tool/selectTool'
import { minimumRadiusForSpeed } from '../geometry/designSpeed'
import {
  ROAD_CLASSES, ROAD_CLASS_ORDER, formationHalfWidth, totalPavementThickness,
  type RoadClassName,
} from '../network/roadClass'
import { MIN_OVERPASS_CLEARANCE } from '../network/crossings'
import { DECK_DEPTH } from '../mesh/structures/bridgeMesh'
import type { StructureSpan } from '../mesh/structures/spans'

/**
 * The demo scene is the only end-to-end evidence the structures pipeline
 * works, so its parameters are asserted rather than eyeballed. Both triggers
 * shipped unreachable once — a grade solver bounded to ground + fill
 * allowance can never produce a structure station, and a corridor template
 * with no `maxBatterWidth` can never produce a wall — and neither failure is
 * visible in a screenshot of a scene that renders perfectly well without them.
 *
 * The scene is built once: it grades three roads over a 257x257 terrain and
 * excavates every corridor, which is not cheap.
 */
const content = buildSceneContent()

/**
 * Everything hanging below a rural road's design line where it is carried over
 * something: the pavement stack it runs on, plus the deck slab under that.
 * Restated from the same two sources `roadScene.ts` derives it from, so a test
 * that agreed with a hardcoded number rather than with the deck that actually
 * gets built would fail here.
 */
const ruralStructureDepth = totalPavementThickness(ROAD_CLASSES.rural) + DECK_DEPTH

/** Total structure vertices across every road. */
const structureVertices = (built: { structures: ReadonlyMap<number, { vertexCount: number }> }) => {
  let total = 0
  for (const [, mesh] of built.structures) total += mesh.vertexCount
  return total
}

/**
 * `terrainBounds` sizes the sun's shadow camera (see `drawRoadScene`), so it
 * is the one piece of that setup that is a pure function of the terrain and
 * testable without a renderer — everything else in Step 3 needs a real
 * `THREE.DirectionalLight` and is covered by using the app (Step 8).
 */
describe('terrainBounds', () => {
  it('centres on a flat heightmap\'s footprint, at its own elevation', () => {
    // 3x3 grid, cellSize 10, all elevations 0: a 20x20 footprint centred on
    // (10, 10), with no elevation spread at all.
    const flat = new Heightmap(0, 0, 10, 3, 3, new Float32Array(9))
    const bounds = terrainBounds(flat)

    expect(bounds.centerX).toBe(10)
    expect(bounds.centerY).toBe(10)
    expect(bounds.centerZ).toBe(0)
    // Half-footprint is (10, 10) with no elevation spread, so the enclosing
    // sphere's radius is exactly the flat diagonal: hypot(10, 10, 0).
    expect(bounds.radius).toBeCloseTo(Math.hypot(10, 10, 0), 10)
  })

  it("grows the radius to cover the heightmap's own elevation spread", () => {
    // 2x2 grid, cellSize 1, origin (5, 5): a single cell, one corner raised
    // 10m above the other three — minZ=0, maxZ=10.
    const elevations = new Float32Array([0, 0, 0, 10])
    const bumpy = new Heightmap(5, 5, 1, 2, 2, elevations)
    const bounds = terrainBounds(bumpy)

    expect(bounds.centerX).toBe(5.5)
    expect(bounds.centerY).toBe(5.5)
    // Midpoint of the elevation range, not the mean of the four samples.
    expect(bounds.centerZ).toBe(5)
    // Half-footprint (0.5, 0.5) plus half the elevation spread (5) — a
    // flat-heightmap radius (as above) would badly undersize the shadow
    // camera's frustum against this much relief.
    expect(bounds.radius).toBeCloseTo(Math.hypot(0.5, 0.5, 5), 10)
  })
})

describe('the demo scene', () => {
  it('grades all three roads', () => {
    expect(content.designs.size).toBe(3)
  })

  it('produces at least one bridge', () => {
    // Rebuilt with no corridor template, so walls are off and every vertex
    // left is a bridge. A count taken from the full scene could not tell the
    // two structure types apart.
    const bridgesOnly = buildNetworkMesh(content.network, content.designs, {
      spacing: 4,
      terrain: content.terrain,
      maxFillHeight: 10,
    })
    expect(structureVertices(bridgesOnly)).toBeGreaterThan(0)
  })

  it('produces retaining walls as well as bridges', () => {
    // Same scene minus the batter limit: no wall can be built without one, so
    // whatever the full scene has beyond this is wall.
    const bridgesOnly = buildNetworkMesh(content.network, content.designs, {
      spacing: 4,
      terrain: content.terrain,
      maxFillHeight: 10,
    })
    expect(structureVertices(content.built)).toBeGreaterThan(structureVertices(bridgesOnly))
  })

  // What ties the earthworks to the structures. `solveNetwork` derives each
  // road's spans once, before excavating, and hands the same list to both
  // `sweepCorridor` (as `structureRanges`) and `buildNetworkMesh` — so the
  // sweep stops at the abutment face rather than at whatever station a
  // per-station fill test happened to trip. This assertion fails outright if
  // that thread is ever cut: with `structureRanges: []` the sweep fills the
  // valley the deck crosses and no bridge vertex stands over natural ground.
  it('leaves the ground unexcavated where a bridge carries the road', () => {
    // The bridge spans a valley the earthworks would otherwise fill in. If
    // the excavation ran through the span, the deck would be buried in its
    // own embankment: somewhere under a bridge the edit layer must still
    // read as natural ground.
    const bridgesOnly = buildNetworkMesh(content.network, content.designs, {
      spacing: 4,
      terrain: content.terrain,
      maxFillHeight: 10,
    })

    let sampled = 0
    let untouched = 0
    for (const [, mesh] of bridgesOnly.structures) {
      for (let i = 0; i < mesh.vertexCount; i++) {
        const x = mesh.positions[i * 3]!
        const y = mesh.positions[i * 3 + 1]!
        sampled++
        if (content.editLayer.sample(x, y) === content.terrain.sample(x, y)) untouched++
      }
    }
    expect(sampled).toBeGreaterThan(0)
    expect(untouched).toBeGreaterThan(0)
  })
})

/**
 * The drawing tool needs the same `RoadNetwork` the scene built its meshes
 * from — otherwise a road it commits would exist in a network nothing
 * renders — and committing has to leave the scene able to build a mesh for
 * the new road. Both are exercised here without a renderer: the event
 * handlers that turn pointer input into `tool.place`/`tool.commit` calls need
 * a canvas and a GPU and are covered by using the app (Step 8), but the
 * mesh-rebuilding logic they end up calling does not, and is covered here.
 *
 * Uses a fresh `RoadNetwork` rather than mutating the shared `content` above,
 * so this test cannot affect the other tests' shared fixture regardless of
 * execution order.
 */
describe('rebuilding after the network changes', () => {
  it('exposes the RoadNetwork the scene content was built from', () => {
    expect(content.network).toBeInstanceOf(RoadNetwork)
    // Every road that made it into the network graded successfully, so the
    // two collections stay in lockstep for this demo scene.
    expect(content.network.roads.length).toBe(content.designs.size)
  })

  it('produces a mesh for a road added after the scene was built', () => {
    // Near the valley's axis (y=1280, matching the demo junction), where the
    // ground is close to flat — a short, gently graded road needs no help
    // from the terrain to succeed.
    const alignment = new Alignment([new Line(vec2(200, 1280), 0, 200)])

    const network = new RoadNetwork()
    const roadId = network.addRoad(alignment, 'gravel')

    const ground = sampleGroundProfile(alignment, content.terrain, 10)
    const solution = solveGradeProfile(ground, {
      maxGrade: 0.2, maxCutDepth: 20, maxFillHeight: 20, maxStructureHeight: 20,
    })
    expect(solution.feasible).toBe(true)
    if (!solution.feasible) return // narrows the type for the compiler

    const designs = new Map([[roadId, solution.profile]])
    const rebuilt = buildNetworkMesh(network, designs, { spacing: 4 })

    const roadMesh = rebuilt.roads.get(roadId)
    expect(roadMesh).toBeDefined()
    const totalVertices = roadMesh!.layers.reduce((sum, l) => sum + l.mesh.vertexCount, 0)
    expect(totalVertices).toBeGreaterThan(0)
  })
})

/**
 * `DrawTool.commit` validates only horizontal geometry (segment lengths,
 * curvature, self-intersection) — it never checks whether the terrain
 * permits a vertical alignment at all. A road can therefore commit into the
 * network and then fail to grade, at which point `designElevationAtStation`
 * treats its (empty) design profile as flat at z=0 — so it still gets a
 * mesh, just one sitting at absolute elevation zero, typically buried far
 * underground on real terrain. Silently dropping that road from `designs`
 * with no further report would be a graph/render divergence: the road is
 * still snappable and splittable, part of every future junction solve, but
 * invisible with no indication why.
 *
 * `solveNetwork` is exported so this is checkable directly against a network
 * built for the purpose, rather than only via a console.warn a test cannot
 * observe.
 */
describe('a road with no feasible vertical alignment', () => {
  it('is recorded in infeasibleRoads instead of silently dropped', () => {
    // A heightmap that climbs 20m every 10m along x — far steeper than any
    // grade/cut/fill allowance this scene solves against, so a road running
    // along it cannot be graded no matter what the solver does.
    const cols = 10
    const rows = 2
    const elevations = new Float32Array(cols * rows)
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        elevations[row * cols + col] = col * 20
      }
    }
    const cliff = new Heightmap(0, 0, 10, cols, rows, elevations)

    const network = new RoadNetwork()
    const alignment = new Alignment([new Line(vec2(5, 5), 0, 50)])
    const roadId = network.addRoad(alignment, 'rural')

    const { designs, infeasibleRoads } = solveNetwork(cliff, network)

    // The core of the fix: this road has no entry in `designs` (nothing to
    // grade it against), but that must not mean it vanishes without a trace —
    // it has to show up somewhere a caller can act on.
    expect(designs.has(roadId)).toBe(false)
    expect(infeasibleRoads.has(roadId)).toBe(true)
    expect(infeasibleRoads.get(roadId)).toBeGreaterThanOrEqual(0)
  })
})

/**
 * `roadScene.ts`'s select-mode key handlers (delete, split, upgrade/downgrade)
 * all do the same two things: call one `SelectTool` method, then call
 * `rebuildNetworkMeshes` — which is exactly `solveNetwork` followed by
 * `buildNetworkMesh`, both already exercised above. The event handlers
 * themselves need a canvas and a GPU and are covered by using the app; what is
 * genuinely new and testable here, without a renderer, is that a network
 * `SelectTool` has actually mutated re-solves and remeshes without error, and
 * that a class change shows up in the rebuilt mesh rather than silently
 * keeping the old cross-section.
 */
describe('select mode mutations re-solve and rebuild', () => {
  /** Flat and empty: every leg below grades trivially, so these tests are
   * about the network mutation and remesh, not the grade solver. */
  const flatTerrain = (): Heightmap => {
    const cols = 41
    const rows = 41
    return new Heightmap(-50, -50, 10, cols, rows, new Float32Array(cols * rows))
  }

  /** A T junction like the demo scene's, small enough for a 41x41 flat
   * terrain: two rural arms east-west, one gravel arm north — a genuine
   * 3-leg junction, so deleting or reclassifying a leg exercises the
   * junction re-solve the visual checklist asks about, not just a lone road. */
  const buildTJunction = (): { network: RoadNetwork; westId: RoadId; eastId: RoadId; northId: RoadId } => {
    const junction = vec2(100, 100)
    const network = new RoadNetwork()
    const westId = network.addRoad(new Alignment([new Line(junction, Math.PI, 100)]), 'rural')
    const eastId = network.addRoad(new Alignment([new Line(junction, 0, 100)]), 'rural')
    const northId = network.addRoad(new Alignment([new Line(junction, Math.PI / 2, 100)]), 'gravel')
    return { network, westId, eastId, northId }
  }

  /** Every vertex of a road's mesh sits at a fixed offset from a dead-straight
   * centreline, and offset is carried entirely in one world axis for a leg
   * that runs exactly along the other — for the north leg here (heading
   * π/2), offset is carried in x, chainage in y. So the full x-extent across
   * every layer's vertices is exactly twice the widest layer's half-width:
   * a direct read of "how wide did this road actually get built" out of the
   * mesh, not an assumption about it. */
  const lateralSpread = (mesh: RoadMesh): number => {
    let min = Infinity
    let max = -Infinity
    for (const layer of mesh.layers) {
      for (let i = 0; i < layer.mesh.vertexCount; i++) {
        const x = layer.mesh.positions[i * 3]!
        if (x < min) min = x
        if (x > max) max = x
      }
    }
    return max - min
  }

  it('deleting the selected road leaves the remaining junction solvable and re-meshed', () => {
    const terrain = flatTerrain()
    const { network, westId, eastId, northId } = buildTJunction()

    const selectTool = new SelectTool(network)
    selectTool.select(vec2(100, 150)) // partway up the north (gravel) leg
    expect(selectTool.selected).toBe(northId)

    const outcome = selectTool.deleteSelected()
    expect(outcome).toEqual({ ok: true, roadId: northId })
    expect(network.roads.length).toBe(2)
    expect(selectTool.selected).toBeUndefined()

    // The same rebuild `roadScene.ts`'s handlers perform after every
    // mutation — must not throw, and the two remaining legs (now a plain
    // east-west pass-through, the junction resolved away) must still both
    // grade and mesh with their ends intact.
    const { designs, built } = solveNetwork(terrain, network)
    expect(designs.size).toBe(2)
    for (const roadId of [westId, eastId]) {
      const mesh = built.roads.get(roadId)
      expect(mesh).toBeDefined()
      const totalVertices = mesh!.layers.reduce((sum, l) => sum + l.mesh.vertexCount, 0)
      expect(totalVertices).toBeGreaterThan(0)
    }
  })

  it("reclassifying the selected road changes its class and the rebuilt mesh's width", () => {
    const terrain = flatTerrain()
    const { network, northId } = buildTJunction()

    const selectTool = new SelectTool(network)
    selectTool.select(vec2(100, 150))
    expect(selectTool.selected).toBe(northId)

    const before = solveNetwork(terrain, network)
    const widthBefore = lateralSpread(before.built.roads.get(northId)!)

    const outcome = selectTool.reclassifySelected('highway')
    expect(outcome).toEqual({ ok: true, roadId: northId, from: 'gravel', to: 'highway' })
    expect(network.road(northId).className).toBe('highway')
    // Reclassifying does not clear the selection the way delete and split do.
    expect(selectTool.selected).toBe(northId)

    const after = solveNetwork(terrain, network)
    const widthAfter = lateralSpread(after.built.roads.get(northId)!)

    expect(widthAfter).toBeGreaterThan(widthBefore)
    // Matches the formation width the two classes are actually built from,
    // not just "got bigger by some amount" — the widest layer (subgrade)
    // extends `widthExtension` beyond the formation edge on each side.
    const gravelSubgrade = ROAD_CLASSES.gravel.layers.find((l) => l.name === 'subgrade')!
    const highwaySubgrade = ROAD_CLASSES.highway.layers.find((l) => l.name === 'subgrade')!
    const expectedBefore = 2 * (formationHalfWidth(ROAD_CLASSES.gravel) + gravelSubgrade.widthExtension)
    const expectedAfter = 2 * (formationHalfWidth(ROAD_CLASSES.highway) + highwaySubgrade.widthExtension)
    // Precision 4 (not tighter): vertex positions are `Float32Array`, whose
    // ~7-digit precision on values around 100 (the junction's x) already
    // costs several decimal places before any road-width arithmetic starts.
    expect(widthBefore).toBeCloseTo(expectedBefore, 4)
    expect(widthAfter).toBeCloseTo(expectedAfter, 4)
  })
})

/**
 * Grade separation: two roads that cross in plan without a player ever having
 * clicked where they meet.
 *
 * The rule is that the newer road goes over, always, and that the lift is a
 * constraint on the newer road's grade solve rather than something done to
 * its answer — see `solveNetwork`'s docstring. `solveNetwork` is exported, so
 * both halves are checkable directly against a network built for the purpose.
 *
 * The demo scene cannot stand in for this: its three arms all meet at one
 * shared node, so it has no crossings at all and never exercises this path.
 */
describe('roads that cross without a junction', () => {
  /** Flat ground at 100m over a 600x600 footprint. */
  const flat = (): Heightmap =>
    new Heightmap(0, 0, 10, 61, 61, new Float32Array(61 * 61).fill(100))

  /**
   * Two 400m straights meeting at (300, 300) at right angles, neither one's
   * endpoint anywhere near the crossing, so nothing about this reads as a
   * junction. `first` is added first and is therefore the older road.
   */
  const crossingPair = (network: RoadNetwork): { first: RoadId; second: RoadId } => ({
    first: network.addRoad(new Alignment([new Line(vec2(100, 300), 0, 400)]), 'rural'),
    second: network.addRoad(
      new Alignment([new Line(vec2(300, 100), Math.PI / 2, 400)]),
      'rural',
    ),
  })

  it('raises the newer road clear of the older one', () => {
    const terrain = flat()
    const network = new RoadNetwork()
    const { first, second } = crossingPair(network)

    const { designs, built } = solveNetwork(terrain, network)

    const older = designs.get(first)!
    const newer = designs.get(second)!
    expect(older).toBeDefined()
    expect(newer).toBeDefined()

    // The crossing is at station 200 on both. The road below stays on flat
    // ground; the road above has to clear it by the lorry clearance plus its
    // own deck and pavement.
    const below = designElevationAtStation(older, 200)
    const above = designElevationAtStation(newer, 200)
    expect(below).toBeCloseTo(100, 6)
    expect(above).toBeGreaterThanOrEqual(below + MIN_OVERPASS_CLEARANCE + ruralStructureDepth - 1e-6)

    // And it climbs there legally. A profile that reached the clearance by
    // stepping up between two stations would satisfy the assertion above
    // while being unbuildable, which is the defect the constraint-not-
    // post-process design exists to rule out.
    for (let i = 1; i < newer.length; i++) {
      const grade = (newer[i]!.z - newer[i - 1]!.z) / (newer[i]!.s - newer[i - 1]!.s)
      expect(Math.abs(grade)).toBeLessThanOrEqual(0.07 + 1e-9)
    }
  })

  it('leaves the older road\'s profile exactly as it would be on its own', () => {
    const terrain = flat()
    const network = new RoadNetwork()
    const { first } = crossingPair(network)

    const solo = new RoadNetwork()
    const soloId = solo.addRoad(new Alignment([new Line(vec2(100, 300), 0, 400)]), 'rural')

    // The whole reason the NEW road is the one that moves: an existing road's
    // vertical profile is never touched, so its structures, its mesh and any
    // road tied to its endpoints all stay valid.
    expect(solveNetwork(terrain, network).designs.get(first)).toEqual(
      solveNetwork(terrain, solo).designs.get(soloId),
    )
  })

  it('leaves tightCrossings empty once the separation has been applied', () => {
    const terrain = flat()
    const network = new RoadNetwork()
    crossingPair(network)

    // This is what turns `tightCrossings` from routine console noise into a
    // defect signal: a crossing this path handled must not still be reported
    // as too tight to pass over.
    expect([...solveNetwork(terrain, network).built.tightCrossings.entries()]).toEqual([])
  })

  it('does not raise a crossing that sits on a node — that is a junction', () => {
    const terrain = flat()
    const network = new RoadNetwork()
    // A road running east-west, and a second road TERMINATING on it at
    // (300, 300) rather than passing over. The second road's start node sits
    // exactly on the crossing, which is the only evidence available that the
    // player meant the two to meet, so nothing is lifted.
    const through = network.addRoad(new Alignment([new Line(vec2(100, 300), 0, 400)]), 'rural')
    const stub = network.addRoad(
      new Alignment([new Line(vec2(300, 300), Math.PI / 2, 200)]),
      'rural',
    )

    const { designs } = solveNetwork(terrain, network)
    expect(designElevationAtStation(designs.get(through)!, 200)).toBeCloseTo(100, 6)
    expect(designElevationAtStation(designs.get(stub)!, 0)).toBeCloseTo(100, 6)
  })

  it('reports a crossing it cannot raise instead of building it at grade', () => {
    // A 120m-wide flat-bottomed trench 30m deep, running east-west along
    // y = 300. A road crossing it north-south is held near the rim by the
    // grade limit — a bridge, effectively — while a road running ALONG the
    // trench floor sits 25m or so below it. Raising the second road over the
    // first would need it to stand higher above its own ground than
    // MAX_STRUCTURE_HEIGHT allows, so there is no legal profile for it.
    const elevations = new Float32Array(61 * 61)
    for (let row = 0; row < 61; row++) {
      for (let col = 0; col < 61; col++) {
        elevations[row * 61 + col] = Math.abs(row * 10 - 300) <= 60 ? 70 : 100
      }
    }
    const trench = new Heightmap(0, 0, 10, 61, 61, elevations)

    const network = new RoadNetwork()
    // Across the trench first, so it is the older road...
    const across = network.addRoad(
      new Alignment([new Line(vec2(300, 100), Math.PI / 2, 400)]),
      'rural',
    )
    // ...and along the floor second, so it is the one asked to climb over.
    const along = network.addRoad(new Alignment([new Line(vec2(100, 300), 0, 400)]), 'rural')

    const { designs, infeasibleRoads, infeasibleCrossings } = solveNetwork(trench, network)

    // Both roads grade perfectly well on their own — this is not an
    // impossible alignment, it is an impossible crossing, and the two must
    // not be reported through the same channel.
    expect([...infeasibleRoads.keys()]).toEqual([])
    expect(designs.has(across)).toBe(true)

    // No design profile for the road that could not be raised. Falling back
    // to its unlifted solve would build it straight through the road above.
    expect(designs.has(along)).toBe(false)
    expect(infeasibleCrossings).toHaveLength(1)
    expect(infeasibleCrossings[0]!.road).toBe(along)
    expect(infeasibleCrossings[0]!.crosses).toBe(across)
    expect(infeasibleCrossings[0]!.requiredElevation).toBeGreaterThan(
      designElevationAtStation(designs.get(across)!, 200),
    )
  })
})

/**
 * The deck an overpass gets, and where the earthwork it replaces is allowed to
 * land.
 *
 * Separate from the block above, which is about the LIFT — whether the design
 * lines separate, and legally. Everything here is about what happens after
 * they do: a lifted road still has a corridor, that corridor still fans out
 * sideways, and unless a deck takes the road off the ground for long enough,
 * the fan lands on the road it was lifted over. The design lines are perfect
 * and what gets built is a dam.
 *
 * Every case is measured the way the defect is seen: by reading the edit layer
 * at grid nodes inside the lower road's own corridor and asking whether any of
 * them received fill.
 */
describe('an overpass deck', () => {
  /** Flat ground at 100m over a 900x900 footprint — room for a 30-degree
   * crossing's 174m deck and both 400m roads with the grid to spare. */
  const flat = (): Heightmap =>
    new Heightmap(0, 0, 10, 91, 91, new Float32Array(91 * 91).fill(100))

  /** Where the two roads meet. On a grid node, so the probe below straddles
   * it symmetrically. */
  const CROSSING = vec2(450, 450)

  /** Length of both roads, so the crossing falls at station 200 on each. */
  const ROAD_LENGTH = 400

  /**
   * Two roads crossing at `angleDeg`, neither one's endpoint anywhere near the
   * crossing so nothing about it reads as a junction.
   *
   * The east-west road is added FIRST and is therefore the older one, the one
   * that stays put and the one whose corridor has to be kept clear. The second
   * runs through the same point at `angleDeg` to it and is the one lifted.
   */
  const crossingAt = (
    angleDeg: number,
    lowerClass: RoadClassName,
    upperClass: RoadClassName,
  ): { network: RoadNetwork; lower: RoadId; upper: RoadId } => {
    const theta = (angleDeg * Math.PI) / 180
    const network = new RoadNetwork()
    const lower = network.addRoad(
      new Alignment([new Line(vec2(CROSSING.x - ROAD_LENGTH / 2, CROSSING.y), 0, ROAD_LENGTH)]),
      lowerClass,
    )
    const start = vec2(
      CROSSING.x - (ROAD_LENGTH / 2) * Math.cos(theta),
      CROSSING.y - (ROAD_LENGTH / 2) * Math.sin(theta),
    )
    const upper = network.addRoad(
      new Alignment([new Line(start, theta, ROAD_LENGTH)]),
      upperClass,
    )
    return { network, lower, upper }
  }

  /**
   * The band either side of the lower road that must stay free of the other
   * road's earthwork: its own formation, plus the batter that stands beside it
   * before a retaining wall takes over.
   *
   * Restated from the same two things `solveNetwork` derives it from rather
   * than written down as a number, so a test that agreed with a stale constant
   * instead of with the corridor that actually gets excavated would fail here.
   */
  const clearHalfWidth = (className: RoadClassName): number =>
    formationHalfWidth(ROAD_CLASSES[className]) + CORRIDOR_MAX_BATTER_WIDTH

  /**
   * Every grid node inside the lower road's corridor that received FILL.
   *
   * Fill specifically, not "any change": the lower road excavates its own
   * corridor, and on flat ground that is a cut everywhere (the design surface
   * sits a pavement stack below natural ground), so a negative delta there is
   * the road being built and a positive one is somebody else's embankment
   * arriving on top of it. That positive delta is the defect — 4.75m of it on
   * the carriageway at 20 degrees — and it is what this counts.
   *
   * `probed` comes back too: a probe that happened to inspect no nodes at all
   * would report zero fills and prove nothing.
   */
  const fillInsideLowerCorridor = (
    terrain: Heightmap,
    editLayer: TerrainEditLayer,
    halfWidth: number,
  ): { probed: number; fills: string[] } => {
    const fills: string[] = []
    let probed = 0
    for (let row = 0; row < terrain.rows; row++) {
      for (let col = 0; col < terrain.cols; col++) {
        const x = terrain.originX + col * terrain.cellSize
        const y = terrain.originY + row * terrain.cellSize
        // Only where the lower road actually runs, and only across its own
        // corridor: beyond its ends and beyond its batters there is nothing of
        // it to bury.
        if (x < CROSSING.x - ROAD_LENGTH / 2 || x > CROSSING.x + ROAD_LENGTH / 2) continue
        if (Math.abs(y - CROSSING.y) > halfWidth) continue
        probed++
        const delta = editLayer.deltaAt(col, row)
        // 1e-6, not 0: deltas are float arithmetic on elevations near 100.
        if (delta > 1e-6) fills.push(`(${x}, ${y}) +${delta.toFixed(2)}m`)
      }
    }
    return { probed, fills }
  }

  /**
   * The heart of it, and the measurement the review made.
   *
   * A station interval on the LIFTED road and a band around the road BELOW are
   * the same interval only at 90 degrees. Deriving the deck from the lower
   * road's width alone — which is what this used to do — is therefore right at
   * 90, wrong at 45, and wrong on the carriageway itself below about 20: the
   * transverse fan of a station outside the deck runs nearly parallel to the
   * road underneath and reaches straight down it.
   *
   * 90 and 60 are here as controls: they passed before the fix and must still
   * pass. 45 and 30 are the cases that did not.
   */
  for (const angleDeg of [90, 60, 45, 30]) {
    it(`keeps the lifted road's earthwork out of the lower road's corridor at ${angleDeg} degrees`, () => {
      const terrain = flat()
      const { network, lower, upper } = crossingAt(angleDeg, 'rural', 'rural')
      const { designs, editLayer, shallowCrossings } = solveNetwork(terrain, network)

      // Both roads exist and the lift actually happened — without this the
      // assertion below could be satisfied by a scene that simply refused to
      // build the upper road at all.
      expect(designs.has(lower)).toBe(true)
      expect(designElevationAtStation(designs.get(lower)!, 200)).toBeCloseTo(100, 6)
      expect(designElevationAtStation(designs.get(upper)!, 200)).toBeGreaterThanOrEqual(
        100 + MIN_OVERPASS_CLEARANCE + ruralStructureDepth - 1e-6,
      )
      // Nothing this square needs the clamp, so nothing may be reported.
      expect(shallowCrossings).toEqual([])

      const { probed, fills } = fillInsideLowerCorridor(
        terrain, editLayer, clearHalfWidth('rural'),
      )
      expect(probed).toBeGreaterThan(100)
      expect(fills).toEqual([])
    })
  }

  /**
   * `solveNetwork` reports the crossings it could not deck honestly.
   *
   * Below `MIN_DECKABLE_CROSSING_ANGLE` the required half-length runs away —
   * at 10 degrees it is over 240m against a 400m road, and it keeps growing.
   * The deck is clamped so it cannot, and the clamp is announced: the standing
   * rule here is that a crossing built wrong is one the player is told about,
   * not one they have to find.
   */
  it('reports a crossing too shallow to deck instead of silently clamping it', () => {
    const terrain = flat()
    const { network, lower, upper } = crossingAt(10, 'rural', 'rural')
    const { designs, shallowCrossings } = solveNetwork(terrain, network)

    // It is still built — this is not `infeasibleCrossings`, where the road
    // gets no profile at all. The road and its lift are real; the deck is the
    // part that is knowingly short.
    expect(designs.has(upper)).toBe(true)

    expect(shallowCrossings).toHaveLength(1)
    const shallow = shallowCrossings[0]!
    expect(shallow.road).toBe(upper)
    expect(shallow.crosses).toBe(lower)
    expect((shallow.angle * 180) / Math.PI).toBeCloseTo(10, 6)
    // The whole point of the report: what was built is short of what the
    // angle asked for, and by how much is on the record.
    expect(shallow.deckHalfLength).toBeLessThan(shallow.requiredHalfLength)
  })


  /**
   * The one span the lifted road is carried on, and the assertion that it is
   * long enough.
   *
   * "Long enough" is not a taste: the corridor sweep steps at
   * `EXCAVATION_STATION_SPACING`, so the first station it takes outside the
   * deck can sit anywhere in that step past the deck's end, and that station
   * must already be clear of the lower road's corridor. So the deck has to
   * reach at least the corridor half-width plus one sweep step beyond the
   * crossing. Both terms are read from the code that produces them rather than
   * written down, so this cannot quietly go stale.
   */
  const deckSpanOf = (
    spans: ReadonlyMap<RoadId, readonly StructureSpan[]>,
    roadId: RoadId,
  ): StructureSpan => {
    const list = spans.get(roadId) ?? []
    expect(list).toHaveLength(1)
    return list[0]!
  }

  /**
   * The deck is derived from how wide the road BELOW is, not how wide the
   * lifted road is. Two classes that differ as far apart as they can — a
   * six-lane highway underneath, a single-lane farm track over it — so
   * borrowing the wrong one's width is a 12m error per end rather than no
   * error at all, which is what a rural-over-rural fixture would measure.
   *
   * Square on purpose. At 90 degrees the angle term drops out entirely and
   * what is left is the width term alone, so this isolates it from the skew
   * arithmetic the tests above exercise.
   */
  it('measures the deck against the road below, not the road being lifted', () => {
    const terrain = flat()
    const { network, upper } = crossingAt(90, 'highway', 'gravel')
    const { spans } = solveNetwork(terrain, network)

    const deck = deckSpanOf(spans, upper)
    const reach = clearHalfWidth('highway') + EXCAVATION_STATION_SPACING
    expect(deck.fromStation).toBeLessThanOrEqual(200 - reach)
    expect(deck.toStation).toBeGreaterThanOrEqual(200 + reach)
  })

  /**
   * The same requirement on the ordinary square case, where the road below is
   * the same class as the road over it.
   *
   * This is what pins the sampling margin. The derivation is exact in the
   * continuum; the deck that gets built is not, because the required range is
   * resampled onto the structure spacing and the sweep steps on a grid of its
   * own. A deck derived exactly and built with no margin lands short.
   */
  it('leaves the deck long enough for the sweep step that follows it', () => {
    const terrain = flat()
    const { network, upper } = crossingAt(90, 'rural', 'rural')
    const { spans } = solveNetwork(terrain, network)

    const deck = deckSpanOf(spans, upper)
    const reach = clearHalfWidth('rural') + EXCAVATION_STATION_SPACING
    expect(deck.fromStation).toBeLessThanOrEqual(200 - reach)
    expect(deck.toStation).toBeGreaterThanOrEqual(200 + reach)
  })

  /**
   * The deck reaches the mesh, not just the span list.
   *
   * `spans` says what the solve decided; this says what was built from it. The
   * two are separate claims — the mesh build takes its spans as an argument,
   * and a caller that handed it a different list (or none) would produce a
   * lifted road with a correct design line, correct earthworks, and nothing
   * holding it up.
   *
   * Measured by elevation, because the lifted road's structures are not only
   * its deck: 6.7m of fill at 3H:1V needs a 20m batter and only 8m is allowed,
   * so both approaches carry retaining walls too. A wall stands between
   * natural ground and the truncated batter's end, which on this fixture tops
   * out around 104m; the deck's own top sits at the design line less the
   * pavement stack, above 106m. Nothing but a deck can be up there.
   */
  it('builds the deck into the lifted road structure mesh', () => {
    const terrain = flat()
    const { network, upper } = crossingAt(90, 'rural', 'rural')
    const { designs, built } = solveNetwork(terrain, network)

    const mesh = built.structures.get(upper)!
    expect(mesh.vertexCount).toBeGreaterThan(0)

    let highest = -Infinity
    for (let i = 0; i < mesh.vertexCount; i++) {
      highest = Math.max(highest, mesh.positions[i * 3 + 2]!)
    }

    const deckTop =
      designElevationAtStation(designs.get(upper)!, 200) -
      totalPavementThickness(ROAD_CLASSES.rural)
    // Precision 4: positions round-trip through a Float32Array, whose ~7
    // significant digits hold values near 100 to about 1e-5.
    expect(highest).toBeCloseTo(deckTop, 4)
  })
})

/**
 * The class the draw tool opens in.
 *
 * This is the defect the player actually reported — "roads that won't
 * connect" — in its first and simplest form: a default class whose corners are
 * bigger than the visible world, so the first road they draw is refused for
 * curve overlap and nothing they can see explains why. The whole rest of this
 * branch is downstream of getting past that.
 *
 * `drawRoadScene` needs a canvas and a GPU, so the default is a module
 * constant rather than a literal buried in it, and what is asserted here is
 * not the choice but the property that forces it.
 */
describe('the default draw class', () => {
  /** A corner needs its own radius' worth of straight either side of it, so
   * the shortest road that can turn at all is twice the corner radius. */
  const shortestRoadWithACorner = (className: RoadClassName): number =>
    2 * minimumRadiusForSpeed(ROAD_CLASSES[className].designSpeedKph)

  it('fits inside the ground the camera frames', () => {
    expect(shortestRoadWithACorner(DEFAULT_DRAW_CLASS)).toBeLessThan(RIG_INITIAL_DISTANCE)
  })

  it('is the only class that does', () => {
    // Not "is the smallest": smallest-but-still-too-big would satisfy that and
    // still refuse the player's first road. Every other class must actually
    // fail to fit.
    for (const className of ROAD_CLASS_ORDER) {
      if (className === DEFAULT_DRAW_CLASS) continue
      expect(shortestRoadWithACorner(className)).toBeGreaterThan(RIG_INITIAL_DISTANCE)
    }
  })

  it('is gravel', () => {
    // The two assertions above say what the default has to be; this says what
    // it is, so that a change to either the framing or the class speeds shows
    // up here as a decision to re-make rather than as a silent re-derivation.
    expect(DEFAULT_DRAW_CLASS).toBe('gravel')
  })
})

/**
 * A known limitation, pinned so its description cannot quietly stop matching.
 *
 * `solveNetwork` lifts the NEWER road over the older one, and "newer" is the
 * road id. `splitRoad` allocates both halves of a split road ids above every
 * existing road, so splitting a road makes its halves the newest roads in the
 * network — younger than anything ever built over them — and any crossing on
 * either half reverses.
 *
 * This asserts the WRONG behaviour on purpose. Fixing it wants creation
 * provenance on `Road`, separate from the id, which is a graph change; what is
 * in scope is that `solveNetwork`'s docstring describes what actually happens,
 * and that is what this holds it to. When the ordering is fixed, this test
 * fails, and that failure is the reminder to rewrite the docstring with it.
 */
describe('splitting a road under an existing overpass', () => {
  it('inverts the crossing, because both halves get ids above every other road', () => {
    const terrain = new Heightmap(0, 0, 10, 61, 61, new Float32Array(61 * 61).fill(100))
    const network = new RoadNetwork()
    const a = network.addRoad(new Alignment([new Line(vec2(100, 300), 0, 400)]), 'rural')
    const c = network.addRoad(
      new Alignment([new Line(vec2(300, 100), Math.PI / 2, 400)]), 'rural',
    )

    const before = solveNetwork(terrain, network)
    const lifted = 100 + MIN_OVERPASS_CLEARANCE + ruralStructureDepth
    expect(designElevationAtStation(before.designs.get(a)!, 200)).toBeCloseTo(100, 6)
    expect(designElevationAtStation(before.designs.get(c)!, 200)).toBeCloseTo(lifted, 6)

    // Two hundred metres from the crossing — what `DrawTool.commit` does when
    // a player ends a third road on A, and nothing to do with C at all.
    const split = network.splitRoad(a, 100)
    expect(split.second).toBeGreaterThan(c)

    const after = solveNetwork(terrain, network)
    // The half of A that carries the crossing is now the newer road, so it is
    // the one that climbs, and the overpass the player already had drops to
    // grade underneath it.
    expect(designElevationAtStation(after.designs.get(split.second)!, 100)).toBeCloseTo(lifted, 6)
    expect(designElevationAtStation(after.designs.get(c)!, 200)).toBeCloseTo(100, 6)
  })
})
