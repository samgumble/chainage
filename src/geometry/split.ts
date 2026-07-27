import { Alignment } from './alignment'
import { Arc, Line, type Primitive } from './primitives'
import { Spiral } from './spiral'

/**
 * Divide a primitive at a station, producing two of the same kind.
 *
 * Each type carries a different invariant across the cut. A line keeps its
 * heading. An arc keeps its curvature and takes the swept heading at the cut.
 * A spiral keeps its curvature *rate*, which is preserved implicitly: the
 * curvature at the cut is the boundary value for both halves, so
 * `(k_cut - k0) / cut` and `(k1 - k_cut) / (length - cut)` are both the
 * original rate.
 */
export const splitPrimitive = (p: Primitive, s: number): [Primitive, Primitive] => {
  if (!(s > 0 && s < p.length)) {
    throw new RangeError(
      `split station ${s} must lie strictly inside (0, ${p.length})`,
    )
  }

  const at = p.poseAt(s)
  const rest = p.length - s

  if (p instanceof Line) {
    return [new Line(p.start, p.heading, s), new Line(at.position, p.heading, rest)]
  }

  if (p instanceof Arc) {
    return [
      new Arc(p.start, p.heading, s, p.curvature),
      new Arc(at.position, at.heading, rest, p.curvature),
    ]
  }

  if (p instanceof Spiral) {
    return [
      new Spiral(p.start, p.heading, s, p.startCurvature, at.curvature),
      new Spiral(at.position, at.heading, rest, at.curvature, p.endCurvature),
    ]
  }

  throw new TypeError('cannot split an unrecognised primitive type')
}

/**
 * Divide an alignment at a station.
 *
 * A cut landing exactly on a joint moves the whole primitive to the second
 * half rather than splitting it into a zero-length piece and itself.
 */
export const splitAlignment = (a: Alignment, s: number): [Alignment, Alignment] => {
  if (a.isEmpty) {
    throw new RangeError('cannot split an empty alignment')
  }
  if (!(s > 0 && s < a.length)) {
    throw new RangeError(
      `split station ${s} must lie strictly inside (0, ${a.length})`,
    )
  }

  const { index, localS } = a.primitiveAt(s)
  const before = a.primitives.slice(0, index)
  const after = a.primitives.slice(index + 1)
  const target = a.primitives[index]!

  // `primitiveAt` resolves a tie to the primitive *starting* at the station,
  // so a cut on a joint arrives here as localS === 0. The mirror case,
  // localS === target.length, can only arise at s === a.length, excluded above.
  if (localS === 0) {
    return [new Alignment(before), new Alignment([target, ...after])]
  }

  const [head, tail] = splitPrimitive(target, localS)
  return [new Alignment([...before, head]), new Alignment([tail, ...after])]
}
