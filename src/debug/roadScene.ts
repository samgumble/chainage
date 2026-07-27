import * as THREE from 'three'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2, fromAngle } from '../geometry/vec2'
import { generateValley } from '../terrain/generate'
import { sampleGroundProfile, designElevationAtStation, type ProfilePoint } from '../terrain/groundProfile'
import { solveGradeProfile } from '../terrain/gradeSolver'
import { TerrainEditLayer } from '../terrain/editLayer'
import { designSurfaceAtOffset, type CorridorTemplate, type CorridorBatters } from '../terrain/corridor'
import { ROAD_CLASSES, formationHalfWidth, totalPavementThickness, type RoadClassName } from '../network/roadClass'
import { toBufferGeometry } from '../render/meshAdapter'
import { terrainGeometry } from '../render/terrainMesh'
import { RoadNetwork, type RoadId } from '../network/graph'
import { buildNetworkMesh, type NetworkMesh } from '../mesh/networkMesh'
import type { Heightmap } from '../terrain/heightmap'

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
const CORRIDOR_MAX_BATTER_WIDTH = 8

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
const EXCAVATION_STATION_SPACING = 5
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

/** Layer colours: warm earth, pale aggregate, dark asphalt — tuned for
 * contrast against each other and against the terrain so the three
 * differing end-stations are unmistakable. */
const LAYER_COLOURS: Record<string, number> = {
  subgrade: 0x8a6a3f,
  base: 0xc7c3ba,
  wearing: 0x35383d,
}

/** Orbit camera: one revolution every ORBIT_PERIOD_S seconds, looking down
 * at the road's plan midpoint from a raised angle. */
const ORBIT_CENTER = new THREE.Vector3(1300, 105, -1300)
const ORBIT_RADIUS = 1400
const ORBIT_HEIGHT = 700
const ORBIT_PERIOD_S = 40

/**
 * Cut and fill the terrain down to the design surface along the corridor.
 *
 * This is the piece that was missing: without it, the solved design line
 * (correctly placed below natural ground through cuts) sits inside an
 * un-dug hill and only pokes through where it happens to break the surface.
 *
 * Approach, approximate by design — this feeds a debug view, not the real
 * earthworks pipeline:
 *
 * 1. Walk the alignment every `EXCAVATION_STATION_SPACING` metres.
 * 2. At each station, take the design elevation from the solved profile and
 *    step transversely across the corridor, no further per step than the
 *    terrain's own cell size, out to a half-width generous enough to cover
 *    the batters (formation half-width, plus the steeper of the two slopes
 *    times the local cut/fill depth, plus a margin).
 * 3. At each transverse sample, snap to the nearest terrain grid node, read
 *    its existing (unedited) elevation, compute the corridor template's
 *    target elevation there, and record the difference as that node's delta
 *    in the edit layer.
 *
 * Grid nodes get written from multiple nearby stations/offsets; last write
 * wins, which is fine here since neighbouring stations along a gently curving
 * alignment agree closely on the design surface at a shared node.
 *
 * This excavation routine is a visual stand-in for the real earthworks
 * pipeline and must not be promoted into `src/terrain/`. Nearest-node
 * snapping with last-write-wins is fine for a debug view where "looks
 * continuous from an orbiting camera" is the bar, but it is not fine for
 * computing quantities — that needs the exact transverse integration in
 * `src/terrain/volumes.ts`, not this grid-snapped approximation.
 *
 * Writes into a caller-supplied `layer` rather than returning a fresh one, so
 * that calling this once per road in a network accumulates every corridor's
 * deltas onto the same terrain instead of each excavation clobbering the last.
 */
