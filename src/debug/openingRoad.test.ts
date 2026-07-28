import { describe, it, expect } from 'vitest'
import {
  BARE_TERRAIN_DISTANCE,
  DECK_FRAME_FILL,
  OPENING_ROAD_BEARING,
  OPENING_ROAD_CLASS,
  OPENING_ROAD_LENGTH,
  OPENING_ROAD_START,
  buildOpeningNetwork,
  openingRoadAlignment,
  openingView,
} from './openingRoad'
import {
  CAMERA_VERTICAL_FOV, buildSceneContent, buildTerrain, drivableRoads, solveNetwork,
} from './roadScene'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import { RoadNetwork } from '../network/graph'
import { ROAD_CLASSES } from '../network/roadClass'
import { minimumRadiusForSpeed } from '../geometry/designSpeed'
import { roadStructureSpans } from '../mesh/structures/spans'
import { sampleGroundProfile, designElevationAtStation } from '../terrain/groundProfile'
import { terrainFocus } from '../render/cameraFraming'
import { Fleet, FIXED_STEP } from '../traffic/fleet'
import { placeVehicle } from '../render/vehiclePlacement'
import { DrawTool } from '../tool/drawTool'
import { SelectTool } from '../tool/selectTool'

/**
 * The road the game opens on, measured.
 *
 * Every number asserted here was measured off `buildTerrain` before it was
 * written down — a sweep over start points, bearings and lengths, scored on
 * feasibility, span count, span height and how much of the road the span ate.
 * They are pinned rather than trusted because they are properties of one
 * particular terrain seed: change the seed, the fill allowance, the grade
 * limit or the alignment, and the opening shot silently loses its bridge.
 *
 * Built once. Grading and excavating an 800m corridor over a 257x257 terrain
 * is the expensive part, and nothing here mutates the result.
 */
const scene = buildSceneContent()
const roadId = scene.network.roads[0]!.id
const design = scene.designs.get(roadId)!
const spans = scene.spans.get(roadId) ?? []

/** Where the sweep found the deck: measured, to the metre. */
const SPAN_FROM = 349
const SPAN_TO = 543
const SPAN_MAX_HEIGHT = 21.1129

describe('the road the game opens on', () => {
  it('is exactly one road', () => {
    // The user asked for a blank canvas once and got one; what they asked for
    // after seeing it was "some road or something else inviting", singular.
    // This is not the three-arm T junction coming back — that layout lives in
    // `demoNetwork.fixture.ts` and is used by tests only.
    expect(scene.network.roads).toHaveLength(1)
    expect(scene.network.roads[0]!.className).toBe(OPENING_ROAD_CLASS)
    expect(OPENING_ROAD_CLASS).toBe('rural')
  })

  it('grades feasibly, through the same solve a player-drawn road takes', () => {
    // In `designs`, not in `infeasibleRoads`. A road that failed to grade is
    // still in the graph and still gets a mesh — one sitting at absolute
    // elevation zero, eighty metres under this terrain — so "the scene has a
    // road in it" is not evidence that it graded.
    expect(scene.designs.has(roadId)).toBe(true)
    expect([...scene.infeasibleRoads.keys()]).toEqual([])
    expect(scene.infeasibleCrossings).toEqual([])
    expect(scene.shallowCrossings).toEqual([])
  })

  it('is built where it was measured to be', () => {
    expect(OPENING_ROAD_START).toEqual({ x: 1550, y: 900 })
    expect(OPENING_ROAD_BEARING).toBeCloseTo((135 * Math.PI) / 180, 12)
    expect(OPENING_ROAD_LENGTH).toBe(800)

    // North-west, so the far end is 566m west and 566m north of the start,
    // and both ends are well inside the 2560m footprint.
    const end = openingRoadAlignment().poseAt(OPENING_ROAD_LENGTH).position
    expect(end.x).toBeCloseTo(984.315, 3)
    expect(end.y).toBeCloseTo(1465.685, 3)
  })

  it('stops where its grade line rejoins natural ground', () => {
    // Both ends at grade, so the road neither erupts from an embankment nor
    // vanishes into a cutting at its ends. Station 0 is pinned to ground by
    // the solver; the far end landing there too is the property that picked
    // 800m over 850m (1.3m out) and 900m (9.5m out, and falling).
    const alignment = openingRoadAlignment()
    for (const station of [0, OPENING_ROAD_LENGTH]) {
      const p = alignment.poseAt(station).position
      const cutOrFill = designElevationAtStation(design, station) - scene.terrain.sample(p.x, p.y)
      expect(Math.abs(cutOrFill)).toBeLessThan(0.5)
    }
  })
})

