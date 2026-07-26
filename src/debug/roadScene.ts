import * as THREE from 'three'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { filletCorner } from '../geometry/fillet'
import { vec2, angleOf, sub, distance, type Vec2 } from '../geometry/vec2'
import { generateValley } from '../terrain/generate'
import { sampleGroundProfile } from '../terrain/groundProfile'
import { solveGradeProfile } from '../terrain/gradeSolver'
import { ROAD_CLASSES } from '../mesh/roadClass'
import { buildRoadMesh } from '../mesh/roadMesh'
import { toBufferGeometry } from '../render/meshAdapter'
import { terrainGeometry } from '../render/terrainMesh'

const CURVE_RADIUS = 400
const MAX_GRADE = 0.07
const MAX_CUT_DEPTH = 12
const MAX_FILL_HEIGHT = 10

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

  const terrain = generateValley({
    cols: 129, rows: 129, cellSize: 20,
    floorElevation: 100, ridgeHeight: 70, valleyHalfWidth: 400, seed: 7,
  })

  scene.add(new THREE.Mesh(
    terrainGeometry(terrain, 1),
    // DoubleSide: the raised orbit camera looks down on the terrain from
    // angles the old near-level fixed camera never reached, and the grid
    // winding culls as back-facing from directly above without this.
    new THREE.MeshStandardMaterial({
      color: 0x7a8a63, roughness: 0.95, flatShading: false, side: THREE.DoubleSide,
    }),
  ))

  const alignment = buildAlignment(vec2(200, 1300), vec2(1400, 1200), vec2(2400, 1340))

  if (alignment) {
    const ground = sampleGroundProfile(alignment, terrain, 10)
    const solution = solveGradeProfile(ground, {
      maxGrade: MAX_GRADE,
      maxCutDepth: MAX_CUT_DEPTH,
      maxFillHeight: MAX_FILL_HEIGHT,
    })

    if (solution.feasible) {
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

  const resize = () => {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  resize()
  window.addEventListener('resize', resize)

  // Slow automatic orbit around the road's midpoint, at a raised angle
  // looking down, so every side of the terrain and the layer stepping is
  // eventually visible without manual input.
  let frame = 0
  const tick = (timeMs: number) => {
    frame = requestAnimationFrame(tick)
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
    window.removeEventListener('resize', resize)
    renderer.dispose()
  }
}
