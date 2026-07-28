import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import type { StructureSpan } from '../mesh/structures/spans'
import { RoadNetwork, type RoadId } from '../network/graph'
import type { RoadClassName } from '../network/roadClass'
import type { ProfilePoint } from '../terrain/groundProfile'
import type { Heightmap } from '../terrain/heightmap'
import { frameRoadRun, terrainFocus, type Framing } from '../render/cameraFraming'

/**
 * The one road the game opens on, and the camera that looks at it.
 *
 * The scene shipped as a blank canvas for exactly one branch. Bare terrain
 * turned out to read as a loading screen rather than as an invitation: a
 * featureless green slope says nothing about what the game is, what can be
 * built or how big a road is. What ships instead is a single existing road
 * carried across the valley on a viaduct, with traffic on it — enough to show
 * cut, fill, a deck on abutments and cars in the first second, and to give the
 * player a sense of scale and something to junction onto, while leaving the
 * other six square kilometres empty for them.
 *
 * ONE road, deliberately. This is not the old three-arm T junction coming
 * back; that layout still exists, unchanged, in `demoNetwork.fixture.ts`, and
 * is used by tests and by nothing else.
 *
 * Everything here is pure arithmetic over the terrain and lives outside
 * `roadScene.ts` on purpose: the file that draws the scene is the one without
 * unit tests, so where the road goes and where the camera looks are decided
 * here and measured in `openingRoad.test.ts`.
 */

/**
 * Where the road starts, high on the valley's southern flank.
 *
 * MEASURED, not chosen. `generateValley`'s axis meanders across the 2560m
 * footprint, so there is no coordinate that is obviously "the valley"; a sweep
 * over start points, bearings and lengths, scoring each candidate on whether
 * it graded, whether it produced exactly one structure span, how tall that
 * span was and how much of the road it consumed, picked this one. What the
 * sweep measured about it:
 *
 * - natural ground falls from 152.1m here to 98.1m at station 480, the lowest
 *   point on the valley floor under the deck, and climbs back to 112.5m at the
 *   far end;
 * - the road's two ends sit 259m south and 71m north of the valley axis, so it
 *   genuinely goes across rather than along;
 * - the grade line lands back on natural ground at the far end to within 6cm,
 *   so the road stops at grade rather than in mid-cutting.
 *
 * These are properties of `buildTerrain`'s particular seed. They are pinned in
 * `openingRoad.test.ts` rather than trusted, because a terrain change would
 * move them silently and the first symptom would be an opening shot with no
 * bridge in it.
 */
export const OPENING_ROAD_START = vec2(1550, 900)

/**
 * North-west, at 135°.
 *
 * Perpendicular to the valley here, which is what makes the crossing a
 * crossing rather than a diagonal scrape along the flank — and, because
 * `CameraRig`'s azimuth starts at 45°, exactly square on to the opening
 * camera. The deck is therefore seen broadside, in profile, rather than
 * end-on down its own length.
 */
export const OPENING_ROAD_BEARING = (3 * Math.PI) / 4

/**
 * 800m.
 *
 * Long enough that the 194m bridge is a feature of the road rather than the
 * whole of it — a quarter of its length — and short enough to stop where the
 * grade line rejoins natural ground. Measured at 850m and beyond the far end
 * drives into a cutting that deepens to `MAX_CUT_DEPTH`, and the road ends in
 * a hole; at 1050m a second span appears and the single clear crossing becomes
 * two.
 */
export const OPENING_ROAD_LENGTH = 800

/**
 * Rural: two lanes, 10m of formation, 80km/h.
 *
 * `DEFAULT_DRAW_CLASS` is gravel because a rural road's 252m minimum radius
 * cannot turn a corner inside the opening camera's view. That constraint is
 * about DRAWING one, and binds only the class the draw tool starts in; a road
 * that is already built has no corner to fit and is not subject to it. This
 * one is dead straight.
 *
 * So the class is picked on what it should look like. Gravel is a single 3m
 * lane, which on a 21m viaduct across a valley reads as a mistake. Arterial is
 * four lanes and 18m of formation and highway is six and 28m, either of which
 * would dominate a landscape the player is meant to find empty. Rural is the
 * road a real valley crossing like this carries, and being the second rung of
 * `ROAD_CLASS_ORDER` it also quietly shows that the ladder has rungs above the
 * one the player starts on.
 */
export const OPENING_ROAD_CLASS: RoadClassName = 'rural'