describe('the bridge the opening road is carried on', () => {
  it('is a single span, at the stations it was measured at', () => {
    expect(spans).toHaveLength(1)
    expect(spans[0]!.fromStation).toBe(SPAN_FROM)
    expect(spans[0]!.toStation).toBe(SPAN_TO)
    expect(spans[0]!.maxHeight).toBeCloseTo(SPAN_MAX_HEIGHT, 4)
  })

  it('stands clear enough of the ground to be a bridge and not a bump', () => {
    // Twice the fill allowance the grade solver would otherwise embank to, so
    // this is a structure by a wide margin rather than by a metre of rounding
    // — and still clear of `MAX_STRUCTURE_HEIGHT`, which several otherwise
    // promising crossings rode exactly, leaving the solve one terrain sample
    // from infeasible.
    expect(spans[0]!.maxHeight).toBeGreaterThan(20)
    expect(spans[0]!.maxHeight).toBeLessThan(30)
  })

  it('is a feature of the road rather than the whole of it', () => {
    const spanLength = spans[0]!.toStation - spans[0]!.fromStation
    expect(spanLength).toBeCloseTo(194, 6)
    expect(spanLength / OPENING_ROAD_LENGTH).toBeLessThan(1 / 3)
    // And it is clear of both ends, so there is real road either side of it.
    expect(spans[0]!.fromStation).toBeGreaterThan(300)
    expect(OPENING_ROAD_LENGTH - spans[0]!.toStation).toBeGreaterThan(200)
  })

  it('comes from the terrain, not from a deck forced under a crossing', () => {
    // `roadStructureSpans` produces spans two ways: `classifySupport` finding
    // the design line too high above natural ground, and `requiredStructureRanges`
    // forcing a deck where one road passes over another. The second is not
    // available here — there is one road, so there are no crossings — but that
    // is an argument, and the point is to measure it. Derived with no required
    // ranges at all, the span is identical, so `classifySupport` alone put it
    // there.
    const fromTerrainAlone = roadStructureSpans({
      alignment: openingRoadAlignment(),
      design,
      terrain: scene.terrain,
      maxFillHeight: 10,
      spacing: 4,
    })
    expect(fromTerrainAlone).toEqual(spans)
  })

  it('is built into the scene mesh, not merely recorded', () => {
    // The span could be perfectly correct and no deck ever reach the screen.
    expect(scene.built.roads.size).toBe(1)
    expect(scene.built.structures.get(roadId)!.vertexCount).toBeGreaterThan(0)
    expect([...scene.unsupportedFill.keys()]).toEqual([])
  })

  it('leaves the ravine under the deck undug', () => {
    // The whole point of a bridge: the earthworks stop at the abutment face
    // rather than filling the valley in. Sampled under the middle of the span,
    // where a corridor sweep that ignored the structure would have piled
    // twenty metres of embankment.
    const mid = openingRoadAlignment().poseAt((SPAN_FROM + SPAN_TO) / 2).position
    expect(scene.editLayer.sample(mid.x, mid.y))
      .toBeCloseTo(scene.terrain.sample(mid.x, mid.y), 6)
  })
})

