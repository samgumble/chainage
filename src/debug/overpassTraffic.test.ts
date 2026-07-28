import { describe, it, expect } from 'vitest'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import { Heightmap } from '../terrain/heightmap'
import { RoadNetwork, type RoadId } from '../network/graph'
import { solveNetwork, drivableRoads } from './roadScene'
import { findCrossings, MIN_OVERPASS_CLEARANCE } from '../network/crossings'
import { ROAD_CLASSES, formationHalfWidth, totalPavementThickness } from '../network/roadClass'
import { designElevationAtStation } from '../terrain/groundProfile'
import { DECK_DEPTH } from '../mesh/structures/bridgeMesh'
import { Fleet, FIXED_STEP } from '../traffic/fleet'
import { laneCentreOffset, placeVehicle } from '../render/vehiclePlacement'
import { VEHICLE_HEIGHT } from '../render/trafficView'

/**
 * A car driving over an overpass deck.
 *
 * Overpasses and traffic shipped on two different branches and had never once
 * been in the same scene. The demo network is a T junction whose three arms
 * share a node, so `findCrossings` classifies that meeting as an intersection
 * and no overpass is ever built there; every other traffic test runs on a
 * synthetic straight with no structure anywhere near it. So nothing, anywhere,
 * demonstrated the one thing the two features together promise: that a vehicle
 * on a lifted road rides the deck it was lifted onto rather than sinking
 * through it or sitting on the ground underneath.
 *
 * The reasoning that says it must work — `placeVehicle` reads
 * `designElevationAtStation`, and for a lifted road the design profile IS the
 * raised line the deck is built under — is correct, and it is exactly the shape
 * of argument this project has been wrong with before. So it is measured here
 * instead, end to end, off the real `solveNetwork`, the real `Fleet` and the
 * real `placeVehicle`.
 *
 * ## The fixture, and why it is flat
 *
 * Two rural roads crossing at 90°, each with both endpoints hundreds of metres
 * clear of the crossing, on a dead-level plane at 100m.
 *
 * Level deliberately. On the demo's valley terrain a road climbing out of the
 * floor is already twenty-five metres over the road on the axis before any
 * clearance floor is applied, so the lift changes nothing and a test that
 * removed it entirely would still pass. On a plane there is nowhere for the
 * separation to come from except the grade separation itself: every metre
 * between the two design lines was put there by `solveNetwork`'s clearance
 * floor, and every metre of deck by `requiredStructureRanges`.
 */

const COLS = 257
const ROWS = 257
const CELL = 10
const GROUND = 100

/** Where the two alignments meet in plan. Both roads are straight, so this is
 * exact rather than a sampled intersection's best guess. */
const CROSSING = vec2(1000, 1280)

const RURAL = ROAD_CLASSES.rural

/**
 * The whole overpass fixture: terrain, network, solve, and the crossing.
 *
 * Built once per describe rather than per test — the corridor sweep over
 * 1350m of road is the expensive part and nothing here mutates the result.
 */
const buildOverpassScene = () => {
  const terrain = new Heightmap(
    0, 0, CELL, COLS, ROWS, new Float32Array(COLS * ROWS).fill(GROUND),
  )

  const network = new RoadNetwork()
  // Older road first, so the id order — which is what `solveNetwork` lifts by
  // — matches the intent rather than coinciding with it.
  const lowerId = network.addRoad(new Alignment([new Line(vec2(600, 1280), 0, 800)]), 'rural')
  const upperId = network.addRoad(
    new Alignment([new Line(vec2(1000, 1000), Math.PI / 2, 600)]), 'rural',
  )

  const solved = solveNetwork(terrain, network)
  return { terrain, network, lowerId, upperId, ...solved }
}

const scene = buildOverpassScene()

const upperDesign = scene.designs.get(scene.upperId) ?? []
const lowerDesign = scene.designs.get(scene.lowerId) ?? []
const upperAlignment = scene.network.road(scene.upperId).alignment
const lowerAlignment = scene.network.road(scene.lowerId).alignment

