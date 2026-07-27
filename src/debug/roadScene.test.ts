import { describe, it, expect } from 'vitest'
import { buildSceneContent, solveNetwork, terrainBounds } from './roadScene'
import { buildNetworkMesh } from '../mesh/networkMesh'
import type { RoadMesh } from '../mesh/roadMesh'
import { RoadNetwork, type RoadId } from '../network/graph'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import { sampleGroundProfile, designElevationAtStation } from '../terrain/groundProfile'
import { solveGradeProfile } from '../terrain/gradeSolver'
import { Heightmap } from '../terrain/heightmap'
import { SelectTool } from '../tool/selectTool'
import { ROAD_CLASSES, formationHalfWidth, totalPavementThickness } from '../network/roadClass'
import { MIN_OVERPASS_CLEARANCE } from '../network/crossings'
import { DECK_DEPTH } from '../mesh/structures/bridgeMesh'

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
   * Everything hanging below a rural road's design line where it is carried
   * over something: the pavement stack it runs on, plus the deck slab under
   * that. Restated from the same two sources `roadScene.ts` derives it from,
   * so a test that agreed with a hardcoded number rather than with the deck
   * that actually gets built would fail here.
   */
  const ruralStructureDepth = totalPavementThickness(ROAD_CLASSES.rural) + DECK_DEPTH

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