describe('the valley the opening road crosses', () => {
  const alignment = openingRoadAlignment()
  const ground = sampleGroundProfile(alignment, scene.terrain, 4)

  it('is deep, and its deepest ground is under the deck', () => {
    let lowest = ground[0]!
    for (const point of ground) if (point.z < lowest.z) lowest = point

    // 98.1m, on the valley floor — measured, and the reason a bridge exists
    // here at all.
    expect(lowest.z).toBeCloseTo(98.06, 2)
    expect(lowest.s).toBeGreaterThanOrEqual(SPAN_FROM)
    expect(lowest.s).toBeLessThanOrEqual(SPAN_TO)
  })

  it('is crossed rather than run along', () => {
    // Both ends stand well above the floor, on opposite flanks: 152.1m on the
    // south side, 112.5m on the north. A road that ran ALONG the valley and
    // happened to bridge a gully would fail this — its ends would sit at
    // valley-floor elevation like everything else on the axis.
    expect(scene.terrain.sample(OPENING_ROAD_START.x, OPENING_ROAD_START.y))
      .toBeCloseTo(152.13, 2)
    const end = alignment.poseAt(OPENING_ROAD_LENGTH).position
    expect(scene.terrain.sample(end.x, end.y)).toBeCloseTo(112.52, 2)

    // 54m of relief along 800m of road: this is a landform, not noise.
    let lowest = Infinity
    let highest = -Infinity
    for (const point of ground) {
      lowest = Math.min(lowest, point.z)
      highest = Math.max(highest, point.z)
    }
    expect(highest - lowest).toBeGreaterThan(45)
  })

  it('is crossed square, not scraped along at an angle', () => {
    // `generateValley`'s axis meanders as `1280 + 140 sin(2πx/W) + 48 sin(5πx/W + seed)`.
    // The road's ends sit 259m south and 71m north of it, so it starts on one
    // flank and finishes past the axis on the other.
    const axisY = (x: number): number =>
      1280
      + Math.sin((x / 2560) * Math.PI * 2) * 400 * 0.35
      + Math.sin((x / 2560) * Math.PI * 5 + 7) * 400 * 0.12

    const end = alignment.poseAt(OPENING_ROAD_LENGTH).position
    expect(OPENING_ROAD_START.y - axisY(OPENING_ROAD_START.x)).toBeCloseTo(-259.34, 2)
    expect(end.y - axisY(end.x)).toBeCloseTo(70.89, 2)
  })
})

describe('traffic on the opening road', () => {
  it('runs, from the first frame the game has', () => {
    const drivable = drivableRoads(scene.network)
    expect(drivable).toHaveLength(1)
    expect(drivable[0]!.className).toBe('rural')

    const fleet = new Fleet()
    fleet.sync(drivable)
    // One minute of simulation: long enough for a car entering at station 0 to
    // reach the far end of an 800m road at rural speed.
    for (let step = 0; step < 60 / FIXED_STEP; step++) fleet.advance(FIXED_STEP)

    let vehicles = 0
    fleet.forEachVehicle(() => { vehicles++ })
    expect(vehicles).toBeGreaterThan(5)
  })

  it('rides the deck across the span rather than the ravine floor under it', () => {
    // The machinery is verified elsewhere (`overpassTraffic.test.ts`); what is
    // measured here is that it fires on the road that actually ships. A car
    // between the abutments must be metres above natural ground, because that
    // is where the deck is.
    const fleet = new Fleet()
    fleet.sync(drivableRoads(scene.network))

    let sampled = 0
    let lowestClearance = Infinity
    let highestClearance = -Infinity
    for (let step = 0; step < 120 / FIXED_STEP; step++) {
      fleet.advance(FIXED_STEP)
      if (step % 60 !== 0) continue
      fleet.forEachVehicle((_road, station) => {
        if (station < SPAN_FROM || station > SPAN_TO) return
        const pose = placeVehicle(openingRoadAlignment(), design, ROAD_CLASSES.rural, station)
        const clearance = pose.z - scene.terrain.sample(pose.x, pose.y)
        sampled++
        lowestClearance = Math.min(lowestClearance, clearance)
        highestClearance = Math.max(highestClearance, clearance)
      })
    }

    expect(sampled).toBeGreaterThan(10)
    // Nothing on the deck is anywhere near the ground, and something on it
    // reaches most of the way to the span's own measured height.
    expect(lowestClearance).toBeGreaterThan(8)
    expect(highestClearance).toBeGreaterThan(SPAN_MAX_HEIGHT - 2)
  })
})

/**
 * The road is there to be built onto, and to be got rid of.
 *
 * Both are claims the game now makes. The starting hint tells the player in as
 * many words that finishing a road on the existing one joins it, and the whole
 * empty-network path — which shipped one branch ago and is still every state
 * reachable by deleting — has to survive the shipped road being deleted.
 */
