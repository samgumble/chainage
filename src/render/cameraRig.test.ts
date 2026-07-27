import { describe, expect, it } from 'vitest'
import {
  CameraRig,
  MAX_DISTANCE,
  MAX_ELEVATION,
  MIN_DISTANCE,
  MIN_ELEVATION,
} from './cameraRig'

describe('CameraRig', () => {
  it('places the camera at the requested distance from the target', () => {
    const rig = new CameraRig({ x: 100, y: 200, z: 10 }, 800)
    const { position, target } = rig
    const d = Math.hypot(
      position.x - target.x,
      position.y - target.y,
      position.z - target.z,
    )
    expect(d).toBeCloseTo(800, 3)
  })

  it('places the camera above the target', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 0 }, 500)
    expect(rig.position.z).toBeGreaterThan(0)
  })

  it('moves the camera around the target when orbiting, keeping the distance', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 0 }, 500)
    const before = { ...rig.position }
    rig.orbit(Math.PI / 2, 0)
    const after = rig.position

    expect(Math.hypot(after.x, after.y, after.z)).toBeCloseTo(500, 3)
    expect(after.x).not.toBeCloseTo(before.x, 1)
  })

  it('a full turn returns the camera to where it started', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 0 }, 500)
    const before = { ...rig.position }
    rig.orbit(Math.PI * 2, 0)
    expect(rig.position.x).toBeCloseTo(before.x, 6)
    expect(rig.position.y).toBeCloseTo(before.y, 6)
    expect(rig.position.z).toBeCloseTo(before.z, 6)
  })

  it('clamps elevation below vertical', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 0 }, 500)
    rig.orbit(0, 10)
    expect(rig.elevation).toBeLessThanOrEqual(MAX_ELEVATION)
    // At exactly vertical the azimuth stops meaning anything.
    expect(MAX_ELEVATION).toBeLessThan(Math.PI / 2)
  })

  it('clamps elevation above the horizon', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 0 }, 500)
    rig.orbit(0, -10)
    expect(rig.elevation).toBeGreaterThanOrEqual(MIN_ELEVATION)
    expect(MIN_ELEVATION).toBeGreaterThan(0)
    // Above the horizon means the camera stays above the target's plane.
    expect(rig.position.z).toBeGreaterThan(0)
  })

  it('zooms within bounds', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 0 }, 500)
    rig.zoom(0.5)
    expect(rig.distance).toBeCloseTo(250, 6)

    rig.zoom(0.0001)
    expect(rig.distance).toBe(MIN_DISTANCE)

    rig.zoom(100000)
    expect(rig.distance).toBe(MAX_DISTANCE)
  })

  it('rejects a non-positive zoom factor', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 0 }, 500)
    expect(() => rig.zoom(0)).toThrow(RangeError)
    expect(() => rig.zoom(-1)).toThrow(RangeError)
  })

  // At azimuth 0 the camera sits due east of the target (position.x =
  // target.x + horizontal, position.y = target.y). So the camera's forward
  // (camera -> target) is due west = (-1, 0), and right is forward turned
  // 90 degrees clockwise seen from above = due north = (0, 1). A pan of
  // (dRight, dForward) must move the target by dRight*right + dForward*forward.
  it('pans the target in the camera\'s own frame at azimuth 0 (world axes aligned)', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 0 }, 500)
    rig.orbit(-rig.azimuth, 0) // azimuth = 0
    const before = { ...rig.target }
    rig.pan(30, 40)

    // right*30 + forward*40 = (0,1)*30 + (-1,0)*40 = (-40, 30)
    expect(rig.target.x - before.x).toBeCloseTo(-40, 6)
    expect(rig.target.y - before.y).toBeCloseTo(30, 6)
  })

  // Same check at an azimuth that is not a multiple of pi/2, so an
  // implementation that only happens to be right on the cardinal axes
  // (e.g. a world-axis pan, since world x/y are also orthogonal unit
  // vectors) gets caught in between.
  it('pans the target in the camera\'s own frame at an oblique azimuth', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 0 }, 500)
    rig.orbit(Math.PI / 3 - rig.azimuth, 0) // azimuth = pi/3
    const before = { ...rig.target }
    rig.pan(30, 40)

    // forward = (-cos(pi/3), -sin(pi/3)), right = (forwardY, -forwardX)
    // right*30 + forward*40 = (-45.98076211353316, -19.64101615137754)
    expect(rig.target.x - before.x).toBeCloseTo(-45.980762, 5)
    expect(rig.target.y - before.y).toBeCloseTo(-19.641016, 5)
  })

  it('keeps panning horizontal however steep the view', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 50 }, 500)
    rig.orbit(0, 10) // clamped to near-vertical (elevation close to pi/2)
    const before = { ...rig.target }
    rig.pan(0, 100)

    // If forward were the camera's true (tilted) view direction rather than
    // its heading projected onto the ground, the horizontal distance covered
    // would shrink to 100 * cos(elevation) as the view steepens - here that
    // would be nowhere near 100. It must stay exactly 100 regardless of
    // elevation.
    const horizontal = Math.hypot(rig.target.x - before.x, rig.target.y - before.y)
    expect(horizontal).toBeCloseTo(100, 6)
    expect(rig.target.z).toBeCloseTo(before.z, 9)
  })

  it('rejects a non-positive starting distance', () => {
    expect(() => new CameraRig({ x: 0, y: 0, z: 0 }, 0)).toThrow(RangeError)
  })

  it('is not affected by later mutation of the object passed to the constructor', () => {
    // A caller can hold the same object through a wider mutable type even
    // though Vec3's fields are individually readonly.
    const passedIn: { x: number; y: number; z: number } = { x: 1, y: 2, z: 3 }
    const rig = new CameraRig(passedIn, 500)

    passedIn.x = 999
    passedIn.y = 999
    passedIn.z = 999

    expect(rig.target.x).toBe(1)
    expect(rig.target.y).toBe(2)
    expect(rig.target.z).toBe(3)
  })

  it('is not affected by mutation of the object returned by the target getter', () => {
    const rig = new CameraRig({ x: 1, y: 2, z: 3 }, 500)

    const captured = rig.target as { x: number; y: number; z: number }
    captured.x = 999
    captured.y = 999
    captured.z = 999

    expect(rig.target.x).toBe(1)
    expect(rig.target.y).toBe(2)
    expect(rig.target.z).toBe(3)
  })
})
