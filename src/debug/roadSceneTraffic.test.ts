import { describe, it, expect } from 'vitest'
import { buildSceneContent, solveNetwork, type SceneContent } from './roadScene'
import { MAX_JUNCTION_ELEVATION_SPREAD } from '../mesh/networkMesh'
import { formationHalfWidth, ROAD_CLASSES } from '../network/roadClass'
import type { NetworkNode, RoadId } from '../network/graph'
import { distance, type Vec2 } from '../geometry/vec2'
import { FIXED_STEP, Fleet, type DrivableRoad } from '../traffic/fleet'
import { VEHICLE_LENGTH } from '../traffic/lane'
import { placeVehicle, type VehiclePose } from '../render/vehiclePlacement'
import { VEHICLE_WIDTH } from '../render/trafficView'

/**
 * The demo scene's traffic, against the demo scene's own geometry.
 *
 * Everything else that tests traffic tests it on a synthetic straight from the
 * origin, where the only road in the world is the one under test. Nothing there
 * can see what a player sees, which is three roads meeting at a point with the
 * camera pointed at it — and the defect this file exists for was invisible to
 * all nine hundred of those tests: every car in the scene materialised inside
 * the junction and drove outward, so no car ever arrived at one and the boxes
 * of three roads' worth of new traffic interpenetrated at the focal point.
 *
 * Built once. Grading three roads over a 257x257 terrain is not cheap.
 */
const content: SceneContent = buildSceneContent()

/** Roads with a design profile — exactly what `TrafficView.sync` passes on. */
const drivable: DrivableRoad[] = [...content.network.roads].filter(
  (road) => (content.designs.get(road.id)?.length ?? 0) > 0,
)

/** The T junction: the one node where more than two road ends meet. */
const junctionNode = (): NetworkNode => {
  const found = content.network.nodes.filter((node) => node.ends.length >= 3)
  expect(found).toHaveLength(1)
  return found[0]!
}

const JUNCTION: Vec2 = junctionNode().position

/**
 * How far from the junction node the legs still share ground, metres.
 *
 * The widest leg's formation half-width — the physical extent of the junction
 * plate — plus a whole vehicle, because a vehicle's box reaches half its length
 * beyond its own centre and so does the one it might hit. Derived from the road
 * classes actually in the scene rather than picked, so a wider class or a longer
 * vehicle moves it.
 */
const JUNCTION_REACH =
  Math.max(...drivable.map((road) => formationHalfWidth(ROAD_CLASSES[road.className]))) +
  VEHICLE_LENGTH

const poseOf = (road: DrivableRoad, station: number): VehiclePose =>
  placeVehicle(
    road.alignment,
    content.designs.get(road.id)!,
    ROAD_CLASSES[road.className],
    station,
  )

type Placed = {
  readonly roadId: RoadId
  readonly station: number
  readonly x: number
  readonly y: number
  readonly heading: number
}

/**
 * Separating-axis overlap test for two `VEHICLE_LENGTH` x `VEHICLE_WIDTH`
 * rectangles at arbitrary headings.
 *
 * Boxes, not circles: two cars 3m apart nose to tail on the same heading are
 * touching, and two cars 3m apart side by side have a metre of clear air
 * between them. A radius test cannot tell those apart, and the whole question
 * here is whether the bodies a player sees pass through each other.
 *
 * Four candidate axes — each box's own two — which is sufficient for
 * rectangles: two convex polygons are disjoint iff some edge normal of one
 * separates them.
 */
const overlaps = (a: Placed, b: Placed): boolean => {
  const halfLength = VEHICLE_LENGTH / 2
  const halfWidth = VEHICLE_WIDTH / 2
  const axes: Vec2[] = [
    { x: Math.cos(a.heading), y: Math.sin(a.heading) },
    { x: -Math.sin(a.heading), y: Math.cos(a.heading) },
    { x: Math.cos(b.heading), y: Math.sin(b.heading) },
    { x: -Math.sin(b.heading), y: Math.cos(b.heading) },
  ]

  /** Half-extent of one box projected onto an axis. */
  const reach = (box: Placed, axis: Vec2): number =>
    halfLength * Math.abs(Math.cos(box.heading) * axis.x + Math.sin(box.heading) * axis.y) +
    halfWidth * Math.abs(-Math.sin(box.heading) * axis.x + Math.cos(box.heading) * axis.y)

  for (const axis of axes) {
    const centreGap = Math.abs((a.x - b.x) * axis.x + (a.y - b.y) * axis.y)
    if (centreGap > reach(a, axis) + reach(b, axis)) return false
  }
  return true
}

