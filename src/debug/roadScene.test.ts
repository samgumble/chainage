import { describe, it, expect } from 'vitest'
import { buildSceneContent, solveNetwork } from './roadScene'
import { buildNetworkMesh } from '../mesh/networkMesh'
import { RoadNetwork } from '../network/graph'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import { sampleGroundProfile } from '../terrain/groundProfile'
import { solveGradeProfile } from '../terrain/gradeSolver'
import { Heightmap } from '../terrain/heightmap'

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
