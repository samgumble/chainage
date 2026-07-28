import { describe, it, expect } from 'vitest'
import { buildSceneContent, drivableRoads, solveNetwork, type SceneContent } from './roadScene'
import { MAX_JUNCTION_ELEVATION_SPREAD } from '../mesh/networkMesh'
import type { RoadWithEntry } from '../mesh/junctionClearance'
import { formationHalfWidth, ROAD_CLASSES, totalPavementThickness } from '../network/roadClass'
import { designElevationAtStation } from '../terrain/groundProfile'
import type { NetworkNode, RoadId } from '../network/graph'
import { distance, type Vec2 } from '../geometry/vec2'
import { FIXED_STEP, Fleet } from '../traffic/fleet'
import { VEHICLE_LENGTH } from '../traffic/lane'
import { laneCentreOffset, placeVehicle, type VehiclePose } from '../render/vehiclePlacement'
import { VEHICLE_WIDTH } from '../render/trafficView'

/**
 * The demo scene's traffic, against the demo scene's own geometry.
 *
 * Everything else that tests traffic tests it on a synthetic straight from the
 * origin, where the only road in the world is the one under test. Nothing there
 * can see what a player sees, which is three roads meeting at a point with the
 * camera pointed at it — and the defect this file exists for was invisible to
 * all nine hundred of those tests: every car in the scene materialised at
 * station 0, which on all three legs IS the junction, so three roads' worth of
 * new traffic interpenetrated at the focal point.
 *
 * The fix is not to reverse the legs. That has been tried and measured: cars
 * then converge on the node instead of diverging from it and collide there just
 * as hard (89 frames became 88), while moving every leg's station 0 to its far
 * end moves `solveGradeProfile`'s only terrain-faithful point off the junction
 * and blows the legs' elevation disagreement there out from 0.457m to 5.797m.
 * The fix is to keep the legs leaving the junction and enter the traffic clear
 * of it — see `mesh/junctionClearance.ts`.
 *
 * Built once. Grading three roads over a 257x257 terrain is not cheap.
 */
const content: SceneContent = buildSceneContent()

/**
 * Roads with a design profile, carrying their entry stations — exactly what
 * `drawRoadScene` hands `TrafficView.sync`.
 */
const drivable: readonly RoadWithEntry[] = drivableRoads(content.network).filter(
  (road) => (content.designs.get(road.id)?.length ?? 0) > 0,
)

/**
 * Where each road is carried on a structure.
 *
 * `buildSceneContent` does not return the spans — `SceneContent` deliberately
 * carries only what the renderer needs — so they are re-solved once here and
 * shared, rather than re-solved in each test that wants them.
 */
const spans = solveNetwork(content.terrain, content.network).spans

/** The T junction: the one node where more than two road ends meet. */
const junctionNode = (): NetworkNode => {
  const found = content.network.nodes.filter((node) => node.ends.length >= 3)
  expect(found).toHaveLength(1)
  return found[0]!
}

const JUNCTION: Vec2 = junctionNode().position

/**
 * How far from the junction node the legs could still share ground, metres.
 *
 * The widest leg's formation half-width — no part of any junction plate built
 * from these classes reaches further along a leg than that — plus a whole
 * vehicle, because a vehicle's box reaches half its length beyond its own
 * centre and so does the one it might hit. Derived from the road classes
 * actually in the scene rather than picked, so a wider class or a longer
 * vehicle moves it.
 */
const JUNCTION_REACH =
  Math.max(...drivable.map((road) => formationHalfWidth(ROAD_CLASSES[road.className]))) +
  VEHICLE_LENGTH