type Run = {
  /** Frames in which two vehicles on DIFFERENT roads had overlapping boxes. */
  readonly framesWithOverlap: number
  /** Closest any two vehicles on different roads came, centre to centre. */
  readonly closestApproach: number
  /** Every overlapping pair seen, so the where and the why can be asserted. */
  readonly overlapping: readonly (readonly [Placed, Placed])[]
  /** Every vehicle seen within `JUNCTION_REACH` of the junction. */
  readonly nearJunction: readonly Placed[]
  /** Furthest any vehicle got from its own road's station 0. */
  readonly furthestStation: number
}

/**
 * Run the real fleet over the real scene for `seconds` and measure.
 *
 * 0.25s per frame is `FIXED_STEP`, so every frame is exactly one simulation
 * step and nothing between two states is missed. Sampling at 60fps instead
 * would step the fleet on one frame in fifteen and check the same state
 * fourteen times over.
 */
const measure = (seconds: number): Run => {
  const fleet = new Fleet()
  fleet.sync(drivable)
  const byId = new Map(drivable.map((road) => [road.id, road]))

  let framesWithOverlap = 0
  let closestApproach = Infinity
  let furthestStation = 0
  const overlapping: (readonly [Placed, Placed])[] = []
  const nearJunction: Placed[] = []

  for (let frame = 0; frame < seconds / FIXED_STEP; frame++) {
    fleet.advance(FIXED_STEP)

    const placed: Placed[] = []
    fleet.forEachVehicle((roadId, station) => {
      const road = byId.get(roadId)!
      const pose = poseOf(road, station)
      const it = { roadId, station, x: pose.x, y: pose.y, heading: pose.heading }
      placed.push(it)
      if (station > furthestStation) furthestStation = station
      if (distance(pose, JUNCTION) <= JUNCTION_REACH) nearJunction.push(it)
    })

    let hit = false
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]!
        const b = placed[j]!
        if (a.roadId === b.roadId) continue
        closestApproach = Math.min(closestApproach, Math.hypot(a.x - b.x, a.y - b.y))
        if (overlaps(a, b)) {
          hit = true
          overlapping.push([a, b])
        }
      }
    }
    if (hit) framesWithOverlap++
  }

  return { framesWithOverlap, closestApproach, overlapping, nearJunction, furthestStation }
}

/** Ten simulated minutes, the window the reviewer's own probe used. */
const run = measure(600)

describe('the demo scene’s traffic', () => {
  it('puts no vehicle into the junction at the moment it enters the road', () => {
    // THE regression. `Fleet` spawns at station 0, so a leg built FROM the
    // junction has its entry point inside the junction — three roads' worth of
    // cars appearing on top of each other at the exact point `RIG_TARGET` aims
    // the camera at. Every leg's station 0 must be at its outer end.
    //
    // This is the assertion that fails if the arms are ever built the other way
    // round again, and nothing in the traffic tests can make it: they are all
    // single roads at the origin, where station 0 is nowhere in particular.
    for (const road of drivable) {
      const entry = poseOf(road, 0)
      expect(distance(entry, JUNCTION)).toBeGreaterThan(road.alignment.length / 2)

      // ...and the far end IS the junction, so a vehicle retires on arriving
      // at one rather than driving off into open country.
      const exit = poseOf(road, road.alignment.length)
      expect(distance(exit, JUNCTION)).toBeLessThanOrEqual(JUNCTION_REACH)
    }
  })

  it('drives its traffic toward the junction, not away from it', () => {
    // The dynamic form of the same claim, and the one that would survive
    // someone reversing the alignments while leaving the geometry alone. Every
    // vehicle that reaches the junction is at the FAR end of its own lane.
    expect(run.nearJunction.length).toBeGreaterThan(50)
    for (const vehicle of run.nearJunction) {
      const length = drivable.find((road) => road.id === vehicle.roadId)!.alignment.length
      expect(vehicle.station).toBeGreaterThan(length / 2)
    }

    // And traffic really does traverse the legs: something got all the way to
    // the end of the longest one.
    const longest = Math.max(...drivable.map((road) => road.alignment.length))
    expect(run.furthestStation).toBeGreaterThan(longest * 0.9)
  })

  it('never overlaps two vehicles anywhere but inside the junction', () => {
    // The reviewer's instrument, kept: oriented boxes, every pair on different
    // roads, ten simulated minutes.
    //
    // Along the roads themselves the count is zero, and that is a real claim
    // about the lane offsets — the two rural arms run within 3.5m of each
    // other for 750m each, and a `laneCentreOffset` that lost its sign or its
    // magnitude would put them on the same line for their whole length.
    //
    // Inside the junction it is NOT zero, and that is the honest state of the
    // simulation rather than an accepted defect: three legs' driving lines
    // cross there, nothing gives way, and nothing can — see the mismatch
    // documented on `Lane.setObstacle` and `canClearBeforeStopping`, which is
    // exactly the per-vehicle stopping mechanism a junction needs. Measured
    // over 600s: 88 of 2400 frames, all of them gravel-branch against rural,
    // all within a few metres of the node. Before the arms were reversed it
    // was 89 of 2400 — the same order of magnitude, but every one of them a
    // car appearing out of nothing at the point the camera is aimed at rather
    // than two cars meeting where a junction is not yet modelled.
    expect(run.overlapping.length).toBeGreaterThan(0)
    for (const [a, b] of run.overlapping) {
      expect(distance(a, JUNCTION)).toBeLessThanOrEqual(JUNCTION_REACH)
      expect(distance(b, JUNCTION)).toBeLessThanOrEqual(JUNCTION_REACH)
      // Never on entry, which is what the old arrangement produced.
      expect(Math.min(a.station, b.station)).toBeGreaterThan(0)
    }

    // The count is reported rather than merely bounded, so a change in it is
    // visible in the diff instead of being absorbed by a loose inequality.
    expect(run.framesWithOverlap).toBe(88)
    expect(run.framesWithOverlap / (600 / FIXED_STEP)).toBeLessThan(0.05)
    expect(run.closestApproach).toBeCloseTo(0.554, 2)
  })

  it('keeps the two rural arms out of each other for their whole length', () => {
    // The lane-offset claim on its own, away from the junction. Both arms run
    // east-west through the same y, so their driving lines are 3.5m apart and
    // nothing else keeps them separate.
    const rural = drivable.filter((road) => road.className === 'rural')
    expect(rural).toHaveLength(2)

    for (let station = 0; station <= 700; station += 5) {
      const a = poseOf(rural[0]!, station)
      const b = poseOf(rural[1]!, station)
      expect(Math.abs(a.y - b.y)).toBeCloseTo(3.5, 9)
    }
  })
})

