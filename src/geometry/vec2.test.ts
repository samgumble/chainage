import { describe, it, expect } from 'vitest'
import {
  vec2, add, sub, scale, dot, cross, length, distance, normalize,
  fromAngle, angleOf, normalizeAngle, signedAngleBetween,
} from './vec2'

describe('vec2 arithmetic', () => {
  it('adds, subtracts and scales', () => {
    expect(add(vec2(1, 2), vec2(3, 4))).toEqual({ x: 4, y: 6 })
    expect(sub(vec2(3, 4), vec2(1, 2))).toEqual({ x: 2, y: 2 })
    expect(scale(vec2(2, 3), 2)).toEqual({ x: 4, y: 6 })
  })

  it('computes dot and cross products', () => {
    expect(dot(vec2(1, 0), vec2(0, 1))).toBe(0)
    expect(dot(vec2(2, 3), vec2(4, 5))).toBe(23)
    expect(cross(vec2(1, 0), vec2(0, 1))).toBe(1)
    expect(cross(vec2(0, 1), vec2(1, 0))).toBe(-1)
  })

  it('computes length and distance', () => {
    expect(length(vec2(3, 4))).toBe(5)
    expect(distance(vec2(1, 1), vec2(4, 5))).toBe(5)
  })

  it('normalizes, and returns zero for a zero vector', () => {
    const n = normalize(vec2(3, 4))
    expect(n.x).toBeCloseTo(0.6, 9)
    expect(n.y).toBeCloseTo(0.8, 9)
    expect(normalize(vec2(0, 0))).toEqual({ x: 0, y: 0 })
  })
})

describe('vec2 angles', () => {
  it('round-trips angle to vector and back', () => {
    for (const a of [0, 0.5, 1.5, 3, -2]) {
      expect(angleOf(fromAngle(a))).toBeCloseTo(a, 9)
    }
  })

  it('pins fromAngle to absolute references', () => {
    // Heading is counter-clockwise from +x
    expect(fromAngle(0)).toEqual({ x: 1, y: 0 })
    expect(fromAngle(Math.PI / 2).x).toBeCloseTo(0, 9)
    expect(fromAngle(Math.PI / 2).y).toBeCloseTo(1, 9)
    expect(fromAngle(Math.PI).x).toBeCloseTo(-1, 9)
    expect(fromAngle(Math.PI).y).toBeCloseTo(0, 9)
  })

  it('pins angleOf to absolute references', () => {
    expect(angleOf({ x: 1, y: 0 })).toBeCloseTo(0, 9)
    expect(angleOf({ x: 0, y: 1 })).toBeCloseTo(Math.PI / 2, 9)
    expect(angleOf({ x: -1, y: 0 })).toBeCloseTo(Math.PI, 9)
  })

  it('normalizes angles into (-PI, PI]', () => {
    expect(normalizeAngle(0)).toBeCloseTo(0, 9)
    expect(normalizeAngle(Math.PI)).toBeCloseTo(Math.PI, 9)
    expect(normalizeAngle(-Math.PI)).toBeCloseTo(Math.PI, 9)
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 9)
    expect(normalizeAngle(2 * Math.PI + 0.5)).toBeCloseTo(0.5, 9)
    expect(normalizeAngle(-2 * Math.PI - 0.5)).toBeCloseTo(-0.5, 9)
  })

  it('measures signed angle between vectors, positive counter-clockwise', () => {
    expect(signedAngleBetween(vec2(1, 0), vec2(0, 1))).toBeCloseTo(Math.PI / 2, 9)
    expect(signedAngleBetween(vec2(0, 1), vec2(1, 0))).toBeCloseTo(-Math.PI / 2, 9)
    expect(signedAngleBetween(vec2(1, 0), vec2(1, 0))).toBeCloseTo(0, 9)
    expect(Math.abs(signedAngleBetween(vec2(1, 0), vec2(-1, 0)))).toBeCloseTo(Math.PI, 9)
  })

  it('measures signed angle for off-axis vectors', () => {
    // From 45° to 135° should give +π/2
    const v45 = fromAngle(Math.PI / 4)
    const v135 = fromAngle(3 * Math.PI / 4)
    expect(signedAngleBetween(v45, v135)).toBeCloseTo(Math.PI / 2, 9)
    // Reverse should give −π/2
    expect(signedAngleBetween(v135, v45)).toBeCloseTo(-Math.PI / 2, 9)
  })
})
