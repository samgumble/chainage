import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2, type Vec2 } from '../geometry/vec2'
import type { PolylineRejection } from '../geometry/polyline'
import { generateValley } from '../terrain/generate'
import {
  sampleGroundProfile, designElevationAtStation, type ProfilePoint,
} from '../terrain/groundProfile'
import {
  solveGradeProfile, STATION_TOLERANCE,
  type GradeSolution, type ClearanceFloor,
} from '../terrain/gradeSolver'
import { TerrainEditLayer } from '../terrain/editLayer'
import { type CorridorTemplate, type CorridorBatters } from '../terrain/corridor'
import { CorridorExcavation, sweepCorridor, type UnsupportedFill } from '../terrain/excavation'
import { rayTerrainIntersection, type Ray3, type Vec3 as GroundVec3 } from '../terrain/rayCast'
import { clampNumber, type Heightmap, type TerrainSampler } from '../terrain/heightmap'
import {
  ROAD_CLASSES,
  ROAD_CLASS_ORDER,
  formationHalfWidth,
  totalPavementThickness,
  type LayerName,
  type RoadClassName,
} from '../network/roadClass'
import { toBufferGeometry } from '../render/meshAdapter'
import { terrainGeometry } from '../render/terrainMesh'
import { CameraRig, type Vec3 as RigVec3 } from '../render/cameraRig'
import { sunAt } from '../render/sunlight'
import { surfaceFor } from '../render/materials'
import { TILT_SHIFT_FRAGMENT_SHADER, createTiltShiftUniforms } from '../render/tiltShift'
import { RoadNetwork, NODE_SNAP_DISTANCE, type RoadId } from '../network/graph'
import { findCrossings, MIN_OVERPASS_CLEARANCE } from '../network/crossings'

/**
 * Slack added to each end of a derived overpass deck, metres.
 *
 * `overpassDeckHalfLength` is exact in the continuum. What it is not exact
 * about is sampling, and three quantisations sit between its answer and what
 * actually gets built:
 *
 * - the required range is resampled onto `STRUCTURE_STATION_SPACING` (4m)
 *   before it becomes a span, and `ABUTMENT_EXTENSION` (3m) does not always
 *   step back over that, so a span can finish up to 1m inside the range asked
 *   for;
 * - the corridor sweep steps at `EXCAVATION_STATION_SPACING` (5m), so the
 *   first station outside the deck sits anywhere in the 5m past its end;
 * - the derivation treats both alignments as straight over the deck's length,
 *   which is exact through a `Line` and approximate through an `Arc`.
 *
 * Ten metres is comfortably clear of the 4m and the 5m, and absorbs a fair
 * amount of curvature besides. This is NOT where the road below's batter run
 * is accounted for — that is `CORRIDOR_MAX_BATTER_WIDTH`, in the half-width
 * the derivation is given. Erring long here costs a slightly longer deck;
 * erring short puts an embankment in the road the deck was bridging.
 */
const OVERPASS_DECK_MARGIN = 10

/**
 * Shallowest crossing angle an overpass deck is derived honestly for, radians.
 *
 * The half-length a deck needs is `(B + W·|cos θ|) / sin θ` (see
 * `overpassDeckHalfLength`), which diverges as the two alignments approach
 * parallel. For this scene's rural-over-rural case — B = 5 + 8 = 13m of
 * corridor to keep clear, W ≈ 28m of swept fan at the ~6m of fill an overpass
 * approach carries — the deck comes out:
 *
 *   90°: 46m   60°: 83m   45°: 114m   30°: 171m   20°: 252m   10°: 439m
 *
 * (each including this margin at both ends). The demo scene's own roads are
 * 300m for the gravel branch and 750m for each arm. At 20° the deck is already
 * five sixths of the branch; at 10° it is longer than the branch is, and there
 * is no road left to approach it on. Twenty degrees is also a 70° skew, well
 * past anything built — highway skews beyond about 45° are already
 * exceptional.
 *
 * So the derivation is clamped here rather than allowed to run away, and every
 * crossing shallower than this goes into `SceneContent.shallowCrossings`. The
 * report is not decoration: a clamped deck IS too short, and the fill it fails
 * to keep off the road below is exactly the "things rendering on top of the
 * road" defect this branch exists to fix, reproduced against the lower road.
 */
const MIN_DECKABLE_CROSSING_ANGLE = (20 * Math.PI) / 180
import { classifyCrossing, type InfeasibleCrossing, type ShallowCrossing } from '../network/crossingKind'
import { buildNetworkMesh, type NetworkMesh } from '../mesh/networkMesh'
import { networkStructureSpans, type StructureSpan } from '../mesh/structures/spans'
import { DECK_DEPTH } from '../mesh/structures/bridgeMesh'
import { DrawTool, SNAP_RADIUS } from '../tool/drawTool'
import { resolveSnap, type SnapTarget } from '../tool/snap'
import { SelectTool, type SplitOutcome } from '../tool/selectTool'
import {
  describePolylineRejection,
  describeSplitOutcome,
  describeUpgradeObstacles,
  describeInfeasibleRoads,
  describeInfeasibleCrossings,
  describeShallowCrossings,
} from '../tool/messages'

const MAX_GRADE = 0.07
const MAX_CUT_DEPTH = 12
const MAX_FILL_HEIGHT = 10

/**
 * How high the design line may stand above natural ground on a STRUCTURE.
 *
 * Without this the solver's band is capped at ground + `MAX_FILL_HEIGHT`, so
 * no station can ever exceed the fill allowance and `classifySupport` can
 * never return `'structure'` — the bridge trigger is unreachable no matter
 * what the terrain does. 30m is deliberately well clear of the 10m fill
 * allowance: the solver hugs natural ground and only climbs away from it
 * where the grade limit forbids following the ground down, so the extra
 * headroom is spent only where a bridge is genuinely wanted. Measured against
 * this valley it produces one 146m span, 17.6m at its deepest, on the east
 * arm; raising it further changes nothing, because the grade limit rather
 * than the band is what holds the line up there.
 */
const MAX_STRUCTURE_HEIGHT = 30

/** Cut and fill batters, horizontal-to-vertical — a property of how the
 * ground stands, not of the pavement built on it, so shared across every
 * road class rather than varying per class the way formation width does. */
const CORRIDOR_CUT_SLOPE = 2
const CORRIDOR_FILL_SLOPE = 3

/**
 * How far a batter may run from the formation edge before a wall takes over.
 *
 * Derived from this scene's own depths rather than picked. The cut batter is
 * 2H:1V and `MAX_CUT_DEPTH` is 12m, so an untruncated cut batter runs out
 * 24m; limiting it to 8m puts a wall wherever the cut is deeper than 4m, or
 * the fill higher than 2.7m at 3H:1V. Measured over the three arms that is
 * 24% of the west arm's stations, 57% of the east and 80% of the gravel
 * branch — walls where this corridor is genuinely tight, which is most of the
 * branch and a quarter of the shallow west arm. Without it `retainingWall()`
 * returns null at every station and no wall is ever built.
 */
export const CORRIDOR_MAX_BATTER_WIDTH = 8

/**
 * Batters and wall limit, shared by every road in the scene.
 *
 * None of it varies by road class: the hillside stands at the same angle
 * whatever is built on it, and the corridor is as constrained for the branch
 * as for the main road. Formation width — the part that does vary — is filled
 * in per road, by `corridorTemplateFor` here and by `buildNetworkMesh` for
 * the wall geometry.
 */
const CORRIDOR_BATTERS: CorridorBatters = {
  cutSlope: CORRIDOR_CUT_SLOPE,
  fillSlope: CORRIDOR_FILL_SLOPE,
  maxBatterWidth: CORRIDOR_MAX_BATTER_WIDTH,
}

/** Earthworks cross-section used to carve the corridor into the terrain for
 * a given road class — each class has its own formation width, so the
 * gravel branch excavates a narrower footprint than the rural main road. */
const corridorTemplateFor = (className: RoadClassName): CorridorTemplate => ({
  ...CORRIDOR_BATTERS,
  formationHalfWidth: formationHalfWidth(ROAD_CLASSES[className]),
})

/** How far apart, along the alignment, the excavation walk takes stations. */
export const EXCAVATION_STATION_SPACING = 5

/**
 * Station spacing for the mesh build and for the structure spans fed to it.
 *
 * One constant for both deliberately. `buildNetworkMesh` samples ground at
 * its `spacing` when it has to derive spans itself, so a scene that computed
 * its spans at one spacing and meshed at another would be handing the mesh
 * layer a span list it would never have produced — the same class of
 * disagreement, one level down, as the one this scene's earthworks and
 * structures used to have with each other.
 */
const STRUCTURE_STATION_SPACING = 4
/** Extra width beyond the computed batter run-out, so the daylight line is
 * never clipped by an undersized excavation footprint. */
const EXCAVATION_MARGIN = 5
/**
 * Extra depth carved below the subgrade's underside everywhere along the
 * corridor, metres.
 *
 * Just enough to cover z-fighting and grid-resolution error at the pavement's
 * bottom face — a "nearest grid node" excavation on a terrain grid whose cell
 * size is comparable to the formation width cannot land exactly on that
 * surface, so bilinearly-sampled terrain a station or two away from an
 * excavated node still carries some of the untouched raw ground. This is not
 * an earthworks allowance the way `EXCAVATION_MARGIN` is; it exists only so
 * the terrain never pokes back through the bottom of the pavement stack.
 */
const EXCAVATION_ZFIGHT_MARGIN = 0.05

/**
 * How far back the camera starts, metres.
 *
 * Close enough that the junction — three formation widths meeting at one
 * point — fills a useful part of the screen, rather than the old ~1565m that
 * read every road as a hairline across a map (Step 6).
 *
 * Module scope, and exported, because it is not only a camera number: it is
 * the width of ground the player can actually see to draw a road in, and
 * `DEFAULT_DRAW_CLASS` is chosen against it. A test that pinned the default
 * class without being able to see this would be pinning a preference rather
 * than the reason for it.
 */
export const RIG_INITIAL_DISTANCE = 300

/**
 * The road class the draw tool starts in.
 *
 * Gravel, because its ~43m minimum corner radius is the only one that fits
 * inside the `RIG_INITIAL_DISTANCE` metres of ground the camera frames. A
 * corner needs its radius' worth of straight on each side of it, so the
 * shortest road with a bend in it is twice the corner radius: 87m for gravel,
 * but 504m for rural, 671m for arterial and 1121m for highway. Defaulting to
 * any of those three means the player's very first road — drawn, reasonably,
 * inside the part of the world they can see — is REFUSED, with a message
 * about curve overlap, before they have any idea that road class is a thing
 * they can change.
 *
 * Faster classes are drawn zoomed out, which is honest: a 252m-radius rural
 * road genuinely is a larger object than a farm track.
 */
export const DEFAULT_DRAW_CLASS: RoadClassName = 'gravel'

/**
 * Where the demo network's three arms meet — a T junction on the valley
 * floor, main road running east-west with a narrower gravel branch heading
 * north. Module scope (not local to `buildSceneContent`) because
 * `drawRoadScene` also needs it, to frame the camera rig on the same point
 * the network was actually built around rather than a second guess at it.
 */
const JUNCTION = vec2(900, 1280)

/**
 * Sweep one road's corridor into a shared excavation.
 *
 * This is the piece that was missing: without it, the solved design line
 * (correctly placed below natural ground through cuts) sits inside an
 * un-dug hill and only pokes through where it happens to break the surface.
 *
 * The walk itself — station stepping, transverse sampling, grid snapping —
 * lives in `terrain/excavation.ts`'s `sweepCorridor`, which is pure and
 * tested; this function just supplies this scene's per-road parameters
 * (pavement depth, batter template, spacing) and hands the result to a
 * `CorridorExcavation` the caller shares across every road, so an overlap
 * at a junction is arbitrated by nearest centreline rather than by whichever
 * road happened to sweep that node last.
 *
 * `spans` is required rather than defaulted: an empty list is a truthful
 * answer for a road with no bridges and a silent catastrophe for a road with
 * one (earthwork fills the valley the deck was meant to cross), and the two
 * must not be spelled the same way at the call site. The caller passes the
 * same list it gives `buildNetworkMesh`, so the abutment stands exactly where
 * the earthwork stops.
 *
 * Returns the stations it embanked higher than `MAX_FILL_HEIGHT` with nothing
 * carrying them — see `UnsupportedFill`. Empty for a road whose high runs all
 * became spans, which is most of them.
 */
const excavateCorridor = (
  into: CorridorExcavation,
  terrain: Heightmap,
  alignment: Alignment,
  profile: readonly ProfilePoint[],
  className: RoadClassName,
  spans: readonly StructureSpan[],
): UnsupportedFill[] => {
  if (alignment.isEmpty || profile.length === 0) return []

  const template = corridorTemplateFor(className)
  const maxSlope = Math.max(template.cutSlope, template.fillSlope)

  // The design profile is the top of the finished road (top of the wearing
  // course), not the terrain elevation the road should rest on. The terrain
  // under the road is the subgrade's underside — the design elevation less
  // the full pavement stack — plus a small margin against z-fighting. Using
  // an arbitrary clearance instead of this would either bury the pavement in
  // cut sections or leave it floating above the embankment in fill sections.
  const pavementDepth = totalPavementThickness(ROAD_CLASSES[className]) + EXCAVATION_ZFIGHT_MARGIN

  return sweepCorridor(
    {
      alignment,
      profile,
      terrain,
      template,
      pavementDepth,
      maxSlope,
      margin: EXCAVATION_MARGIN,
      stationSpacing: EXCAVATION_STATION_SPACING,
      transverseSpacing: terrain.cellSize,
      structureRanges: spans,
      maxFillHeight: MAX_FILL_HEIGHT,
    },
    into,
  )
}

