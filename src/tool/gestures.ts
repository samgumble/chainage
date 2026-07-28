import { type Vec2, add, distance, scale, signedAngleBetween, sub } from '../geometry/vec2'

/**
 * A point in screen pixels: x right, y down, origin at the canvas's top-left.
 *
 * Structurally a `Vec2`, and the `vec2` helpers are used on it deliberately,
 * but the name is here to keep the two spaces apart in the reader's head.
 * Nothing in this module is in world metres. Every distance below is a
 * distance across the glass, and any position leaving here has to be
 * unprojected before it means anything on the ground.
 */
export type ScreenPoint = Vec2

/**
 * How far a finger may travel and still have its lift read as a tap, screen
 * pixels.
 *
 * Ten. Android's `ViewConfiguration` puts touch slop at 8dp and UIKit's tap
 * tolerance sits at roughly 10pt, so both platforms draw the line in the same
 * place and a player who learned the feel on either will find this familiar.
 * The unit is CSS pixels rather than device pixels on purpose: CSS pixels are
 * already normalised for display density, so ten of them is about the same
 * physical distance on every phone — and a fingertip's tremor is a physical
 * distance, not a pixel count.
 */
const TAP_SLOP = 10

/**
 * How long a finger may stay down and still have its lift read as a tap,
 * milliseconds.
 *
 * Five hundred, matching Android's long-press timeout and UIKit's default
 * `minimumPressDuration` of 0.5s. Past it the player is holding, not tapping.
 * On a drawing surface a finger held that long without ever crossing the slop
 * is far more likely to be a hand resting on the glass than a road point
 * being aimed, so the recogniser reports nothing at all rather than placing
 * one — see `up`.
 */
const TAP_TIMEOUT = 500

/**
 * How long after a tap a second tap still counts as a double tap,
 * milliseconds.
 *
 * Three hundred, exactly `ViewConfiguration.getDoubleTapTimeout()`.
 *
 * The window costs nothing in latency here because the first tap is reported
 * the instant it happens, and the second is reported as a `doubleTap` alone.
 * The alternative — withholding every tap for 300ms to see whether a second
 * one follows — would put a third of a second between the player's finger and
 * every single road point. On a game whose whole pitch is drawing roads
 * calmly, that lag is a far worse defect than a consumer having to accept
 * that the first tap of a double tap already landed.
 */
const DOUBLE_TAP_WINDOW = 300

/**
 * How far apart two taps may land and still be one double tap, screen pixels.
 *
 * Thirty: three times the tap slop, and still narrower than the ~40px contact
 * patch of an adult fingertip at typical phone density. A player double
 * tapping does not re-aim between the two taps, so two taps further apart
 * than a fingertip were aimed at different things.
 *
 * Android's own double-tap slop is much looser — 100dp — which is right for a
 * screen of buttons and wrong here: two road points a fingertip apart are a
 * perfectly ordinary thing to want to draw, and swallowing the second as a
 * double tap would make short kerbs impossible.
 */
const DOUBLE_TAP_SLOP = 30

/**
 * Something the player did, in screen pixels.
 *
 * A discriminated union so a consumer's `switch` is exhaustive: every gesture
 * this recogniser can produce has to be answered for somewhere.
 *
 * `dragCancel` is a separate kind rather than a flag on `dragEnd` on purpose.
 * The two mean opposite things — `dragEnd` commits the pending road point,
 * `dragCancel` throws it away — and a boolean is far too easy to forget to
 * read. As distinct kinds the type system makes the consumer say which one it
 * meant.
 */
