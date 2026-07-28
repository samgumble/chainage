import { describe, expect, it } from 'vitest'
import { MAX_ZOOM_STEP_PER_SAMPLE, cameraMoveForTwoFinger, type CameraView } from './cameraGesture'
import { CameraRig, type Vec3 } from './cameraRig'

/** A view the camera is nowhere near either zoom limit in, so a test that
 * zooms can measure the factor rather than the clamp. */
const VIEW: CameraView = { distance: 500, verticalFovDegrees: 45, viewportHeightPx: 900 }

/**
 * World metres per screen pixel, restated from the frustum rather than
 * imported from `snapRadius.ts`.
 *
 * Deliberate duplication: importing the very function under test's own helper
 * would make every scaling assertion below tautological — it would pass just
 * as happily if the module multiplied by that helper twice, or not at all.
 */
const metresPerPixel = (view: CameraView): number =>
  (2 * view.distance * Math.tan((view.verticalFovDegrees * Math.PI) / 180 / 2)) /
  view.viewportHeightPx

/** A sample with nothing happening, so each test can turn on exactly one
 * component and attribute the whole result to it. */
const still = { pan: { dx: 0, dy: 0 }, pinch: 1, twist: 0 }

/** No pan at all. Through `Math.abs`, because negating a zero pixel delta
 * gives `-0`, which `toEqual` and `toBe` distinguish from `0` and a player
 * cannot — the same reason the "did not disturb the twist" assertions below
 * go through `Math.abs`. A test that only fails because a sign was flipped ON
 * A ZERO has not detected anything a player could feel, and would be a false
 * kill in a mutation run. */
const expectNoPan = (pan: { dRight: number; dForward: number }): void => {
  expect(Math.abs(pan.dRight)).toBe(0)
  expect(Math.abs(pan.dForward)).toBe(0)
}

// --- The screen basis, derived from the rig's public position -------------
//
// Where a world point appears on screen, in pixels from the centre of the
// frame. Used by the two "does it feel like direct manipulation" tests below,
// which are the only honest way to pin a sign: an assertion that `dRight` is
// negative is just the implementation written twice, whereas "the ground under
// the fingers stays under the fingers" is the thing a player would report.
//
// Derived from `rig.position` and `rig.target` alone — no restatement of the
// rig's internal azimuth arithmetic — and linearised at the target's own
// distance, which is exactly the depth `metresPerPixel` is the scale for.
const groundForward = (rig: CameraRig): { x: number; y: number } => {
  const to = rig.target
  const from = rig.position
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  return { x: dx / length, y: dy / length }
}

const screenOffset = (
  rig: CameraRig,
  point: Vec3,
  view: CameraView,
): { x: number; y: number } => {
  const forward = groundForward(rig)
  // Right is forward turned ninety degrees clockwise on the ground.
  const right = { x: forward.y, y: -forward.x }
  const target = rig.target
  const r = { x: point.x - target.x, y: point.y - target.y }
  const scale = metresPerPixel(view)
  return {
    x: (r.x * right.x + r.y * right.y) / scale,
    // Screen y counts downward; forward points up the screen.
    y: -(r.x * forward.x + r.y * forward.y) / scale,
  }
}