/**
 * The widest this road's corridor sweep will ever fan, metres each side.
 *
 * Not an estimate. `sweepCorridor` computes exactly
 * `formationHalfWidth + maxSlope · depth + margin` at stations
 * `EXCAVATION_STATION_SPACING` apart, and this evaluates the same expression
 * at the same stations off the same profile, so its answer is a true upper
 * bound on how far sideways any sample of this road can land.
 *
 * The deck derivation needs that bound and not the formation width, because a
 * station outside the deck does not reach the road below through its
 * centreline — it reaches it through the transverse fan, and the fan is large:
 * at the ~6m of fill an overpass approach carries, a rural road's is nearly
 * 30m, six times its own formation half-width.
 *
 * Measured over the WHOLE road, not just near the crossing, because the
 * closed-form half-length below assumes a single fan width valid at every
 * station outside the deck. A bound taken over part of the road would not be
 * one.
 */
const maxSweptHalfWidth = (
  alignment: Alignment,
  design: readonly ProfilePoint[],
  terrain: Heightmap,
  className: RoadClassName,
): number => {
  const template = corridorTemplateFor(className)
  const maxSlope = Math.max(template.cutSlope, template.fillSlope)
  const pavementDepth = totalPavementThickness(ROAD_CLASSES[className]) + EXCAVATION_ZFIGHT_MARGIN

  const steps = Math.max(1, Math.ceil(alignment.length / EXCAVATION_STATION_SPACING))
  let widest = 0
  for (let i = 0; i <= steps; i++) {
    const s = Math.min(i * EXCAVATION_STATION_SPACING, alignment.length)
    const pose = alignment.poseAt(s)
    const groundZ = terrain.sample(pose.position.x, pose.position.y)
    const designZ = designElevationAtStation(design, s) - pavementDepth
    const half = template.formationHalfWidth + maxSlope * Math.abs(groundZ - designZ) + EXCAVATION_MARGIN
    if (half > widest) widest = half
  }
  return widest
}

/**
 * How much of the lifted road must be on a deck, measured each way from the
 * crossing, metres.
 *
 * The thing the deck has to achieve is not stated on the lifted road at all.
 * It is stated on the road BELOW: a band of half-width `clearHalfWidth`,
 * measured PERPENDICULAR TO THAT ROAD, into which no earthwork may fall. Those
 * two are the same interval only when the roads cross at 90°, which is why
 * taking the half-length straight from the lower road's width — as this used
 * to — is right at 90°, wrong at 45°, and catastrophically wrong below 20°.
 *
 * Put the lower road on the x-axis with the crossing at the origin, and let
 * the lifted road run at angle θ through it. A station `t` along the lifted
 * road sits at `(t·cos θ, t·sin θ)`; its transverse fan runs along
 * `(−sin θ, cos θ)` and reaches `sweptHalfWidth` each way. A sample at
 * transverse offset `u` therefore lands at
 *
 *     y = t·sin θ + u·cos θ
 *
 * and misses the band entirely when `|t|·sin θ − W·|cos θ| > B` for every
 * `|u| ≤ W`, i.e. when
 *
 *     |t| > (B + W·|cos θ|) / sin θ
 *
 * which is the half-length returned. At 90° the `cos θ` term vanishes and the
 * answer collapses to `B` — the old behaviour, and the reason the old code
 * looked correct in every test that had one. As `sin θ → 0` it diverges: two
 * nearly-parallel roads need a deck as long as the stretch over which they run
 * within a corridor width of each other, which is unbounded.
 *
 * Divergence is handled by clamping `sin θ` at `MIN_DECKABLE_CROSSING_ANGLE`
 * and saying so in the result. `|cos θ|` is left at the TRUE angle: clamping
 * it too would shrink the numerator at the same time as the denominator and
 * quietly cancel part of the error the clamp is meant to be honest about.
 */
const overpassDeckHalfLength = (
  clearHalfWidth: number,
  sweptHalfWidth: number,
  upperHeading: number,
  lowerHeading: number,
): { halfLength: number; requiredHalfLength: number; angle: number; clamped: boolean } => {
  const delta = upperHeading - lowerHeading
  // Undirected: a road crossing at 170° crosses at 10°, and which way each
  // alignment happens to have been drawn says nothing about the geometry.
  const angle = Math.atan2(Math.abs(Math.sin(delta)), Math.abs(Math.cos(delta)))
  const reach = clearHalfWidth + sweptHalfWidth * Math.abs(Math.cos(angle))

  const requiredHalfLength = reach / Math.sin(angle) + OVERPASS_DECK_MARGIN
  const clamped = angle < MIN_DECKABLE_CROSSING_ANGLE
  const halfLength = clamped
    ? reach / Math.sin(MIN_DECKABLE_CROSSING_ANGLE) + OVERPASS_DECK_MARGIN
    : requiredHalfLength

  return { halfLength, requiredHalfLength, angle, clamped }
}

/** Everything the scene draws, with no three.js anywhere in sight. */
export type SceneContent = {
  /** Natural ground, before any corridor excavation. */
  readonly terrain: Heightmap
  readonly network: RoadNetwork
  readonly designs: ReadonlyMap<RoadId, ProfilePoint[]>
  /** Natural ground plus every corridor's cut and fill. What gets drawn. */
  readonly editLayer: TerrainEditLayer
  readonly built: NetworkMesh
  /**
   * Roads in the network with no feasible vertical alignment, keyed to the
   * station along the alignment where the grade solve ran out of room.
   *
   * Such a road still exists in the graph — `commit` only validates
   * horizontal geometry, so it is already snappable, splittable and part of
   * every future junction solve — but has no entry in `designs`. Without a
   * design profile, `designElevationAtStation` (see `groundProfile.ts`)
   * treats it as flat at z=0, so `built.roads` still gets a mesh for it, just
   * a degenerate one sitting at absolute elevation zero — buried tens of
   * metres underground on terrain like this scene's, not because the road
   * has genuinely no geometry, but because nothing upstream noticed the
   * grade solve failed. Recorded here rather than left to that coincidence:
   * see `drawRoadScene`'s use of this for the console warning that
   * accompanies it.
   */
  readonly infeasibleRoads: ReadonlyMap<RoadId, number>
  /**
   * Crossings that had to become overpasses and could not be raised clear of
   * the road below within the grade limit.
   *
   * A separate channel from `infeasibleRoads` because it is a separate
   * failure: these roads grade perfectly well on their own terrain and only
   * run out of room once they have to climb over something. They get no
   * design profile either — building the crossing at grade instead would put
   * one road through another, which is the defect being fixed, so it is
   * reported rather than approximated.
   */
  readonly infeasibleCrossings: readonly InfeasibleCrossing[]
  /**
   * Overpasses whose crossing angle was too shallow to derive a deck for, and
   * which were therefore built on a deck clamped to
   * `MIN_DECKABLE_CROSSING_ANGLE`'s length.
   *
   * A third channel rather than a flavour of `infeasibleCrossings`, because
   * the outcome differs: these roads DO get a design profile and DO get built.
   * What they do not get is a deck long enough to keep their own earthwork off
   * the road below, so the crossing is knowingly wrong and the player has to
   * be told rather than left to spot the embankment lying across their road.
   */
  readonly shallowCrossings: readonly ShallowCrossing[]
  /**
   * Per road, the stations embanked higher than the fill allowance with no
   * structure carrying them.
   *
   * Console-only, like `built.tightCrossings` and `built.infeasibleJunctions`:
   * it is a defect in what was built rather than a refusal the player can act
   * on by drawing differently, and the message line is for the latter. What
   * matters is that it is not silent — see `UnsupportedFill` for why neither
   * building it nor the old skip is the right answer, and why the honest move
   * is to build the continuous thing and say so.
   */
  readonly unsupportedFill: ReadonlyMap<RoadId, readonly UnsupportedFill[]>
}

/** How far apart, along the alignment, the grade solve takes stations. */
const GRADE_STATION_SPACING = 10

/**
 * How much structure hangs below a road's design line where it is carried
 * over something, metres.
 *
 * The design line is the top of the wearing course; underneath it sits the
 * whole pavement stack, and underneath that the deck slab. Both numbers come
 * from the code that actually builds the deck (`buildBridgeMesh`'s
 * `deckClearance` default and `DECK_DEPTH`) rather than being restated here:
 * a second, independently-chosen deck thickness that drifted from the first
 * would put the modelled soffit somewhere other than where the clearance was
 * measured to, which is precisely the class of duplication this branch has
 * already had to remove once.
 */
const overpassStructureDepth = (className: RoadClassName): number =>
  totalPavementThickness(ROAD_CLASSES[className]) + DECK_DEPTH

/** Grade a single alignment against natural ground: the full solver result,
 * feasible or not, so a caller that needs to know why can see the station
 * where the solve ran out of room. `clearanceFloors` carries any grade
 * separation the alignment owes to roads it crosses (see `solveNetwork`). */
const solveGround = (
  ground: readonly ProfilePoint[],
  clearanceFloors: readonly ClearanceFloor[] = [],
): GradeSolution =>
  solveGradeProfile(ground, {
    maxGrade: MAX_GRADE,
    maxCutDepth: MAX_CUT_DEPTH,
    maxFillHeight: MAX_FILL_HEIGHT,
    maxStructureHeight: MAX_STRUCTURE_HEIGHT,
    clearanceFloors,
  })

const solveFor = (alignment: Alignment, terrain: Heightmap): GradeSolution =>
  solveGround(sampleGroundProfile(alignment, terrain, GRADE_STATION_SPACING))

/**
 * Clearance floors that force a profile at least `minimumElevation` high at
 * an arbitrary station — not just at the sampled stations either side of it.
 *
 * `solveGradeProfile` constrains stations, and a crossing lands wherever the
 * two alignments happen to meet, which is almost never on one. Flooring the
 * NEAREST station would leave the crossing itself up to half a station away
 * from where the clearance was enforced — on a 7% grade over this scene's 10m
 * spacing, up to 0.35m of clearance quietly missing from the one place it was
 * being measured. Flooring BOTH bracketing stations instead is exact: the
 * profile is piecewise linear between stations, so if both ends of the
 * interval clear the floor, every point inside it does too, the crossing
 * included.
 *
 * It does ask for slightly more than the minimum — the road holds that height
 * across the whole 10m interval rather than at one point in it. That is the
 * direction to err in: the alternative rounds a hard clearance requirement
 * down, and the excess is well under a metre of extra climb against a 5m
 * clearance.
 */
const clearanceFloorsAt = (
  ground: readonly ProfilePoint[],
  station: number,
  minimumElevation: number,
): ClearanceFloor[] => {
  if (ground.length === 0) return []

  const floorAt = (i: number): ClearanceFloor => ({ station: ground[i]!.s, minimumElevation })

  const first = ground[0]!
  const last = ground[ground.length - 1]!
  if (station <= first.s + STATION_TOLERANCE) return [floorAt(0)]
  if (station >= last.s - STATION_TOLERANCE) return [floorAt(ground.length - 1)]

  for (let i = 1; i < ground.length; i++) {
    const previous = ground[i - 1]!
    const current = ground[i]!
    if (station > current.s) continue
    // Exactly on a station: one floor, not two. Flooring its neighbour as
    // well would hold the road up for a further station in one direction for
    // no reason at all.
    if (Math.abs(station - current.s) <= STATION_TOLERANCE) return [floorAt(i)]
    if (Math.abs(station - previous.s) <= STATION_TOLERANCE) return [floorAt(i - 1)]
    return [floorAt(i - 1), floorAt(i)]
  }

  return [floorAt(ground.length - 1)]
}

