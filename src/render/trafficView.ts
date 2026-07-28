import * as THREE from 'three'
import type { RoadId } from '../network/graph'
import { ROAD_CLASSES, type RoadClassName } from '../network/roadClass'
import type { ProfilePoint } from '../terrain/groundProfile'
import type { Alignment } from '../geometry/alignment'
import { Fleet, type DrivableRoad } from '../traffic/fleet'
import { VEHICLE_LENGTH } from '../traffic/lane'
import { placeVehicle } from './vehiclePlacement'

/** Body width and height, metres. Length is `VEHICLE_LENGTH` — the same 4.5m
 * the car-following model measures bumper to bumper, so the gap the simulation
 * keeps is the gap the eye sees between two boxes. */
export const VEHICLE_WIDTH = 1.8
export const VEHICLE_HEIGHT = 1.5

/**
 * How many vehicles the instanced mesh has room for.
 *
 * An `InstancedMesh`'s instance buffers are allocated once at its declared
 * count, so this is a ceiling rather than a target: `mesh.count` is set to the
 * number actually in play each frame and the rest of the buffer is not drawn.
 * The demo network carries about thirty; five hundred leaves room for a player
 * who keeps drawing roads, and costs one 500×16 float matrix buffer.
 */
export const FLEET_CAPACITY = 500

/** The colour of a car. Bright and slightly warm, because the entire scene it
 * sits on — asphalt, concrete, cut earth — is desaturated, and traffic that
 * reads as part of the road surface is traffic nobody can see moving. */
const VEHICLE_COLOUR = 0xd8dbe0

type RoadEntry = {
  readonly alignment: Alignment
  readonly design: readonly ProfilePoint[]
  readonly className: RoadClassName
}

/**
 * The traffic simulation and the boxes that draw it.
 *
 * Owns a `Fleet` (no three.js) and one `InstancedMesh` (all of it), and is the
 * only place the two meet. `roadScene.ts` sees three verbs — `sync` when the
 * network changes, `advance` every frame, `dispose` at teardown — and never a
 * loop with geometry in it, which is where every defect on this project has
 * historically lived.
 *
 * One `BoxGeometry` and one `MeshStandardMaterial` for the whole fleet,
 * allocated in the constructor and never per frame. The per-frame work is
 * writing `count` matrices into a buffer that already exists.
 */
export class TrafficView {
  private readonly fleet = new Fleet()
  private readonly roads = new Map<RoadId, RoadEntry>()
  readonly mesh: THREE.InstancedMesh

  /** Scratch, reused for every instance of every frame. */
  private readonly matrix = new THREE.Matrix4()
  private readonly position = new THREE.Vector3()
  private readonly quaternion = new THREE.Quaternion()
  private readonly euler = new THREE.Euler()
  private readonly unitScale = new THREE.Vector3(1, 1, 1)
  private written = 0
  private warnedOverflow = false

  constructor(capacity: number = FLEET_CAPACITY) {
    // Local +x is forward, +z is across, +y is up — three's own convention,
    // reached from the project's by the same `(x, y, z) -> (x, z, -y)` map
    // `meshAdapter.ts` uses, applied below to the instance transform rather
    // than to vertices.
    const geometry = new THREE.BoxGeometry(VEHICLE_LENGTH, VEHICLE_HEIGHT, VEHICLE_WIDTH)
    // The pose this is placed at is the road SURFACE, so the box is shifted up
    // by half its height in its own local space. Otherwise every car is buried
    // to its waist in the seal — which reads as a rendering bug in the road,
    // not as a misplaced car.
    geometry.translate(0, VEHICLE_HEIGHT / 2, 0)

    this.mesh = new THREE.InstancedMesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: VEHICLE_COLOUR, roughness: 0.4, metalness: 0.1 }),
      capacity,
    )
    this.mesh.castShadow = true
    // Receives as well as casts: a car driving through the shade of a cutting
    // that stays sunlit is a brighter object than the road under it, which
    // reads as a car pasted onto the scene rather than one in it.
    this.mesh.receiveShadow = true
    // The instances are scattered across kilometres of terrain while the
    // geometry's own bounding sphere is a 4.5m box at the origin, so three's
    // frustum test would cull the entire fleet whenever the origin is off
    // screen — which, at this scene's framing, is always.
    this.mesh.frustumCulled = false
    this.mesh.count = 0
  }

  get vehicleCount(): number {
    return this.fleet.vehicleCount
  }

  /**
   * Point the simulation at the network's current roads.
   *
   * Only roads with a design profile get traffic. A road that failed to grade
   * has no entry in `designs` (see `SceneContent.infeasibleRoads`) and its mesh
   * is flattened to elevation zero; giving it cars would put them at z=0 too,
   * tens of metres underground, and the one honest answer for a road that was
   * never built is that nothing drives on it.
   */
  sync(
    roads: Iterable<DrivableRoad>,
    designs: ReadonlyMap<RoadId, readonly ProfilePoint[]>,
  ): void {
    this.roads.clear()
    const drivable: DrivableRoad[] = []

    for (const road of roads) {
      const design = designs.get(road.id)
      if (!design || design.length === 0) continue
      this.roads.set(road.id, {
        alignment: road.alignment,
        design,
        className: road.className,
      })
      drivable.push(road)
    }

    this.fleet.sync(drivable)
  }

  /**
   * Step the simulation by `elapsed` real seconds and rewrite every instance
   * matrix from the result.
   *
   * `elapsed` is a raw frame delta and may be anything at all, including the
   * several seconds a backgrounded tab hands back on its first frame — the
   * fixed-step accumulator inside `Fleet.advance` is what makes that safe.
   */
  advance(elapsed: number): void {
    this.fleet.advance(elapsed)

    this.written = 0
    this.fleet.forEachVehicle((roadId, station) => {
      const entry = this.roads.get(roadId)
      if (!entry) return
      if (this.written >= this.mesh.instanceMatrix.count) {
        if (!this.warnedOverflow) {
          this.warnedOverflow = true
          console.warn(
            `traffic: more than ${this.mesh.instanceMatrix.count} vehicles; the rest are not drawn`,
          )
        }
        return
      }

      const pose = placeVehicle(entry.alignment, entry.design, ROAD_CLASSES[entry.className], station)
      // `(x, y, z) -> (x, z, -y)`, and a project heading (counter-clockwise
      // from +x in the ground plane) becomes the same angle about three's +Y:
      // rotating local +x by θ about +Y gives `(cos θ, 0, -sin θ)`, which is
      // exactly where the flip sends the project-space direction
      // `(cos θ, sin θ, 0)`. Same angle, no negation — a sign error here turns
      // every car sideways to its own road.
      this.position.set(pose.x, pose.z, -pose.y)
      this.euler.set(0, pose.heading, 0)
      this.quaternion.setFromEuler(this.euler)
      this.matrix.compose(this.position, this.quaternion, this.unitScale)
      this.mesh.setMatrixAt(this.written, this.matrix)
      this.written++
    })

    this.mesh.count = this.written
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    const material = this.mesh.material
    if (Array.isArray(material)) {
      for (const m of material) m.dispose()
    } else {
      material.dispose()
    }
    this.mesh.dispose()
  }
}