export type Gesture =
  | { readonly kind: 'tap'; readonly x: number; readonly y: number; readonly time: number }
  | { readonly kind: 'doubleTap'; readonly x: number; readonly y: number; readonly time: number }
  /** The finger crossed the slop. `x`/`y` are where it went *down*, the anchor. */
  | { readonly kind: 'dragStart'; readonly x: number; readonly y: number; readonly time: number }
  | {
      readonly kind: 'dragMove'
      readonly x: number
      readonly y: number
      /** Movement since the previous sample (since `dragStart`'s anchor, the first time). */
      readonly dx: number
      readonly dy: number
      readonly time: number
    }
  /** The drag finished normally. Commit whatever it was previewing. */
  | { readonly kind: 'dragEnd'; readonly x: number; readonly y: number; readonly time: number }
  /** The drag was abandoned. Discard whatever it was previewing. */
  | { readonly kind: 'dragCancel'; readonly time: number }
  | { readonly kind: 'twoFingerStart'; readonly centre: ScreenPoint; readonly time: number }
  /**
   * One two-finger sample: the whole camera gesture at one instant.
   *
   * Pan, pinch and twist arrive together in a single event rather than as
   * three, because they are three components of one similarity transform
   * about `centre` and the consumer applies them as one. Splitting them would
   * force a camera to buffer three events and work out which of them belonged
   * to the same instant — reconstructing information this recogniser already
   * had. Every component is always present: pan is zero, pinch is exactly 1
   * and twist is exactly 0 when nothing of that kind happened, so "did
   * anything else move?" is never a question the consumer has to ask.
   *
   * No dead band is applied. What the fingers did is a fact; what counts as
   * too small to act on is a camera-tuning decision, and belongs with the
   * camera.
   */
  | {
      readonly kind: 'twoFinger'
      /** Movement of the midpoint since the previous sample, screen pixels. */
      readonly pan: { readonly dx: number; readonly dy: number }
      /** Multiplier on the distance between the fingers since the previous sample. */
      readonly pinch: number
      /**
       * Rotation of the line between the fingers since the previous sample,
       * radians. Positive is clockwise *as the player sees it*, because this
       * module works in screen pixels where y increases downward.
       */
      readonly twist: number
      /** Current midpoint: the point to pivot and zoom about. */
      readonly centre: ScreenPoint
      readonly time: number
    }
  | { readonly kind: 'twoFingerEnd'; readonly time: number }

type Phase =
  /** Nothing down. */
  | { readonly kind: 'idle' }
  /** One finger down, still undecided between tap and drag. */
  | {
      readonly kind: 'pending'
      readonly id: number
      readonly start: ScreenPoint
      readonly startTime: number
    }
  /** One finger down, past the slop. */
  | { readonly kind: 'dragging'; readonly id: number; readonly last: ScreenPoint }
  /** Two fingers driving the camera. Any other pointer is ignored. */
  | {
      readonly kind: 'twoFinger'
      readonly a: number
      readonly b: number
      readonly centre: ScreenPoint
      readonly span: number
      /** The vector from a to b, kept whole so twist can be measured without angle wrap. */
      readonly axis: ScreenPoint
    }
  /**
   * Fingers are still down but own nothing.
   *
   * Reached when a gesture ends or is taken away while the hand is still on
   * the glass. Without it, lifting one finger out of a pinch would hand the
   * remaining finger straight back to the drawing tool, and the road point
   * would leap to wherever that finger happened to be resting.
   */
  | { readonly kind: 'spent' }

/**
 * Turns a stream of pointer events into named gestures.
 *
 * One finger draws: a tap places a road point, a drag moves the pending one
 * so the preview follows the finger. Two fingers drive the camera: pan, pinch
 * and twist. That split is what makes a drawing app work on touch — the
 * alternative, one finger for the camera plus a mode button for drawing, puts
 * a mode switch between the player and every road they draw.
 *
 * Deliberately pure: numbers in, gestures out. No DOM types, no renderer, and
 * no clock — `time` is always a parameter, never `Date.now()`, so a test can
 * describe a 301-millisecond gap exactly rather than sleeping and hoping.
 * Adapting real `PointerEvent`s to these four methods is the browser's job,
 * and stays thin enough to read in one sitting.
 *
 * Each method returns the gestures that event produced, usually none or one.
 */
export class GestureRecogniser {
  private readonly active = new Map<number, ScreenPoint>()
  private phase: Phase = { kind: 'idle' }
  private lastTap: { readonly position: ScreenPoint; readonly time: number } | undefined