const excavateCorridor = (
  layer: TerrainEditLayer,
  alignment: Alignment,
  profile: readonly ProfilePoint[],
  className: RoadClassName,
): void => {
  if (alignment.isEmpty || profile.length === 0) return

  const terrain = layer.base
  const template = corridorTemplateFor(className)
  const transverseStep = terrain.cellSize
  const maxSlope = Math.max(template.cutSlope, template.fillSlope)
  const steps = Math.max(1, Math.ceil(alignment.length / EXCAVATION_STATION_SPACING))

  // The design profile is the top of the finished road (top of the wearing
  // course), not the terrain elevation the road should rest on. The terrain
  // under the road is the subgrade's underside — the design elevation less
  // the full pavement stack — plus a small margin against z-fighting. Using
  // an arbitrary clearance instead of this would either bury the pavement in
  // cut sections or leave it floating above the embankment in fill sections.
  const pavementDepth = totalPavementThickness(ROAD_CLASSES[className])

  for (let i = 0; i <= steps; i++) {
    const s = Math.min(i * EXCAVATION_STATION_SPACING, alignment.length)
    const pose = alignment.poseAt(s)
    const roadZ = designElevationAtStation(profile, s)
    const designZ = roadZ - pavementDepth - EXCAVATION_ZFIGHT_MARGIN

    const centreGroundZ = terrain.sample(pose.position.x, pose.position.y)

    // Where a structure carries the road there is no earthwork to build, so
    // leave the ground alone — otherwise the embankment this loop would raise
    // swallows the bridge whole. Same test `classifySupport` applies, but
    // station by station: it does not know about `MIN_SPAN_LENGTH`, so an
    // isolated high station would leave a short unfilled notch with no bridge
    // over it. None occur in this valley, and this is a debug view.
    if (roadZ - centreGroundZ > MAX_FILL_HEIGHT) continue

    const depth = Math.abs(centreGroundZ - designZ)
    const half = template.formationHalfWidth + maxSlope * depth + EXCAVATION_MARGIN

    const normal = fromAngle(pose.heading + Math.PI / 2)
    const transverseSteps = Math.max(1, Math.ceil(half / transverseStep))

    for (let j = -transverseSteps; j <= transverseSteps; j++) {
      const offset = (half * j) / transverseSteps
      const worldX = pose.position.x + normal.x * offset
      const worldY = pose.position.y + normal.y * offset

      const col = Math.round((worldX - terrain.originX) / terrain.cellSize)
      const row = Math.round((worldY - terrain.originY) / terrain.cellSize)
      if (col < 0 || col >= terrain.cols || row < 0 || row >= terrain.rows) continue

      const groundZ = terrain.elevationAtIndex(col, row)
      const targetZ = designSurfaceAtOffset(offset, designZ, groundZ, template)
      layer.setDelta(col, row, targetZ - groundZ)
    }
  }
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
  const JUNCTION = vec2(900, 1280)

  const network = new RoadNetwork()
  const designs = new Map<RoadId, ProfilePoint[]>()

  const solveFor = (alignment: Alignment): ProfilePoint[] | null => {
    const ground = sampleGroundProfile(alignment, terrain, 10)
    const solution = solveGradeProfile(ground, {
      maxGrade: MAX_GRADE,
      maxCutDepth: MAX_CUT_DEPTH,
      maxFillHeight: MAX_FILL_HEIGHT,
      maxStructureHeight: MAX_STRUCTURE_HEIGHT,
    })
    return solution.feasible ? solution.profile : null
  }

  // West and east arms both start at the junction, heading opposite ways
  // along the valley; the branch starts there too, heading north.
  const westArm = new Alignment([new Line(JUNCTION, Math.PI, 750)])
  const eastArm = new Alignment([new Line(JUNCTION, 0, 750)])
  const branch = new Alignment([new Line(JUNCTION, Math.PI / 2, 300)])

  const arms: [Alignment, 'rural' | 'gravel'][] = [
    [westArm, 'rural'], [eastArm, 'rural'], [branch, 'gravel'],
  ]

  for (const [alignment, className] of arms) {
    const design = solveFor(alignment)
    if (!design) continue
    designs.set(network.addRoad(alignment, className), design)
  }

  // Excavate the terrain down to every road's design line before anything is
  // rendered, so each road sits in a real cutting/embankment rather than
  // buried inside (or floating above) untouched ground. All three roads
  // accumulate onto the same edit layer so the junction area — where more
  // than one corridor's footprint overlaps — is carved consistently.
  const editLayer = new TerrainEditLayer(terrain)
  for (const road of network.roads) {
    const design = designs.get(road.id)
    if (!design || design.length === 0) continue
    excavateCorridor(editLayer, road.alignment, design, road.className)
  }

  // Structures are measured against NATURAL ground, not `editLayer`. The edit
  // layer has already been cut and filled to the design surface, so under the
  // road it sits at the design line by construction: every station would read
  // as level, no station could exceed the fill allowance, and neither the
  // bridge nor the wall trigger could fire at all.
  const built = buildNetworkMesh(network, designs, {
    spacing: 4,
    terrain,
    maxFillHeight: MAX_FILL_HEIGHT,
    corridorBatters: CORRIDOR_BATTERS,
  })

  return { terrain, network, designs, editLayer, built }
}

