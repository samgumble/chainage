import { describe, it, expect } from 'vitest'
import { buildSceneContent, solveNetwork } from './roadScene'
import { buildNetworkMesh } from '../mesh/networkMesh'
import type { RoadMesh } from '../mesh/roadMesh'
import { RoadNetwork, type RoadId } from '../network/graph'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import { sampleGroundProfile } from '../terrain/groundProfile'
import { solveGradeProfile } from '../terrain/gradeSolver'
import { Heightmap } from '../terrain/heightmap'
import { SelectTool } from '../tool/selectTool'
import { ROAD_CLASSES, formationHalfWidth } from '../network/roadClass'

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