  /** Whether any gesture is currently being tracked. */
  get inProgress(): boolean {
    return this.phase.kind !== 'idle'
  }

  down(id: number, x: number, y: number, time: number): readonly Gesture[] {
    const out: Gesture[] = []
    const position: ScreenPoint = { x, y }

    if (this.active.has(id)) {
      // A repeated down for a pointer already tracked. Treat it as a move of
      // that pointer rather than as a new finger, which would corrupt the
      // two-finger pair.
      this.active.set(id, position)
      return out
    }
    this.active.set(id, position)

    switch (this.phase.kind) {
      case 'idle':
        this.phase = { kind: 'pending', id, start: position, startTime: time }
        break

      case 'pending': {
        // The first finger never crossed the slop, so no drag had begun and
        // there is nothing to cancel.
        this.beginTwoFinger(this.phase.id, id, time, out)
        break
      }

      case 'dragging': {
        const dragId = this.phase.id
        // The case this whole module exists to get right. A drag interrupted
        // by a second finger is cancelled, never ended: the player is
        // reaching for the camera, and committing the pending road point here
        // would place one they never asked for every time they start a pinch.
        out.push({ kind: 'dragCancel', time })
        this.beginTwoFinger(dragId, id, time, out)
        break
      }

      case 'twoFinger':
        // A third finger, or a fourth. Ignored outright — it is tracked in
        // `active` so its lift is accounted for, but it takes no part in the
        // gesture. Swapping the pair over to it would make the camera jump,
        // and a palm landing on the screen mid-pinch is the common cause.
        break

      case 'spent':
        // A finger put back down during a gesture that had already ended.
        // Once two are down again, resume the camera: re-placing a finger
        // mid-pinch is ordinary, and refusing to notice would strand the
        // player with a dead screen until they lifted their whole hand.
        if (this.active.size === 2) {
          const ids = [...this.active.keys()]
          const [first, second] = ids
          if (first !== undefined && second !== undefined) {
            this.beginTwoFinger(first, second, time, out)
          }
        }
        break
    }

    return out
  }

  move(id: number, x: number, y: number, time: number): readonly Gesture[] {
    const out: Gesture[] = []
    if (!this.active.has(id)) return out

    const position: ScreenPoint = { x, y }
    this.active.set(id, position)

    switch (this.phase.kind) {
      case 'pending': {
        const phase = this.phase
        if (phase.id !== id) break
        if (distance(position, phase.start) <= TAP_SLOP) break

        this.phase = { kind: 'dragging', id, last: position }
        // The anchor first, then where the finger is now: the consumer gets
        // both without having to remember the down position itself.
        out.push({ kind: 'dragStart', x: phase.start.x, y: phase.start.y, time })
        out.push({
          kind: 'dragMove',
          x,
          y,
          dx: x - phase.start.x,
          dy: y - phase.start.y,
          time,
        })
        break
      }

      case 'dragging': {
        const phase = this.phase
        if (phase.id !== id) break
        out.push({ kind: 'dragMove', x, y, dx: x - phase.last.x, dy: y - phase.last.y, time })
        this.phase = { kind: 'dragging', id, last: position }
        break
      }

      case 'twoFinger': {
        const phase = this.phase
        if (id !== phase.a && id !== phase.b) break
        const a = this.active.get(phase.a)
        const b = this.active.get(phase.b)
        if (a === undefined || b === undefined) break

        const centre = scale(add(a, b), 0.5)
        const axis = sub(b, a)
        const span = distance(a, b)
        const pan = sub(centre, phase.centre)
        // Two fingers exactly coincident have no span to scale from. Report no
        // zoom rather than a division by zero.
        const pinch = phase.span === 0 ? 1 : span / phase.span
        // Measured between the two axis vectors rather than by subtracting
        // stored angles, so a gesture that crosses the +/-PI seam reports a
        // small rotation instead of a full turn.
        const twist = signedAngleBetween(phase.axis, axis)

        this.phase = { kind: 'twoFinger', a: phase.a, b: phase.b, centre, span, axis }
        out.push({
          kind: 'twoFinger',
          pan: { dx: pan.x, dy: pan.y },
          pinch,
          twist,
          centre,
          time,
        })
        break
      }

      case 'idle':
      case 'spent':
        break
    }

    return out
  }

