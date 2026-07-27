import { Alignment } from './alignment'
import { type Fillet, MIN_DEFLECTION, filletCorner } from './fillet'
import { Line, type Primitive } from './primitives'
import { type Vec2, angleOf, distance, signedAngleBetween, sub } from './vec2'

export type PolylineRejection =
  | { readonly reason: 'too-few-points' }
  | {
      readonly reason: 'corner-too-sharp'
      /** Index into the caller's array of the corner that cannot be filleted. */
      readonly index: number
    }
  | {
      readonly reason: 'curves-overlap'
      /** Index into the caller's array of the point the straight starts from. */
      readonly index: number
      /** Tangent length the two curves need, metres. */
      readonly required: number
      /** Length of the straight they have to share, metres. */
      readonly available: number
    }
  | {
      readonly reason: 'segment-too-short'
      /** Index into the caller's array of the point the straight starts from. */
      readonly index: number
      /** Actual length of the straight, metres. */
      readonly length: number
      /** Minimum legal length, metres. */
      readonly limit: number
    }

export type PolylineResult =
  | { readonly ok: true; readonly alignment: Alignment }
  | { readonly ok: false; readonly rejection: PolylineRejection }

/**
 * Shorter than this and a segment has no usable direction, metres.
 *
 * A millimetre is far below any distance a player can express by clicking and
 * far above the floating-point noise of a projected pointer position.
 */
const MIN_SEGMENT_LENGTH = 1e-3

/**
 * Slack on the overlap comparison so exactly-touching curves are legal.
 *
 * Exported so a test can pin its value directly (construct a straight whose
 * required tangent length exceeds what is available by less than this, and
 * assert it is still accepted) rather than relying on an example where
 * floating-point rounding happens to land on the accepting side regardless
 * of whether this constant is even applied.
 */
export const OVERLAP_TOLERANCE = 1e-9

/**
 * Shortest legal straight, metres. From the design spec (§4.1): "minimum
 * ~7m (reject shorter)" — tiny segments are a documented source of both
 * visual artifacts and pathfinding failures.
 *
 * **Scope decision:** this bounds the *built* straight — the Line primitive
 * actually emitted after fillets have consumed their share of each end —
 * not the raw distance between two clicks. Two things make that the right
 * layer to check, not just a convenient one:
 *
 * 1. A straight that two adjacent curves fully consume is already legal and
 *    already never emitted (see the zero-length handling below, and "accepts
 *    curves that exactly fill the straight between them" in the test file).
 *    Checking the raw click distance instead would have no principled way to
 *    exempt that case from a generic "click segment too short" rule without
 *    re-deriving the same fillet math this check sits downstream of anyway.
 * 2. What the spec is actually guarding against — a sliver that shows up as
 *    a visual artifact or breaks pathfinding — is a property of the geometry
 *    that gets built, not of where the player happened to click. A rural
 *    road and a highway share a click distance but consume different tangent
 *    lengths from it (different corner radii), so only the built length is
 *    class-independent in the way the spec's warning is: it is either a real
 *    sliver in the road that gets built, or it never existed at all. Reading
 *    it off the raw clicks would flag some highways for a click distance a
 *    gravel track would happily accept, which does not make sense to someone
 *    drawing: the corner radius that consumed most of their segment is not
 *    something they had control over at the moment they clicked.
 */
const MIN_ALIGNMENT_SEGMENT_LENGTH = 7

/**
 * Turn a clicked polyline into a continuous alignment.
 *
 * Every corner that genuinely turns gets a curve of the given radius, and the
 * straights are shortened to meet their curves' tangent points. Two things
 * make that impossible, and both are reported against the caller's own point
 * indices so the tool can show the player which click is the problem: a corner
 * too sharp to fillet at this radius, and two adjacent curves whose tangent
 * lengths together exceed the straight between them.
 */