/** The crossing stations, read off the solver's own crossing rather than
 * recomputed here from the geometry. */
const crossing = findCrossings(scene.network, scene.designs)[0]
const upperStation = crossing?.upper === scene.upperId
  ? crossing.upperStation
  : crossing?.lowerStation ?? 0
const lowerStation = crossing?.upper === scene.upperId
  ? crossing.lowerStation
  : crossing?.upperStation ?? 0

const upperSpans = scene.spans.get(scene.upperId) ?? []

/**
 * Top of the deck slab at a station, metres.
 *
 * Not a second opinion about where the deck is: `buildBridgeMesh` places its
 * deck top at `designElevationAtStation(design, s) − deckClearance`, and its
 * `deckClearance` defaults to the class's own `totalPavementThickness` —
 * because the pavement stack occupies exactly that gap. This restates the same
 * expression so the vehicle can be measured against it, and
 * `matches the built structure mesh` below checks the restatement against the
 * geometry actually produced rather than trusting it.
 */
const deckTopAt = (design: readonly { s: number; z: number }[], s: number): number =>
  designElevationAtStation(design, s) - totalPavementThickness(RURAL)

/**
 * How far a vehicle's wheels sit above the top of the deck slab, metres.
 *
 * The pavement stack, less the crossfall drop from the crown out to the middle
 * of the nearside lane. For a rural road that is 0.50 − 1.75 × 0.025 = 0.45625:
 * the car is on top of the seal, the seal is on top of the deck, and the number
 * is a property of the class rather than of this scene.
 */
const EXPECTED_RIDE_HEIGHT =
  totalPavementThickness(RURAL) - Math.abs(laneCentreOffset(RURAL)) * RURAL.crossfall

/** Highest z on the structure mesh at a station, transversely across the deck.
 * The deck's top face is level across the road, so any top vertex at the
 * station gives it; the abutment and pier boxes are all below the deck's
 * underside and can never win. */
const structureTopAt = (roadId: RoadId, alignment: Alignment, s: number): number | null => {
  const mesh = scene.built.structures.get(roadId)
  if (!mesh) return null
  const pose = alignment.poseAt(s)
  const cos = Math.cos(pose.heading)
  const sin = Math.sin(pose.heading)
  let best: number | null = null

  for (let i = 0; i < mesh.vertexCount; i++) {
    const dx = mesh.positions[i * 3]! - pose.position.x
    const dy = mesh.positions[i * 3 + 1]! - pose.position.y
    // At this station (within a rounding error) and within the road's width.
    if (Math.abs(dx * cos + dy * sin) > 0.05) continue
    if (Math.hypot(dx, dy) > formationHalfWidth(RURAL) + 1) continue
    const z = mesh.positions[i * 3 + 2]!
    if (best === null || z > best) best = z
  }
  return best
}

type OnDeck = {
  readonly station: number
  readonly z: number
  readonly aboveDeck: number
  readonly aboveGround: number
}

/**
 * Ten simulated minutes of the real fleet over the real network.
 *
 * `FIXED_STEP` per frame, so every frame is exactly one simulation step and no
 * state between two frames is skipped — the same sampling `roadSceneTraffic`
 * uses, for the same reason.
 */
const run = (() => {
  const fleet = new Fleet()
  fleet.sync(drivableRoads(scene.network))

  const onDeck: OnDeck[] = []
  let framesWithBoth = 0
  let leastClearance = Infinity

  for (let frame = 0; frame < Math.round(600 / FIXED_STEP); frame++) {
    fleet.advance(FIXED_STEP)

    let upperZ: number | null = null
    let lowerZ: number | null = null

    fleet.forEachVehicle((roadId, station) => {
      const road = scene.network.road(roadId)
      const design = scene.designs.get(roadId)!
      const pose = placeVehicle(road.alignment, design, ROAD_CLASSES[road.className], station)

      if (
        roadId === scene.upperId &&
        upperSpans.length > 0 &&
        station >= upperSpans[0]!.fromStation &&
        station <= upperSpans[0]!.toStation
      ) {
        onDeck.push({
          station,
          z: pose.z,
          aboveDeck: pose.z - deckTopAt(design, station),
          aboveGround: pose.z - scene.terrain.sample(pose.x, pose.y),
        })
      }

      // Vehicles standing over (or under) the crossing itself, within a
      // vehicle's own length of it in plan.
      if (Math.hypot(pose.x - CROSSING.x, pose.y - CROSSING.y) <= 6) {
        if (roadId === scene.upperId) upperZ = pose.z
        if (roadId === scene.lowerId) lowerZ = pose.z
      }
    })

    if (upperZ !== null && lowerZ !== null) {
      framesWithBoth++
      // Wheels of the car above, to the roof of the car below.
      leastClearance = Math.min(leastClearance, upperZ - (lowerZ + VEHICLE_HEIGHT))
    }
  }

  return { onDeck, framesWithBoth, leastClearance }
})()

