/**
 * Turning a screen-space snap tolerance into a world-space one.
 *
 * `SNAP_RADIUS` (`drawTool.ts`) is a fixed 15 metres of world space, chosen
 * with no reference to the screen at all — its own docstring calls it "a
 * usability threshold, not a topological one". That is fine only as long as
 * the relationship between world metres and screen pixels never changes, and
 * it never stops changing: `CameraRig.distance` (`render/cameraRig.ts`) runs
 * anywhere from 40m to 6000m back from the ground. A fixed WORLD radius
 * therefore covers a wildly different number of SCREEN pixels depending on
 * how far the camera has zoomed out, while a fingertip — roughly 10mm across
 * whatever the zoom — needs a screen-space tolerance, not a world one.
 *
 * This module inverts the relationship: given a tolerance in CSS pixels (the
 * unit a pointer actually moves in) and the camera's current distance and
 * field of view, it returns the number of world metres that pixel tolerance
 * covers right now. No three.js: the arithmetic is plain trigonometry over
 * numbers the caller already has (`CameraRig.distance`, the projection's own
 * vertical FOV, the canvas's CSS height), so it is testable without a
 * renderer and importable from `src/tool/`, which may not depend on it.
 */

/**
 * World metres covered by one CSS pixel, at a given camera distance and
 * vertical field of view.
 *
 * A perspective camera's frustum has visible height `2 * distance *
 * tan(fov / 2)` at `distance` — the same relationship `cameraFraming.ts`'s
 * `distanceToFrame` solves in the other direction (there: given a height,
 * find the distance that frames it; here: given a distance, find the height
 * that is visible). Dividing that visible height by the viewport's height in
 * CSS pixels turns "world metres visible" into "world metres per pixel".
 *
 * `roadScene.ts`'s own drag-to-pan handler already computes exactly this
 * quantity, for exactly this reason — a pan in `dx`/`dy` screen pixels has to
 * become a pan distance in world metres so the ground point under the
 * pointer keeps pace with it. This is that arithmetic, pulled out so both
 * callers can share one derivation instead of two copies quietly drifting
 * apart.
 *
 * Vertical field of view and viewport HEIGHT specifically, not horizontal —
 * matching `distanceToFrame`: the vertical FOV is the one a
 * `THREE.PerspectiveCamera` is actually constructed with and the one that
 * does not change when the canvas is resized (the horizontal FOV moves with
 * the aspect ratio instead), so it is the only stable anchor between the two
 * spaces.
 */
export const worldMetresPerScreenPixel = (
  distance: number,
  verticalFovDegrees: number,
  viewportHeightPx: number,
): number => {
  if (!(distance > 0)) {
    throw new RangeError(`camera distance must be positive, got ${distance}`)
  }
  if (!(verticalFovDegrees > 0) || verticalFovDegrees >= 180) {
    throw new RangeError(
      `vertical field of view must be within (0, 180) degrees, got ${verticalFovDegrees}`,
    )
  }
  if (!(viewportHeightPx > 0)) {
    throw new RangeError(`viewport height must be positive, got ${viewportHeightPx}`)
  }

  const visibleWorldHeight = 2 * distance * Math.tan((verticalFovDegrees * Math.PI) / 360)
  return visibleWorldHeight / viewportHeightPx
}

/**
 * A world-space snap radius, in metres, equivalent to a tolerance of
 * `screenRadiusPx` CSS pixels at the camera's current `distance`.
 *
 * This is the number `DrawTool.hover`/`place` should pass to `resolveSnap` in
 * place of a fixed world constant: multiply a screen-space tolerance by how
 * many world metres one screen pixel currently covers (`worldMetresPerScreenPixel`),
 * and the result grows and shrinks with the zoom exactly the way a
 * fingertip's ON-SCREEN size does not.
 *
 * Guards its own input rather than deferring entirely to
 * `worldMetresPerScreenPixel`: a zero or negative pixel tolerance is exactly
 * the kind of silently-wrong input this project reports rather than
 * tolerates, and the multiplication alone would happily return zero or a
 * negative "radius" for it without complaint.
 */
export const snapRadiusInWorld = (
  screenRadiusPx: number,
  distance: number,
  verticalFovDegrees: number,
  viewportHeightPx: number,
): number => {
  if (!(screenRadiusPx > 0)) {
    throw new RangeError(`screen radius must be positive, got ${screenRadiusPx}`)
  }
  return screenRadiusPx * worldMetresPerScreenPixel(distance, verticalFovDegrees, viewportHeightPx)
}

/**
 * How far from a fingertip's actual touch point a snap target may sit and
 * still count as "under the finger", CSS pixels — the COARSE default for
 * `snapRadiusInWorld`, meant for callers that detect a `pointer: coarse`
 * media query match.
 *
 * A fingertip's contact patch is roughly 10mm across (the figure this whole
 * task starts from). At the CSS-pixel definition of 96px to the inch
 * (1px = 1/96in = 0.2646mm), 10mm is about 37.8 CSS px across — an 18.9px
 * radius. Rounded up slightly to 22px: exactly half of the 44 CSS px minimum
 * accessible touch-target SIZE this same plan's Task 3 uses for the on-screen
 * control bar (Apple's Human Interface Guidelines and Android's Material
 * Design both converge on ~44-48pt/dp as the smallest comfortably-hittable
 * control), so the same fingertip-sized reasoning produces the same number in
 * both places rather than two independently-chosen ones that happen to be
 * close.
 */
export const COARSE_POINTER_SNAP_RADIUS_PX = 22

/**
 * The FINE default for `snapRadiusInWorld` — a mouse or a pen, which needs
 * only a small capture zone around its actual tip, not a fingertip-sized one.
 *
 * Ten, matching AutoCAD's own default object-snap "aperture" (the `APERTURE`
 * system variable, default value 10, valid range 1-50 pixels) — a real,
 * long-standing convention from a CAD tool built entirely around a mouse
 * snapping precisely to existing geometry, which is exactly this situation.
 *
 * This number was chosen on its own terms, not fitted to reproduce today's
 * `SNAP_RADIUS` (15m) at any particular distance — see `snapRadius.test.ts`'s
 * "at the opening framing" block for the measured, and not especially close,
 * comparison between the two, and the report accompanying this module for
 * why that gap is left as a reported finding rather than closed by inflating
 * this constant.
 */
export const FINE_POINTER_SNAP_RADIUS_PX = 10
