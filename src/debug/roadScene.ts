import * as THREE from 'three'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2, fromAngle, type Vec2 } from '../geometry/vec2'
import type { PolylineRejection } from '../geometry/polyline'
import { generateValley } from '../terrain/generate'
import { sampleGroundProfile, designElevationAtStation, type ProfilePoint } from '../terrain/groundProfile'
import { solveGradeProfile, type GradeSolution } from '../terrain/gradeSolver'
import { TerrainEditLayer } from '../terrain/editLayer'
import { designSurfaceAtOffset, type CorridorTemplate, type CorridorBatters } from '../terrain/corridor'
import { rayTerrainIntersection, type Ray3, type Vec3 as GroundVec3 } from '../terrain/rayCast'
import type { Heightmap, TerrainSampler } from '../terrain/heightmap'
import { ROAD_CLASSES, formationHalfWidth, totalPavementThickness, type RoadClassName } from '../network/roadClass'
import { toBufferGeometry } from '../render/meshAdapter'
import { terrainGeometry } from '../render/terrainMesh'
import { CameraRig, type Vec3 as RigVec3 } from '../render/cameraRig'
import { RoadNetwork, type RoadId } from '../network/graph'
import { buildNetworkMesh, type NetworkMesh } from '../mesh/networkMesh'
import { DrawTool, SNAP_RADIUS } from '../tool/drawTool'
import { resolveSnap, type SnapTarget } from '../tool/snap'
import { SelectTool, type SplitOutcome } from '../tool/selectTool'
import {
  describeSplitOutcome,
  describeUpgradeObstacles,
  describeInfeasibleRoads,
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

/** Structure (bridge/wall) colour — a neutral stone tone distinct from every
 * pavement layer, so a structure reads as a different kind of thing rather
 * than an odd-coloured road. */
const STRUCTURE_COLOUR = 0x9a958c

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
}

/** Grade a single alignment against natural ground: the full solver result,
 * feasible or not, so a caller that needs to know why can see the station
 * where the solve ran out of room. */
