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

/** Layer colours: dark earth, grey aggregate, near-black asphalt. */
const LAYER_COLOURS: Record<string, number> = {
  subgrade: 0x6b5c48,
  base: 0x8a8a86,
  wearing: 0x2e3033,
}

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
  scene.fog = new THREE.Fog(0x14181d, 1200, 3200)

  const camera = new THREE.PerspectiveCamera(45, 1, 1, 6000)

  scene.add(new THREE.HemisphereLight(0xbdd7ff, 0x3a3227, 1.1))
  const sun = new THREE.DirectionalLight(0xfff2d8, 2.2)
  sun.position.set(-600, 900, 400)
  scene.add(sun)

  const terrain = generateValley({
    cols: 129, rows: 129, cellSize: 20,
    floorElevation: 100, ridgeHeight: 70, valleyHalfWidth: 400, seed: 7,
  })

  scene.add(new THREE.Mesh(
    terrainGeometry(terrain, 1),
    new THREE.MeshStandardMaterial({ color: 0x5e6b4a, roughness: 0.95, flatShading: false }),
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

  // Look along the road from above and behind its start.
  camera.position.set(-200, 420, -700)
  camera.lookAt(1300, 110, -1280)

  const resize = () => {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  resize()
  window.addEventListener('resize', resize)

  let frame = 0
  const tick = () => {
    frame = requestAnimationFrame(tick)
    renderer.render(scene, camera)
  }
  tick()

  return () => {
    cancelAnimationFrame(frame)
    window.removeEventListener('resize', resize)
    renderer.dispose()
  }
}
