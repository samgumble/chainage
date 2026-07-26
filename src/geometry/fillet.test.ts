import { describe, it, expect } from 'vitest'
import { filletCorner } from './fillet'
import { vec2, angleOf } from './vec2'

describe('filletCorner', () => {
  it('gives tangent distance equal to radius for a 90 degree turn', () => {
    // Travelling +x, turning to +y, at the corner (100, 0).
    const f = filletCorner(vec2(100, 0), vec2(1, 0), vec2(0, 1), 50)!
    expect(f).not.toBeNull()
    expect(f.tangentDistance).toBeCloseTo(50, 6)
    expect(f.deflection).toBeCloseTo(Math.PI / 2, 9)
  })

  it('places tangent points back along incoming and forward along outgoing', () => {
    const f = filletCorner(vec2(100, 0), vec2(1, 0), vec2(0, 1), 50)!
    expect(f.tangentIn.x).toBeCloseTo(50, 6)
    expect(f.tangentIn.y).toBeCloseTo(0, 6)
    expect(f.tangentOut.x).toBeCloseTo(100, 6)
    expect(f.tangentOut.y).toBeCloseTo(50, 6)
  })

  it('produces an arc that starts at tangentIn and ends at tangentOut', () => {
    const f = filletCorner(vec2(100, 0), vec2(1, 0), vec2(0, 1), 50)!
    const start = f.arc.poseAt(0)
    const end = f.arc.poseAt(f.arc.length)
    expect(start.position.x).toBeCloseTo(f.tangentIn.x, 5)
    expect(start.position.y).toBeCloseTo(f.tangentIn.y, 5)
    expect(end.position.x).toBeCloseTo(f.tangentOut.x, 5)
    expect(end.position.y).toBeCloseTo(f.tangentOut.y, 5)
  })

  it('has arc length equal to radius times deflection', () => {
    const f = filletCorner(vec2(100, 0), vec2(1, 0), vec2(0, 1), 50)!
    expect(f.arc.length).toBeCloseTo(50 * (Math.PI / 2), 6)
  })

  it('curves left with positive curvature for a left turn', () => {
    const f = filletCorner(vec2(100, 0), vec2(1, 0), vec2(0, 1), 50)!
    expect(f.arc.curvature).toBeGreaterThan(0)
    expect(f.arc.curvature).toBeCloseTo(1 / 50, 9)
  })

  it('curves right with negative curvature for a right turn', () => {
    const f = filletCorner(vec2(100, 0), vec2(1, 0), vec2(0, -1), 50)!
    expect(f.arc.curvature).toBeLessThan(0)
    expect(f.arc.curvature).toBeCloseTo(-1 / 50, 9)
    expect(f.deflection).toBeCloseTo(-Math.PI / 2, 9)
  })

  it('scales tangent distance with a shallower turn', () => {
    // A 60 degree deflection: T = R * tan(30 deg) = R * 0.57735
    const out = vec2(Math.cos(Math.PI / 3), Math.sin(Math.PI / 3))
    const f = filletCorner(vec2(0, 0), vec2(1, 0), out, 100)!
    expect(f.tangentDistance).toBeCloseTo(100 * Math.tan(Math.PI / 6), 6)
  })

  it('returns null for a straight corner', () => {
    expect(filletCorner(vec2(0, 0), vec2(1, 0), vec2(1, 0), 50)).toBeNull()
  })

  it('returns null for a full reversal', () => {
    expect(filletCorner(vec2(0, 0), vec2(1, 0), vec2(-1, 0), 50)).toBeNull()
  })

  it('rejects a non-positive radius', () => {
    expect(() => filletCorner(vec2(0, 0), vec2(1, 0), vec2(0, 1), 0)).toThrow(RangeError)
    expect(() => filletCorner(vec2(0, 0), vec2(1, 0), vec2(0, 1), -5)).toThrow(RangeError)
  })

  it('produces the same result for non-unit input vectors as their unit equivalents', () => {
    const unit = filletCorner(vec2(100, 0), vec2(1, 0), vec2(0, 1), 50)!
    const scaled = filletCorner(vec2(100, 0), vec2(5, 0), vec2(0, 3), 50)!
    expect(scaled).not.toBeNull()
    expect(scaled.tangentDistance).toBeCloseTo(unit.tangentDistance, 9)
    expect(scaled.deflection).toBeCloseTo(unit.deflection, 9)
    expect(scaled.tangentIn.x).toBeCloseTo(unit.tangentIn.x, 9)
    expect(scaled.tangentIn.y).toBeCloseTo(unit.tangentIn.y, 9)
    expect(scaled.tangentOut.x).toBeCloseTo(unit.tangentOut.x, 9)
    expect(scaled.tangentOut.y).toBeCloseTo(unit.tangentOut.y, 9)
  })

  it('is fully geometrically consistent at a 60 degree deflection', () => {
    const dOut = vec2(Math.cos(Math.PI / 3), Math.sin(Math.PI / 3))
    const f = filletCorner(vec2(0, 0), vec2(1, 0), dOut, 100)!
    expect(f).not.toBeNull()

    const start = f.arc.poseAt(0)
    expect(start.position.x).toBeCloseTo(f.tangentIn.x, 9)
    expect(start.position.y).toBeCloseTo(f.tangentIn.y, 9)

    const end = f.arc.poseAt(f.arc.length)
    expect(end.position.x).toBeCloseTo(f.tangentOut.x, 9)
    expect(end.position.y).toBeCloseTo(f.tangentOut.y, 9)
    expect(end.heading).toBeCloseTo(angleOf(dOut), 9)
  })

  it('returns null for a near-reversal corner within the default tangent-distance bound', () => {
    const magnitude = Math.PI - 1e-3
    const dOut = vec2(Math.cos(magnitude), Math.sin(magnitude))
    expect(filletCorner(vec2(0, 0), vec2(1, 0), dOut, 50)).toBeNull()
  })

  it('rejects a corner that would otherwise succeed when maxTangentDistance is small', () => {
    // 60 degree deflection normally succeeds (see above); a tiny bound rejects it.
    const dOut = vec2(Math.cos(Math.PI / 3), Math.sin(Math.PI / 3))
    expect(filletCorner(vec2(0, 0), vec2(1, 0), dOut, 100, 1)).toBeNull()
  })

  it('returns null for a zero-length input vector', () => {
    expect(filletCorner(vec2(0, 0), vec2(0, 0), vec2(0, 1), 50)).toBeNull()
  })
})