const solveFor = (alignment: Alignment, terrain: Heightmap): GradeSolution => {
  const ground = sampleGroundProfile(alignment, terrain, 10)
  return solveGradeProfile(ground, {
    maxGrade: MAX_GRADE,
    maxCutDepth: MAX_CUT_DEPTH,
    maxFillHeight: MAX_FILL_HEIGHT,
    maxStructureHeight: MAX_STRUCTURE_HEIGHT,
  })
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
 */
export const solveNetwork = (
  terrain: Heightmap,
  network: RoadNetwork,
): {
  designs: Map<RoadId, ProfilePoint[]>
  editLayer: TerrainEditLayer
  built: NetworkMesh
  infeasibleRoads: Map<RoadId, number>
} => {
  const designs = new Map<RoadId, ProfilePoint[]>()
  const infeasibleRoads = new Map<RoadId, number>()
  for (const road of network.roads) {
    const solution = solveFor(road.alignment, terrain)
    if (solution.feasible) {
      designs.set(road.id, solution.profile)
    } else {
      infeasibleRoads.set(road.id, solution.failedAtStation)
    }
  }

  // Excavate the terrain down to every road's design line before anything is
  // rendered, so each road sits in a real cutting/embankment rather than
  // buried inside (or floating above) untouched ground. All roads accumulate
  // onto the same edit layer so overlapping corridor footprints (junctions)
  // are carved consistently.
  const editLayer = new TerrainEditLayer(terrain)
  for (const road of network.roads) {
    const design = designs.get(road.id)
    if (!design || design.length === 0) continue
    excavateCorridor(editLayer, road.alignment, design, road.className)
  }

  // Structures are measured against NATURAL ground, not the edit layer. The
  // edit layer has already been cut and filled to the design surface, so
  // under the road it sits at the design line by construction: every station
  // would read as level, no station could exceed the fill allowance, and
  // neither the bridge nor the wall trigger could fire at all.
  const built = buildNetworkMesh(network, designs, {
    spacing: 4,
    terrain,
    maxFillHeight: MAX_FILL_HEIGHT,
    corridorBatters: CORRIDOR_BATTERS,
  })

  return { designs, editLayer, built, infeasibleRoads }
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

  const { designs, editLayer, built, infeasibleRoads } = solveNetwork(terrain, network)
  return { terrain, network, designs, editLayer, built, infeasibleRoads }
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
const addNetworkMeshes = (
  scene: THREE.Scene,
  terrain: Heightmap,
  editLayer: TerrainEditLayer,
  built: NetworkMesh,
  infeasibleRoads: ReadonlyMap<RoadId, number>,
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

  for (const [, roadMesh] of built.roads) {
    for (const layer of roadMesh.layers) {
      if (layer.mesh.vertexCount === 0) continue
      const mesh = new THREE.Mesh(
        toBufferGeometry(layer.mesh),
        new THREE.MeshStandardMaterial({
          color: LAYER_COLOURS[layer.name] ?? 0x888888,
          roughness: 0.9,
          side: THREE.DoubleSide,
        }),
      )
      scene.add(mesh)
      meshes.push(mesh)
    }
  }

  for (const [, junctionMesh] of built.junctions) {
    if (junctionMesh.vertexCount === 0) continue
    const mesh = new THREE.Mesh(
      toBufferGeometry(junctionMesh),
      new THREE.MeshStandardMaterial({
        color: LAYER_COLOURS.wearing ?? 0x2e3033,
        roughness: 0.9,
        side: THREE.DoubleSide,
      }),
    )
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
    const mesh = new THREE.Mesh(
      toBufferGeometry(structureMesh),
      new THREE.MeshStandardMaterial({
        color: STRUCTURE_COLOUR, roughness: 0.85, side: THREE.DoubleSide,
      }),
    )
    scene.add(mesh)
    meshes.push(mesh)
  }

  if (built.tightCrossings.size > 0) {
    console.warn('crossings below minimum clearance', [...built.tightCrossings.entries()])
  }

  const terrainMesh = new THREE.Mesh(
    terrainGeometry(terrain, 1, editLayer),
    // DoubleSide: the raised camera can look down on the terrain from angles
    // a near-level fixed camera never reached, and the grid winding culls as
    // back-facing from directly above without this.
    new THREE.MeshStandardMaterial({
      color: 0x7a8a63, roughness: 0.95, flatShading: false, side: THREE.DoubleSide,
    }),
  )
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

  const scene = new THREE.Scene()
  // Pushed well past the camera's usual working distance so it no longer
  // greys out the terrain and road; kept as gentle depth cueing near the far
  // clip.
  scene.fog = new THREE.Fog(0x14181d, 3800, 6000)

  const camera = new THREE.PerspectiveCamera(45, 1, 1, 6000)

  // three r185 uses physically-based lighting, so intensities read very
  // differently to older three.js versions — these are tuned by eye to
  // give the terrain clear form and separate the three road layers.
  scene.add(new THREE.HemisphereLight(0xbdd7ff, 0x3a3227, 3.5))
  const sun = new THREE.DirectionalLight(0xfff2d8, 4.5)
  sun.position.set(-600, 900, 400)
  scene.add(sun)

  const content = buildSceneContent()
  const { terrain, network } = content
  let editLayer = content.editLayer
  let built = content.built
  let infeasibleRoads = content.infeasibleRoads
  let terrainSampler: TerrainSampler = editLayer

  // The tool draws in whatever class the player picked; there is no class
  // picker yet, so it draws rural roads until the selection UI exists.
  const tool = new DrawTool(network, 'rural')
  const selectTool = new SelectTool(network)

  /** Which of the two modes the player is currently in. Defaults to draw so
   * the scene opens exactly as it always has. */
  let toolMode: ToolMode = 'draw'
  setMessage('')

  let networkMeshes = addNetworkMeshes(scene, terrain, editLayer, built, infeasibleRoads)

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
    terrainSampler = editLayer

    for (const mesh of networkMeshes) {
      scene.remove(mesh)
      disposeMesh(mesh)
    }
    networkMeshes = addNetworkMeshes(scene, terrain, editLayer, built, infeasibleRoads)

    // A road with no feasible vertical alignment used to reach only the
    // console (see `SceneContent.infeasibleRoads`) — surfaced here so it is
    // visible after every rebuild, whatever mutation triggered it. Takes
    // priority over whatever message the caller already set: an infeasible
    // road is a standing problem with the network, not a transient result of
    // the action that happened to trigger this rebuild.
    const infeasibleMessage = describeInfeasibleRoads(infeasibleRoads)
    if (infeasibleMessage) setMessage(infeasibleMessage, 'refusal')
  }

  const attemptCommit = (): void => {
    const result = tool.commit()
    if (result.ok) {
      rebuildNetworkMeshes()
    } else {
      console.warn('commit rejected:', result.rejection.reason, result.rejection)
    }
  }

  // --- Camera rig ---------------------------------------------------------
  //
  // Targets the same place the old automatic orbit circled — ORBIT_CENTER
  // converted from three.js's (x, z, -y) back to the project's (x, y, z) — and
  // starts at the distance the old fixed radius/height implied, so the
  // initial framing is unchanged even though the motion is now pointer-driven
  // instead of automatic.
  const RIG_TARGET: RigVec3 = { x: 1300, y: 1300, z: 105 }
  const RIG_INITIAL_DISTANCE = Math.hypot(1400, 700)
  const rig = new CameraRig(RIG_TARGET, RIG_INITIAL_DISTANCE)

  /** Project convention `(x, y, z)`, `z` up, to three.js's `(x, z, -y)`. Must
   * stay the exact inverse of `threeToProject` below. Takes the camera rig's
   * own `Vec3` — this is only ever called with `rig.position`/`rig.target`. */
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

  /** Log a rejection once per distinct cause, not once per frame. */
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
   */
  const switchToolMode = (next: ToolMode): void => {
    if (next === toolMode) return
    if (toolMode === 'draw') {
      cancelPendingClick()
      tool.cancel()
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
        default:
          break
      }
      return
    }

    switch (event.key) {
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
    updatePreview()
    updateHighlight()
    renderer.render(scene, camera)
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

    renderer.dispose()
    messageEl.remove()
  }
}
