import { describe, expect, it } from 'vitest'
import {
  COARSE_POINTER_SNAP_RADIUS_PX,
  FINE_POINTER_SNAP_RADIUS_PX,
  MAX_SNAP_RADIUS_M,
  MIN_SNAP_RADIUS_M,
  clampedSnapRadiusInWorld,
  snapRadiusInWorld,
  worldMetresPerScreenPixel,
} from './snapRadius'
import { CAMERA_VERTICAL_FOV } from '../debug/roadScene'
import { SNAP_RADIUS } from './drawTool'
import { MAX_DISTANCE, MIN_DISTANCE } from '../render/cameraRig'
import { NODE_SNAP_DISTANCE } from '../network/graph'
import { PICK_RADIUS } from './selectTool'
import { MIN_TOUCH_TARGET_PX } from './touchTarget'

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

  it('a coarser screen-pixel radius always gets a larger world radius, same distance and viewport', () => {
    // Deliberately generic — 20px vs 8px, not the FINE/COARSE constants —
    // because the relationship between the two POINTER constants themselves
    // is no longer this simple. See the dedicated block below.
    const wider = snapRadiusInWorld(20, 400, 45, 900)
    const narrower = snapRadiusInWorld(8, 400, 45, 900)
    expect(wider).toBeGreaterThan(narrower)
  })

  describe('FINE_POINTER_SNAP_RADIUS_PX vs COARSE_POINTER_SNAP_RADIUS_PX', () => {
    // Before this correction, FINE was 10px (AutoCAD's aperture, chosen on
    // its own terms) and COARSE was 22px (half a fingertip), so a coarse
    // pointer really did get a more forgiving radius than a fine one — the
    // intuition a fingertip needs more slack than a mouse tip.
    //
    // Reproducing desktop's pre-existing feel exactly (see
    // `FINE_POINTER_SNAP_RADIUS_PX`'s own doc) pushes FINE to ~38px, which is
    // now LARGER than COARSE's 22px. Since both go through the same
    // `worldMetresPerScreenPixel` multiplication at any given distance, that
    // means the fine (mouse) world radius is now always at least as large as
    // the coarse (touch) one — the opposite of the pre-fix relationship, and
    // not something a clamp can undo (clamping a bigger raw value and a
    // smaller one to the same range preserves their order, never inverts
    // it). This is reported as a genuine, unresolved tension rather than
    // patched by nudging either constant off its own separately-justified
    // reasoning — see this module's accompanying report.
    // A fingertip is not more precise than a cursor, so touch must never be
    // given a tighter tolerance than the mouse. This held trivially while the
    // fine default was 10px; it stopped holding the moment the fine default
    // was raised to 38px to preserve desktop's existing feel, which is what
    // put the floor into COARSE_POINTER_SNAP_RADIUS_PX.
    it('never gives a coarse pointer a tighter tolerance than a fine one', () => {
      expect(COARSE_POINTER_SNAP_RADIUS_PX).toBeGreaterThanOrEqual(FINE_POINTER_SNAP_RADIUS_PX)
    })

    it('holds that at every distance the camera can reach, not just one', () => {
      for (const distance of [MIN_DISTANCE, 100, 426.8, 1500, MAX_DISTANCE]) {
        const fine = snapRadiusInWorld(FINE_POINTER_SNAP_RADIUS_PX, distance, 45, 900)
        const coarse = snapRadiusInWorld(COARSE_POINTER_SNAP_RADIUS_PX, distance, 45, 900)
        expect(coarse).toBeGreaterThanOrEqual(fine)
      }
    })

    // The fingertip figure is still the one that governs whenever it is the
    // larger of the two — the floor only binds while desktop's legacy 15m is
    // the more generous. Tighten SNAP_RADIUS and this reverts on its own.
    it('falls back to the fingertip figure when the fine default is tighter', () => {
      expect(COARSE_POINTER_SNAP_RADIUS_PX).toBe(
        Math.max(22, FINE_POINTER_SNAP_RADIUS_PX),
      )
    })

    // The 22 above is no longer a number of its own: it is half the touch
    // target the on-screen control bar is built from (see `touchTarget.ts`),
    // which is where the "half of 44" claim in FINGERTIP_SNAP_RADIUS_PX's
    // docstring now actually lives. Asserted here because that constant is
    // private, so this is the only place the linkage can be checked — and
    // without it, retuning MIN_TOUCH_TARGET_PX would silently move the touch
    // snap tolerance with no test noticing.
    it('the fingertip figure is exactly half the minimum touch target', () => {
      expect(MIN_TOUCH_TARGET_PX / 2).toBe(22)
      expect(COARSE_POINTER_SNAP_RADIUS_PX).toBe(
        Math.max(MIN_TOUCH_TARGET_PX / 2, FINE_POINTER_SNAP_RADIUS_PX),
      )
    })
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

    it("CAMERA_VERTICAL_FOV matches the literal this module's FINE derivation assumes", () => {
      // `snapRadius.ts` cannot import `CAMERA_VERTICAL_FOV` from
      // `debug/roadScene.ts` without pulling three.js into `src/tool/`'s
      // module graph, so it restates the figure as a private literal. This
      // guards against that literal silently drifting from the real one.
      expect(CAMERA_VERTICAL_FOV).toBe(45)
    })

    it('the fine-pointer default reproduces the pre-existing 15m at the opening framing', () => {
      // This is the corrective half of Problem 1: the original
      // `FINE_POINTER_SNAP_RADIUS_PX` (10px, AutoCAD's aperture, chosen on
      // its own terms) landed at ~3.9m here — under a third of the fixed
      // `SNAP_RADIUS` every desktop player had been snapping against, a real
      // and unrequested regression to how the game feels for a mouse. This
      // derives `FINE_POINTER_SNAP_RADIUS_PX` FROM `SNAP_RADIUS` and this
      // exact opening distance instead, so it must reproduce it exactly
      // (within floating-point rounding) — if it does not, either the
      // derivation broke or the opening framing moved without this figure
      // being re-derived, either of which this test should catch first.
      const derived = snapRadiusInWorld(
        FINE_POINTER_SNAP_RADIUS_PX,
        OPENING_DISTANCE,
        CAMERA_VERTICAL_FOV,
        REFERENCE_VIEWPORT_HEIGHT,
      )
      expect(derived).toBeCloseTo(SNAP_RADIUS, 9)
    })

    it('reports the coarse-pointer world radius at the opening framing too', () => {
      // Floored to the fine radius (see COARSE_POINTER_SNAP_RADIUS_PX), so at
      // the opening framing touch and mouse land on the same 15m. That is the
      // intended outcome, not a coincidence: the floor exists precisely so a
      // fingertip is never held to a tighter tolerance than a cursor, and at
      // this framing desktop's legacy 15m is the more generous of the two.
      const coarse = snapRadiusInWorld(
        COARSE_POINTER_SNAP_RADIUS_PX,
        OPENING_DISTANCE,
        CAMERA_VERTICAL_FOV,
        REFERENCE_VIEWPORT_HEIGHT,
      )
      expect(coarse).toBeCloseTo(15, 2)
      expect(coarse).toBeGreaterThan(MIN_SNAP_RADIUS_M)
      expect(coarse).toBeLessThan(MAX_SNAP_RADIUS_M)
    })
  })
})