describe('the overpass fixture', () => {
  it('really is an overpass, and not a junction or a flat crossing', () => {
    // If any of this fails the rest of the file is measuring something other
    // than a car on a deck, so it is asserted first rather than assumed.
    expect(scene.infeasibleRoads.size).toBe(0)
    expect(scene.infeasibleCrossings).toHaveLength(0)
    // 90° is nowhere near `MIN_DECKABLE_CROSSING_ANGLE`, so the deck derivation
    // is honest rather than clamped.
    expect(scene.shallowCrossings).toHaveLength(0)

    expect(crossing).toBeDefined()
    expect(crossing!.position.x).toBeCloseTo(CROSSING.x, 9)
    expect(crossing!.position.y).toBeCloseTo(CROSSING.y, 9)
    // Mid-span on both roads: neither endpoint is anywhere near it, so
    // `classifyCrossing` cannot read this as a junction.
    expect(upperStation).toBeCloseTo(280, 6)
    expect(lowerStation).toBeCloseTo(400, 6)
    expect(Math.min(upperStation, upperAlignment.length - upperStation)).toBeGreaterThan(250)
    expect(Math.min(lowerStation, lowerAlignment.length - lowerStation)).toBeGreaterThan(350)
  })

  it('lifts the newer road and leaves the older one on the ground', () => {
    // The older road never moves — it is a level plane at 100 and it stays
    // there, which is what makes every metre of separation below attributable
    // to the lift.
    expect(designElevationAtStation(lowerDesign, lowerStation)).toBeCloseTo(GROUND, 9)

    // 100 + 5.0 clearance + (0.50 pavement + 1.2 deck) of structure hanging
    // under the design line. Same 106.70 `solveNetwork`'s own docstring quotes
    // for the flat-ground case.
    const required = GROUND + MIN_OVERPASS_CLEARANCE + totalPavementThickness(RURAL) + DECK_DEPTH
    expect(required).toBeCloseTo(106.7, 9)
    expect(designElevationAtStation(upperDesign, upperStation)).toBeCloseTo(106.7, 6)
    expect(crossing!.clearance).toBeGreaterThanOrEqual(MIN_OVERPASS_CLEARANCE)
  })

  it('forces the lifted stretch onto a deck, and only the lifted road', () => {
    // The lift alone would not do it: 6.70m of fill is under `MAX_FILL_HEIGHT`,
    // so `classifySupport` reads it as earthwork and the sweep would build an
    // embankment straight across the road below. The span exists only because
    // `requiredStructureRanges` demanded it.
    expect(upperSpans).toHaveLength(1)
    expect(upperSpans[0]!.fromStation).toBeCloseTo(257, 6)
    expect(upperSpans[0]!.toStation).toBeCloseTo(303, 6)
    expect(upperSpans[0]!.maxHeight).toBeCloseTo(6.7, 6)

    // The deck covers the crossing with room either side, so a vehicle is on
    // structure for the whole time it is over the road below.
    expect(upperSpans[0]!.fromStation).toBeLessThan(upperStation - formationHalfWidth(RURAL))
    expect(upperSpans[0]!.toStation).toBeGreaterThan(upperStation + formationHalfWidth(RURAL))

    // Nothing carries the road underneath. It is at grade on level ground.
    expect(scene.spans.get(scene.lowerId) ?? []).toHaveLength(0)
  })

  it('puts the deck top exactly one pavement stack below the design line', () => {
    // Ties `deckTopAt` — the expression every vehicle below is measured
    // against — to the geometry `buildBridgeMesh` actually produced, so the two
    // cannot drift apart without this failing. Sampled at the deck's own
    // section stations, which is where its vertices are.
    const span = upperSpans[0]!
    const length = span.toStation - span.fromStation
    const steps = Math.max(1, Math.ceil(length / 5))
    let matched = 0

    for (let i = 0; i <= steps; i++) {
      const s = span.fromStation + (length * i) / steps
      const top = structureTopAt(scene.upperId, upperAlignment, s)
      expect(top).not.toBeNull()
      // 1e-5, not exact: mesh positions are stored as float32.
      expect(top!).toBeCloseTo(deckTopAt(upperDesign, s), 5)
      matched++
    }
    expect(matched).toBe(steps + 1)
  })
})

