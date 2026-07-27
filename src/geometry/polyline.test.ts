import { describe, expect, it } from 'vitest'
import { Arc, Line } from './primitives'
import { type Vec2, distance } from './vec2'
import { buildPolylineAlignment } from './polyline'

const at = (x: number, y: number): Vec2 => ({ x, y })

/** The alignment must start at the first point and end at the last. */
const expectEndpoints = (
  result: ReturnType<typeof buildPolylineAlignment>,
  first: Vec2,
  last: Vec2,
) => {
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const a = result.alignment
  expect(distance(a.poseAt(0).position, first)).toBeLessThan(1e-6)
  expect(distance(a.poseAt(a.length).position, last)).toBeLessThan(1e-6)
}

describe('buildPolylineAlignment', () => {
  it('turns two points into a single straight', () => {
    const result = buildPolylineAlignment([at(0, 0), at(100, 0)], 50)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.alignment.primitives).toHaveLength(1)
    expect(result.alignment.primitives[0]).toBeInstanceOf(Line)
    expect(result.alignment.length).toBeCloseTo(100, 9)
  })

  it('inserts an arc at a corner and keeps the chain continuous', () => {
    const points = [at(0, 0), at(200, 0), at(200, 200)]
    const result = buildPolylineAlignment(points, 50)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const { alignment } = result
    expect(alignment.isContinuous).toBe(true)
    expect(alignment.primitives.map((p) => p.constructor.name)).toEqual([
      'Line', 'Arc', 'Line',
    ])
    expectEndpoints(result, points[0]!, points[2]!)
  })

  it('gives the inserted arc the radius it was asked for', () => {
    const result = buildPolylineAlignment([at(0, 0), at(200, 0), at(200, 200)], 50)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const arc = result.alignment.primitives.find((p) => p instanceof Arc)
    expect(arc).toBeInstanceOf(Arc)
    if (!(arc instanceof Arc)) return
    expect(1 / Math.abs(arc.curvature)).toBeCloseTo(50, 6)
  })

  it('shortens the straights to meet the curve, rather than overshooting the corner', () => {
    // A 90-degree corner at (200, 0) with radius 50 gives T = 50, so the first
    // straight runs 0..150 and the second starts 50m past the corner.
    const result = buildPolylineAlignment([at(0, 0), at(200, 0), at(200, 200)], 50)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [first] = result.alignment.primitives
    expect(first).toBeInstanceOf(Line)
    expect(first?.length).toBeCloseTo(150, 6)
  })

  it('emits no curve for a corner that does not turn', () => {
    const result = buildPolylineAlignment([at(0, 0), at(100, 0), at(200, 0)], 50)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.alignment.primitives.every((p) => p instanceof Line)).toBe(true)
    expect(result.alignment.isContinuous).toBe(true)
    expect(result.alignment.length).toBeCloseTo(200, 6)
  })

  it('handles several corners in a row', () => {
    const points = [at(0, 0), at(300, 0), at(300, 300), at(600, 300), at(600, 600)]
    const result = buildPolylineAlignment(points, 40)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.alignment.isContinuous).toBe(true)
    expect(result.alignment.primitives.filter((p) => p instanceof Arc)).toHaveLength(3)
    expectEndpoints(result, points[0]!, points[4]!)
  })

  it('turns both ways', () => {
    // Right then left. Curvature signs must differ.
    const points = [at(0, 0), at(200, 0), at(200, -200), at(400, -200)]
    const result = buildPolylineAlignment(points, 40)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const arcs = result.alignment.primitives.filter((p): p is Arc => p instanceof Arc)
    expect(arcs).toHaveLength(2)
    expect(Math.sign(arcs[0]!.curvature)).not.toBe(Math.sign(arcs[1]!.curvature))
    expect(result.alignment.isContinuous).toBe(true)
  })

  it('ignores a repeated point', () => {
    const result = buildPolylineAlignment(
      [at(0, 0), at(100, 0), at(100, 0), at(200, 0)],
      50,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // A duplicate leaves a zero-length segment with no direction; every angle
    // computed from it would be meaningless, so it must be dropped rather
    // than treated as a corner.
    expect(result.alignment.length).toBeCloseTo(200, 6)
    expect(result.alignment.isContinuous).toBe(true)
  })

  it('rejects fewer than two distinct points', () => {
    expect(buildPolylineAlignment([at(0, 0)], 50)).toEqual({
      ok: false,
      rejection: { reason: 'too-few-points' },
    })
    expect(buildPolylineAlignment([at(0, 0), at(0, 0)], 50)).toEqual({
      ok: false,
      rejection: { reason: 'too-few-points' },
    })
    expect(buildPolylineAlignment([], 50)).toEqual({
      ok: false,
      rejection: { reason: 'too-few-points' },
    })
  })

  it('rejects a hairpin, naming the point at fault', () => {
    // Almost a full reversal: tangent distance diverges.
    const points = [at(0, 0), at(1000, 0), at(0, 1)]
    const result = buildPolylineAlignment(points, 50)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe('corner-too-sharp')
    if (result.rejection.reason !== 'corner-too-sharp') return
    expect(result.rejection.index).toBe(1)
  })

  it('rejects curves that would overlap, and says by how much', () => {
    // Two 90-degree corners 60m apart, each needing T = 50: 100m of tangent
    // into a 60m straight.
    const points = [at(0, 0), at(200, 0), at(200, 60), at(400, 60)]
    const result = buildPolylineAlignment(points, 50)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe('curves-overlap')
    if (result.rejection.reason !== 'curves-overlap') return
    expect(result.rejection.available).toBeCloseTo(60, 6)
    expect(result.rejection.required).toBeCloseTo(100, 6)
    expect(result.rejection.index).toBe(1)
  })

  it('reports the original index of a bad corner even after a duplicate is dropped', () => {
    // The duplicate at index 1 shifts every later point; the reported index
    // must refer to the caller's array, not the cleaned one.
    const points = [at(0, 0), at(0, 0), at(1000, 0), at(0, 1)]
    const result = buildPolylineAlignment(points, 50)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe('corner-too-sharp')
    if (result.rejection.reason !== 'corner-too-sharp') return
    expect(result.rejection.index).toBe(2)
  })

  it('accepts curves that exactly fill the straight between them', () => {
    // Two 90-degree corners 100m apart, each needing T = 50. Exactly zero
    // straight left between them — legal, and must not emit a zero-length
    // primitive.
    const points = [at(0, 0), at(200, 0), at(200, 100), at(400, 100)]
    const result = buildPolylineAlignment(points, 50)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.alignment.isContinuous).toBe(true)
    for (const p of result.alignment.primitives) {
      expect(p.length).toBeGreaterThan(0)
    }
  })

  it('rejects a non-positive radius', () => {
    expect(() => buildPolylineAlignment([at(0, 0), at(100, 0)], 0)).toThrow(RangeError)
    expect(() => buildPolylineAlignment([at(0, 0), at(100, 0)], -5)).toThrow(RangeError)
  })
})