describe('clampedSnapRadiusInWorld', () => {
  it('matches the unclamped derivation when the raw result is already within bounds', () => {
    // At the opening framing, 15m sits comfortably inside
    // [MIN_SNAP_RADIUS_M, MAX_SNAP_RADIUS_M] (1m-20m), so clamping must be a
    // no-op here.
    const OPENING_DISTANCE = 426.8
    const clamped = clampedSnapRadiusInWorld(FINE_POINTER_SNAP_RADIUS_PX, OPENING_DISTANCE, CAMERA_VERTICAL_FOV, 900)
    expect(clamped).toBeCloseTo(SNAP_RADIUS, 9)
  })

  it('clamps to MAX_SNAP_RADIUS_M at MAX_DISTANCE — Problem 2, the unbounded end', () => {
    // Unclamped, a mouse's screen-space radius at the camera's farthest zoom
    // (MAX_DISTANCE, `render/cameraRig.ts`) derives to roughly 211m of
    // ground — a click claiming a road nowhere near the pointer. Clamped, it
    // must be pinned exactly at the ceiling.
    const raw = snapRadiusInWorld(FINE_POINTER_SNAP_RADIUS_PX, MAX_DISTANCE, CAMERA_VERTICAL_FOV, 900)
    expect(raw).toBeCloseTo(210.87, 1) // the unbounded figure, for the record
    expect(raw).toBeGreaterThan(MAX_SNAP_RADIUS_M)

    const clamped = clampedSnapRadiusInWorld(FINE_POINTER_SNAP_RADIUS_PX, MAX_DISTANCE, CAMERA_VERTICAL_FOV, 900)
    expect(clamped).toBe(MAX_SNAP_RADIUS_M)
    expect(clamped).toBeCloseTo(20, 9)
  })

  it('clamps to MIN_SNAP_RADIUS_M at MIN_DISTANCE — a real close-zoom shortfall', () => {
    // Unclamped, the tolerance shrinks below the floor at the camera's closest
    // zoom (MIN_DISTANCE, `render/cameraRig.ts`) on a tall display: more
    // pixels down the viewport means each one covers less ground.
    //
    // A 900px viewport no longer demonstrates this, and that is worth saying
    // rather than quietly swapping the number: raising the fine default to
    // 38px lifted the floored coarse radius there to ~1.41m, above the 1m
    // floor. The clamp is not thereby unnecessary — it still binds on an
    // ordinary tall monitor, which is the case pinned here.
    const TALL_VIEWPORT = 1440
    const raw = snapRadiusInWorld(COARSE_POINTER_SNAP_RADIUS_PX, MIN_DISTANCE, CAMERA_VERTICAL_FOV, TALL_VIEWPORT)
    expect(raw).toBeLessThan(MIN_SNAP_RADIUS_M)

    const clamped = clampedSnapRadiusInWorld(COARSE_POINTER_SNAP_RADIUS_PX, MIN_DISTANCE, CAMERA_VERTICAL_FOV, TALL_VIEWPORT)
    expect(clamped).toBe(MIN_SNAP_RADIUS_M)
    expect(clamped).toBeCloseTo(1, 9)
  })

  it('never falls outside [MIN_SNAP_RADIUS_M, MAX_SNAP_RADIUS_M] for any plausible input', () => {
    const plausible: readonly [screenRadiusPx: number, distance: number, fov: number, viewportHeightPx: number][] = [
      [1, MIN_DISTANCE, 1, 4000], // narrowest FOV, closest zoom, huge viewport
      [1, MAX_DISTANCE, 179, 1], // widest FOV, farthest zoom, tiny viewport
      [FINE_POINTER_SNAP_RADIUS_PX, 426.8, 45, 900], // opening framing
      [COARSE_POINTER_SNAP_RADIUS_PX, MAX_DISTANCE, 45, 900], // touch, zoomed all the way out
    ]
    for (const [screenRadiusPx, distance, fov, viewportHeightPx] of plausible) {
      const clamped = clampedSnapRadiusInWorld(screenRadiusPx, distance, fov, viewportHeightPx)
      expect(clamped).toBeGreaterThanOrEqual(MIN_SNAP_RADIUS_M)
      expect(clamped).toBeLessThanOrEqual(MAX_SNAP_RADIUS_M)
    }
  })
})

describe('MIN_SNAP_RADIUS_M and MAX_SNAP_RADIUS_M', () => {
  it('MIN is twice NODE_SNAP_DISTANCE — the network merge tolerance', () => {
    expect(MIN_SNAP_RADIUS_M).toBe(2 * NODE_SNAP_DISTANCE)
    expect(MIN_SNAP_RADIUS_M).toBeCloseTo(1, 9)
  })

  it('MAX equals PICK_RADIUS — the tolerance already used for picking an existing road', () => {
    expect(MAX_SNAP_RADIUS_M).toBe(PICK_RADIUS)
    expect(MAX_SNAP_RADIUS_M).toBeCloseTo(20, 9)
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
