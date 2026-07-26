import * as THREE from 'three'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { filletCorner } from '../geometry/fillet'
import { vec2, angleOf, sub, distance, fromAngle, type Vec2 } from '../geometry/vec2'
import { generateValley } from '../terrain/generate'
import type { Heightmap } from '../terrain/heightmap'
import { sampleGroundProfile, designElevationAtStation, type ProfilePoint } from '../terrain/groundProfile'
import { solveGradeProfile } from '../terrain/gradeSolver'
import { TerrainEditLayer } from '../terrain/editLayer'
import { designSurfaceAtOffset, type CorridorTemplate } from '../terrain/corridor'
import { ROAD_CLASSES, formationHalfWidth, totalPavementThickness } from '../mesh/roadClass'
import { buildRoadMesh } from '../mesh/roadMesh'
import { toBufferGeometry } from '../render/meshAdapter'
import { terrainGeometry } from '../render/terrainMesh'

const CURVE_RADIUS = 400
const MAX_GRADE = 0.07
const MAX_CUT_DEPTH = 12
const MAX_FILL_HEIGHT = 10

/** Earthworks cross-section used to carve the corridor into the terrain,
 * consistent with the road actually being drawn (see ROAD_CLASSES.rural). */
const CORRIDOR_TEMPLATE: CorridorTemplate = {
  formationHalfWidth: formationHalfWidth(ROAD_CLASSES.rural),
  cutSlope: 2,
  fillSlope: 3,
}

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

const buildAlignment = (a: Vec2, corner: Vec2, b: Vec2): Alignment | null => {
  const dIn = sub(corner, a)
  const dOut = sub(b, corner)
  const fillet = filletCorner(corner, dIn, dOut, CURVE_RADIUS)
  if (!fillet) return null
  const inLength = distance(a, fillet.tangentIn)
  const outLength = distance(fillet.tangentOut, b)
  if (inLength <= 0 || outLength <= 0) return null
  return new Alignment([
    new Line(a, angleOf(dIn), inLength),
    fillet.arc,
    new Line(fillet.tangentOut, angleOf(dOut), outLength),
  ])
}

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
 */
const excavateCorridor = (
  terrain: Heightmap,
  alignment: Alignment,
  profile: readonly ProfilePoint[],
  template: CorridorTemplate,
): TerrainEditLayer => {
  const layer = new TerrainEditLayer(terrain)
  if (alignment.isEmpty || profile.length === 0) return layer

  const transverseStep = terrain.cellSize
  const maxSlope = Math.max(template.cutSlope, template.fillSlope)
  const steps = Math.max(1, Math.ceil(alignment.length / EXCAVATION_STATION_SPACING))

  // The design profile is the top of the finished road (top of the wearing
  // course), not the terrain elevation the road should rest on. The terrain
  // under the road is the subgrade's underside — the design elevation less
  // the full pavement stack — plus a small margin against z-fighting. Using
  // an arbitrary clearance instead of this would either bury the pavement in
  // cut sections or leave it floating above the embankment in fill sections.
  const pavementDepth = totalPavementThickness(ROAD_CLASSES.rural)

  for (let i = 0; i <= steps; i++) {
    const s = Math.min(i * EXCAVATION_STATION_SPACING, alignment.length)
    const pose = alignment.poseAt(s)
    const designZ = designElevationAtStation(profile, s) - pavementDepth - EXCAVATION_ZFIGHT_MARGIN

    const centreGroundZ = terrain.sample(pose.position.x, pose.position.y)
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

  return layer
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

  // Fine enough that the excavated corridor (a 10m-wide formation) isn't lost
  // between grid nodes: at the original 20m cellSize, a single cell spans the
  // whole formation width plus both batters, so the cut/fill dissolves into
  // the surrounding terrain's own noise instead of reading as an engineered
  // surface. Same 2560m footprint as before, just twice the density.
  const terrain = generateValley({
    cols: 257, rows: 257, cellSize: 10,
    floorElevation: 100, ridgeHeight: 70, valleyHalfWidth: 400, seed: 7,
  })

  const alignment = buildAlignment(vec2(200, 1300), vec2(1400, 1200), vec2(2400, 1340))

  // Falls back to the raw heightmap when there is no alignment (or no
  // feasible grade solution) to excavate against.
  let terrainSource: { sample(x: number, y: number): number } = terrain

  if (alignment) {
    const ground = sampleGroundProfile(alignment, terrain, 10)
    const solution = solveGradeProfile(ground, {
      maxGrade: MAX_GRADE,
      maxCutDepth: MAX_CUT_DEPTH,
      maxFillHeight: MAX_FILL_HEIGHT,
    })

    if (solution.feasible) {
      // Excavate the terrain down to the design line before anything is
      // rendered, so the road sits in a real cutting/embankment rather than
      // buried inside (or floating above) untouched ground.
      const editLayer = excavateCorridor(terrain, alignment, solution.profile, CORRIDOR_TEMPLATE)
      terrainSource = editLayer

      // Deliberately part-built, so all three layers are visible at once.
      const total = alignment.length
      const road = buildRoadMesh(
        alignment, solution.profile, ROAD_CLASSES.rural,
        { subgrade: total, base: total * 0.72, wearing: total * 0.45 },
        { spacing: 4 },
      )

      for (const layer of road.layers) {
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
