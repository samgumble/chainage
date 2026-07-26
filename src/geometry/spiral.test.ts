import { describe, it, expect } from 'vitest'
import { Spiral } from './spiral'
import { Line, Arc } from './primitives'
import { vec2 } from './vec2'

describe('Spiral degenerate cases', () => {
  it('matches a Line when curvature is zero throughout', () => {
    const spiral = new Spiral(vec2(3, 7), 0.4, 120, 0, 0)
    const line = new Line(vec2(3, 7), 0.4, 120)
    for (let s = 0; s <= 120; s += 10) {
      const a = spiral.poseAt(s)
      const b = line.poseAt(s)
      expect(a.position.x).toBeCloseTo(b.position.x, 4)
      expect(a.position.y).toBeCloseTo(b.position.y, 4)
      expect(a.heading).toBeCloseTo(b.heading, 4)
    }
  })

  it('matches an Arc when curvature is constant and non-zero', () => {
    const k = 1 / 150
    const spiral = new Spiral(vec2(-2, 5), 1.1, 200, k, k)
    const arc = new Arc(vec2(-2, 5), 1.1, 200, k)
    for (let s = 0; s <= 200; s += 10) {
      const a = spiral.poseAt(s)
      const b = arc.poseAt(s)
      expect(a.position.x).toBeCloseTo(b.position.x, 4)
      expect(a.position.y).toBeCloseTo(b.position.y, 4)
      expect(a.heading).toBeCloseTo(b.heading, 4)
    }
  })
})

describe('Spiral curvature transition', () => {
  it('interpolates curvature linearly along its length', () => {
    const spiral = new Spiral(vec2(0, 0), 0, 100, 0, 1 / 50)
    expect(spiral.poseAt(0).curvature).toBeCloseTo(0, 9)
    expect(spiral.poseAt(50).curvature).toBeCloseTo(1 / 100, 9)
    expect(spiral.poseAt(100).curvature).toBeCloseTo(1 / 50, 9)
  })

  it('accumulates the analytically correct total heading change', () => {
    // Total turn = integral of curvature ds = mean curvature * length.
    const k0 = 0
    const k1 = 1 / 40
    const L = 80
    const spiral = new Spiral(vec2(0, 0), 0, L, k0, k1)
    const expected = ((k0 + k1) / 2) * L
    expect(spiral.poseAt(L).heading).toBeCloseTo(expected, 6)
  })

  it('bends left for increasing positive curvature', () => {
    const spiral = new Spiral(vec2(0, 0), 0, 100, 0, 1 / 50)
    const end = spiral.poseAt(100)
    expect(end.position.y).toBeGreaterThan(0)
    expect(end.heading).toBeGreaterThan(0)
  })

  it('clamps s to its length', () => {
    const spiral = new Spiral(vec2(0, 0), 0, 50, 0, 1 / 100)
    expect(spiral.poseAt(999).position.x).toBeCloseTo(spiral.poseAt(50).position.x, 9)
    expect(spiral.poseAt(-5).position.x).toBeCloseTo(0, 9)
  })
})
