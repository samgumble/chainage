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

/** Slack on the overlap comparison so exactly-touching curves are legal. */
const OVERLAP_TOLERANCE = 1e-9

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
    const from = kept[seg]!.point
    const to = kept[seg + 1]!.point
    const endFillet = filletAt(seg + 1)

    // The straight runs from wherever the previous curve let go, to wherever
    // the next one takes over.
    const lineEnd = endFillet ? endFillet.tangentIn : to
    const lineLength = distance(cursor, lineEnd)

    // Two curves may exactly meet, leaving no straight at all. That is legal;
    // a zero-length primitive is not.
    if (lineLength > MIN_SEGMENT_LENGTH) {
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
