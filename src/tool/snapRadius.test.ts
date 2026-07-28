import { describe, expect, it } from 'vitest'
import {
  COARSE_POINTER_SNAP_RADIUS_PX,
  FINE_POINTER_SNAP_RADIUS_PX,
  snapRadiusInWorld,
  worldMetresPerScreenPixel,
} from './snapRadius'
import { CAMERA_VERTICAL_FOV } from '../debug/roadScene'
import { SNAP_RADIUS } from './drawTool'

describe('snapRadiusInWorld', () => {
  it('grows with camera distance — the same finger covers more ground zoomed out', () => {
    const zoomedIn = snapRadiusInWorld(20, 100, 45, 900)
    const zoomedOut = snapRadiusInWorld(20, 1000, 45, 900)
    expect(zoomedOut).toBeGreaterThan(zoomedIn)
    // Both the visible world height and the world-per-pixel figure it
    // produces are linear in distance for a fixed FOV and viewport, so a
    // 10x increase in distance is exactly a 10x increase in radius — not
    // just "bigger", but bigger by the right amount.
    expect(zoomedOut / zoomedIn).toBeCloseTo(10, 6)
  })

  it('a coarse pointer gets a larger radius than a fine one, same distance and viewport', () => {
    const fine = snapRadiusInWorld(FINE_POINTER_SNAP_RADIUS_PX, 400, 45, 900)
    const coarse = snapRadiusInWorld(COARSE_POINTER_SNAP_RADIUS_PX, 400, 45, 900)
    expect(coarse).toBeGreaterThan(fine)
  })

  it('never returns zero or a negative number for any plausible input', () => {
    const plausible: readonly [screenRadiusPx: number, distance: number, fov: number, viewportHeightPx: number][] = [
      [1, 40, 1, 1], // narrowest FOV, closest zoom, tiny viewport
      [1, 6000, 179, 4000], // widest FOV, farthest zoom, huge viewport
      [100, 427, 45, 900], // a generous screen radius at the opening framing
      [0.1, 40, 0.01, 1], // fractional screen radius, near-zero FOV
    ]
    for (const [screenRadiusPx, distance, fov, viewportHeightPx] of plausible) {
      expect(snapRadiusInWorld(screenRadiusPx, distance, fov, viewportHeightPx)).toBeGreaterThan(0)
    }
  })

  it('throws rather than silently substituting a plausible value for nonsensical input', () => {
    expect(() => snapRadiusInWorld(10, 0, 45, 900)).toThrow(RangeError)
    expect(() => snapRadiusInWorld(10, -5, 45, 900)).toThrow(RangeError)
    expect(() => snapRadiusInWorld(10, 400, 0, 900)).toThrow(RangeError)
    expect(() => snapRadiusInWorld(10, 400, 180, 900)).toThrow(RangeError)
    expect(() => snapRadiusInWorld(10, 400, 181, 900)).toThrow(RangeError)
    expect(() => snapRadiusInWorld(10, 400, 45, 0)).toThrow(RangeError)
    expect(() => snapRadiusInWorld(10, 400, 45, -1)).toThrow(RangeError)
    expect(() => snapRadiusInWorld(0, 400, 45, 900)).toThrow(RangeError)
    expect(() => snapRadiusInWorld(-1, 400, 45, 900)).toThrow(RangeError)
  })

  describe('at the opening framing', () => {
    // 426.8m — pinned by `openingRoad.test.ts`'s "stands back far enough for
    // the valley and close enough for the deck" test, measured off
    // `buildTerrain`'s particular seed and the 194.5m bridge-deck chord
    // `openingView` frames at `DECK_FRAME_FILL`. Not rebuilt here: grading and
    // excavating an 800m corridor over a 257x257 heightmap just to read one
    // number back out would make this file slow for no benefit — the number
    // is already guarded by its own pinning test, which would fail first if
    // it ever moved.
    const OPENING_DISTANCE = 426.8

    // A representative desktop browser viewport height, CSS pixels — a
    // maximised window on a common 1920x1080 display, minus the browser's
    // own chrome. No canonical figure exists anywhere in this codebase: the
    // canvas fills whatever window it is given (`#app { position: fixed;
    // inset: 0 }` in `index.html`), so this is a stated assumption for this
    // test, not a constant measured from the app.
    const REFERENCE_VIEWPORT_HEIGHT = 900

    it("does not land close to today's fixed 15m — a real, reported discrepancy", () => {
      const derived = snapRadiusInWorld(
        FINE_POINTER_SNAP_RADIUS_PX,
        OPENING_DISTANCE,
        CAMERA_VERTICAL_FOV,
        REFERENCE_VIEWPORT_HEIGHT,
      )

      // Per the brief this module was built against: "if it does not [land
      // near 15m], say so with the numbers rather than fudging a coefficient
      // to make it match — a real discrepancy is information about which of
      // the two values was wrong." Measured, it does not land near 15m: a
      // 10px mouse tolerance (AutoCAD's own default aperture) works out to
      // roughly 3.9m at the opening framing, under a third of today's fixed
      // constant. Inflating `FINE_POINTER_SNAP_RADIUS_PX` to ~38px would
      // force a numeric match, but 38px is not a defensible MOUSE tolerance
      // by any convention this module cites — it would be curve-fitting, the
      // one thing this derivation is explicitly not meant to do.
      //
      // So this test pins the actual finding rather than asserting a false
      // closeness: the derived figure is a genuine, order-of-magnitude-sized
      // fraction of `SNAP_RADIUS`, not "close" to it. See this module's own
      // report for the fuller comparison across the camera's whole distance
      // range (40m-6000m), and for why 15m turns out to have been the
      // uncalibrated one — see also `drawTool.ts`'s own admission that
      // `SNAP_RADIUS` was "a usability threshold, not a topological one".
      expect(derived).toBeGreaterThan(1)
      expect(derived).toBeLessThan(SNAP_RADIUS / 2)
      // Pinned precisely, so the real size of the gap cannot silently drift
      // without this test noticing.
      expect(derived).toBeCloseTo(3.93, 2)
    })
  })
})

describe('worldMetresPerScreenPixel', () => {
  it('is exactly the visible frustum height divided by viewport height', () => {
    const distance = 200
    const fov = 60
    const viewportHeightPx = 800
    const expected = (2 * distance * Math.tan((fov * Math.PI) / 360)) / viewportHeightPx
    expect(worldMetresPerScreenPixel(distance, fov, viewportHeightPx)).toBeCloseTo(expected, 9)
  })

  it('rejects a field of view at or beyond 180 degrees rather than returning nonsense', () => {
    expect(() => worldMetresPerScreenPixel(100, 180, 900)).toThrow(RangeError)
    expect(() => worldMetresPerScreenPixel(100, 250, 900)).toThrow(RangeError)
  })
})
