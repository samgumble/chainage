import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import { ROAD_CLASSES } from '../network/roadClass'
import type { RoadId } from '../network/graph'
import type { ProfilePoint } from '../terrain/groundProfile'
import type { DrivableRoad } from '../traffic/fleet'
import { VEHICLE_LENGTH } from '../traffic/lane'
import { TrafficView, VEHICLE_HEIGHT, VEHICLE_WIDTH } from './trafficView'
import { placeVehicle } from './vehiclePlacement'

const road = (
  id: RoadId,
  heading: number,
  length: number,
  className: DrivableRoad['className'],
): DrivableRoad => ({
  id,
  alignment: new Alignment([new Line(vec2(0, 0), heading, length)]),
  className,
})

const level = (length: number, z: number): ProfilePoint[] => [
  { s: 0, z },
  { s: length, z },
]

/** Run the view for `seconds` of simulated time at 60fps. */
const run = (view: TrafficView, seconds: number): void => {
  for (let i = 0; i < seconds * 60; i++) view.advance(1 / 60)
}

describe('TrafficView', () => {
  it('draws exactly as many instances as there are vehicles', () => {
    const view = new TrafficView()
    const roads = [road(0, 0, 600, 'rural'), road(1, Math.PI / 2, 300, 'gravel')]
    view.sync(roads, new Map([[0, level(600, 100)], [1, level(300, 100)]]))

    expect(view.mesh.count).toBe(0)
    run(view, 20)
    expect(view.vehicleCount).toBeGreaterThan(2)
    expect(view.mesh.count).toBe(view.vehicleCount)
    view.dispose()
  })

  it('gives no traffic to a road with no design profile', () => {
    // The infeasible-road case: the road exists in the graph and its mesh is
    // flattened to z=0, so cars on it would be tens of metres underground.
    const view = new TrafficView()
    view.sync([road(0, 0, 600, 'rural'), road(1, 0, 300, 'gravel')], new Map([[0, level(600, 100)]]))
    run(view, 20)

    expect(view.vehicleCount).toBeGreaterThan(0)
    const positions = instancePositions(view)
    for (const p of positions) expect(p.y).toBeGreaterThan(50)
    view.dispose()
  })

  it('gives no traffic to a road whose design profile is empty', () => {
    const view = new TrafficView()
    view.sync([road(0, 0, 600, 'rural')], new Map([[0, []]]))
    run(view, 20)
    expect(view.vehicleCount).toBe(0)
    expect(view.mesh.count).toBe(0)
    view.dispose()
  })

  it('converts to three.js handedness as (x, y, z) -> (x, z, -y)', () => {
    const view = new TrafficView()
    const r = road(0, 0, 600, 'rural')
    view.sync([r], new Map([[0, level(600, 100)]]))
    run(view, 20)

    const drawn = instancePositions(view)
    expect(drawn.length).toBeGreaterThan(0)

    // Every drawn instance must correspond to some vehicle station, placed by
    // the pure function and flipped exactly once.
    const expected: THREE.Vector3[] = []
    for (const station of stations(view)) {
      const pose = placeVehicle(r.alignment, level(600, 100), ROAD_CLASSES.rural, station)
      expected.push(new THREE.Vector3(pose.x, pose.z, -pose.y))
    }

    drawn.sort((a, b) => a.x - b.x)
    expected.sort((a, b) => a.x - b.x)
    expect(drawn.length).toBe(expected.length)
    for (let i = 0; i < drawn.length; i++) {
      expect(drawn[i]!.x).toBeCloseTo(expected[i]!.x, 5)
      expect(drawn[i]!.y).toBeCloseTo(expected[i]!.y, 5)
      expect(drawn[i]!.z).toBeCloseTo(expected[i]!.z, 5)
    }
    view.dispose()
  })

  it('points a vehicle along its road, not across it', () => {
    // A project heading of θ must come out as three-space forward
    // (cos θ, 0, -sin θ). Negating the angle — the natural mistake when a
    // handedness flip is involved — mirrors every car about its road on any
    // heading but due east, and turns a northbound car to face south.
    for (const heading of [0, Math.PI / 2, Math.PI, -Math.PI / 3]) {
      const view = new TrafficView()
      view.sync([road(0, heading, 600, 'rural')], new Map([[0, level(600, 100)]]))
      run(view, 10)

      const matrix = new THREE.Matrix4()
      view.mesh.getMatrixAt(0, matrix)
      const forward = new THREE.Vector3(1, 0, 0).applyMatrix4(matrix).sub(
        new THREE.Vector3(0, 0, 0).applyMatrix4(matrix),
      )
      expect(forward.x).toBeCloseTo(Math.cos(heading), 5)
      expect(forward.y).toBeCloseTo(0, 5)
      expect(forward.z).toBeCloseTo(-Math.sin(heading), 5)
      view.dispose()
    }
  })

  it('stands the body on the road surface rather than through it', () => {
    const view = new TrafficView()
    view.sync([road(0, 0, 600, 'gravel')], new Map([[0, level(600, 100)]]))
    run(view, 10)

    // The geometry was translated up by half its height, so its own local
    // origin is at the wheels: the instance is placed at the road SURFACE and
    // the box stands on it. Without the translate, every car is buried to its
    // waist in the seal — which reads as a bug in the road, not in the car.
    view.mesh.geometry.computeBoundingBox()
    const box = view.mesh.geometry.boundingBox
    expect(box).not.toBeNull()
    expect(box!.min.y).toBeCloseTo(0, 5)
    expect(box!.max.y).toBeCloseTo(VEHICLE_HEIGHT, 5)

    // Gravel has no lane offset, so there is no crossfall drop either: the
    // instance origin sits exactly on the 100m design line.
    const matrix = new THREE.Matrix4()
    view.mesh.getMatrixAt(0, matrix)
    expect(new THREE.Vector3().setFromMatrixPosition(matrix).y).toBeCloseTo(100, 5)
    view.dispose()
  })

  it('sizes the box to the length the model measures gaps in', () => {
    const view = new TrafficView()
    view.mesh.geometry.computeBoundingBox()
    const box = view.mesh.geometry.boundingBox
    expect(box).not.toBeNull()
    expect(box!.max.x - box!.min.x).toBeCloseTo(VEHICLE_LENGTH, 5)
    expect(box!.max.z - box!.min.z).toBeCloseTo(VEHICLE_WIDTH, 5)
    view.dispose()
  })

  it('shares one geometry and one material across the whole fleet', () => {
    const view = new TrafficView()
    view.sync([road(0, 0, 600, 'rural')], new Map([[0, level(600, 100)]]))
    run(view, 30)
    expect(view.vehicleCount).toBeGreaterThan(3)
    // An InstancedMesh is one geometry and one material by construction; this
    // pins that the fleet is drawn as one rather than as a mesh per car.
    expect(view.mesh).toBeInstanceOf(THREE.InstancedMesh)
    expect(Array.isArray(view.mesh.material)).toBe(false)
    view.dispose()
  })

  it('stops drawing a road’s traffic when the road is deleted', () => {
    const view = new TrafficView()
    const roads = [road(0, 0, 600, 'rural'), road(1, Math.PI / 2, 300, 'gravel')]
    const designs = new Map([[0, level(600, 100)], [1, level(300, 100)]])
    view.sync(roads, designs)
    run(view, 20)
    const both = view.mesh.count
    expect(both).toBeGreaterThan(2)

    view.sync([roads[0]!], new Map([[0, level(600, 100)]]))
    view.advance(1 / 60)
    expect(view.mesh.count).toBeLessThan(both)
    // Nothing left driving through empty air where the deleted road was: that
    // road ran north, so every remaining instance is on the eastbound one.
    for (const p of instancePositions(view)) expect(Math.abs(p.z)).toBeLessThan(10)
    view.dispose()
  })

  it('keeps drawing after a rebuild that changes nothing', () => {
    const view = new TrafficView()
    const roads = [road(0, 0, 600, 'rural')]
    const designs = new Map([[0, level(600, 100)]])
    view.sync(roads, designs)
    run(view, 20)
    const before = view.mesh.count

    view.sync(roads, designs)
    view.advance(1 / 60)
    expect(view.mesh.count).toBe(before)
    view.dispose()
  })

  it('survives a frame delta of several seconds', () => {
    const view = new TrafficView()
    view.sync([road(0, 0, 600, 'rural')], new Map([[0, level(600, 100)]]))
    expect(() => view.advance(45)).not.toThrow()
    expect(view.mesh.count).toBe(view.vehicleCount)
    view.dispose()
  })

  it('disposes without throwing', () => {
    const view = new TrafficView()
    view.sync([road(0, 0, 600, 'rural')], new Map([[0, level(600, 100)]]))
    run(view, 5)
    expect(() => view.dispose()).not.toThrow()
  })

  it('draws no more instances than the buffer holds', () => {
    // An `InstancedMesh`'s matrix buffer is allocated once at its declared
    // count. Setting `mesh.count` above it does not grow the buffer — three
    // uploads that many instances from a buffer that ends sooner, and the draw
    // call reads past it. Every other test in this file runs well under
    // `FLEET_CAPACITY`, so nothing else can reach the guard at all.
    const warnings: string[] = []
    const warn = console.warn
    console.warn = (message: string): void => { warnings.push(message) }
    try {
      const view = new TrafficView(8)
      const roads = Array.from({ length: 6 }, (_, i) => road(i, (i * Math.PI) / 6, 4000, 'rural'))
      view.sync(roads, new Map(roads.map((r) => [r.id, level(4000, 100)])))
      run(view, 100)

      // Far more traffic than the buffer: the simulation is not capped, only
      // the drawing is.
      expect(view.vehicleCount).toBeGreaterThan(8)
      expect(view.mesh.count).toBe(8)
      expect(view.mesh.count).toBeLessThanOrEqual(view.mesh.instanceMatrix.count)

      // Every drawn matrix is a real vehicle's, not a stale or zeroed slot.
      for (const p of instancePositions(view)) {
        expect(p.y).toBeCloseTo(100 - 1.75 * ROAD_CLASSES.rural.crossfall, 5)
      }

      // Once, not once per frame: six thousand identical console lines is its
      // own bug.
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('8')
      view.dispose()
    } finally {
      console.warn = warn
    }
  })
})

const instancePositions = (view: TrafficView): THREE.Vector3[] => {
  const matrix = new THREE.Matrix4()
  const out: THREE.Vector3[] = []
  for (let i = 0; i < view.mesh.count; i++) {
    view.mesh.getMatrixAt(i, matrix)
    out.push(new THREE.Vector3().setFromMatrixPosition(matrix))
  }
  return out
}

/**
 * The stations the drawn instances are at, recovered from the draw itself.
 *
 * Only valid for a road built as a straight from the origin on heading 0, for
 * which three-space x IS the station (the lane offset is entirely in y, and
 * the flip leaves x alone). The point of recovering it rather than asking the
 * simulation is that the check it feeds is then about the two components x
 * does not determine — the lane offset and the elevation — against the pure
 * placement function.
 */
const stations = (view: TrafficView): number[] => {
  const matrix = new THREE.Matrix4()
  const out: number[] = []
  for (let i = 0; i < view.mesh.count; i++) {
    view.mesh.getMatrixAt(i, matrix)
    out.push(new THREE.Vector3().setFromMatrixPosition(matrix).x)
  }
  return out
}
