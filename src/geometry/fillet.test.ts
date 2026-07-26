import { describe, it, expect } from 'vitest'
import { filletCorner } from './fillet'
import { vec2 } from './vec2'

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
})