/**
 * Regrade every road in a network, excavate every corridor onto a fresh edit
 * layer, and rebuild every mesh.
 *
 * Used both to build the initial demo scene and to rebuild after the drawing
 * tool commits a road: the least-risk way to keep a mutated network's meshes
 * in sync with it is to regenerate everything from scratch rather than patch
 * around the edges.
 *
 * Known limitation: this redoes work for roads the edit did not touch.
 * Correct, and slow once the network is large — measure before making it
 * incremental.
 *
 * ## Grade separation
 *
 * Two roads that cross in plan without sharing a node are not a junction —
 * the player never clicked where they meet — so they must not be built
 * through each other. The road drawn LATER is raised over the earlier one,
 * always, and the earlier one's profile is never touched. That direction is
 * not a preference:
 *
 * - Mutating an existing road's vertical profile would invalidate its
 *   structures, its mesh and every road tied to its endpoints — a far larger
 *   blast radius, and one whose result would depend on the order roads
 *   happened to be drawn in.
 * - Lifting only the new road keeps the dependency a strict order: a road is
 *   solved against the FINAL profiles of every road older than it and against
 *   nothing else, so there is no cycle to iterate and no fixed point to
 *   converge on. Roads are re-solved in ascending id here for exactly that
 *   reason.
 * - It is predictable for the player: the road you are drawing is the road
 *   that goes over.
 *
 * The lift is a constraint on the grade solve, not a lift applied to its
 * answer — see the phase 1 comment in `gradeSolver.ts`. An overpass that
 * cannot be climbed to within the grade limit therefore comes back as an
 * infeasible solve and lands in `infeasibleCrossings`, rather than as a
 * profile that reaches the clearance by way of a grade the class forbids.
 *
 * Known limitation, and it is not rare. "Age" here is the road id, and
 * `splitRoad` allocates BOTH halves of a split road ids above every road that
 * already exists. Splitting a road therefore makes both of its halves the
 * newest roads in the network — younger than anything that was ever built
 * over it — and any crossing on either half reverses. Nothing about the split
 * has to be anywhere near the crossing for this to happen.
 *
 * Three clicks reach it, and the third is an ordinary thing to do:
 *
 *   1. Draw road A, east-west.
 *   2. Draw road C across it. C is newer, so C is lifted over A: measured on
 *      flat ground at 100m, C sits at 106.70 at the crossing and A stays at
 *      100.00.
 *   3. Draw road D ending ON A, anywhere — `DrawTool.commit` splits A there to
 *      make the junction. Two hundred metres from the crossing is enough.
 *
 * On the next solve the half of A carrying the crossing is the newer road, so
 * it is the one lifted: measured, A's half comes back at 106.70 and C drops to
 * 100.00. An already-built overpass visibly inverts because the player made a
 * junction somewhere else on the road underneath it.
 *
 * Everything above this paragraph is still true — the solve is still a strict
 * order with no cycle to iterate, and it is still deterministic. What is not
 * true is that the road which moves is the road most recently drawn. Fixing
 * that wants creation provenance on `Road`, separate from the id, which is a
 * graph change rather than a scene one; until then this is documented rather
 * than papered over, and pinned by a test in `roadScene.test.ts` so the
 * description cannot quietly stop matching the behaviour.
 */
export const solveNetwork = (
  terrain: Heightmap,
  network: RoadNetwork,
): {
  designs: Map<RoadId, ProfilePoint[]>
  editLayer: TerrainEditLayer
  built: NetworkMesh
  /**
   * Where each road is carried on a structure rather than on earth.
   *
   * Returned rather than kept private because it is the one output that says
   * whether the overpass mechanism actually fired: a lifted road whose deck
   * was never forced looks identical in `designs` (the lift is there) and
   * differs only here and in the earthworks that follow from here.
   */
  spans: Map<RoadId, readonly StructureSpan[]>
  infeasibleRoads: Map<RoadId, number>
  infeasibleCrossings: InfeasibleCrossing[]
  shallowCrossings: ShallowCrossing[]
  unsupportedFill: Map<RoadId, readonly UnsupportedFill[]>
} => {
  // --- Pass 1: grade every road on its own, ignoring the others ------------
  //
  // Provisional, because a road that crosses an older one is about to be
  // re-solved with a clearance floor on it. Needed first all the same:
  // `findCrossings` will not report a pair unless both roads have a design
  // profile to measure a gap between.
  const provisional = new Map<RoadId, ProfilePoint[]>()
  const infeasibleRoads = new Map<RoadId, number>()
  for (const road of network.roads) {
    const solution = solveFor(road.alignment, terrain)
    if (solution.feasible) {
      provisional.set(road.id, solution.profile)
    } else {
      infeasibleRoads.set(road.id, solution.failedAtStation)
    }
  }

  // --- Pass 2: which crossings are junctions and which are overpasses ------
  //
  // The placed points a crossing is classified against are the network's own
  // node positions. After `DrawTool.commit` that is exactly what a placed
  // point has become: a point clicked on an existing road splits it and
  // becomes a node shared by both, and a point clicked anywhere else becomes
  // a node of the new road alone. Nothing else survives a commit, and nothing
  // else needs to — the scene does not have to be handed the tool's gesture
  // state to know where the player clicked, because the graph already
  // records it.
  //
  // `NODE_SNAP_DISTANCE` is the tolerance for the same reason `findCrossings`
  // already uses it for its own shared-node exclusion: a crossing position is
  // found by intersecting 5m-sampled polylines, so it carries that sampling's
  // error and cannot be compared to a click position at millimetre precision.
  //
  // Crossings that classify as intersections are left entirely alone. Those
  // are either junctions that already work — `findCrossings` drops crossings
  // at a SHARED node before this ever sees them — or a road terminating on
  // another one that `commit` did not split, which wants a junction and
  // certainly does not want to be raised five metres into the air. The latter
  // stays visible: it is a genuine at-grade collision, and it is what
  // `built.tightCrossings` now exists to report.
  const nodePositions = network.nodes.map((node) => node.position)

  /** Per road, what it must clear: always roads older than itself. */
  const overpasses = new Map<
    RoadId,
    { under: RoadId; station: number; underStation: number }[]
  >()

  for (const crossing of findCrossings(network, provisional)) {
    if (classifyCrossing(crossing, nodePositions, NODE_SNAP_DISTANCE) === 'intersection') continue

    // Newer road over older, by id — NOT by `findCrossings`' own upper/lower,
    // which only says which design line happens to sit higher at grade and
    // would hand the lift to whichever road the terrain favoured.
    const newer = Math.max(crossing.upper, crossing.lower)
    const older = Math.min(crossing.upper, crossing.lower)
    const newerStation = newer === crossing.upper ? crossing.upperStation : crossing.lowerStation
    const olderStation = older === crossing.upper ? crossing.upperStation : crossing.lowerStation

    const list = overpasses.get(newer) ?? []
    list.push({ under: older, station: newerStation, underStation: olderStation })
    overpasses.set(newer, list)
  }

  // --- Pass 3: re-solve, oldest first, with the clearances owed ------------
  //
  // Ascending id, so by the time a road is solved every road it has to clear
  // already holds its final profile. Nothing here is iterated to a fixed
  // point because nothing needs to be: lifting a road never moves anything
  // older than it.
  const designs = new Map<RoadId, ProfilePoint[]>()
  const infeasibleCrossings: InfeasibleCrossing[] = []
  const shallowCrossings: ShallowCrossing[] = []
  /** Station ranges each road must be decked over to clear another road. */
  const liftedRanges = new Map<RoadId, { fromStation: number; toStation: number }[]>()

  for (const road of [...network.roads].sort((a, b) => a.id - b.id)) {
    const unlifted = provisional.get(road.id)
    if (!unlifted) continue // already in `infeasibleRoads`

    const required = overpasses.get(road.id) ?? []
    if (required.length === 0) {
      designs.set(road.id, unlifted)
      continue
    }

    const ground = sampleGroundProfile(road.alignment, terrain, GRADE_STATION_SPACING)
    const structureDepth = overpassStructureDepth(road.className)
    const floors: ClearanceFloor[] = []
    const wanted: {
      under: RoadId
      station: number
      underStation: number
      requiredElevation: number
    }[] = []

    for (const crossing of required) {
      const under = designs.get(crossing.under)
      // The road below never graded, so it has no design line to clear. It is
      // already reported in `infeasibleRoads`; inventing a clearance against
      // `designElevationAtStation`'s zero-for-empty answer would fabricate a
      // requirement out of missing information.
      if (!under) continue

      // Top of the wearing course of the road above = the road below, plus
      // the clearance a lorry needs, plus everything hanging under this
      // road's own design line to hold it up.
      const requiredElevation =
        designElevationAtStation(under, crossing.underStation) +
        MIN_OVERPASS_CLEARANCE +
        structureDepth

      floors.push(...clearanceFloorsAt(ground, crossing.station, requiredElevation))
      wanted.push({
        under: crossing.under,
        station: crossing.station,
        underStation: crossing.underStation,
        requiredElevation,
      })
    }

    const solution = solveGround(ground, floors)
    if (solution.feasible) {
      designs.set(road.id, solution.profile)

      // --- How much of this road has to be on a deck ------------------------
      //
      // Derived from the SOLVED profile, not from the provisional one: how far
      // sideways this road's corridor fans is a function of how high the lift
      // left it standing over its own ground, and that is not known until the
      // lift has been solved.
      //
      // A deck only as long as the clearance floors would be five or ten
      // metres — narrower than the corridor it is bridging, and below
      // `MIN_SPAN_LENGTH`, so it would be discarded and the embankment built
      // anyway. But a deck as long as the road below is WIDE is not enough
      // either: that is a station interval measured on this road, and what has
      // to be kept clear is a band measured perpendicular to the other one.
      // The two coincide only at 90°. See `overpassDeckHalfLength`.
      const sweptHalfWidth = maxSweptHalfWidth(
        road.alignment, solution.profile, terrain, road.className,
      )
      const deckRanges: { fromStation: number; toStation: number }[] = []

      for (const w of wanted) {
        const underRoad = network.road(w.under)
        // The band to keep clear is the road BELOW's own corridor: its
        // formation, plus the batter run that stands beside it before a
        // retaining wall takes over. Its own class, not this road's.
        const clearHalfWidth =
          formationHalfWidth(ROAD_CLASSES[underRoad.className]) + CORRIDOR_MAX_BATTER_WIDTH

        const deck = overpassDeckHalfLength(
          clearHalfWidth,
          sweptHalfWidth,
          road.alignment.poseAt(w.station).heading,
          underRoad.alignment.poseAt(w.underStation).heading,
        )

        if (deck.clamped) {
          shallowCrossings.push({
            road: road.id,
            crosses: w.under,
            station: w.station,
            angle: deck.angle,
            deckHalfLength: deck.halfLength,
            requiredHalfLength: deck.requiredHalfLength,
          })
        }

        deckRanges.push({
          fromStation: w.station - deck.halfLength,
          toStation: w.station + deck.halfLength,
        })
      }

      // The stretches this road must be decked over, remembered so the span
      // derivation can force them onto a structure. Without this the lift
      // succeeds, the design lines separate correctly, and the corridor sweep
      // then fills an embankment across the road underneath — because a lift
      // of five metres' clearance plus the deck is still under
      // `MAX_FILL_HEIGHT`, so height alone reads it as earthwork. See
      // `RoadSpanInputs.requiredStructureRanges`.
      liftedRanges.set(road.id, deckRanges)
      continue
    }

    // No design profile, deliberately. Falling back to the unlifted solve
    // would build this road straight through the one underneath it, which is
    // the whole defect; every crossing the solve was carrying is reported
    // instead, because a single failed solve does not say which of them was
    // the impossible one.
    for (const w of wanted) {
      infeasibleCrossings.push({
        road: road.id,
        crosses: w.under,
        station: w.station,
        requiredElevation: w.requiredElevation,
        failedAtStation: solution.failedAtStation,
      })
    }
  }

  // Where each road is carried on a structure rather than on earth — derived
  // BEFORE any excavation, because the earthworks need it. Structures are
  // measured against NATURAL ground, which is why this can run first at all:
  // spans are a function of the alignment, the solved design line and the
  // untouched terrain, and never of the excavation's own output. (Measuring
  // them against the edit layer would not merely be circular, it would find
  // nothing: cut and filled to the design surface, every station reads as
  // level and neither the bridge nor the wall trigger could fire.)
  //
  // The list built here is handed to BOTH consumers — the sweep below and
  // `buildNetworkMesh` — rather than derived twice. Two independent
  // derivations is exactly the defect being fixed: the earthworks stopped
  // where a per-station fill test tripped (stations 280-420) while the span,
  // abutments included, ran 273-423, leaving a bare terrain cliff and an
  // unsupported notch in the seven stations at each end where the two
  // disagreed.
  const spans = networkStructureSpans(network.roads, {
    designs,
    terrain,
    maxFillHeight: MAX_FILL_HEIGHT,
    spacing: STRUCTURE_STATION_SPACING,
    requiredStructureRanges: liftedRanges,
  })

  // Excavate the terrain down to every road's design line before anything is
  // rendered, so each road sits in a real cutting/embankment rather than
  // buried inside (or floating above) untouched ground. Every road sweeps
  // into the SAME `CorridorExcavation`, and it is applied to the edit layer
  // only once every road has been swept — a node inside two overlapping
  // corridors is arbitrated by nearest centreline regardless of which road
  // was swept first. Building one excavation per road instead would
  // reproduce the last-write-wins bug this replaced: whichever road's
  // `applyTo` ran last would erase any earlier road's cut wherever their
  // footprints overlapped.
  const editLayer = new TerrainEditLayer(terrain)
  const excavation = new CorridorExcavation(terrain.cols, terrain.rows)
  const unsupportedFill = new Map<RoadId, readonly UnsupportedFill[]>()
  for (const road of network.roads) {
    const design = designs.get(road.id)
    // No design profile means the grade solve failed; that road is already
    // recorded in `infeasibleRoads` above. Nothing is swept for it and no
    // spans are claimed on its behalf — there is no design line to measure
    // either against ground.
    if (!design || design.length === 0) continue

    // The very list `buildNetworkMesh` is handed below — read out of the same
    // map, not derived a second time. That is the whole point of `spans`
    // existing above rather than being computed at each of the two places it
    // is needed.
    const unsupported = excavateCorridor(
      excavation, terrain, road.alignment, design, road.className, spans.get(road.id) ?? [],
    )
    if (unsupported.length > 0) unsupportedFill.set(road.id, unsupported)
  }
  excavation.applyTo(editLayer)

  // Structures are measured against NATURAL ground, not the edit layer — see
  // the spans comment above. `spans` is passed rather than left to be
  // recomputed here so the deck and its abutments land on precisely the
  // ground the sweep above left unexcavated for them.
  const built = buildNetworkMesh(network, designs, {
    spacing: STRUCTURE_STATION_SPACING,
    terrain,
    maxFillHeight: MAX_FILL_HEIGHT,
    corridorBatters: CORRIDOR_BATTERS,
    structureSpans: spans,
  })

  return {
    designs, editLayer, built, spans,
    infeasibleRoads, infeasibleCrossings, shallowCrossings, unsupportedFill,
  }
}

