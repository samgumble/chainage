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

  it('pans the target in the camera\'s own frame, not the world\'s', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 0 }, 500)
    // Face along +x, then pan "forward": the target must move along the
    // camera's forward axis, not along world +y.
    rig.orbit(-rig.azimuth, 0)
    const before = { ...rig.target }
    rig.pan(0, 100)

    const moved = Math.hypot(rig.target.x - before.x, rig.target.y - before.y)
    expect(moved).toBeCloseTo(100, 3)
    expect(rig.target.z).toBeCloseTo(before.z, 9)
  })

  it('pans right perpendicular to forward', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 0 }, 500)
    const before = { ...rig.target }
    rig.pan(100, 0)
    const right = { x: rig.target.x - before.x, y: rig.target.y - before.y }

    const after = { ...rig.target }
    rig.pan(0, 100)
    const forward = { x: rig.target.x - after.x, y: rig.target.y - after.y }

    expect(right.x * forward.x + right.y * forward.y).toBeCloseTo(0, 6)
  })

  it('keeps panning horizontal however steep the view', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 50 }, 500)
    rig.orbit(0, 10)   // clamped to near-vertical
    const before = rig.target.z
    rig.pan(100, 100)
    expect(rig.target.z).toBeCloseTo(before, 9)
  })

  it('rejects a non-positive starting distance', () => {
    expect(() => new CameraRig({ x: 0, y: 0, z: 0 }, 0)).toThrow(RangeError)
  })
})
