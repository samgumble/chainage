import { clamp, type Pose, type Primitive } from './primitives'
import { distance, normalizeAngle } from './vec2'

export type ContinuityBreak = {
  /** Index of the primitive that starts where the previous one should have ended. */
  readonly index: number
  /** Distance between the previous primitive's end and this one's start, metres. */
  readonly positionGap: number
  /** Absolute heading difference across the joint, radians. */
  readonly headingGap: number
}

/** A millimetre. Below this, a joint is closed as far as anyone can tell. */
const POSITION_TOLERANCE = 1e-3
/** About 0.006 degrees. Below this, a kink is invisible at any road scale. */
const HEADING_TOLERANCE = 1e-4

/**
 * Minimum allowed gap between consecutive stations, in metres.
 *
 * Mirrors the constant of the same name and purpose in
 * `src/terrain/groundProfile.ts` and `src/mesh/ribbon.ts`: `i * spacing`
 * stepping can still land a hair under `this.length` through floating-point
 * noise, and without this guard the final-station append below would add a
 * near-duplicate station instead of replacing the last stepped one.
 * `src/geometry/` imports nothing from outside itself, so this is defined
 * locally rather than shared with those two.
 */
const MIN_STATION_GAP = 1e-6

/**
 * Find every joint where the chain fails to meet.
 *
 * A sound alignment is continuous in position and heading at each joint —
 * curvature may step (a straight meeting an arc is a legitimate curvature
 * discontinuity), but a gap or a kink is a defect. Heading is compared through
 * `normalizeAngle` so a joint straddling the +/-PI boundary reads as closed
 * rather than as a full turn.
 */
export const checkContinuity = (
  primitives: readonly Primitive[],
): ContinuityBreak[] => {
  const breaks: ContinuityBreak[] = []

  for (let i = 1; i < primitives.length; i++) {
    const previous = primitives[i - 1]!
    const current = primitives[i]!

    const end = previous.poseAt(previous.length)
    const start = current.poseAt(0)

    const positionGap = distance(end.position, start.position)
    const headingGap = Math.abs(normalizeAngle(start.heading - end.heading))

    if (positionGap > POSITION_TOLERANCE || headingGap > HEADING_TOLERANCE) {
      breaks.push({ index: i, positionGap, headingGap })
    }
  }

  return breaks
}

/**
 * An ordered chain of primitives forming one road centerline.
 *
 * Primitives are assumed to already be positioned end to end — construction
 * of a continuous chain is the caller's job (see the fillet and road-tool
 * layers). This class only handles arc-length dispatch and sampling.
 */
export class Alignment {
  /** Cumulative start distance of each primitive; starts.length === primitives.length. */
  private readonly starts: number[]
  readonly length: number
  /**
   * Joints that fail to meet. Empty for a sound alignment.
   *
   * Construction does not throw on a break. A half-built alignment mid-drag is
   * a normal transient state, and throwing would make the drawing tool
   * unusable — the tool inspects this and shows the player where the problem
   * is instead.
   */
  readonly continuityBreaks: ContinuityBreak[]

  constructor(readonly primitives: readonly Primitive[]) {
    this.starts = []
    let total = 0
    for (const p of primitives) {
      this.starts.push(total)
      total += p.length
    }
    this.length = total
    this.continuityBreaks = checkContinuity(primitives)
  }

  get isContinuous(): boolean {
    return this.continuityBreaks.length === 0
  }

  get isEmpty(): boolean {
    return this.primitives.length === 0
  }

  /** Which primitive owns a station, and how far into it. */
  primitiveAt(s: number): { readonly index: number; readonly localS: number } {
    if (this.isEmpty) {
      throw new RangeError('cannot locate a station on an empty alignment')
    }
    const t = clamp(s, this.length)

    // Last primitive whose start is at or below t. Ties go to the later one,
    // matching poseAt's existing convention.
    let index = 0
    for (let i = this.primitives.length - 1; i >= 0; i--) {
      if (t >= this.starts[i]!) {
        index = i
        break
      }
    }
    return { index, localS: t - this.starts[index]! }
  }

  poseAt(s: number): Pose {
    const { index, localS } = this.primitiveAt(s)
    const pose = this.primitives[index]!.poseAt(localS)
    // The primitive reported its local station; the alignment reports its own.
    return { ...pose, s: this.starts[index]! + pose.s }
  }

  /** Poses every `spacing` metres, always including s=0 and s=length. */
  sample(spacing: number): Pose[] {
    if (spacing <= 0) {
      throw new RangeError('sample spacing must be positive')
    }
    if (this.isEmpty) return []

    const poses: Pose[] = []
    for (let i = 0; i * spacing < this.length; i++) {
      poses.push(this.poseAt(i * spacing))
    }

    // The final station is always this.length; if that would land within
    // MIN_STATION_GAP of the last stepped station, replace it rather than
    // append a near-duplicate (see MIN_STATION_GAP above).
    const last = poses[poses.length - 1]
    if (!last || this.length - last.s > MIN_STATION_GAP) {
      poses.push(this.poseAt(this.length))
    } else if (last.s !== this.length) {
      poses[poses.length - 1] = this.poseAt(this.length)
    }

    return poses
  }
}