/**
 * Terrain, roads, earthworks and meshes for the demo scene.
 *
 * Split out from `drawRoadScene` so the scene's parameters can be asserted
 * against without a WebGL context. The bar those assertions hold is that this
 * scene actually exercises the structures pipeline: a demo whose constants
 * make every trigger unreachable looks exactly like one that works.
 */
export const buildSceneContent = (): SceneContent => {
  // Fine enough that the excavated corridor (a 10m-wide formation) isn't lost
  // between grid nodes: at the original 20m cellSize, a single cell spans the
  // whole formation width plus both batters, so the cut/fill dissolves into
  // the surrounding terrain's own noise instead of reading as an engineered
  // surface. Same 2560m footprint as before, just twice the density.
  const terrain = generateValley({
    cols: 257, rows: 257, cellSize: 10,
    floorElevation: 100, ridgeHeight: 70, valleyHalfWidth: 400, seed: 7,
  })

  // A T junction on the valley floor: a main road running east-west with a
  // narrower gravel branch heading north. Three straight roads meeting at one
  // point, which is exactly what a junction needs and nothing more.
  //
  // All three alignments are built starting FROM the junction rather than
  // arriving at it. `solveGradeProfile`'s forward greedy sweep pins station 0
  // to natural ground but can drift away from it by the far end of a long
  // alignment (the terrain here is rough enough that it does): starting every
  // leg at the junction means every leg's own elevation there is natural
  // ground, so the three legs agree and the junction sits flush without
  // needing `elevationMismatches` to paper over a drifted arrival station.
  const network = new RoadNetwork()

  // West and east arms both start at the junction, heading opposite ways
  // along the valley; the branch starts there too, heading north.
  const westArm = new Alignment([new Line(JUNCTION, Math.PI, 750)])
  const eastArm = new Alignment([new Line(JUNCTION, 0, 750)])
  const branch = new Alignment([new Line(JUNCTION, Math.PI / 2, 300)])

  const arms: [Alignment, 'rural' | 'gravel'][] = [
    [westArm, 'rural'], [eastArm, 'rural'], [branch, 'gravel'],
  ]

  // Only roads that grade feasibly join the demo network — an infeasible arm
  // would otherwise sit in the network with no design profile and an empty
  // mesh, which is not what this fixed demo layout wants.
  for (const [alignment, className] of arms) {
    if (!solveFor(alignment, terrain).feasible) continue
    network.addRoad(alignment, className)
  }

  const {
    designs, editLayer, built,
    infeasibleRoads, infeasibleCrossings, shallowCrossings, unsupportedFill,
  } = solveNetwork(terrain, network)
  return {
    terrain, network, designs, editLayer, built,
    infeasibleRoads, infeasibleCrossings, shallowCrossings, unsupportedFill,
  }
}

/** A sphere in the project's own convention (`(x, y)` ground, `z` up) that
 * encloses a terrain's full footprint and elevation range. */
export type TerrainBounds = {
  readonly centerX: number
  readonly centerY: number
  readonly centerZ: number
  readonly radius: number
}

/**
 * The bounding sphere of a heightmap — its footprint (from `originX`/`originY`
 * out to `width`/`height`) and the full spread of its own elevations.
 *
 * Exists to size the sun's shadow camera (see `drawRoadScene`): a
 * `DirectionalLight`'s shadow is an orthographic camera whose default frustum
 * is a couple of units across, which on terrain at this scene's scale
 * produces either no shadows at all or a small square of them near the
 * origin. A pure function of the terrain rather than a number picked by eye,
 * so it stays correct if the demo terrain's footprint or relief ever changes.
 * No three.js in sight, so it is testable without a renderer.
 */
export const terrainBounds = (terrain: Heightmap): TerrainBounds => {
  let minZ = Infinity
  let maxZ = -Infinity
  for (const z of terrain.elevations) {
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }

  const centerX = terrain.originX + terrain.width / 2
  const centerY = terrain.originY + terrain.height / 2
  const centerZ = (minZ + maxZ) / 2
  const halfElevation = (maxZ - minZ) / 2

  return {
    centerX,
    centerY,
    centerZ,
    radius: Math.hypot(terrain.width / 2, terrain.height / 2, halfElevation),
  }
}

/**
 * Per-vertex colour for the terrain mesh, RGB triples in `terrainGeometry`'s
 * own (row-major, step-1) vertex order.
 *
 * Undisturbed ground gets `surfaceFor('terrain')`'s colour; anywhere the edit
 * layer has moved the ground from its natural elevation — the whole excavated
 * corridor, batters included, not just where a road's ribbon sits — gets
 * `surfaceFor('cutFace')`'s instead. Terrain and cut face share the same
 * roughness and metalness (see `materials.ts`), so a single material with
 * vertex colours carries the whole distinction; there is no second mesh here
 * to give a different material to.
 *
 * Deliberately not built inside `terrainGeometry` itself: walking the same
 * grid a second time here, rather than threading a colour concern into that
 * function, keeps `terrainGeometry` free of anything but position/normal/uv,
 * at the cost of repeating its (col, row) -> vertex-index walk. Must be
 * called with `step = 1`, matching how `drawRoadScene` builds the geometry —
 * a different step would desync the two vertex orderings.
 */
const terrainVertexColours = (terrain: Heightmap, editLayer: TerrainEditLayer): Float32Array => {
  const terrainColour = new THREE.Color(surfaceFor('terrain').colour)
  const cutColour = new THREE.Color(surfaceFor('cutFace').colour)
  const colours = new Float32Array(terrain.cols * terrain.rows * 3)

  for (let row = 0; row < terrain.rows; row++) {
    for (let col = 0; col < terrain.cols; col++) {
      const cut = editLayer.deltaAt(col, row) !== 0
      const colour = cut ? cutColour : terrainColour
      const i = (row * terrain.cols + col) * 3
      colours[i] = colour.r
      colours[i + 1] = colour.g
      colours[i + 2] = colour.b
    }
  }

  return colours
}

/**
 * Add every mesh for a built network — pavement layers, junctions,
 * structures and the terrain surface — to a scene, and return them so the
 * caller can remove and dispose them later (see `disposeMesh`).
 *
 * Also logs the same warnings the scene has always logged: infeasible
 * junctions, elevation mismatches and tight crossings — plus, now, roads
 * with no feasible vertical alignment at all (see `SceneContent.infeasibleRoads`).
 */
/**
 * Depth-test rank for the pavement stack, top layer first.
 *
 * The three layers are separately-built meshes stacked over an identical
 * footprint, and the gap between them is the layer thickness itself — five
 * centimetres between wearing course and base on the thinner classes.
 * Nothing else in the scene separates coplanar surfaces, and depth-buffer
 * resolution is not a constant: with `near = 1` and `far = 6000` it is about
 * five millimetres at the default framing, but roughly sixty at a kilometre
 * out. So the stack holds together close in and the base begins punching
 * through the seal as the player zooms away — a defect that only appears at
 * the range where it is least likely to be tested.
 *
 * `polygonOffset` fixes it in depth rather than in geometry: each lower layer
 * is pushed further from the camera by its rank, so a lower layer can never
 * win the depth test against the one sealing it, at any distance. Raising the
 * layers apart in world space would have worked too and been wrong — the
 * thicknesses are real pavement dimensions that the cut-and-fill volumes and
 * the excavation depth are both computed from.
 *
 * Keyed by `LayerName` rather than `string` so that adding a fourth layer is
 * a type error here instead of a silently-zero rank at runtime.
 */
const PAVEMENT_DEPTH_RANK: Record<LayerName, number> = {
  wearing: 0,
  base: 1,
  subgrade: 2,
}

const addNetworkMeshes = (
  scene: THREE.Scene,
  terrain: Heightmap,
  editLayer: TerrainEditLayer,
  built: NetworkMesh,
  infeasibleRoads: ReadonlyMap<RoadId, number>,
  infeasibleCrossings: readonly InfeasibleCrossing[],
  shallowCrossings: readonly ShallowCrossing[],
  unsupportedFill: ReadonlyMap<RoadId, readonly UnsupportedFill[]>,
): THREE.Mesh[] => {
  const meshes: THREE.Mesh[] = []

  if (infeasibleRoads.size > 0) {
    // A road that fails to grade still commits — `DrawTool.commit` validates
    // only horizontal geometry — so without this it sits in the network,
    // snappable and splittable, its mesh flattened to elevation zero (see
    // `SceneContent.infeasibleRoads`) and buried out of sight with nothing
    // said about it anywhere. Reported here rather than refused at commit
    // time: see the fix-wave report for why (the commit path would
    // otherwise need terrain).
    console.warn(
      'roads with no feasible vertical alignment (committed to the graph, mesh flattened to z=0):',
      [...infeasibleRoads.entries()],
    )
  }

  if (infeasibleCrossings.length > 0) {
    // Distinct from the warning above: these roads grade fine on their own
    // and only fail once they have to climb over something. They have no
    // design profile either — see `SceneContent.infeasibleCrossings` for why
    // building them at grade instead is not an option.
    console.warn(
      'crossings that could not be raised clear of the road below (no design profile built):',
      infeasibleCrossings,
    )
  }

  if (shallowCrossings.length > 0) {
    // Distinct again from both warnings above: these roads graded, got their
    // lift, and got a deck — just not a long enough one, because the angle
    // they cross at asks for a deck that grows without bound (see
    // `MIN_DECKABLE_CROSSING_ANGLE`). An error rather than a warning: the
    // earthwork the short deck fails to hold back lands on the road below,
    // which is the defect this whole path exists to prevent.
    console.error(
      'crossings too shallow to deck honestly — the deck was clamped, so the lifted ' +
        "road's earthwork is no longer held clear of the road below's corridor:",
      shallowCrossings,
    )
  }

  if (unsupportedFill.size > 0) {
    // A high run too short to become a span leaves nothing to suppress the
    // embankment, so the sweep builds one past the declared fill allowance —
    // 16.40m of it against a 10m allowance on a 20m notch. The old code
    // skipped those stations instead and left an unsupported hole in the
    // road; neither is right, so the continuous one is built and reported
    // rather than one of the two being chosen quietly. See `UnsupportedFill`.
    console.error(
      'earthwork embanked above the fill allowance with no structure under it:',
      [...unsupportedFill.entries()],
    )
  }

  // Road and junction surfaces receive the sun's shadow (from terrain, from
  // structures, from each other at a junction) as well as casting it — a
  // ribbon in the shade of a cutting is exactly what a raised, low-sun view
  // should show.
  for (const [, roadMesh] of built.roads) {
    for (const layer of roadMesh.layers) {
      if (layer.mesh.vertexCount === 0) continue
      const surface = surfaceFor(layer.name)
      const mesh = new THREE.Mesh(
        toBufferGeometry(layer.mesh),
        new THREE.MeshStandardMaterial({
          color: surface.colour,
          roughness: surface.roughness,
          metalness: surface.metalness,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: PAVEMENT_DEPTH_RANK[layer.name],
          polygonOffsetUnits: PAVEMENT_DEPTH_RANK[layer.name],
        }),
      )
      mesh.castShadow = true
      mesh.receiveShadow = true
      scene.add(mesh)
      meshes.push(mesh)
    }
  }

  for (const [, junctionMesh] of built.junctions) {
    if (junctionMesh.vertexCount === 0) continue
    // A junction plate is the same sealed surface as the wearing course it
    // joins, not a fourth material of its own.
    const surface = surfaceFor('wearing')
    const mesh = new THREE.Mesh(
      toBufferGeometry(junctionMesh),
      new THREE.MeshStandardMaterial({
        color: surface.colour,
        roughness: surface.roughness,
        metalness: surface.metalness,
        side: THREE.DoubleSide,
      }),
    )
    mesh.castShadow = true
    mesh.receiveShadow = true
    scene.add(mesh)
    meshes.push(mesh)
  }

  if (built.infeasibleJunctions.size > 0) {
    console.warn('infeasible junctions', [...built.infeasibleJunctions.entries()])
  }
  if (built.elevationMismatches.size > 0) {
    console.warn('junction elevation mismatches', [...built.elevationMismatches.entries()])
  }

  for (const [, structureMesh] of built.structures) {
    if (structureMesh.vertexCount === 0) continue
    // Bridge decks, abutments, piers and retaining walls are all structural
    // concrete — one material, distinct from every pavement layer and from
    // the terrain, so a structure reads as a different kind of thing rather
    // than an odd-coloured road.
    const surface = surfaceFor('concrete')
    const mesh = new THREE.Mesh(
      toBufferGeometry(structureMesh),
      new THREE.MeshStandardMaterial({
        color: surface.colour,
        roughness: surface.roughness,
        metalness: surface.metalness,
        side: THREE.DoubleSide,
      }),
    )
    mesh.castShadow = true
    scene.add(mesh)
    meshes.push(mesh)
  }

  if (built.tightCrossings.size > 0) {
    // This used to be routine noise: crossings were detected, logged, and
    // built through each other anyway. Now `solveNetwork` raises every
    // crossing it classifies as an overpass, and refuses to build a road
    // whose lift it cannot solve, so anything still arriving here is one of
    // exactly two things — a road terminating on another that `commit` did
    // not split into a junction (classified `'intersection'`, so deliberately
    // not lifted, and genuinely colliding), or a crossing the lift was
    // applied to and failed to separate. Both are defects rather than
    // observations, which is why this is an error and not a warning.
    console.error(
      'crossings still below minimum clearance after grade separation — ' +
        'either a road terminates on another without a junction, or a lift did not take:',
      [...built.tightCrossings.entries()],
    )
  }

  // Vertex-coloured rather than a flat tint: the excavated corridor (see
  // `terrainVertexColours`) is a different surface from undisturbed ground,
  // not just a different shade of the same one. Terrain and cut face share a
  // roughness and metalness (see `materials.ts`), so those two properties are
  // still uniform across the mesh — only colour varies per vertex.
  const terrainSurface = surfaceFor('terrain')
  const terrainMesh = new THREE.Mesh(
    terrainGeometry(terrain, 1, editLayer),
    // DoubleSide: the raised camera can look down on the terrain from angles
    // a near-level fixed camera never reached, and the grid winding culls as
    // back-facing from directly above without this.
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: terrainSurface.roughness,
      metalness: terrainSurface.metalness,
      flatShading: false,
      side: THREE.DoubleSide,
    }),
  )
  terrainMesh.geometry.setAttribute(
    'color',
    new THREE.BufferAttribute(terrainVertexColours(terrain, editLayer), 3),
  )
  terrainMesh.castShadow = true
  terrainMesh.receiveShadow = true
  scene.add(terrainMesh)
  meshes.push(terrainMesh)

  return meshes
}