const poseOf = (road: RoadWithEntry, station: number): VehiclePose =>
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
  /** Closest any vehicle's centre came to the junction node. */
  readonly nearestToJunction: number
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
  let nearestToJunction = Infinity
  let furthestStation = 0
  const overlapping: (readonly [Placed, Placed])[] = []

  for (let frame = 0; frame < seconds / FIXED_STEP; frame++) {
    fleet.advance(FIXED_STEP)

    const placed: Placed[] = []
    fleet.forEachVehicle((roadId, station) => {
      const road = byId.get(roadId)!
      const pose = poseOf(road, station)
      placed.push({ roadId, station, x: pose.x, y: pose.y, heading: pose.heading })
      if (station > furthestStation) furthestStation = station
      nearestToJunction = Math.min(nearestToJunction, distance(pose, JUNCTION))
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

  return { framesWithOverlap, closestApproach, overlapping, nearestToJunction, furthestStation }
}

/** Ten simulated minutes, the window the reviewer's own probe used. */
const run = measure(600)

describe('the demo scene’s traffic', () => {
  it('builds every leg outward from the junction', () => {
    // The geometric half of the fix, and the reason the legs are NOT reversed:
    // `solveGradeProfile` pins station 0 to natural ground and drifts from it
    // further along, so a leg starting at the junction is faithful to the
    // terrain exactly where the three legs have to agree with each other.
    //
    // This fails the moment someone anchors the legs at their far ends again.
    //
    // The alignment's own stations, not the driving line's: a leg's chainage
    // starts on the centreline, and the 1.75m the vehicles sit off it would
    // otherwise show up here as two millimetres of slop.
    for (const road of drivable) {
      expect(distance(road.alignment.poseAt(0).position, JUNCTION)).toBeCloseTo(0, 9)
      expect(distance(road.alignment.poseAt(road.alignment.length).position, JUNCTION))
        .toBeCloseTo(road.alignment.length, 6)
    }
  })

  it('enters its traffic clear of the junction and drives it away', () => {
    // The traffic half. Every leg's station 0 is inside the intersection, so
    // every leg has to be told to admit vehicles further along — and the
    // distance comes from the junction's own solved plate, not from a number
    // in this file. 6.5m on the rural arms, 9.5m on the gravel branch.
    for (const road of drivable) {
      expect(road.spawnStation).toBeGreaterThan(0)
    }

    // Which means no car's centre is ever within a car's length of the node,
    // measured over the whole run rather than argued from the entry stations.
    expect(run.nearestToJunction).toBeGreaterThan(VEHICLE_LENGTH)
    expect(run.nearestToJunction).toBeCloseTo(6.731, 2)

    // And traffic really does traverse the legs: something got all the way to
    // the end of the longest one.
    const longest = Math.max(...drivable.map((road) => road.alignment.length))
    expect(run.furthestStation).toBeGreaterThan(longest * 0.9)
  })

  it('never overlaps two vehicles from different roads, anywhere', () => {
    // The reviewer's instrument, kept and tightened: oriented boxes, every pair
    // on different roads, ten simulated minutes, and the count is now ZERO
    // rather than "zero except inside the junction".
    //
    // It can be zero because the three legs DIVERGE from the node. Three entry
    // points a few metres out along three different bearings are far apart, and
    // every vehicle only ever gets further from the others — so there is no
    // convergence for the simulation to have to give way at. Reversing the legs
    // could not reach zero: the gravel branch's `laneCentreOffset` is 0, so its
    // driving line crosses both rural driving lines inside all three lanes, and
    // arriving cars met there exactly as spawning cars had.
    expect(run.overlapping).toHaveLength(0)
    expect(run.framesWithOverlap).toBe(0)

    // The margin is reported rather than merely bounded, so a change in it is
    // visible in the diff instead of being absorbed by a loose inequality. Two
    // boxes this size cannot overlap beyond 4.85m centre to centre — the sum of
    // their half-diagonals — so ten metres is not a near miss.
    expect(run.closestApproach).toBeCloseTo(10.115, 2)
    expect(run.closestApproach).toBeGreaterThan(Math.hypot(VEHICLE_LENGTH, VEHICLE_WIDTH))
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

describe('the junction the demo is built around', () => {
  /**
   * Recorded, not accepted.
   *
   * The three legs agree at the node to within 0.457m, which is what building
   * them all outward FROM it buys: `solveGradeProfile`'s greedy sweep pins
   * station 0 to natural ground, and station 0 is the junction on all three.
   * The residue is the crossfall correction and the sweep's own first step, and
   * it is still above `MAX_JUNCTION_ELEVATION_SPREAD` — a pre-existing quarter
   * of a metre over, not something to paper over here.
   *
   * The number is pinned tightly because it is the thing that moved when the
   * legs were reversed: anchoring them at their far ends instead put it at
   * 5.797m, a three-metre step at the exact point the camera rig is aimed at.
   */
  it('keeps its legs agreeing in elevation to within half a metre', () => {
    const node = junctionNode()
    const spread = content.built.elevationMismatches.get(node.id)
    expect(spread).toBeDefined()
    expect(spread!).toBeCloseTo(0.457, 3)
    expect(spread!).toBeLessThan(1)

    // Still over the threshold, which is why it is in `elevationMismatches` at
    // all. Pinned so that a grade solver which really does resolve junction
    // elevations makes this test fail rather than pass quietly.
    expect(spread!).toBeGreaterThan(MAX_JUNCTION_ELEVATION_SPREAD)
  })

  it('still builds a bridge, and builds it on the east arm', () => {
    // The structures pipeline is the demo's only end-to-end evidence, and
    // renumbering the stations moves every span. Measured from the junction
    // outward, the east arm crosses the ravine between 273 and 423.
    const east = drivable.find(
      (road) => road.className === 'rural' && poseOf(road, road.alignment.length).x > JUNCTION.x,
    )!
    const eastSpans = spans.get(east.id) ?? []
    expect(eastSpans).toHaveLength(1)
    expect(eastSpans[0]!.fromStation).toBeCloseTo(273, 6)
    expect(eastSpans[0]!.toStation).toBeCloseTo(423, 6)
    expect(eastSpans[0]!.maxHeight).toBeGreaterThan(10)

    // The gravel branch carries none. It gained one (57-243) only while the
    // legs were reversed, because arriving from the ridge put its low-drift end
    // at the junction; built outward from the valley floor it follows the
    // ground and needs no structure.
    const gravel = drivable.find((road) => road.className === 'gravel')!
    expect(spans.get(gravel.id) ?? []).toHaveLength(0)
  })
})

/**
 * The other kind of deck: a bridge the TERRAIN asked for, not a crossing.
 *
 * `overpassTraffic.test.ts` measures a car on a deck that exists because
 * `requiredStructureRanges` forced one under a lifted road. This is the
 * ordinary case that got there first and had never been checked with traffic on
 * it: the east arm's design line runs 17.6m over a ravine, `classifySupport`
 * calls those stations 'structure' on height alone, and the span between 273
 * and 423 is the result.
 *
 * Worth its own test rather than folded into the overpass one because the two
 * spans are produced by different code paths — height versus a required range —
 * and only the elevation they end up at is shared.
 */
describe('traffic on the demo scene’s valley bridge', () => {
  const east = drivable.find(
    (road) => road.className === 'rural' && poseOf(road, road.alignment.length).x > JUNCTION.x,
  )!
  const span = (spans.get(east.id) ?? [])[0]!
  const design = content.designs.get(east.id)!
  const rc = ROAD_CLASSES[east.className]

  /** Top of the deck slab: the design line less the pavement stack resting on
   * it — `buildBridgeMesh`'s own `deckClearance` default, restated so the
   * vehicle can be measured against it. */
  const deckTopAt = (station: number): number =>
    designElevationAtStation(design, station) - totalPavementThickness(rc)

  const onBridge = (() => {
    const fleet = new Fleet()
    fleet.sync(drivable)
    const samples: { station: number; aboveDeck: number; aboveGround: number }[] = []

    for (let frame = 0; frame < Math.round(600 / FIXED_STEP); frame++) {
      fleet.advance(FIXED_STEP)
      fleet.forEachVehicle((roadId, station) => {
        if (roadId !== east.id) return
        if (station < span.fromStation || station > span.toStation) return
        const pose = poseOf(east, station)
        samples.push({
          station,
          aboveDeck: pose.z - deckTopAt(station),
          aboveGround: pose.z - content.terrain.sample(pose.x, pose.y),
        })
      })
    }
    return samples
  })()

  it('drives cars the whole way across the span', () => {
    expect(span.fromStation).toBeCloseTo(273, 6)
    expect(span.toStation).toBeCloseTo(423, 6)
    expect(onBridge.length).toBeGreaterThan(1000)

    const stations = onBridge.map((s) => s.station)
    expect(Math.min(...stations)).toBeLessThan(span.fromStation + 5)
    expect(Math.max(...stations)).toBeGreaterThan(span.toStation - 5)
  })

  it('rides the deck rather than the ravine floor under it', () => {
    // Same constant as the overpass: the pavement stack less the crossfall drop
    // out to the middle of the nearside lane. It is a property of the road
    // class, so a car on a valley bridge and a car on an overpass sit at the
    // identical height above their respective decks.
    const rideHeight =
      totalPavementThickness(rc) - Math.abs(laneCentreOffset(rc)) * rc.crossfall
    expect(rideHeight).toBeCloseTo(0.45625, 9)

    for (const sample of onBridge) {
      expect(sample.aboveDeck).toBeCloseTo(rideHeight, 9)
      expect(sample.aboveDeck).toBeGreaterThan(0)
    }

    // And the drop underneath, which is the whole reason there is a bridge
    // here: a car that read natural ground instead of the design line would be
    // seventeen metres lower at the deepest point.
    const aboveGround = onBridge.map((s) => s.aboveGround)
    expect(Math.min(...aboveGround)).toBeGreaterThan(9)
    expect(Math.max(...aboveGround)).toBeCloseTo(17.554, 3)
  })
})
