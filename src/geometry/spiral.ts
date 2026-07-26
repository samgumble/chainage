import { type Vec2, normalizeAngle } from './vec2'
import { clamp, type Pose, type Primitive } from './primitives'

/** Integration steps per metre. 0.5 gives sub-millimetre error at road scale. */
const STEPS_PER_METRE = 0.5
/**
 * Extra integration steps per radian of total heading sweep over the
 * integrated segment. STEPS_PER_METRE alone scales with length only, so a
 * short, tightly-curving spiral (large heading change over little distance)
 * under-samples the oscillating cos/sin integrand. 40 was chosen empirically
 * against a 20000-interval Simpson reference: it brings a 40m spiral with
 * curvature swinging from -1/10 to +1/10 (the reported failure case, ~2.7e-4
 * error before this fix) down to ~5e-8, comfortably under the 5e-5 tolerance
 * implied by the tests' toBeCloseTo(x, 4).
 */
const STEPS_PER_RADIAN = 40
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
    const t = clamp(s, this.length)
    return this.startCurvature + this.curvatureRate * t
  }

  /** Closed form: the integral of curvature from 0 to s. */
  headingAt(s: number): number {
    const t = clamp(s, this.length)
    return this.heading + this.startCurvature * t + 0.5 * this.curvatureRate * t * t
  }

  poseAt(s: number): Pose {
    const t = clamp(s, this.length)

    // Bound the total heading swept over [0, t]: for a rate that changes
    // sign this isn't the net turn, but (|k0| + |k(t)|)/2 * t safely bounds
    // the swept magnitude that drives how fast cos/sin oscillate.
    const sweep = (Math.abs(this.startCurvature) + Math.abs(this.curvatureAt(t))) / 2 * t

    // Composite Simpson's rule needs an even number of intervals.
    let n = Math.max(MIN_STEPS, Math.ceil(t * STEPS_PER_METRE + sweep * STEPS_PER_RADIAN))
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
      s: t,
      position: {
        x: this.start.x + factor * sumX,
        y: this.start.y + factor * sumY,
      },
      heading: normalizeAngle(this.headingAt(t)),
      curvature: this.curvatureAt(t),
    }
  }
}