describe('cameraMoveForTwoFinger', () => {
  describe('pinch', () => {
    it('spreading the fingers brings the camera closer', () => {
      const move = cameraMoveForTwoFinger({ ...still, pinch: 2 }, VIEW)
      expect(move.zoomFactor).toBeLessThan(1)
    })

    it('is the reciprocal of the pinch: fingers twice as far apart halve the distance', () => {
      expect(cameraMoveForTwoFinger({ ...still, pinch: 2 }, VIEW).zoomFactor).toBeCloseTo(0.5, 12)
      expect(cameraMoveForTwoFinger({ ...still, pinch: 0.5 }, VIEW).zoomFactor).toBeCloseTo(2, 12)
    })

    it('leaves the distance alone when the fingers held their separation', () => {
      expect(cameraMoveForTwoFinger(still, VIEW).zoomFactor).toBe(1)
    })

    it('actually moves a rig closer when the fingers spread', () => {
      const rig = new CameraRig({ x: 0, y: 0, z: 0 }, VIEW.distance)
      rig.zoom(cameraMoveForTwoFinger({ ...still, pinch: 2 }, VIEW).zoomFactor)
      expect(rig.distance).toBeCloseTo(250, 9)
    })

    it('never returns a factor the rig would reject', () => {
      for (const pinch of [0, -1, -0.5, 1e-12, 1e12]) {
        const factor = cameraMoveForTwoFinger({ ...still, pinch }, VIEW).zoomFactor
        expect(factor).toBeGreaterThan(0)
        expect(Number.isFinite(factor)).toBe(true)
      }
    })

    it('takes two coincident fingers as saying nothing about scale, not as an infinite zoom', () => {
      expect(cameraMoveForTwoFinger({ ...still, pinch: 0 }, VIEW).zoomFactor).toBe(1)
    })

    it('a separation that cannot have come from a distance ratio says nothing either', () => {
      expect(cameraMoveForTwoFinger({ ...still, pinch: -2 }, VIEW).zoomFactor).toBe(1)
    })

    it('bounds one sample to MAX_ZOOM_STEP_PER_SAMPLE, both ways', () => {
      expect(cameraMoveForTwoFinger({ ...still, pinch: 0.0001 }, VIEW).zoomFactor).toBe(
        MAX_ZOOM_STEP_PER_SAMPLE,
      )
      expect(cameraMoveForTwoFinger({ ...still, pinch: 10000 }, VIEW).zoomFactor).toBe(
        1 / MAX_ZOOM_STEP_PER_SAMPLE,
      )
    })

    it('leaves a real pinch untouched by that bound', () => {
      // A vigorous pinch between two 8ms samples is a few percent, nowhere
      // near a factor of four. If this ever clamps, the bound has been set
      // inside the range of an actual gesture.
      const move = cameraMoveForTwoFinger({ ...still, pinch: 1.2 }, VIEW)
      expect(move.zoomFactor).toBeCloseTo(1 / 1.2, 12)
    })

    it('does not disturb the pan or the twist', () => {
      const move = cameraMoveForTwoFinger({ ...still, pinch: 3 }, VIEW)
      expectNoPan(move.pan)
      expect(Math.abs(move.dAzimuth)).toBe(0)
    })
  })

  describe('pan', () => {
    it('converts screen pixels to world metres at the view s own scale', () => {
      const move = cameraMoveForTwoFinger({ ...still, pan: { dx: 100, dy: 0 } }, VIEW)
      expect(Math.abs(move.pan.dRight)).toBeCloseTo(100 * metresPerPixel(VIEW), 9)
    })

    it('pans further per pixel the further back the camera stands', () => {
      const near = cameraMoveForTwoFinger(
        { ...still, pan: { dx: 100, dy: 0 } },
        { ...VIEW, distance: 100 },
      )
      const far = cameraMoveForTwoFinger(
        { ...still, pan: { dx: 100, dy: 0 } },
        { ...VIEW, distance: 1000 },
      )
      expect(Math.abs(far.pan.dRight)).toBeCloseTo(10 * Math.abs(near.pan.dRight), 9)
    })

    it('drags the ground with the fingers, horizontally', () => {
      const rig = new CameraRig({ x: 0, y: 0, z: 0 }, VIEW.distance)
      // A point off to one side and ahead, so neither screen axis is zero and
      // a swapped pair of components could not pass unnoticed.
      const point: Vec3 = { x: 137, y: -64, z: 0 }
      const before = screenOffset(rig, point, VIEW)

      const move = cameraMoveForTwoFinger({ ...still, pan: { dx: 100, dy: 0 } }, VIEW)
      rig.pan(move.pan.dRight, move.pan.dForward)
      const after = screenOffset(rig, point, VIEW)

      expect(after.x - before.x).toBeCloseTo(100, 6)
      expect(after.y - before.y).toBeCloseTo(0, 6)
    })

    it('drags the ground with the fingers, vertically', () => {
      const rig = new CameraRig({ x: 0, y: 0, z: 0 }, VIEW.distance)
      const point: Vec3 = { x: 137, y: -64, z: 0 }
      const before = screenOffset(rig, point, VIEW)

      const move = cameraMoveForTwoFinger({ ...still, pan: { dx: 0, dy: 80 } }, VIEW)
      rig.pan(move.pan.dRight, move.pan.dForward)
      const after = screenOffset(rig, point, VIEW)

      expect(after.y - before.y).toBeCloseTo(80, 6)
      expect(after.x - before.x).toBeCloseTo(0, 6)
    })

    it('a midpoint that did not move moves nothing', () => {
      expectNoPan(cameraMoveForTwoFinger(still, VIEW).pan)
    })

    it('does not disturb the zoom or the twist', () => {
      const move = cameraMoveForTwoFinger({ ...still, pan: { dx: 40, dy: -70 } }, VIEW)
      expect(move.zoomFactor).toBe(1)
      expect(Math.abs(move.dAzimuth)).toBe(0)
    })
  })

  describe('twist', () => {
    it('turns the azimuth by exactly what the fingers turned', () => {
      expect(cameraMoveForTwoFinger({ ...still, twist: 0.3 }, VIEW).dAzimuth).toBe(0.3)
      expect(cameraMoveForTwoFinger({ ...still, twist: -0.3 }, VIEW).dAzimuth).toBe(-0.3)
    })

    it('turns the world clockwise on screen when the fingers turn clockwise', () => {
      // `Gesture.twist` is positive clockwise as the player sees it, and with
      // screen y counting downward a clockwise turn INCREASES atan2(y, x).
      // This is the whole sign argument for `dAzimuth = twist`, measured
      // rather than asserted.
      const rig = new CameraRig({ x: 0, y: 0, z: 0 }, VIEW.distance)
      const point: Vec3 = { x: 137, y: -64, z: 0 }
      const before = screenOffset(rig, point, VIEW)

      const twist = 0.2
      rig.orbit(cameraMoveForTwoFinger({ ...still, twist }, VIEW).dAzimuth, 0)
      const after = screenOffset(rig, point, VIEW)

      const angleBefore = Math.atan2(before.y, before.x)
      const angleAfter = Math.atan2(after.y, after.x)
      expect(angleAfter - angleBefore).toBeCloseTo(twist, 6)
    })

    it('does not disturb the pan or the zoom', () => {
      const move = cameraMoveForTwoFinger({ ...still, twist: 0.5 }, VIEW)
      expectNoPan(move.pan)
      expect(move.zoomFactor).toBe(1)
    })

    it('never tilts: a sample carries no elevation signal', () => {
      // Asserted through the shape of `CameraMove` rather than a number: there
      // is no elevation field to get wrong, and if one is ever added this test
      // is where the decision has to be revisited.
      const move = cameraMoveForTwoFinger({ pan: { dx: 30, dy: 90 }, pinch: 1.5, twist: 0.4 }, VIEW)
      expect(Object.keys(move).sort()).toEqual(['dAzimuth', 'pan', 'zoomFactor'])
    })
  })

  describe('all three at once', () => {
    it('reports each component independently of the others', () => {
      const sample = { pan: { dx: 25, dy: -40 }, pinch: 1.5, twist: 0.12 }
      const move = cameraMoveForTwoFinger(sample, VIEW)

      expect(move.pan.dRight).toBeCloseTo(-25 * metresPerPixel(VIEW), 9)
      expect(move.pan.dForward).toBeCloseTo(-40 * metresPerPixel(VIEW), 9)
      expect(move.zoomFactor).toBeCloseTo(1 / 1.5, 12)
      expect(move.dAzimuth).toBe(0.12)
    })
  })

  describe('a view that cannot be measured against', () => {
    it('refuses a camera at no distance rather than dividing by it', () => {
      expect(() => cameraMoveForTwoFinger(still, { ...VIEW, distance: 0 })).toThrow(RangeError)
    })

    it('refuses a viewport with no height', () => {
      expect(() => cameraMoveForTwoFinger(still, { ...VIEW, viewportHeightPx: 0 })).toThrow(
        RangeError,
      )
    })

    it('refuses a field of view that is not one', () => {
      expect(() => cameraMoveForTwoFinger(still, { ...VIEW, verticalFovDegrees: 180 })).toThrow(
        RangeError,
      )
    })
  })
})
