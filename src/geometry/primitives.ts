import { type Vec2, normalizeAngle } from './vec2'

export type Pose = {
  readonly position: Vec2
  readonly heading: number
  readonly curvature: number
}

export interface Primitive {
  readonly length: number
  poseAt(s: number): Pose
}

const clamp = (s: number, length: number): number =>
  s < 0 ? 0 : s > length ? length : s

/** A straight segment of constant heading and zero curvature. */
export class Line implements Primitive {
  constructor(
    readonly start: Vec2,
    readonly heading: number,
    readonly length: number,
  ) {}

  poseAt(s: number): Pose {
    const t = clamp(s, this.length)
    return {
      position: {
        x: this.start.x + t * Math.cos(this.heading),
        y: this.start.y + t * Math.sin(this.heading),
      },
      heading: normalizeAngle(this.heading),
      curvature: 0,
    }
  }
}

/**
 * A circular arc of constant curvature.
 * Positive curvature turns left (counter-clockwise); radius is 1/|curvature|.
 *
 * Integrating heading(s) = heading0 + curvature * s gives:
 *   x(s) = x0 + ( sin(heading0 + k*s) - sin(heading0) ) / k
 *   y(s) = y0 - ( cos(heading0 + k*s) - cos(heading0) ) / k
 */
export class Arc implements Primitive {
  constructor(
    readonly start: Vec2,
    readonly heading: number,
    readonly length: number,
    readonly curvature: number,
  ) {
    if (curvature === 0) {
      throw new RangeError('Arc curvature must be non-zero; use Line instead')
    }
  }

  poseAt(s: number): Pose {
    const t = clamp(s, this.length)
    const k = this.curvature
    const h0 = this.heading
    const h = h0 + k * t
    return {
      position: {
        x: this.start.x + (Math.sin(h) - Math.sin(h0)) / k,
        y: this.start.y - (Math.cos(h) - Math.cos(h0)) / k,
      },
      heading: normalizeAngle(h),
      curvature: k,
    }
  }
}
