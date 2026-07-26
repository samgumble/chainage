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
    poses.push(this.poseAt(this.length))
    return poses
  }
}