  up(id: number, time: number): readonly Gesture[] {
    const out: Gesture[] = []
    if (!this.active.has(id)) return out
    this.active.delete(id)

    switch (this.phase.kind) {
      case 'pending': {
        const phase = this.phase
        if (phase.id !== id) break
        if (time - phase.startTime <= TAP_TIMEOUT) {
          // The down position, not the up one. It is where the player aimed;
          // the up position has whatever roll the finger picked up on release.
          out.push(this.resolveTap(phase.start, time))
        }
        this.phase = this.settled()
        break
      }

      case 'dragging': {
        const phase = this.phase
        if (phase.id !== id) break
        out.push({ kind: 'dragEnd', x: phase.last.x, y: phase.last.y, time })
        this.phase = this.settled()
        break
      }

      case 'twoFinger': {
        const phase = this.phase
        // A third, ignored finger lifting leaves the pair alone.
        if (id !== phase.a && id !== phase.b) break
        out.push({ kind: 'twoFingerEnd', time })
        this.phase = this.settled()
        break
      }

      case 'idle':
      case 'spent':
        this.phase = this.settled()
        break
    }

    return out
  }

  /**
   * The browser or the OS took the pointer away — a scroll took over, a
   * system edge gesture started, a call arrived. Routine on mobile.
   *
   * Whatever was in progress is abandoned, never completed: a stolen pointer
   * is not a player finishing a road point. `time` is a parameter for the same
   * reason it is everywhere else here, and a real `pointercancel` event
   * carries a `timeStamp` to supply it.
   */
  cancel(id: number, time: number): readonly Gesture[] {
    const out: Gesture[] = []
    if (!this.active.has(id)) return out
    this.active.delete(id)

    switch (this.phase.kind) {
      case 'pending': {
        // No drag had begun, and a cancelled press is not a tap.
        if (this.phase.id === id) this.phase = this.settled()
        break
      }

      case 'dragging': {
        if (this.phase.id !== id) break
        out.push({ kind: 'dragCancel', time })
        this.phase = this.settled()
        break
      }

      case 'twoFinger': {
        const phase = this.phase
        if (id !== phase.a && id !== phase.b) break
        out.push({ kind: 'twoFingerEnd', time })
        this.phase = this.settled()
        break
      }

      case 'idle':
      case 'spent':
        this.phase = this.settled()
        break
    }

    return out
  }

  /** Idle only once the glass is clear; otherwise the remaining fingers own nothing. */
  private settled(): Phase {
    return this.active.size === 0 ? { kind: 'idle' } : { kind: 'spent' }
  }

  private resolveTap(position: ScreenPoint, time: number): Gesture {
    const previous = this.lastTap
    if (
      previous !== undefined &&
      time - previous.time <= DOUBLE_TAP_WINDOW &&
      distance(position, previous.position) <= DOUBLE_TAP_SLOP
    ) {
      // Cleared, so a third tap starts a new pair rather than chaining into a
      // second double tap off the same middle one.
      this.lastTap = undefined
      return { kind: 'doubleTap', x: position.x, y: position.y, time }
    }
    this.lastTap = { position, time }
    return { kind: 'tap', x: position.x, y: position.y, time }
  }

  private beginTwoFinger(a: number, b: number, time: number, out: Gesture[]): void {
    const pa = this.active.get(a)
    const pb = this.active.get(b)
    if (pa === undefined || pb === undefined) {
      this.phase = this.settled()
      return
    }

    // A tap from before the camera move must not pair with one from after it:
    // the seconds spent pinching are not a player double tapping.
    this.lastTap = undefined

    const centre = scale(add(pa, pb), 0.5)
    this.phase = {
      kind: 'twoFinger',
      a,
      b,
      centre,
      span: distance(pa, pb),
      axis: sub(pb, pa),
    }
    out.push({ kind: 'twoFingerStart', centre, time })
  }
}