/** The opening road's horizontal alignment: one straight, no curves. */
export const openingRoadAlignment = (): Alignment =>
  new Alignment([new Line(OPENING_ROAD_START, OPENING_ROAD_BEARING, OPENING_ROAD_LENGTH)])

/**
 * The network the game opens with: one road in it.
 *
 * No feasibility pre-check, unlike `buildDemoNetwork`. That fixture screens
 * its arms because it builds three of them and one failing would leave a
 * road in the graph with no design profile. Here there is one road and it is
 * the whole point of the scene, so a version of it that did not grade must be
 * a failing test rather than a network that quietly comes back empty.
 */
export const buildOpeningNetwork = (): RoadNetwork => {
  const network = new RoadNetwork()
  network.addRoad(openingRoadAlignment(), OPENING_ROAD_CLASS)
  return network
}

/**
 * How much of the frame's height the bridge deck takes up in the opening shot.
 *
 * The one number here that is a composition decision rather than a
 * measurement, so it was picked by looking at the three candidates rendered:
 *
 * - 0.6 puts the camera 391m back. The deck is big, but the far ridge is
 *   squeezed into the top of the frame and the valley reads as flat ground
 *   with a dip in it.
 * - 0.5 puts it 469m back, with the whole skyline in shot — and 35m from
 *   making the starting hint false (see below).
 * - 0.55, at 427m, keeps the skyline and the valley's shape, keeps the deck,
 *   its piers, its shadow and the cars on it clearly readable, and leaves 77m
 *   of margin on the hint.
 *
 * The remaining 45% of the frame is not slack, it is the valley: because the
 * camera looks down at 0.4 radians rather than straight on, a 354m vertical
 * field sweeps some 900m of ground — more than the valley's 800m width from
 * crest to crest.
 *
 * The margin matters because the hint tells the player that gravel is the only
 * class whose corners fit inside this view, and a corner needs its own radius'
 * worth of straight either side of it: 87m for gravel, 504m for rural. The
 * distance this produces has to stay between those two for that sentence to be
 * true, and `roadScene.test.ts` asserts it against the real framing rather than
 * against a constant. See `describeStartingHint`.
 */
export const DECK_FRAME_FILL = 0.55

/**
 * How far back the camera stands when there is no structure to frame, metres.
 *
 * The empty world: before any road exists in a test, and after a player
 * deletes the last one. Not derivable from anything — an empty scene has no
 * subject with a size — so it is the number the blank-canvas branch shipped
 * as `RIG_INITIAL_DISTANCE`, kept because it is a known-good working distance
 * for drawing at, and named for the one case that now uses it.
 */
export const BARE_TERRAIN_DISTANCE = 300

/** The parts of a solved scene the opening camera is a function of. Structural
 * rather than `SceneContent` itself, so this module does not have to import
 * the scene that imports it. */
export type FramableScene = {
  readonly terrain: Heightmap
  readonly network: RoadNetwork
  readonly designs: ReadonlyMap<RoadId, readonly ProfilePoint[]>
  readonly spans: ReadonlyMap<RoadId, readonly StructureSpan[]>
}

/**
 * Where the camera starts: on the tallest bridge deck in the scene, framed so
 * the valley it crosses comes with it.
 *
 * The tallest span rather than the first, because "first" is an id ordering —
 * whichever road happened to be added earliest — and would re-aim the opening
 * shot at a 12m culvert if one were ever added before the viaduct. Height is a
 * property of the thing being looked at.
 *
 * Falls back to `terrainFocus` at `BARE_TERRAIN_DISTANCE` when the scene has
 * no span in it at all. That is not a defensive branch: it is the state the
 * game is in the moment a player deletes the road, and a camera that threw or
 * aimed at nothing there would break a legal scene.
 */
export const openingView = (
  scene: FramableScene,
  verticalFovDegrees: number,
  fill: number = DECK_FRAME_FILL,
): Framing => {
  let best: { roadId: RoadId; span: StructureSpan } | undefined

  for (const [roadId, spans] of scene.spans) {
    if (!scene.designs.has(roadId)) continue
    for (const span of spans) {
      if (!best || span.maxHeight > best.span.maxHeight) best = { roadId, span }
    }
  }

  if (!best) {
    return { target: terrainFocus(scene.terrain), distance: BARE_TERRAIN_DISTANCE }
  }

  return frameRoadRun(
    scene.network.road(best.roadId).alignment,
    scene.designs.get(best.roadId)!,
    best.span.fromStation,
    best.span.toStation,
    verticalFovDegrees,
    fill,
  )
}
