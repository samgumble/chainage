/**
 * Turning one two-finger sample into one camera move.
 *
 * `GestureRecogniser` (`tool/gestures.ts`) reports what the fingers did, in
 * screen pixels and dimensionless ratios: a midpoint that moved so many
 * pixels, a separation that grew by such a factor, a line between the fingers
 * that turned by so many radians. `CameraRig` (`render/cameraRig.ts`) takes
 * world metres, a distance multiplier and radians of azimuth. Everything
 * between those two — every sign, every unit conversion, every bound — lives
 * here.
 *
 * It lives here rather than in `debug/roadScene.ts` for the reason that file's
 * own history keeps proving: it has no unit tests, and a sign error in a pan
 * or a reciprocal left off a pinch is exactly the kind of defect that survives
 * a code review and is only found by a player whose camera flies backwards.
 *
 * No three.js, and no DOM. `CameraRig` is deliberately free of both and this
 * is the layer that feeds it, so it has to be too: numbers in, numbers out,
 * testable without a renderer or a canvas.
 */

import type { Gesture } from '../tool/gestures'
import { worldMetresPerScreenPixel } from '../tool/snapRadius'

/** The one two-finger sample this module reads, straight off the recogniser's
 * own union so the two cannot drift apart. `Pick`ed rather than used whole
 * because `centre` and `time` say nothing about how far the camera moves —
 * `centre` is where to pivot, which is a decision this rig cannot express (it
 * orbits and zooms about its target, not about an arbitrary screen point), and
 * a test should not have to invent either to ask what a pinch is worth. */
export type TwoFingerSample = Pick<Extract<Gesture, { kind: 'twoFinger' }>, 'pan' | 'pinch' | 'twist'>

/** Everything about the current view a screen-pixel gesture has to be measured
 * against. Exactly `CameraRig.distance`, the projection's own vertical field
 * of view and the canvas's CSS height — the three numbers
 * `worldMetresPerScreenPixel` needs, and no scene state at all. */
export type CameraView = {
  readonly distance: number
  readonly verticalFovDegrees: number
  readonly viewportHeightPx: number
}

/** One move, in exactly the units `CameraRig`'s three verbs take. */
export type CameraMove = {
  /** Straight into `CameraRig.pan(dRight, dForward)`, world metres. */
  readonly pan: { readonly dRight: number; readonly dForward: number }
  /** Straight into `CameraRig.zoom(factor)`: a multiplier on the distance. */
  readonly zoomFactor: number
  /** Straight into `CameraRig.orbit(dAzimuth, 0)`, radians. */
  readonly dAzimuth: number
}

/**
 * The most one sample may change the camera's distance, as a factor either
 * way.
 *
 * Not a feel control — it never binds during a real pinch. It exists for one
 * reachable degenerate input: `GestureRecogniser` reports `pinch` as the ratio
 * of the current finger separation to the previous one, so two fingers that
 * land exactly on top of each other report a pinch of exactly zero, whose
 * reciprocal is infinite. Left unbounded that single sample would throw the
 * camera to `MAX_DISTANCE` — the whole world snapping away because two
 * contact points were rounded to the same pixel.
 *
 * Four, because a real hand cannot do it. Samples arrive one per
 * `pointermove`, which is 8-16ms apart on a phone; changing the separation
 * between two fingers by more than four times inside one frame is not a
 * gesture, it is a reporting artefact. So anything this clamp catches was
 * never a pinch, and anything that was a pinch passes through untouched.
 */
export const MAX_ZOOM_STEP_PER_SAMPLE = 4

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value

/**
 * What one two-finger sample is worth to the camera.
 *
 * ## Pan
 *
 * The midpoint's movement in screen pixels becomes world metres through
 * `worldMetresPerScreenPixel` — the same conversion the mouse's middle-button
 * pan has always used, so a two-finger drag and a middle-button drag move the
 * ground by the same amount for the same pixels travelled, at every zoom.
 *
 * Both signs are inverted relative to the finger, and that inversion is what
 * makes it feel like dragging the ground rather than dragging the camera: the
 * target slides *opposite* the fingers, so the piece of terrain under them
 * stays under them. `dRight = -dx` because fingers moving right must carry the
 * ground right, which means the camera's target moves left. `dForward = +dy`
 * because screen y counts downward (`ScreenPoint`) while `CameraRig`'s
 * `forward` points away from the camera and therefore *up* the screen — so
 * fingers moving down the glass and the target moving forward are the same
 * sign, not opposite ones. Both match `debug/roadScene.ts`'s existing
 * `rig.pan(-dx * worldPerPixel, dy * worldPerPixel)` exactly.
 *
 * ## Pinch
 *
 * `zoomFactor` is the RECIPROCAL of the pinch, because the two measure
 * opposite things: `pinch` is how much bigger the gap between the fingers got,
 * and `CameraRig.zoom`'s factor multiplies how far away the camera stands.
 * Spreading the fingers (pinch > 1) is the universal "bring it closer", which
 * is a smaller distance. Getting this backwards is the single most likely
 * defect in this file, and is exactly what `cameraGesture.test.ts` pins first.
 *
 * ## Twist
 *
 * One radian of finger twist is one radian of azimuth, in the same direction:
 * the world turns with the fingers. Increasing `azimuth` walks the camera
 * anticlockwise around its target (see `CameraRig.position`), which — through
 * the screen basis that projection produces — makes the world appear to turn
 * CLOCKWISE, the same way as a positive `twist` (`Gesture`'s `twist` is
 * positive clockwise as the player sees it). So the two are added, not
 * subtracted.
 *
 * That is deliberately the OPPOSITE convention to the mouse's orbit drag,
 * which turntables the camera ("dragging right turns the world left"). It is
 * not an inconsistency to fix: direct manipulation is the settled standard for
 * a two-finger twist — every map application on every phone turns the map with
 * the fingers — and a mouse has no twist gesture to disagree with it. The two
 * conventions never meet on the same input.
 *
 * Elevation is left alone. A two-finger sample carries no signal for it that
 * is not already spoken for: the vertical component of the midpoint's movement
 * is pan, and taking a share of it for elevation would make every vertical
 * two-finger drag tilt the camera slightly as it panned.
 */
export const cameraMoveForTwoFinger = (sample: TwoFingerSample, view: CameraView): CameraMove => {
  const metresPerPixel = worldMetresPerScreenPixel(
    view.distance,
    view.verticalFovDegrees,
    view.viewportHeightPx,
  )

  // A pinch of zero (fingers reported at the same point) has no reciprocal,
  // and a negative one cannot be produced by a distance ratio at all. Both are
  // taken as "this sample says nothing about scale" rather than as a licence
  // to divide — see MAX_ZOOM_STEP_PER_SAMPLE for why the camera must not act
  // on the infinity that division would produce.
  const zoomFactor =
    sample.pinch > 0
      ? clamp(1 / sample.pinch, 1 / MAX_ZOOM_STEP_PER_SAMPLE, MAX_ZOOM_STEP_PER_SAMPLE)
      : 1

  return {
    pan: {
      dRight: -sample.pan.dx * metresPerPixel,
      dForward: sample.pan.dy * metresPerPixel,
    },
    zoomFactor,
    dAzimuth: sample.twist,
  }
}
