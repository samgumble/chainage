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

import { SNAP_RADIUS } from './drawTool'
import { NODE_SNAP_DISTANCE } from '../network/graph'
import { PICK_RADIUS } from './selectTool'
import { MIN_TOUCH_TARGET_PX } from './touchTarget'

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
 * radius. Rounded up slightly to 22px: exactly half of `MIN_TOUCH_TARGET_PX`,
 * the minimum accessible touch-target SIZE the on-screen control bar
 * (`render/controlBar.ts`) sizes every button from, so the same
 * fingertip-sized reasoning produces the same number in both places rather
 * than two independently-chosen ones that happen to be close.
 *
 * Written as that constant halved rather than as the literal 22 it works out
 * to. Until Task 3 there was nowhere to import the 44 from, so this line said
 * `= 22` and the prose above said "half of 44" — true when written, and
 * exactly the pairing that goes wrong silently the first time either number is
 * retuned. Now the claim is the code.
 */
const FINGERTIP_SNAP_RADIUS_PX = MIN_TOUCH_TARGET_PX / 2

/**
 * The camera distance the game opens on, world metres — the framing
 * `openingView` computes before any zoom or pan input, pinned by
 * `openingRoad.test.ts`'s "stands back far enough for the valley and close
 * enough for the deck" test (`expect(view.distance).toBeCloseTo(426.8, 1)`).
 * Restated here as a literal, not imported, for the same reason the FOV
 * below is: importing `debug/roadScene.ts` (or `openingRoad.ts`) would pull
 * three.js into `src/tool/`'s module graph, which this module's own doc
 * comment says it must not do. If the real opening distance ever moves,
 * `snapRadius.test.ts` cross-checks this literal against the live value and
 * fails first.
 */
const OPENING_FRAMING_DISTANCE_M = 426.8

/**
 * Must equal `CAMERA_VERTICAL_FOV` in `debug/roadScene.ts` — restated as a
 * literal for the same "no three.js in `src/tool/`" reason as the distance
 * above. `snapRadius.test.ts` imports the live constant and asserts the two
 * stay equal, so a change to the real FOV fails a test here rather than
 * silently invalidating this derivation.
 */
const OPENING_FRAMING_VERTICAL_FOV_DEG = 45

/**
 * A representative desktop browser viewport height, CSS pixels — a maximised
 * window on a common 1920x1080 display, minus the browser's own chrome. No
 * canonical figure exists anywhere in this codebase (the canvas fills
 * whatever window it is given), so this is a stated assumption, matched to
 * the one `snapRadius.test.ts`'s "at the opening framing" block already uses.
 */
const OPENING_FRAMING_REFERENCE_VIEWPORT_HEIGHT_PX = 900

/**
 * The FINE default for `snapRadiusInWorld` — a mouse or a pen.
 *
 * This is NOT an independent judgement about what a mouse needs. It exists
 * for one reason only: to reproduce, exactly, the fixed `SNAP_RADIUS` (15m,
 * `drawTool.ts`) that every desktop player has been snapping against until
 * now, measured at the distance the camera actually opens on. Its value is
 * therefore a *consequence* of `SNAP_RADIUS = 15` and the opening framing,
 * not a number chosen on its own terms the way `COARSE_POINTER_SNAP_RADIUS_PX`
 * was — hence the division below rather than a pasted constant: change
 * `SNAP_RADIUS`, the opening framing, or the reference viewport, and this
 * value moves with them instead of quietly drifting out of sync.
 *
 * Worked out, this comes to roughly 38 CSS px — is it wrong for a mouse?
 * AutoCAD's own default object-snap "aperture" (the `APERTURE` system
 * variable) is 10px, a real, long-standing convention from a CAD tool built
 * entirely around a mouse snapping precisely to existing geometry, which is
 * exactly this situation. 38px is nearly four times that. It is entirely
 * plausible a tighter aperture — closer to AutoCAD's 10px, closer to
 * `snapRadius.test.ts`'s original (and since-corrected) attempt at this
 * constant — would make the tool feel MORE precise and no worse. That is a
 * real, deliberate tuning decision about desktop feel, and it is explicitly
 * NOT this module's decision to make: shipping it silently alongside a
 * mobile-controls feature, the way the first attempt at this constant did,
 * is exactly the unrequested regression this correction exists to undo. Ship
 * 38px now to hold desktop's feel exactly where it already was; revisit the
 * number later as its own, separately-reviewed change if a tighter aperture
 * turns out to feel better.
 *
 * One further consequence worth flagging plainly: 38px is now LARGER than
 * `COARSE_POINTER_SNAP_RADIUS_PX` (22px). Before this fix, the fine default
 * (10px) was smaller than the coarse one, matching the intuition that a
 * fingertip needs a more forgiving tolerance than a mouse tip. Reproducing
 * desktop's pre-existing feel exactly inverts that: at any given camera
 * distance, the fine (mouse) world radius this module now derives is always
 * at least as large as the coarse (touch) one — never smaller, per the
 * `worldMetresPerScreenPixel` multiplication both go through. That inversion
 * is a genuine tension between "don't change desktop's feel" and "touch
 * should be more forgiving than a mouse", not something this module can
 * resolve by nudging either constant without breaking that constant's own,
 * separately-justified reasoning. See this module's accompanying report for
 * the fuller discussion; `snapRadius.test.ts` pins the actual (inverted)
 * relationship rather than asserting the false one.
 */