/**
 * Dispose a mesh's geometry and material(s).
 *
 * Called before removing a stale mesh from the scene, so rebuilding on every
 * commit does not leak GPU memory for as long as the player keeps drawing
 * roads.
 */
const disposeMesh = (mesh: THREE.Mesh): void => {
  mesh.geometry.dispose()
  if (Array.isArray(mesh.material)) {
    for (const material of mesh.material) material.dispose()
  } else {
    mesh.material.dispose()
  }
}

/** The two things a player can be doing. Tab switches between them; see
 * `switchToolMode`. */
type ToolMode = 'draw' | 'select'

export const drawRoadScene = (canvas: HTMLCanvasElement): (() => void) => {
  // --- Message line --------------------------------------------------------
  //
  // A single absolutely-positioned element next to the canvas — not the
  // inspector panel (a later plan), just enough that the current mode and
  // the outcome of the last action are never silent. Appended to the
  // canvas's own parent so it sits over the same positioned box the canvas
  // fills, rather than assuming anything about the page around it.
  const messageHost = canvas.parentElement ?? document.body
  const messageEl = document.createElement('div')
  messageEl.style.position = 'absolute'
  messageEl.style.left = '12px'
  messageEl.style.top = '12px'
  messageEl.style.padding = '4px 10px'
  messageEl.style.borderRadius = '4px'
  messageEl.style.font = '13px/1.4 ui-sans-serif, system-ui, sans-serif'
  messageEl.style.pointerEvents = 'none'
  messageEl.style.whiteSpace = 'pre'
  messageHost.appendChild(messageEl)

  const modeLabel = (toolMode: ToolMode): string => (toolMode === 'draw' ? 'Draw' : 'Select')

  /**
   * Set the message line's text, always prefixed with the current mode so the
   * tool is never silently in a state the player did not choose (§Step 1/2).
   * A refusal gets a visibly different look from a confirmation or the bare
   * mode label.
   */
  const setMessage = (detail: string, kind: 'info' | 'refusal' = 'info'): void => {
    messageEl.textContent = detail ? `${modeLabel(toolMode)} — ${detail}` : modeLabel(toolMode)
    if (kind === 'refusal') {
      messageEl.style.background = 'rgba(140, 30, 30, 0.85)'
      messageEl.style.color = '#ffdede'
    } else {
      messageEl.style.background = 'rgba(20, 24, 29, 0.75)'
      messageEl.style.color = '#e8e4dc'
    }
  }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setClearColor(0x14181d)

  // ACES Filmic is what turns a bright sun into a scene instead of a clipped
  // white wash — without it a physically-lit sun blows every surface it
  // touches straight to (1,1,1) and the render reads like a screenshot of a
  // spreadsheet. `outputColorSpace` is left alone rather than set blindly:
  // three 0.185's `WebGLRenderer` already defaults it to `SRGBColorSpace`
  // (confirmed by reading `WebGLRenderer.js`'s constructor), so setting it
  // again here would only restate the default — but it is restated anyway,
  // as a visible assertion of that fact rather than a silent reliance on it,
  // so a future three.js version that changed the default would show up here
  // as an explicit line rather than a quietly different render.
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1
  renderer.outputColorSpace = THREE.SRGBColorSpace

  // A model lit by a single directional sun wants a real shadow, not a flat
  // unlit render.
  renderer.shadowMap.enabled = true
  // Not PCFSoftShadowMap: it is deprecated in three 0.185 and silently falls
  // back to PCFShadowMap with a console warning on every compile, so this
  // asks for what is actually going to be used (a filtered, though not
  // softened, PCF shadow) rather than for a soft filter that is not.
  renderer.shadowMap.type = THREE.PCFShadowMap

  const scene = new THREE.Scene()
  // No fog: depth of field (the tilt-shift pass, below) already tells the eye
  // what is near and what is far. Fog on top of that reads as neither — two
  // different ways of saying "distance" competing with each other rather than
  // one clear one.

  const camera = new THREE.PerspectiveCamera(45, 1, 1, 6000)

  /** Project convention `(x, y, z)`, `z` up, to three.js's `(x, z, -y)`. Must
   * stay the exact inverse of `threeToProject` below. Takes the camera rig's
   * own `Vec3` — this is only ever called with `rig.position`/`rig.target` —
   * and, being a linear (origin-preserving) map, is reused as-is to convert
   * the sun's direction vector too. */
  const toThreePosition = (p: RigVec3): THREE.Vector3 => new THREE.Vector3(p.x, p.z, -p.y)

  /** three.js's `(x, y, z)` back to the project's `(x, y, z)`, `z` up. The
   * inverse of `meshAdapter.ts`'s `(x, y, z) -> (x, z, -y)`: three.x = x,
   * three.y = z, three.z = -y, so x = three.x, z = three.y, y = -three.z.
   * Returns the ground-cast's own `Vec3` — this only ever feeds `Ray3`. */
  const threeToProject = (v: THREE.Vector3): GroundVec3 => ({
    x: v.x,
    y: -v.z,
    z: v.y,
  })

  const content = buildSceneContent()
  const { terrain, network } = content
  let editLayer = content.editLayer
  let built = content.built
  let infeasibleRoads = content.infeasibleRoads
  let infeasibleCrossings = content.infeasibleCrossings
  let shallowCrossings = content.shallowCrossings
  let unsupportedFill = content.unsupportedFill
  let terrainSampler: TerrainSampler = editLayer

  // --- Sun and fill light ---------------------------------------------------
  //
  // Mid-afternoon: long enough shadows to read as a time of day, without the
  // orange of sunset — `sunAt`'s own docstring calls this hour out as the
  // reason `MAX_SUN_ELEVATION` is not overhead.
  const SUN_HOUR = 15
  const sunlight = sunAt(SUN_HOUR)

  // Reduced from the fixed light's old 3.5: that light had to do all the
  // work on its own, and now that the sun casts a real shadow, an
  // equally-bright fill would flatten it straight back out. Kept, rather
  // than removed, so the shadowed side of a cutting is dim, not black.
  scene.add(new THREE.HemisphereLight(0xbdd7ff, 0x3a3227, 1.2))

  const sun = new THREE.DirectionalLight(sunlight.colour, sunlight.intensity)
  sun.castShadow = true

  // The shadow camera is orthographic and, left at its default, has a
  // frustum a couple of units across — on terrain at this scene's scale that
  // produces either no shadows or a small square of them near the origin, and
  // looks exactly like a terrain bug rather than an unsized camera.
  // `updateSunShadow`, below, sizes it from the camera rig every frame; the
  // terrain's own bounding sphere (`bounds`, from `terrainBounds`) is used
  // only as that sizing's ceiling, not its everyday source — see the two
  // constants right after it.
  const bounds = terrainBounds(terrain)
  const shadowCamera = sun.shadow.camera

  /** Shadow map resolution, one edge. Read here and by `updateSunShadow`
   * (for `normalBias`'s texel-size calculation, below) so the two can never
   * disagree about what the map is actually sized to. */
  const SHADOW_MAP_SIZE = 4096

  /**
   * Shadow frustum half-size floor and ceiling, world units.
   *
   * The floor keeps close zooms from shrinking the frustum to nothing.
   *
   * The ceiling is `bounds.radius` — the terrain's own bounding sphere —
   * because nothing beyond the terrain's footprint ever needs a shadow in
   * this scene: every caster and receiver here sits on or above it. Without
   * it, zooming out toward `MAX_DISTANCE` (6000m) grows the frustum without
   * bound, spending a 4096 map on a box wide enough to reproduce the exact
   * self-shadowing acne `71c2d1f` fixed — and worse, now that `normalBias`
   * itself scales down with a *smaller* frustum (see below), a `normalBias`
   * left at that smaller frustum's scale would be far too tight for a
   * frustum this size. Clamping the ceiling to the terrain's own extent
   * keeps the worst-case texel bounded to what the terrain can actually show:
   * `2 * bounds.radius / SHADOW_MAP_SIZE`, worked out in the fix-wave report.
   *
   * This ceiling does not, by itself, fix every case of the frustum being
   * too *small*: at a shallow rig elevation the camera's own view frustum
   * reaches ground kilometres away (see the `updateSunShadow` docstring),
   * far beyond any frustum this scene can afford full-resolution shadows
   * over. Past that point a shadow terminator is unavoidable without
   * sacrificing the near-field resolution this whole scheme exists for; the
   * fix-wave report says where it falls and why it is not visually
   * prominent at the rig's default framing (the tilt-shift pass' own full
   * blur distance falls close to it).
   */
  const MIN_SHADOW_HALF_SIZE = 150
  const MAX_SHADOW_HALF_SIZE = bounds.radius

  /**
   * Fit the shadow frustum to what the camera can actually see.
   *
   * Sizing it to the whole terrain is the obvious thing and it does not work:
   * this terrain is 2560m across, so even a 4096 map spends about 0.93m of
   * ground on every shadow texel — coarser than the road features meant to
   * cast, and coarse enough that the depth comparison mis-fires across the
   * whole surface and paints it in self-shadowing acne. Following the camera
   * instead spends the same texels on the few hundred metres in frame, which
   * is a twentyfold gain in resolution and is what makes the shadows clean
   * rather than what makes them cheap.
   *
   * Called every frame, because the extent depends on the rig's distance and
   * the centre on its target, and both change as the player moves.
   */
  const updateSunShadow = (): void => {
    // The camera sees roughly its own distance in ground height at this field
    // of view, so a frustum of that order covers the frame with margin.
    // Clamped both ways: see `MIN_SHADOW_HALF_SIZE`/`MAX_SHADOW_HALF_SIZE`,
    // above, for why each bound exists.
    const halfSize = clampNumber(rig.distance, MIN_SHADOW_HALF_SIZE, MAX_SHADOW_HALF_SIZE)
    shadowCamera.left = -halfSize
    shadowCamera.right = halfSize
    shadowCamera.top = halfSize
    shadowCamera.bottom = -halfSize

    // Far enough back that anything standing on the ground is inside near/far
    // whatever the sun's elevation, and scaled to the frustum so the depth
    // range stays tight — a needlessly long range costs precision.
    const lightDistance = halfSize * 4
    shadowCamera.near = 1
    shadowCamera.far = lightDistance + halfSize * 2

    const target = rig.target
    sun.target.position.copy(toThreePosition(target))
    sun.position.copy(
      toThreePosition({
        x: target.x + sunlight.direction.x * lightDistance,
        y: target.y + sunlight.direction.y * lightDistance,
        z: target.z + sunlight.direction.z * lightDistance,
      }),
    )

    // Shadow acne (self-shadowing noise on a lit face) and peter-panning (the
    // shadow visibly detached from what casts it) pull in opposite directions
    // from the same knob. `normalBias` offsets the sampled position along the
    // surface normal in world units, so the value it wants is set by how much
    // ground a shadow texel covers — a fixed value tuned for one frustum size
    // is exactly what let acne back in on zoom-out (see `MAX_SHADOW_HALF_SIZE`
    // above): a bias tuned for a ~300m frustum's ~0.15m texels is twelve times
    // too small once the frustum (pre-ceiling) grew wide enough for ~2m ones.
    // Deriving it from the texel size this frustum actually has, every frame,
    // means it tracks whatever `halfSize` the clamp above produced instead of
    // being right for only the size it was tuned against.
    const texelSize = (2 * halfSize) / SHADOW_MAP_SIZE
    sun.shadow.normalBias = texelSize * NORMAL_BIAS_TEXEL_FRACTION

    shadowCamera.updateProjectionMatrix()
  }
  // The light's target must be in the scene graph for its world matrix to
  // update — otherwise it stays at the origin and the light points nowhere
  // near the terrain regardless of where `sun.position` is set.
  scene.add(sun.target)

  // Constant depth bias, not texel-scaled like `normalBias`: the shadow
  // camera is orthographic, so its depth range is linear in world units and
  // `near`/`far` already grow with `halfSize` (see `updateSunShadow`) — a
  // fixed fraction of a range that itself scales with the frustum already
  // scales with it too, unlike `normalBias`, which offsets in world units
  // directly rather than as a fraction of the depth range.
  //
  // The magnitude is EMPIRICAL and must stay that way. It was once cut to
  // -1e-5 on the following argument: `bias` is a fraction of a depth range
  // of `halfSize * 6 - 1` (~1799m at the default framing), so -0.0002 offsets
  // ~0.36m in world space, while depth-buffer quantisation over that range is
  // ~1e-4m on a 24-bit texture — apparently three orders of magnitude of
  // slack, and 0.36m is enough to detach a shadow from anything shorter.
  //
  // The arithmetic is right and the conclusion was wrong: at -1e-5 acne
  // returns across the whole terrain, in fine contour-following moire, dark
  // enough to visibly desaturate the scene. Quantisation is not the only
  // error being covered — PCF taps, the interpolated depth across a texel
  // that spans ~0.15m of ground, and the shallow angle between a low sun and
  // a gently sloping surface all contribute, and none of them appear in that
  // calculation. -0.0002 is the value an earlier fix wave arrived at BY
  // LOOKING AT THE SCENE, and re-derivation is not evidence against it.
  //
  // If this is ever changed again, change it in the browser with the terrain
  // in view, not on paper.
  sun.shadow.bias = -0.0002
  // The fraction of one shadow-map texel `normalBias` offsets by, set once
  // here (`updateSunShadow` computes the bias itself, every frame). Derived,
  // not tuned fresh: at the frustum size this scene used to fix `normalBias`
  // at (halfSize ~= 300, giving a ~0.1465m texel on a 4096 map),
  // `0.05 / 0.1465 ~= 0.34` is the fraction that reproduces that original,
  // already-working value — so this keeps the old tuning at the old scale
  // and extrapolates it, rather than guessing a new number from nothing.
  const NORMAL_BIAS_TEXEL_FRACTION = 1 / 3
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE)
  // Deliberately not fitted here: `updateSunShadow` reads the camera rig,
  // which is constructed further down, and calling it now would touch `rig`
  // in its temporal dead zone and throw before the scene ever renders. The
  // frame loop fits it before the first draw, so there is nothing to fit yet.

  scene.add(sun)

  // See `DEFAULT_DRAW_CLASS` for why this class and not another.
  let drawClassIndex = ROAD_CLASS_ORDER.indexOf(DEFAULT_DRAW_CLASS)
  let tool = new DrawTool(network, ROAD_CLASS_ORDER[drawClassIndex]!)
  const selectTool = new SelectTool(network)

  /**
   * Switch the draw tool's class, discarding whatever gesture was in
   * progress. `DrawTool` computes `cornerRadius` in its constructor, so
   * changing class means constructing a new tool — a half-drawn gravel
   * road is not a valid half-drawn highway, so nothing carries over.
   */
  const setDrawClass = (index: number): void => {
    const wrapped = (index + ROAD_CLASS_ORDER.length) % ROAD_CLASS_ORDER.length
    if (wrapped === drawClassIndex) return
    // A gesture in progress belongs to the class it was started in; the
    // corner radius that validated its points no longer applies.
    tool.cancel()
    drawClassIndex = wrapped
    tool = new DrawTool(network, ROAD_CLASS_ORDER[wrapped]!)
    // `setMessage` already prefixes every message with the current mode
    // label (see its docstring) — prefixing "Draw — " here too would
    // duplicate it, so this names only the class and radius.
    setMessage(`${ROAD_CLASS_ORDER[wrapped]!} (radius ${tool.cornerRadius.toFixed(0)}m)`, 'info')
  }

  /** Which of the two modes the player is currently in. Defaults to draw so
   * the scene opens exactly as it always has. */
  let toolMode: ToolMode = 'draw'
  setMessage('')

  let networkMeshes = addNetworkMeshes(
    scene, terrain, editLayer, built,
    infeasibleRoads, infeasibleCrossings, shallowCrossings, unsupportedFill,
  )

  /**
   * Regrade, re-excavate and rebuild every mesh from the network's current
   * state, and swap the scene's meshes for the result.
   *
   * Called after a successful commit. Everything is rebuilt, not just the
   * roads the commit touched — see `solveNetwork`'s docstring for why that is
   * an accepted, known limitation rather than a bug.
   */
  const rebuildNetworkMeshes = (): void => {
    const result = solveNetwork(terrain, network)
    editLayer = result.editLayer
    built = result.built
    infeasibleRoads = result.infeasibleRoads
    infeasibleCrossings = result.infeasibleCrossings
    shallowCrossings = result.shallowCrossings
    unsupportedFill = result.unsupportedFill
    terrainSampler = editLayer

    for (const mesh of networkMeshes) {
      scene.remove(mesh)
      disposeMesh(mesh)
    }
    networkMeshes = addNetworkMeshes(
      scene, terrain, editLayer, built,
      infeasibleRoads, infeasibleCrossings, shallowCrossings, unsupportedFill,
    )

    // A road with no feasible vertical alignment used to reach only the
    // console (see `SceneContent.infeasibleRoads`) — surfaced here so it is
    // visible after every rebuild, whatever mutation triggered it. Takes
    // priority over whatever message the caller already set: an infeasible
    // road is a standing problem with the network, not a transient result of
    // the action that happened to trigger this rebuild.
    // Three standing problems, reported in the order a player can act on
    // them: a road that cannot be graded at all wants a different alignment,
    // and only once it has one is there any point telling them a crossing on
    // it could not be raised — or, failing both of those, that a crossing that
    // WAS raised is too shallow for its deck to hold the earthwork back. All
    // take priority over whatever message the caller already set, for the
    // reason above.
    const infeasibleMessage =
      describeInfeasibleRoads(infeasibleRoads) ||
      describeInfeasibleCrossings(infeasibleCrossings) ||
      describeShallowCrossings(shallowCrossings)
    if (infeasibleMessage) setMessage(infeasibleMessage, 'refusal')
  }

  const attemptCommit = (): void => {
    const result = tool.commit()
    if (result.ok) {
      rebuildNetworkMeshes()
    } else {
      // Kept alongside the message line below (not replaced by it): the
      // console gives the raw rejection object for debugging, the message
      // line gives the player a sentence they can act on.
      console.warn('commit rejected:', result.rejection.reason, result.rejection)
      setMessage(describePolylineRejection(result.rejection), 'refusal')
    }
  }

  // --- Camera rig ---------------------------------------------------------
  //
  // Targets the actual junction the demo network was built around (`JUNCTION`,
  // module scope — see its docstring), not a separate guess at the same spot,
  // so bringing the distance in below reliably frames the junction rather
  // than empty terrain beside it.
  const RIG_TARGET: RigVec3 = {
    x: JUNCTION.x,
    y: JUNCTION.y,
    z: terrain.sample(JUNCTION.x, JUNCTION.y),
  }

  const rig = new CameraRig(RIG_TARGET, RIG_INITIAL_DISTANCE)
  // Lower than `CameraRig`'s own default elevation (`Math.PI / 5`, 36°): a
  // diorama is looked across at a raised, comfortable angle, not down at from
  // near-plan.
  rig.elevation = 0.4

  const updateCameraFromRig = (): void => {
    camera.position.copy(toThreePosition(rig.position))
    camera.lookAt(toThreePosition(rig.target))
  }

  // --- Pointer -> world ray ------------------------------------------------
  const raycaster = new THREE.Raycaster()

  /**
   * Where a pointer at client coordinates hits the ground, in the project's
   * convention — or `undefined` if it points at the sky.
   *
   * Marches the heightfield (`rayTerrainIntersection`), not the rendered
   * terrain mesh: the whole reason the ray-march exists is that the picked
   * position must not depend on the mesh's tessellation.
   */
  const worldPositionAt = (clientX: number, clientY: number): Vec2 | undefined => {
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return undefined

    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera)

    const ray: Ray3 = {
      origin: threeToProject(raycaster.ray.origin),
      direction: threeToProject(raycaster.ray.direction),
    }
    return rayTerrainIntersection(ray, terrainSampler)
  }

  // --- Draw preview --------------------------------------------------------
  /** How far apart, along the previewed alignment, the curve is sampled for
   * the provisional line — well inside "a few metres". */
  const PREVIEW_SAMPLE_SPACING = 5
  /** Height above terrain the preview and marker are lifted, so they never
   * z-fight the ground they are drawn over. */
  const PREVIEW_MARGIN = 0.3

  const SNAP_COLOURS: Record<SnapTarget['kind'], number> = {
    free: 0xffffff,
    node: 0xffcc00,
    road: 0x33ccff,
  }

  /** What the pointer last resolved to, independent of the tool's own
   * (private) hover state — recomputed alongside `tool.hover()` from the same
   * pure function, so the marker can show its kind. */
  let hoverSnap: SnapTarget | undefined

  /** The pointer's last known ground position, unsnapped — `undefined` when
   * the pointer is over the sky or hasn't moved yet. Used by select mode's
   * split verb, which needs the raw position rather than a snap target. */
  let lastPointerWorldPosition: Vec2 | undefined

  let previewLine: THREE.Line | undefined
  const previewOkMaterial = new THREE.LineBasicMaterial({ color: 0xbfe3ff })
  const previewWarnMaterial = new THREE.LineBasicMaterial({ color: 0xff5533 })

  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(2.5, 12, 8),
    new THREE.MeshBasicMaterial({ color: SNAP_COLOURS.free }),
  )
  marker.visible = false
  scene.add(marker)

  const projectToThree = (p: Vec2, extraMargin = 0): THREE.Vector3 => {
    const z = terrainSampler.sample(p.x, p.y) + PREVIEW_MARGIN + extraMargin
    return new THREE.Vector3(p.x, z, -p.y)
  }

  /**
   * Report a rejection once per distinct cause, not once per frame — to the
   * console, as before, and now to the message line too, so a corner too
   * sharp to fillet or a segment short of the minimum shows up on screen
   * while the player is still drawing it, not only at commit time.
   */
  let lastLoggedRejectionKey: string | undefined
  const logRejection = (rejection: PolylineRejection | undefined): void => {
    if (!rejection) {
      lastLoggedRejectionKey = undefined
      return
    }
    const key = JSON.stringify(rejection)
    if (key === lastLoggedRejectionKey) return
    lastLoggedRejectionKey = key
    console.warn('draw preview rejected:', rejection.reason, rejection)
    setMessage(describePolylineRejection(rejection), 'refusal')
  }

  const setPreviewGeometry = (points: THREE.Vector3[], material: THREE.LineBasicMaterial): void => {
    const geometry = new THREE.BufferGeometry().setFromPoints(points)
    if (previewLine) {
      previewLine.geometry.dispose()
      previewLine.geometry = geometry
      previewLine.material = material
    } else {
      previewLine = new THREE.Line(geometry, material)
      scene.add(previewLine)
    }
  }

  const clearPreviewLine = (): void => {
    if (!previewLine) return
    scene.remove(previewLine)
    previewLine.geometry.dispose()
    previewLine = undefined
  }

  /**
   * Rebuild the preview line and snap marker from the tool's current state.
   *
   * Runs every frame. The geometry is disposed before every replacement (via
   * `setPreviewGeometry`/`clearPreviewLine`), so a preview rebuilt on every
   * frame while drawing does not leak GPU memory.
   */
  const updatePreview = (): void => {
    const preview = tool.preview

    if (!preview) {
      clearPreviewLine()
      logRejection(undefined)
    } else if (preview.ok) {
      const points = preview.alignment
        .sample(PREVIEW_SAMPLE_SPACING)
        .map((pose) => projectToThree(pose.position))
      setPreviewGeometry(points, previewOkMaterial)
      logRejection(undefined)
    } else {
      // The shape the player asked for, straight between the points they
      // placed (plus wherever they are hovering now) — not the curve
      // builder, which is exactly what failed.
      const rawPoints = hoverSnap ? [...tool.points, hoverSnap.position] : [...tool.points]
      const points = rawPoints.map((p) => projectToThree(p))
      setPreviewGeometry(points, previewWarnMaterial)
      logRejection(preview.rejection)
    }

    if (hoverSnap) {
      marker.position.copy(projectToThree(hoverSnap.position, 0.1))
      ;(marker.material as THREE.MeshBasicMaterial).color.setHex(SNAP_COLOURS[hoverSnap.kind])
      marker.visible = true
    } else {
      marker.visible = false
    }
  }

  // --- Selection highlight ---------------------------------------------------
  //
  // The selected road's centreline, drawn the same way the draw preview is —
  // a bright line lifted clear of the surface. Rebuilt every frame straight
  // from `selectTool.selected`, the same pattern `updatePreview` already uses
  // for the preview line, rather than cached against a remembered id: a
  // selection can be invalidated by something this scene never routes back
  // through the select tool (a road drawn onto the selected one splits it —
  // see `SelectTool`'s docstring), and `selected` already re-checks existence
  // on every read, so reading it fresh here is what makes that safe.
  let highlightLine: THREE.Line | undefined
  const highlightMaterial = new THREE.LineBasicMaterial({ color: 0x39ff8a })

  const clearHighlight = (): void => {
    if (!highlightLine) return
    scene.remove(highlightLine)
    highlightLine.geometry.dispose()
    highlightLine = undefined
  }

  const updateHighlight = (): void => {
    const roadId = selectTool.selected
    if (roadId === undefined) {
      clearHighlight()
      return
    }

    const points = network
      .road(roadId)
      .alignment.sample(PREVIEW_SAMPLE_SPACING)
      .map((pose) => projectToThree(pose.position))
    const geometry = new THREE.BufferGeometry().setFromPoints(points)
    if (highlightLine) {
      // Disposed before every replacement, exactly like the preview line —
      // this is the geometry-leak pattern the preview line already had to be
      // fixed for once.
      highlightLine.geometry.dispose()
      highlightLine.geometry = geometry
    } else {
      highlightLine = new THREE.Line(geometry, highlightMaterial)
      scene.add(highlightLine)
    }
  }

  // --- Pointer input: camera control, hover and placement -----------------
  const ORBIT_RADIANS_PER_PIXEL = 0.005
  /** Multiplicative per unit of wheel delta, so zoom feels the same at every
   * scale rather than shrinking to nothing far out or exploding up close. */
  const ZOOM_SENSITIVITY = 0.0015
  /** Pointer movement, in pixels, beyond which a left-button gesture is a
   * drag rather than a click. */
  const CLICK_MOVE_THRESHOLD_PX = 5
  /** Window within which a second click is treated as a double click rather
   * than two independent placements. */
  const DOUBLE_CLICK_MS = 300

  type DragMode = 'orbit' | 'pan' | 'place'
  type DragState = {
    readonly mode: DragMode
    readonly pointerId: number
    /** The button that started this drag (`PointerEvent.button`). A mouse
     * reuses one `pointerId` for every button, so ending a drag has to check
     * this too — otherwise releasing the right button while the left is
     * still held is taken as ending the left-button drag. */
    readonly button: number
    lastX: number
    lastY: number
    readonly startX: number
    readonly startY: number
    moved: boolean
  }

  let drag: DragState | undefined
  let pendingClickTimer: number | undefined

  /**
   * Suppress-snap modifier for §4.1's "a held modifier suppresses all
   * snapping". Shift is already orbit's modifier (see `onPointerDown`), so
   * this uses Alt/Option instead — the scene binds no other behaviour to it,
   * and unlike Ctrl it carries no legacy "emulate a right click" meaning on
   * any current platform.
   */
  const suppressSnapModifier = (event: MouseEvent): boolean => event.altKey

  const updateHover = (event: PointerEvent): void => {
    const worldPosition = worldPositionAt(event.clientX, event.clientY)
    // Tracked independent of mode/hover-snap so the split verb (select mode's
    // "S") has the pointer's current ground position to hand to
    // `splitSelectedAt`, the same position the player is looking at.
    lastPointerWorldPosition = worldPosition
    if (!worldPosition) {
      hoverSnap = undefined
      return
    }
    const suppressSnap = suppressSnapModifier(event)
    tool.hover(worldPosition, suppressSnap)
    hoverSnap = suppressSnap
      ? { kind: 'free', position: worldPosition }
      : resolveSnap(network, worldPosition, SNAP_RADIUS)
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (drag) return

    let mode: DragMode
    if (event.button === 2 || (event.button === 0 && event.shiftKey)) mode = 'orbit'
    else if (event.button === 1) mode = 'pan'
    else if (event.button === 0) mode = 'place'
    else return

    canvas.setPointerCapture(event.pointerId)
    drag = {
      mode,
      pointerId: event.pointerId,
      button: event.button,
      lastX: event.clientX,
      lastY: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    }
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (drag && drag.pointerId === event.pointerId) {
      const dx = event.clientX - drag.lastX
      const dy = event.clientY - drag.lastY
      drag.lastX = event.clientX
      drag.lastY = event.clientY
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > CLICK_MOVE_THRESHOLD_PX) {
        drag.moved = true
      }

      if (drag.mode === 'orbit') {
        // Dragging right turns the world left, as in every map: positive dx
        // (pointer moving right) yaws the camera the opposite way round.
        rig.orbit(-dx * ORBIT_RADIANS_PER_PIXEL, -dy * ORBIT_RADIANS_PER_PIXEL)
      } else if (drag.mode === 'pan') {
        // World-space size of one pixel at the target's distance, so the
        // ground point under the pointer keeps pace with it whatever the
        // zoom, rather than panning faster or slower far out than up close.
        const verticalFovRadians = (camera.fov * Math.PI) / 180
        const worldPerPixel =
          (2 * rig.distance * Math.tan(verticalFovRadians / 2)) / Math.max(1, canvas.clientHeight)
        rig.pan(-dx * worldPerPixel, dy * worldPerPixel)
      }
      // 'place' mode: no camera or hover update while a potential click is
      // still being distinguished from a drag.
      return
    }

    updateHover(event)
  }

  /**
   * End the drag matching this pointer, regardless of which button the event
   * reports — used by `pointercancel`, which is not tied to any one button
   * and must always terminate whatever drag is in progress.
   */
  const endDrag = (event: PointerEvent): DragState | undefined => {
    if (!drag || drag.pointerId !== event.pointerId) return undefined
    const finished = drag
    drag = undefined
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId)
    }
    return finished
  }

  /** Clear a pending single-click timer without running the deferred
   * placement it guards — used wherever the pending gesture is resolved by
   * some other action (a keyboard commit/cancel/undo) or superseded by a
   * second click, so a click the player already moved on from cannot still
   * land 300ms later as a phantom point. */
  const cancelPendingClick = (): void => {
    if (pendingClickTimer === undefined) return
    window.clearTimeout(pendingClickTimer)
    pendingClickTimer = undefined
  }

  const onPointerUp = (event: PointerEvent): void => {
    // A mouse reuses one pointerId across every button, so a right-button-up
    // while the left button still holds this drag must not be mistaken for
    // ending it — only the button that started the drag can end it. Leave
    // the drag (and its pointer capture) exactly as it was.
    if (drag && drag.pointerId === event.pointerId && drag.button !== event.button) return

    const finished = endDrag(event)
    if (!finished || finished.mode !== 'place' || finished.moved) return

    const worldPosition = worldPositionAt(event.clientX, event.clientY)
    if (!worldPosition) return

    // Select mode's click is a single, immediate pick — no double-click
    // deferral, and no second path to the ground: it reuses the exact same
    // gesture (drag-vs-click already resolved above) and pointer-to-ground
    // machinery draw mode's placement uses.
    if (toolMode === 'select') {
      const pickedRoadId = selectTool.select(worldPosition)
      setMessage(pickedRoadId === undefined ? 'Nothing there to select.' : 'Selected a road.')
      return
    }

    const suppressSnap = suppressSnapModifier(event)

    if (pendingClickTimer !== undefined) {
      // Second click within the window: a double click. It keeps the point
      // this click itself was given — the road being committed should
      // include where the player just clicked, not silently end one point
      // short — then commits rather than placing a third point.
      cancelPendingClick()
      tool.place(worldPosition, suppressSnap)
      attemptCommit()
    } else {
      pendingClickTimer = window.setTimeout(() => {
        pendingClickTimer = undefined
        tool.place(worldPosition, suppressSnap)
      }, DOUBLE_CLICK_MS)
    }
  }

  const onPointerCancel = (event: PointerEvent): void => {
    endDrag(event)
  }

  /** Approximate CSS pixels per "line" when a `WheelEvent` reports
   * `DOM_DELTA_LINE` — Firefox's default unit for an ordinary mouse wheel,
   * against Chrome/Safari's `DOM_DELTA_PIXEL`. Without normalising this,
   * Firefox's deltaY of a few lines per notch reads as a few pixels, and
   * zoom moves at roughly 0.45% of the speed it does elsewhere. 16px matches
   * Firefox's own default wheel line height. */
  const WHEEL_LINE_HEIGHT_PX = 16

  /** `deltaY` normalised to the same "pixels" unit regardless of which mode
   * the browser reported it in. */
  const normalizedWheelDeltaY = (event: WheelEvent): number => {
    switch (event.deltaMode) {
      case WheelEvent.DOM_DELTA_LINE:
        return event.deltaY * WHEEL_LINE_HEIGHT_PX
      case WheelEvent.DOM_DELTA_PAGE:
        return event.deltaY * Math.max(1, canvas.clientHeight)
      default:
        return event.deltaY
    }
  }

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    rig.zoom(Math.exp(normalizedWheelDeltaY(event) * ZOOM_SENSITIVITY))
  }

  const onContextMenu = (event: MouseEvent): void => {
    event.preventDefault()
  }

  /**
   * Switch between draw and select mode, cancelling whatever is pending in
   * the mode being left.
   *
   * Only draw mode has anything pending to cancel — a half-placed road and
   * the timer waiting to see if the next click is a double click. Left
   * running, that timer is exactly the "stale gesture survives a mode
   * switch" hazard this file has hit before: it would fire up to 300ms after
   * the player has already moved to select mode and silently feed a point to
   * a draw tool nobody is looking at. Select mode's own actions (pick,
   * delete, split, reclassify) are all immediate, so leaving it cancels
   * nothing — in particular the selection itself survives the trip (see
   * `updateHighlight`), so switching to draw and back does not lose it.
   *
   * A held drag is cleared here too, regardless of which mode is being left.
   * `onPointerUp` resolves a drag by reading `toolMode` at release time, not
   * at press time — so a drag started in one mode and released after a mode
   * switch would otherwise resolve in the mode it did not start in (e.g. a
   * held left-button placement release, in select mode, after Tab was
   * pressed mid-drag). Ending it here, and releasing the pointer capture
   * that goes with it, means `onPointerUp` finds no drag to resolve at all.
   */
  const switchToolMode = (next: ToolMode): void => {
    if (next === toolMode) return
    if (toolMode === 'draw') {
      cancelPendingClick()
      tool.cancel()
    }
    if (drag) {
      if (canvas.hasPointerCapture(drag.pointerId)) {
        canvas.releasePointerCapture(drag.pointerId)
      }
      drag = undefined
    }
    toolMode = next
    setMessage('')
  }

  const handleDeleteSelected = (): void => {
    const outcome = selectTool.deleteSelected()
    if (outcome.ok) {
      setMessage('Deleted the selected road.')
      rebuildNetworkMeshes()
    } else {
      setMessage('Select a road before deleting it.', 'refusal')
    }
  }

  const handleSplitSelected = (): void => {
    // `splitSelectedAt` needs a ground position; without one (pointer over
    // the sky, or never moved) there is nothing to split at, which is the
    // same message as clicking somewhere off the selected road.
    if (lastPointerWorldPosition === undefined) {
      const outcome: SplitOutcome =
        selectTool.selected === undefined
          ? { ok: false, reason: 'nothing-selected' }
          : { ok: false, reason: 'not-on-the-selected-road' }
      setMessage(describeSplitOutcome(outcome), 'refusal')
      return
    }

    const outcome = selectTool.splitSelectedAt(lastPointerWorldPosition)
    setMessage(describeSplitOutcome(outcome), outcome.ok ? 'info' : 'refusal')
    if (outcome.ok) rebuildNetworkMeshes()
  }

  /** `]` (direction 1) or `[` (direction -1). */
  const handleReclassifySelected = (direction: 1 | -1): void => {
    if (selectTool.selected === undefined) {
      setMessage('Select a road before changing its class.', 'refusal')
      return
    }

    const to = selectTool.classStep(direction)
    if (to === undefined) {
      // Nothing to reclassify to — already at the top or bottom of the
      // ladder. Not a rejection `reclassifySelected` itself can report (there
      // is no obstacle, no class to name), so it is never called.
      setMessage(
        direction === 1 ? 'Already at the highest road class.' : 'Already at the lowest road class.',
        'refusal',
      )
      return
    }

    const outcome = selectTool.reclassifySelected(to)
    if (outcome.ok) {
      setMessage(`Reclassified from ${outcome.from} to ${outcome.to}.`)
      rebuildNetworkMeshes()
    } else if (outcome.reason === 'not-permitted') {
      setMessage(describeUpgradeObstacles(outcome.obstacles), 'refusal')
    } else {
      setMessage('Select a road before changing its class.', 'refusal')
    }
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Tab') {
      // The browser's own default would move focus off the canvas.
      event.preventDefault()
      switchToolMode(toolMode === 'draw' ? 'select' : 'draw')
      return
    }

    // Every other key is mode-specific. Draw mode already used Backspace for
    // "undo the last point"; select mode uses the same key for "delete the
    // selected road". Branching on mode up front, rather than trying to fold
    // both into one switch, is what keeps a key from firing in the mode it
    // does not belong to.
    if (toolMode === 'draw') {
      switch (event.key) {
        case 'Enter':
          event.preventDefault()
          cancelPendingClick()
          attemptCommit()
          break
        case 'Escape':
          event.preventDefault()
          cancelPendingClick()
          tool.cancel()
          break
        case 'Backspace':
          event.preventDefault()
          cancelPendingClick()
          tool.undoLastPoint()
          break
        case '1':
        case '2':
        case '3':
        case '4':
          event.preventDefault()
          cancelPendingClick()
          setDrawClass(Number(event.key) - 1)
          break
        default:
          break
      }
      return
    }

    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        selectTool.clear()
        setMessage('')
        break
      case 'Delete':
      case 'Backspace':
        event.preventDefault()
        handleDeleteSelected()
        break
      case 's':
      case 'S':
        event.preventDefault()
        handleSplitSelected()
        break
      case ']':
        event.preventDefault()
        handleReclassifySelected(1)
        break
      case '[':
        event.preventDefault()
        handleReclassifySelected(-1)
        break
      default:
        break
    }
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerCancel)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('contextmenu', onContextMenu)
  window.addEventListener('keydown', onKeyDown)

  // --- Post-processing: tilt-shift depth of field --------------------------
  //
  // A shallow depth of field, sharp only around what the camera is orbiting
  // and blurring both nearer and farther, is what reads as a miniature rather
  // than a smeared screenshot — see `tiltShift.ts`.
  const initialWidth = Math.max(1, canvas.clientWidth)
  const initialHeight = Math.max(1, canvas.clientHeight)
  // Captured once: this renderer's own pixel ratio never changes after
  // construction, and `EffectComposer` itself captures it the same way at
  // construction time, so recomputing it later would only ever repeat this
  // value.
  const composerPixelRatio = renderer.getPixelRatio()

  // The pass reads depth (see `TILT_SHIFT_FRAGMENT_SHADER`), so the render
  // target it draws into needs a real depth *texture* — a composer's default
  // target has only a depth *buffer*, which the shader cannot sample, and the
  // effect would silently do nothing. `EffectComposer` uses this target (and
  // a clone of it, which clones the depth texture along with it) as its two
  // internal buffers, so both ends up with one.
  //
  // `type: THREE.HalfFloatType` matters as much as the depth texture does:
  // left at the default (`UnsignedByteType`), the whole scene is quantised to
  // 8-bit linear *before* `OutputPass` ever runs ACES tone mapping on it, so
  // the tone curve stretches already-banded shadow and cut-face darks instead
  // of smooth linear values. `EffectComposer`'s own default target uses
  // `HalfFloatType` for exactly this reason (see `EffectComposer.js`); this
  // target is supplied explicitly (for the depth texture, above) and so has
  // to restate it rather than inherit it.
  const composerRenderTarget = new THREE.WebGLRenderTarget(
    initialWidth * composerPixelRatio,
    initialHeight * composerPixelRatio,
    {
      depthTexture: new THREE.DepthTexture(initialWidth * composerPixelRatio, initialHeight * composerPixelRatio),
      type: THREE.HalfFloatType,
    },
  )

  const composer = new EffectComposer(renderer, composerRenderTarget)
  composer.addPass(new RenderPass(scene, camera))

  /** Standard full-screen-pass vertex shader — three's own `CopyShader` uses
   * exactly this, and `TILT_SHIFT_FRAGMENT_SHADER` supplies only the
   * fragment stage and expects this same `vUv`. */
  const TILT_SHIFT_VERTEX_SHADER = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

  // How much depth around the focal distance stays sharp, and how far beyond
  // that band the blur takes to reach full strength, metres. Tuned by eye
  // (Step 8) at the rig's default framing: narrow enough that the junction is
  // unmistakably the one sharp thing in the frame, wide enough that the whole
  // junction — not just the single point the rig orbits — stays in focus
  // together.
  const FOCUS_RANGE_METRES = 60
  const FOCUS_FALLOFF_METRES = 220

  /**
   * The uniform shape `TILT_SHIFT_UNIFORM_NAMES` names, typed concretely (with
   * real texture types, since this file — unlike `tiltShift.ts` — is allowed
   * to know about three.js) so the per-frame/per-resize writes below don't
   * have to fight three's own `{ [name: string]: { value: any } }` typing on
   * `ShaderPass.uniforms`.
   *
   * Deliberately not built by hand here: `createTiltShiftUniforms` (see
   * `tiltShift.ts`) is keyed off `TILT_SHIFT_UNIFORM_NAMES` itself, so a
   * uniform the shader declares but this construction forgets — the failure
   * mode `908fe00` already fixed once — is now a type error at that
   * function's own return statement, not a silent no-op discovered by eye.
   */
  type TiltShiftUniforms = {
    readonly tDiffuse: { value: THREE.Texture | null }
    readonly tDepth: { value: THREE.Texture | null }
    readonly uFocusDistance: { value: number }
    readonly uFocusRange: { value: number }
    readonly uFocusFalloff: { value: number }
    readonly uNear: { value: number }
    readonly uFar: { value: number }
    readonly uTexelSize: { value: { x: number; y: number } }
  }

  const tiltShiftPass = new ShaderPass({
    uniforms: createTiltShiftUniforms({
      focusDistance: rig.distance,
      focusRange: FOCUS_RANGE_METRES,
      focusFalloff: FOCUS_FALLOFF_METRES,
      near: camera.near,
      far: camera.far,
      texelWidth: 1 / (initialWidth * composerPixelRatio),
      texelHeight: 1 / (initialHeight * composerPixelRatio),
    }),
    vertexShader: TILT_SHIFT_VERTEX_SHADER,
    fragmentShader: TILT_SHIFT_FRAGMENT_SHADER,
  })
  composer.addPass(tiltShiftPass)

  // Tone mapping and the sRGB encode happen in the material shader only when
  // three renders to the *default framebuffer*. Rendering into a composer's
  // target writes raw linear values instead, so without a final pass to
  // convert them the linear buffer is handed to the screen as though it were
  // already sRGB — which reads as a dark, desaturated, muddy image, and makes
  // `toneMappingExposure` appear to do nothing at all, because no tone mapping
  // ever ran. `OutputPass` exists for exactly this: it applies the renderer's
  // tone mapping and output colour space as the last thing before the screen,
  // so it must stay last in the chain.
  //
  // Kept in a named variable (rather than passed anonymously, as every other
  // pass here is) only so the teardown at the bottom of this function can
  // call its own `dispose()` — see that teardown's comment for why that
  // matters in three 0.185.
  const outputPass = new OutputPass()
  composer.addPass(outputPass)

  // `ShaderPass` deep-clones the uniforms object passed to its constructor
  // (`UniformsUtils.cloneUniforms`, called on the object literal above) into
  // a *new* object before handing it to the material it actually renders
  // with. Holding onto the object literal itself and mutating it every frame
  // would silently update nothing — every uniform read below goes through
  // `tiltShiftPass.uniforms`, the clone that is actually live, not the
  // literal above. The cast is safe rather than a hopeful guess: `cloneUniforms`
  // maps every key of the source object 1:1, so the clone has exactly the
  // shape of the literal just constructed above.
  const tiltShiftUniforms = tiltShiftPass.uniforms as unknown as TiltShiftUniforms

  // A window `resize` event alone isn't enough: it fires only for the
  // window's own dimensions, not for every reason the canvas's box can
  // change size (layout, container changes, fractional-pixel rounding
  // between the window and the element). ResizeObserver reports the
  // canvas's actual content-box size directly — including once immediately
  // on observe(), with the real post-layout size — so the renderer and
  // camera are sized from the same source of truth the canvas is actually
  // displayed at, and stay correct across every kind of resize.
  let lastWidth = -1
  let lastHeight = -1
  const resize = (width: number, height: number) => {
    if (width <= 0 || height <= 0) return
    if (width === lastWidth && height === lastHeight) return
    lastWidth = width
    lastHeight = height
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()

    // The composer owns render targets sized to the canvas — resizing the
    // renderer alone leaves them (and the blur) at the old resolution.
    // `EffectComposer.setSize` resizes both of its internal buffers (and,
    // with them, the depth texture attached to each), so no separate
    // render-target recreation is needed here.
    composer.setSize(width, height)
    // Not a `THREE.Vector2` (see `TiltShiftUniforms`, above, and
    // `createTiltShiftUniforms` in `tiltShift.ts`) — a plain `{x, y}` pair, so
    // set the two fields directly rather than calling a `.set()` that does
    // not exist on this shape.
    tiltShiftUniforms.uTexelSize.value.x = 1 / (width * composerPixelRatio)
    tiltShiftUniforms.uTexelSize.value.y = 1 / (height * composerPixelRatio)
  }

  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const box = entry.contentBoxSize?.[0]
      if (box) {
        resize(box.inlineSize, box.blockSize)
      } else {
        resize(entry.contentRect.width, entry.contentRect.height)
      }
    }
  })
  resizeObserver.observe(canvas)

  let frame = 0
  const tick = (): void => {
    frame = requestAnimationFrame(tick)
    // Belt and suspenders alongside the ResizeObserver above: cheap enough
    // to check every frame, and it catches the box changing size for any
    // reason the observer's host environment fails to notify for (some
    // embeddings/automation contexts never deliver a ResizeObserver
    // callback at all), rather than leaving the canvas stuck at a stale
    // resolution until something else happens to touch it.
    resize(canvas.clientWidth, canvas.clientHeight)
    updateCameraFromRig()
    // The shadow frustum follows the camera, so it has to be refitted after
    // the rig has been read and before anything is drawn with it.
    updateSunShadow()
    updatePreview()
    updateHighlight()

    // What the player is orbiting around is what stays sharp: the focal
    // distance follows the rig every frame, not a value fixed at scene
    // creation, so zooming changes what is in focus instead of leaving the
    // blur exactly where it started.
    tiltShiftUniforms.uFocusDistance.value = rig.distance
    // Read fresh every frame rather than cached once: the render target this
    // points at is whichever buffer `RenderPass` just wrote the scene's depth
    // into, and re-reading it here (rather than assuming which buffer that
    // is) is what stays correct across a resize without extra bookkeeping.
    tiltShiftUniforms.tDepth.value = composer.readBuffer.depthTexture
    composer.render()
  }
  tick()

  return () => {
    cancelAnimationFrame(frame)
    resizeObserver.disconnect()
    canvas.removeEventListener('pointerdown', onPointerDown)
    canvas.removeEventListener('pointermove', onPointerMove)
    canvas.removeEventListener('pointerup', onPointerUp)
    canvas.removeEventListener('pointercancel', onPointerCancel)
    canvas.removeEventListener('wheel', onWheel)
    canvas.removeEventListener('contextmenu', onContextMenu)
    window.removeEventListener('keydown', onKeyDown)
    cancelPendingClick()

    // Every road/terrain/junction/structure mesh built by `addNetworkMeshes`
    // (including the terrain surface itself, last in that array), plus the
    // preview line, both preview materials, the selection highlight and the
    // snap marker — everything this function allocated on the GPU, not just
    // the renderer. Without this, every road drawn and every rebuild leaks
    // its geometries and materials for as long as the page stays open.
    for (const mesh of networkMeshes) {
      scene.remove(mesh)
      disposeMesh(mesh)
    }
    clearPreviewLine()
    previewOkMaterial.dispose()
    previewWarnMaterial.dispose()
    clearHighlight()
    highlightMaterial.dispose()
    scene.remove(marker)
    marker.geometry.dispose()
    ;(marker.material as THREE.MeshBasicMaterial).dispose()

    // The post-processing chain's own GPU resources. `EffectComposer.dispose()`
    // (present in three 0.185, whatever an older comment here used to claim)
    // frees its own two render targets — one supplied here, one its own clone,
    // each carrying a depth texture — and its internal `copyPass`'s material
    // and full-screen quad, but it does not reach into the passes *this scene*
    // added via `addPass`: `RenderPass` owns nothing further to free, but
    // `OutputPass` and `tiltShiftPass` each carry their own shader material
    // and full-screen quad, so each needs its own `dispose()` call too. Left
    // undone, every mount of this scene would leak a pair of full-resolution
    // colour+depth render targets plus two materials and full-screen quads.
    composer.dispose()
    outputPass.dispose()
    tiltShiftPass.dispose()

    // The sun's shadow map is a render target the renderer allocates lazily
    // on first use, once shadows are enabled — not created by this function
    // directly, but still this function's responsibility to free.
    sun.shadow.dispose()

    renderer.dispose()
    messageEl.remove()
  }
}