export const drawRoadScene = (canvas: HTMLCanvasElement): (() => void) => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setClearColor(0x14181d)

  const scene = new THREE.Scene()
  // Pushed well past the orbit radius (~1400m) so it no longer greys out
  // the terrain and road; kept as gentle depth cueing near the far clip.
  scene.fog = new THREE.Fog(0x14181d, 3800, 6000)

  const camera = new THREE.PerspectiveCamera(45, 1, 1, 6000)

  // three r185 uses physically-based lighting, so intensities read very
  // differently to older three.js versions — these are tuned by eye to
  // give the terrain clear form and separate the three road layers.
  scene.add(new THREE.HemisphereLight(0xbdd7ff, 0x3a3227, 3.5))
  const sun = new THREE.DirectionalLight(0xfff2d8, 4.5)
  sun.position.set(-600, 900, 400)
  scene.add(sun)

  const { terrain, editLayer, built } = buildSceneContent()
  const terrainSource: { sample(x: number, y: number): number } = editLayer

  for (const [, roadMesh] of built.roads) {
    for (const layer of roadMesh.layers) {
      if (layer.mesh.vertexCount === 0) continue
      scene.add(new THREE.Mesh(
        toBufferGeometry(layer.mesh),
        new THREE.MeshStandardMaterial({
          color: LAYER_COLOURS[layer.name] ?? 0x888888,
          roughness: 0.9,
          side: THREE.DoubleSide,
        }),
      ))
    }
  }

  for (const [, junctionMesh] of built.junctions) {
    if (junctionMesh.vertexCount === 0) continue
    scene.add(new THREE.Mesh(
      toBufferGeometry(junctionMesh),
      new THREE.MeshStandardMaterial({
        color: LAYER_COLOURS.wearing ?? 0x2e3033,
        roughness: 0.9,
        side: THREE.DoubleSide,
      }),
    ))
  }

  if (built.infeasibleJunctions.size > 0) {
    console.warn('infeasible junctions', [...built.infeasibleJunctions.entries()])
  }
  if (built.elevationMismatches.size > 0) {
    console.warn('junction elevation mismatches', [...built.elevationMismatches.entries()])
  }

  const STRUCTURE_COLOUR = 0x9a958c

  for (const [, structureMesh] of built.structures) {
    if (structureMesh.vertexCount === 0) continue
    scene.add(new THREE.Mesh(
      toBufferGeometry(structureMesh),
      new THREE.MeshStandardMaterial({
        color: STRUCTURE_COLOUR, roughness: 0.85, side: THREE.DoubleSide,
      }),
    ))
  }

  if (built.tightCrossings.size > 0) {
    console.warn('crossings below minimum clearance', [...built.tightCrossings.entries()])
  }

  scene.add(new THREE.Mesh(
    terrainGeometry(terrain, 1, terrainSource),
    // DoubleSide: the raised orbit camera looks down on the terrain from
    // angles the old near-level fixed camera never reached, and the grid
    // winding culls as back-facing from directly above without this.
    new THREE.MeshStandardMaterial({
      color: 0x7a8a63, roughness: 0.95, flatShading: false, side: THREE.DoubleSide,
    }),
  ))

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

  // Slow automatic orbit around the road's midpoint, at a raised angle
  // looking down, so every side of the terrain and the layer stepping is
  // eventually visible without manual input.
  let frame = 0
  const tick = (timeMs: number) => {
    frame = requestAnimationFrame(tick)
    // Belt and suspenders alongside the ResizeObserver above: cheap enough
    // to check every frame, and it catches the box changing size for any
    // reason the observer's host environment fails to notify for (some
    // embeddings/automation contexts never deliver a ResizeObserver
    // callback at all), rather than leaving the canvas stuck at a stale
    // resolution until something else happens to touch it.
    resize(canvas.clientWidth, canvas.clientHeight)
    const angle = (timeMs / 1000 / ORBIT_PERIOD_S) * Math.PI * 2
    camera.position.set(
      ORBIT_CENTER.x + Math.cos(angle) * ORBIT_RADIUS,
      ORBIT_CENTER.y + ORBIT_HEIGHT,
      ORBIT_CENTER.z + Math.sin(angle) * ORBIT_RADIUS,
    )
    camera.lookAt(ORBIT_CENTER)
    renderer.render(scene, camera)
  }
  tick(0)

  return () => {
    cancelAnimationFrame(frame)
    resizeObserver.disconnect()
    renderer.dispose()
  }
}