describe('traffic on the overpass', () => {
  it('drives cars across the deck', () => {
    // Not a formality. A lane whose vehicles never reach the span would make
    // every assertion below vacuously true.
    expect(run.onDeck.length).toBeGreaterThan(1000)
    const stations = run.onDeck.map((s) => s.station)
    expect(Math.min(...stations)).toBeLessThan(upperStation)
    expect(Math.max(...stations)).toBeGreaterThan(upperStation)
  })

  it('rides on the deck rather than through it or on the ground', () => {
    // THE measurement. Every vehicle inside the span sits exactly the pavement
    // stack (less its crossfall drop) above the top of the deck slab: on the
    // seal, which is on the deck. Constant across every sample because the
    // offset from the crown is constant.
    expect(EXPECTED_RIDE_HEIGHT).toBeCloseTo(0.45625, 9)

    for (const sample of run.onDeck) {
      expect(sample.aboveDeck).toBeCloseTo(EXPECTED_RIDE_HEIGHT, 9)
      // Stated separately from the equality above, because it is the claim in
      // the title and it is the one a reader checks first.
      expect(sample.aboveDeck).toBeGreaterThan(0)
    }

    // And not on the natural ground either — which is the failure mode a
    // `placeVehicle` reading terrain instead of the design profile would
    // produce, and which the equality above would also catch. Five metres is
    // the lowest a car on this deck gets, at the far end of the approach.
    const aboveGround = run.onDeck.map((s) => s.aboveGround)
    expect(Math.min(...aboveGround)).toBeGreaterThan(5)
    expect(Math.max(...aboveGround)).toBeCloseTo(6.65304, 4)
  })

  it('keeps a car on the deck clear of a car underneath it', () => {
    // Measured between real vehicles rather than between design lines: the
    // wheels of the car above against the roof of the car below. The design
    // lines are 6.70m apart; a car is 1.5m tall and sits 0.04m below the crown
    // it is measured from, so the air between two cars is what is left.
    const staticGap =
      placeVehicle(upperAlignment, upperDesign, RURAL, upperStation).z -
      (placeVehicle(lowerAlignment, lowerDesign, RURAL, lowerStation).z + VEHICLE_HEIGHT)
    expect(staticGap).toBeCloseTo(5.2, 6)
    expect(staticGap).toBeGreaterThan(MIN_OVERPASS_CLEARANCE - VEHICLE_HEIGHT)

    // Over the run, the pair actually observed at the crossing. The upper car
    // is not always exactly on the crown of the lift — it can be a few metres
    // up the approach — so this is a little tighter than the static figure and
    // is the honest number.
    expect(run.framesWithBoth).toBeGreaterThan(0)
    expect(run.leastClearance).toBeGreaterThan(0)
    expect(run.leastClearance).toBeGreaterThanOrEqual(MIN_OVERPASS_CLEARANCE - VEHICLE_HEIGHT)
    expect(run.leastClearance).toBeCloseTo(4.828, 3)
  })
})