describe('building on and off the opening road', () => {
  /** A short gravel road on the southern flank, finishing ON the opening road
   * at station 200 — a plain gesture in the default class, in the part of the
   * world the opening camera frames. */
  const drawOnto = (network: RoadNetwork) => {
    const meetsAt = openingRoadAlignment().poseAt(200).position
    const tool = new DrawTool(network, 'gravel')
    tool.place(vec2(meetsAt.x + 150, meetsAt.y - 60), false)
    tool.place(vec2(meetsAt.x, meetsAt.y), false)
    return tool.commit()
  }

  it('splits into a junction when a road finishes on it, as the hint says', () => {
    // The hint's exact claim — "finish on the existing road to join it" — as an
    // assertion. Without this the sentence is prose about behaviour nothing
    // checks.
    const network = buildOpeningNetwork()
    const result = drawOnto(network)

    expect(result.ok).toBe(true)
    // One road became two halves, plus the new one: three roads meeting at a
    // shared node, which is what a junction IS in this graph.
    expect(network.roads).toHaveLength(3)

    const terrain = buildTerrain()
    const solved = solveNetwork(terrain, network)
    expect(solved.infeasibleRoads.size).toBe(0)
    expect(solved.built.junctions.size).toBe(1)
  })

  it('gives the game back a working empty world when it is deleted', () => {
    // The state the previous branch shipped as the opening one. Every
    // empty-network test still covers it in the abstract; this covers the one
    // path a player can actually take to reach it.
    const network = buildOpeningNetwork()
    const terrain = buildTerrain()

    const selectTool = new SelectTool(network)
    const midDeck = openingRoadAlignment().poseAt((SPAN_FROM + SPAN_TO) / 2).position
    const selected = selectTool.select(vec2(midDeck.x, midDeck.y))
    expect(selected).toBe(network.roads[0]!.id)
    expect(selectTool.deleteSelected()).toEqual({ ok: true, roadId: selected })

    expect(network.roads).toEqual([])
    expect(network.nodes).toEqual([])

    const solved = solveNetwork(terrain, network)
    expect(solved.designs.size).toBe(0)
    expect(solved.spans.size).toBe(0)
    expect(solved.built.roads.size).toBe(0)
    expect(drivableRoads(network)).toEqual([])

    // The ground heals — the whole corridor, viaduct abutments included.
    let moved = 0
    for (let row = 0; row < terrain.rows; row++) {
      for (let col = 0; col < terrain.cols; col++) {
        if (solved.editLayer.deltaAt(col, row) !== 0) moved++
      }
    }
    expect(moved).toBe(0)

    // And the camera falls back rather than aiming at a road that is gone.
    expect(openingView({ terrain, network, ...solved }, CAMERA_VERTICAL_FOV))
      .toEqual({ target: terrainFocus(terrain), distance: BARE_TERRAIN_DISTANCE })
  })
})