export const FINE_POINTER_SNAP_RADIUS_PX =
  SNAP_RADIUS /
  worldMetresPerScreenPixel(
    OPENING_FRAMING_DISTANCE_M,
    OPENING_FRAMING_VERTICAL_FOV_DEG,
    OPENING_FRAMING_REFERENCE_VIEWPORT_HEIGHT_PX,
  )

/**
 * The COARSE default, and never smaller than the fine one.
 *
 * `FINGERTIP_SNAP_RADIUS_PX` above is the honest answer to "how big is a
 * fingertip" — 22px, half a 44px touch target. Taken on its own it produces a
 * result that is plainly wrong: 22px is SMALLER than the 38px the fine
 * default works out to, so a mouse would snap more generously than a thumb.
 *
 * The inversion is not a mistake in either constant. It is what the two
 * numbers together reveal — that the fixed 15m desktop players have been
 * snapping against is, at the opening framing, already more forgiving than a
 * fingertip needs. Both constants are right about their own question; the
 * error would be to use the fingertip figure as if it were an upper bound.
 *
 * So the floor is the fine radius, for a reason that holds whatever either
 * constant is later retuned to: a fingertip is not more precise than a
 * cursor, so touch must never be given a tighter tolerance than the mouse.
 * If `SNAP_RADIUS` is ever tightened (AutoCAD's ~10px aperture suggests it
 * might want to be), the fine default shrinks below 22px and this reverts to
 * the fingertip figure on its own, with no further change here.
 */
export const COARSE_POINTER_SNAP_RADIUS_PX = Math.max(
  FINGERTIP_SNAP_RADIUS_PX,
  FINE_POINTER_SNAP_RADIUS_PX,
)

/**
 * The smallest a derived snap radius may be, world metres.
 *
 * Twice `NODE_SNAP_DISTANCE` (0.5m, `network/graph.ts`) — the tolerance the
 * NETWORK itself already uses to treat two road ends as "the same point".
 * A tool-level snap radius any smaller than that would be claiming more
 * precision than the topology underneath it can even represent: two nodes
 * within `NODE_SNAP_DISTANCE` are already merged into one, so a snap
 * tolerance tighter than that distance could never actually distinguish
 * anything the network wouldn't have collapsed anyway. Doubling it (rather
 * than using 0.5 directly) leaves a working margin above that floor instead
 * of sitting exactly on it. This is not a hypothetical edge case: at
 * `MIN_DISTANCE` (40m, `render/cameraRig.ts`) with an ordinary 900px
 * viewport, `COARSE_POINTER_SNAP_RADIUS_PX` alone derives to about 0.81m —
 * already below this floor — before any exotic zoom or screen size is
 * involved. See `snapRadius.test.ts` for the exact figures.
 */
export const MIN_SNAP_RADIUS_M = 2 * NODE_SNAP_DISTANCE

/**
 * The largest a derived snap radius may be, world metres.
 *
 * Equal to `PICK_RADIUS` (`tool/selectTool.ts`) — the tolerance this
 * codebase already uses for the click that finds an EXISTING road under the
 * pointer, deliberately wider than the drawing tool's own tolerance because
 * "picking is a coarser gesture than placing". A snap radius while DRAWING
 * should never be more forgiving than the tolerance already judged
 * acceptable for the coarser act of picking a road outright — if it were, a
 * click could snap to geometry the player did not even manage to select on
 * purpose. 20m is also the right order of magnitude on its own terms: the
 * widest road class this game builds (`highway`, `network/roadClass.ts`) is
 * 6 lanes at 3.7m plus 3m shoulders on each side, `formationHalfWidth` * 2 ≈
 * 28.2m full width — so a 20m snap radius is comparable to, not some small
 * fraction of, the footprint of the widest thing a player might be pointing
 * at, rather than an arbitrary round number. Without this ceiling, at
 * `MAX_DISTANCE` (6000m, `render/cameraRig.ts`) `FINE_POINTER_SNAP_RADIUS_PX`
 * alone would derive to roughly 211m — a click claiming a road it could not
 * plausibly have meant. See `snapRadius.test.ts` for the exact figures.
 */
export const MAX_SNAP_RADIUS_M = PICK_RADIUS

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value

/**
 * `snapRadiusInWorld`, bounded to `[MIN_SNAP_RADIUS_M, MAX_SNAP_RADIUS_M]`.
 *
 * This is the function callers (`debug/roadScene.ts`'s `currentSnapRadius`)
 * should actually use, in place of calling `snapRadiusInWorld` directly:
 * screen-space scaling is right for how snapping FEELS, but wrong, unbounded,
 * for what it means topologically at either extreme of the camera's zoom
 * range — see `MIN_SNAP_RADIUS_M` and `MAX_SNAP_RADIUS_M`'s own docs for why
 * each bound is where it is. `snapRadiusInWorld` itself is left exactly as
 * Task 2 built and tested it; this wraps it rather than changing it, so nothing
 * that already depends on its unbounded behaviour is disturbed.
 */
export const clampedSnapRadiusInWorld = (
  screenRadiusPx: number,
  distance: number,
  verticalFovDegrees: number,
  viewportHeightPx: number,
): number =>
  clamp(
    snapRadiusInWorld(screenRadiusPx, distance, verticalFovDegrees, viewportHeightPx),
    MIN_SNAP_RADIUS_M,
    MAX_SNAP_RADIUS_M,
  )