export const buildPolylineAlignment = (
  points: readonly Vec2[],
  radius: number,
): PolylineResult => {
  if (!(radius > 0)) {
    throw new RangeError('corner radius must be positive')
  }

  // Drop points that repeat their predecessor. A zero-length segment has no
  // direction, and every angle derived from it would be meaningless — but the
  // caller's indices must survive, since a rejection names one of their clicks.
  const kept: { point: Vec2; index: number }[] = []
  points.forEach((point, index) => {
    const last = kept[kept.length - 1]
    if (last && distance(last.point, point) < MIN_SEGMENT_LENGTH) return
    kept.push({ point, index })
  })

  if (kept.length < 2) {
    return { ok: false, rejection: { reason: 'too-few-points' } }
  }

  // fillets[k] belongs to vertex k + 1. A null entry is a corner straight
  // enough to need no curve.
  const fillets: (Fillet | null)[] = []
  for (let v = 1; v < kept.length - 1; v++) {
    const corner = kept[v]!.point
    const incoming = sub(corner, kept[v - 1]!.point)
    const outgoing = sub(kept[v + 1]!.point, corner)

    if (Math.abs(signedAngleBetween(incoming, outgoing)) < MIN_DEFLECTION) {
      fillets.push(null)
      continue
    }

    // Only reached for a corner that genuinely turns, so a null here means
    // "too sharp to fillet", never "straight".
    const fillet = filletCorner(corner, incoming, outgoing, radius)
    if (!fillet) {
      return {
        ok: false,
        rejection: { reason: 'corner-too-sharp', index: kept[v]!.index },
      }
    }
    fillets.push(fillet)
  }

  /** The fillet at a vertex, or null at the two ends and at straight corners. */
  const filletAt = (vertex: number): Fillet | null => {
    if (vertex <= 0 || vertex >= kept.length - 1) return null
    return fillets[vertex - 1] ?? null
  }

  // Each straight has to accommodate the tangent length of the curve at both
  // of its ends.
  for (let seg = 0; seg < kept.length - 1; seg++) {
    const from = kept[seg]!
    const to = kept[seg + 1]!
    const available = distance(from.point, to.point)
    const required =
      (filletAt(seg)?.tangentDistance ?? 0) +
      (filletAt(seg + 1)?.tangentDistance ?? 0)

    if (required > available + OVERLAP_TOLERANCE) {
      return {
        ok: false,
        rejection: { reason: 'curves-overlap', index: from.index, required, available },
      }
    }
  }

  const primitives: Primitive[] = []
  let cursor = kept[0]!.point

  for (let seg = 0; seg < kept.length - 1; seg++) {
    const fromEntry = kept[seg]!
    const from = fromEntry.point
    const to = kept[seg + 1]!.point
    const endFillet = filletAt(seg + 1)

    // The straight runs from wherever the previous curve let go, to wherever
    // the next one takes over.
    const lineEnd = endFillet ? endFillet.tangentIn : to
    const lineLength = distance(cursor, lineEnd)

    // Two curves may exactly meet, leaving no straight at all. That is legal;
    // a zero-length primitive is not, and only a primitive that will actually
    // be emitted is a "segment" the minimum-length rule below has any
    // business judging (see MIN_ALIGNMENT_SEGMENT_LENGTH's docstring).
    if (lineLength > MIN_SEGMENT_LENGTH) {
      if (lineLength < MIN_ALIGNMENT_SEGMENT_LENGTH) {
        return {
          ok: false,
          rejection: {
            reason: 'segment-too-short',
            index: fromEntry.index,
            length: lineLength,
            limit: MIN_ALIGNMENT_SEGMENT_LENGTH,
          },
        }
      }
      primitives.push(new Line(cursor, angleOf(sub(to, from)), lineLength))
    }

    if (endFillet) {
      primitives.push(endFillet.arc)
      cursor = endFillet.tangentOut
    } else {
      cursor = to
    }
  }

  return { ok: true, alignment: new Alignment(primitives) }
}