describe('the opening camera', () => {
  const view = openingView(scene, CAMERA_VERTICAL_FOV)

  it('aims at the middle of the deck, at deck level', () => {
    // Measured: the mid-span point of the solved design line. A camera aimed
    // at the terrain under it would be aimed twenty metres down, at the bottom
    // of the ravine, with the bridge out of shot above.
    expect(view.target.x).toBeCloseTo(1234.63, 2)
    expect(view.target.y).toBeCloseTo(1215.37, 2)
    expect(view.target.z).toBeCloseTo(121.514, 3)

    const groundUnderTheDeck = scene.terrain.sample(view.target.x, view.target.y)
    expect(view.target.z - groundUnderTheDeck).toBeGreaterThan(19)
  })

  it('shows the bridge, not just some road', () => {
    // The mutation this exists to catch: aiming somewhere that does not have
    // the bridge in it — the terrain's plan centre, say, which is what the
    // blank-canvas branch used and is 79m off the deck and 31m below it.
    const middleOfTheMap = terrainFocus(scene.terrain)
    expect(Math.hypot(view.target.x - middleOfTheMap.x, view.target.y - middleOfTheMap.y))
      .toBeGreaterThan(50)

    // And the target really is ON the span, not merely near it.
    const alignment = openingRoadAlignment()
    const from = alignment.poseAt(SPAN_FROM).position
    const to = alignment.poseAt(SPAN_TO).position
    expect(Math.hypot(view.target.x - from.x, view.target.y - from.y))
      .toBeLessThan(SPAN_TO - SPAN_FROM)
    expect(Math.hypot(view.target.x - to.x, view.target.y - to.y))
      .toBeLessThan(SPAN_TO - SPAN_FROM)
  })

  it('stands back far enough for the valley and close enough for the deck', () => {
    // 427m, derived from the deck's own 194.5m chord and `DECK_FRAME_FILL`.
    expect(view.distance).toBeCloseTo(426.8, 1)

    // The deck takes up its share of the frame, and no more.
    const frameHeight = 2 * view.distance * Math.tan((CAMERA_VERTICAL_FOV * Math.PI) / 360)
    const from = openingRoadAlignment().poseAt(SPAN_FROM).position
    const to = openingRoadAlignment().poseAt(SPAN_TO).position
    const chord = Math.hypot(
      to.x - from.x, to.y - from.y,
      designElevationAtStation(design, SPAN_TO) - designElevationAtStation(design, SPAN_FROM),
    )
    expect(chord / frameHeight).toBeCloseTo(DECK_FRAME_FILL, 8)

    // The camera looks down at 0.4 radians (see `drawRoadScene`), so the
    // vertical field sweeps 830m of ground — the valley's full 800m width
    // between crests. Tighter and the valley sides leave the shot.
    expect(frameHeight / Math.sin(0.4)).toBeGreaterThan(800)
  })

  it('keeps the starting hint true', () => {
    // The hint tells the player gravel is the only class whose corners fit in
    // this view, and a corner needs its radius' worth of straight either side,
    // so the shortest road that can turn is twice the minimum radius. If the
    // camera ever pulled back past the rural figure that sentence becomes a
    // lie, and this is the thing that notices.
    const shortestTurn = (kph: number) => 2 * minimumRadiusForSpeed(kph)

    expect(shortestTurn(ROAD_CLASSES.gravel.designSpeedKph)).toBeLessThan(view.distance)
    expect(shortestTurn(ROAD_CLASSES.rural.designSpeedKph)).toBeGreaterThan(view.distance)
    expect(shortestTurn(ROAD_CLASSES.arterial.designSpeedKph)).toBeGreaterThan(view.distance)
    expect(shortestTurn(ROAD_CLASSES.highway.designSpeedKph)).toBeGreaterThan(view.distance)
  })

  it('falls back to the middle of the terrain when nothing is built', () => {
    // The state a player reaches by deleting the shipped road, and the state
    // every empty-network test is in. A camera that threw or aimed at nothing
    // here would break a legal scene.
    const terrain = buildTerrain()
    const empty = solveNetwork(terrain, new RoadNetwork())
    const view = openingView(
      { terrain, network: new RoadNetwork(), designs: empty.designs, spans: empty.spans },
      CAMERA_VERTICAL_FOV,
    )

    expect(view.target).toEqual(terrainFocus(terrain))
    expect(view.distance).toBe(BARE_TERRAIN_DISTANCE)
  })

  it('picks the tallest deck, not the first one it finds', () => {
    // "First" would be an id ordering — whichever road happened to be added
    // earliest — and would re-aim the opening shot at a culvert. Height is a
    // property of the thing being looked at, so it is what decides.
    //
    // The fixture is built so those two answers DIFFER: a second crossing
    // added AFTER the opening road, far enough east that the two never meet
    // (so no overpass is forced and neither span is anything but the terrain's
    // own doing), carrying a 23.41m span against the opening road's 21.11m.
    // With the opening road still first by id, a "first span wins" rule aims
    // at the wrong bridge and this fails.
    const terrain = buildTerrain()
    const network = buildOpeningNetwork()
    const tallerId = network.addRoad(
      new Alignment([new Line(vec2(1900, 1000), Math.PI / 3, 600)]), 'rural',
    )
    const solved = solveNetwork(terrain, network)

    expect(solved.infeasibleRoads.size).toBe(0)
    expect(solved.shallowCrossings).toEqual([])
    const first = solved.spans.get(network.roads[0]!.id)![0]!
    const taller = solved.spans.get(tallerId)![0]!
    expect(first.maxHeight).toBeCloseTo(21.1129, 4)
    expect(taller.maxHeight).toBeCloseTo(23.4057, 4)
    expect(tallerId).toBeGreaterThan(network.roads[0]!.id)

    const view = openingView({ terrain, network, ...solved }, CAMERA_VERTICAL_FOV)
    const mid = network.road(tallerId).alignment.poseAt(
      (taller.fromStation + taller.toStation) / 2,
    ).position
    expect(view.target.x).toBeCloseTo(mid.x, 6)
    expect(view.target.y).toBeCloseTo(mid.y, 6)
  })
})
