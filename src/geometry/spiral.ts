import { type Vec2, normalizeAngle } from './vec2'
import type { Pose, Primitive } from './primitives'

/** Integration steps per metre. 0.5 gives sub-millimetre error at road scale. */
const STEPS_PER_METRE = 0.5
const MIN_STEPS = 16

/**
 * A clothoid (Euler spiral): curvature varies linearly with distance.
 *
 *   curvature(s) = k0 + (k1 - k0) * s / L
 *   heading(s)   = h0 + k0*s + (k1 - k0)*s^2 / (2L)      [closed form]
 *   position(s)  = integral of (cos h, sin h) ds          [no closed form]
 *
 * Heading is exact; position is integrated with composite Simpson's rule,
 * which is exact for the cubic terms that dominate at road scale.
 */
export class Spiral implements Primitive {
  private readonly curvatureRate: number

  constructor(
    readonly start: Vec2,
    readonly heading: number,
    readonly length: number,
    readonly startCurvature: number,
    readonly endCurvature: number,
  ) {
    this.curvatureRate =
      length === 0 ? 0 : (endCurvature - startCurvature) / length
  }

  curvatureAt(s: number): number {
    return this.startCurvature + this.curvatureRate * s
  }

  /** Closed form: the integral of curvature from 0 to s. */
  headingAt(s: number): number {
    return this.heading + this.startCurvature * s + 0.5 * this.curvatureRate * s * s
  }

  poseAt(s: number): Pose {
    const t = s < 0 ? 0 : s > this.length ? this.length : s

    // Composite Simpson's rule needs an even number of intervals.
    let n = Math.max(MIN_STEPS, Math.ceil(t * STEPS_PER_METRE))
    if (n % 2 !== 0) n += 1

    const h = t / n
    let sumX = 0
    let sumY = 0

    for (let i = 0; i <= n; i++) {
      const si = i * h
      const weight = i === 0 || i === n ? 1 : i % 2 === 1 ? 4 : 2
      const angle = this.headingAt(si)
      sumX += weight * Math.cos(angle)
      sumY += weight * Math.sin(angle)
    }

    const factor = h / 3
    return {
      position: {
        x: this.start.x + factor * sumX,
        y: this.start.y + factor * sumY,
      },
      heading: normalizeAngle(this.headingAt(t)),
      curvature: this.curvatureAt(t),
    }
  }
}
