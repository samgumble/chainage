import { clamp, type Pose, type Primitive } from './primitives'

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

  constructor(readonly primitives: readonly Primitive[]) {
    this.starts = []
    let total = 0
    for (const p of primitives) {
      this.starts.push(total)
      total += p.length
    }
    this.length = total
  }

  get isEmpty(): boolean {
    return this.primitives.length === 0
  }

  poseAt(s: number): Pose {
    if (this.isEmpty) {
      throw new RangeError('Cannot evaluate an empty alignment')
    }
    const t = clamp(s, this.length)

    // Find the last primitive whose start is <= t.
    let index = 0
    for (let i = this.primitives.length - 1; i >= 0; i--) {
      if (t >= this.starts[i]!) {
        index = i
        break
      }
    }

    const primitive = this.primitives[index]!
    return primitive.poseAt(t - this.starts[index]!)
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
    poses.push(this.poseAt(this.length))
    return poses
  }
}