describe('what reversing the arms cost', () => {
  /**
   * Recorded, not accepted.
   *
   * `solveGradeProfile`'s greedy sweep pins station 0 to natural ground and
   * drifts from it further along, so which end a leg starts at decides where it
   * is faithful to the terrain. With all three legs starting AT the junction
   * they agreed there to within 0.46m; with all three ARRIVING there they
   * disagree by 5.80m, and `buildJunctionMesh` sits the plate at the mean — a
   * step of nearly three metres at the point the camera is aimed at.
   *
   * The ground along the west arm rises at up to 17.9%, far beyond the 7% the
   * class allows, so no orientation lets that leg simply follow it; the drift
   * has to land somewhere. Pinning it away is possible — `GradeConstraints`
   * already has `fixedEnd`, and the west arm solves feasibly with it set to
   * natural ground at the junction — but making the network solve junction
   * elevations as a shared constraint is a grade-solver change, not a scene
   * one, and is deliberately not made here.
   *
   * This test fails the moment that work lands, which is the intent.
   */
  it('leaves the junction legs disagreeing in elevation', () => {
    const node = junctionNode()
    const spread = content.built.elevationMismatches.get(node.id)
    expect(spread).toBeDefined()
    expect(spread!).toBeGreaterThan(MAX_JUNCTION_ELEVATION_SPREAD)
    expect(spread!).toBeCloseTo(5.797, 2)
  })

  it('still builds a bridge, and builds it on the east arm', () => {
    // The structures pipeline is the demo's only end-to-end evidence, and
    // renumbering the stations moves every span. The east arm crosses the same
    // ravine either way; its span used to be 273-423 measured from the
    // junction and is now 181-439 measured from the outer end.
    const { spans } = solveNetwork(content.terrain, content.network)

    const east = drivable.find(
      (road) => road.className === 'rural' && poseOf(road, 0).x > JUNCTION.x,
    )!
    const eastSpans = spans.get(east.id) ?? []
    expect(eastSpans).toHaveLength(1)
    expect(eastSpans[0]!.fromStation).toBeCloseTo(181, 6)
    expect(eastSpans[0]!.toStation).toBeCloseTo(439, 6)
    expect(eastSpans[0]!.maxHeight).toBeGreaterThan(10)

    // And the gravel branch, which carried none before, now does: arriving from
    // the ridge it stays high above the valley floor for most of its length.
    const gravel = drivable.find((road) => road.className === 'gravel')!
    const gravelSpans = spans.get(gravel.id) ?? []
    expect(gravelSpans).toHaveLength(1)
    expect(gravelSpans[0]!.fromStation).toBeCloseTo(57, 6)
    expect(gravelSpans[0]!.toStation).toBeCloseTo(243, 6)
  })
})
