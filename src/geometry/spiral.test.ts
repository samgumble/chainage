import { describe, it, expect } from 'vitest'
import { Spiral } from './spiral'
import { Line, Arc } from './primitives'
import { vec2, type Vec2 } from './vec2'

/**
 * High-resolution reference integrator for a clothoid, independent of the
 * production `poseAt` step-count logic. Uses the spiral's own `headingAt`
 * (exact closed form, independently verified by the heading-only tests
 * above) and a fixed, very large Simpson step count so its own truncation
 * error is negligible next to anything `poseAt` could produce.
 */
function referencePosition(spiral: Spiral, s: number): Vec2 {
  const t = s < 0 ? 0 : s > spiral.length ? spiral.length : s
  const n = 20000
  const h = t / n
  let sumX = 0
  let sumY = 0
  for (let i = 0; i <= n; i++) {
    const si = i * h
    const weight = i === 0 || i === n ? 1 : i % 2 === 1 ? 4 : 2
    const angle = spiral.headingAt(si)
    sumX += weight * Math.cos(angle)
    sumY += weight * Math.sin(angle)
  }
  const factor = h / 3
  return { x: spiral.start.x + factor * sumX, y: spiral.start.y + factor * sumY }
}

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

  it('clamps s identically across poseAt, curvatureAt, and headingAt', () => {
    const spiral = new Spiral(vec2(1, 2), 0.3, 50, -1 / 80, 1 / 100)

    // Beyond the end.
    const pastEnd = spiral.poseAt(999)
    expect(spiral.curvatureAt(999)).toBeCloseTo(pastEnd.curvature, 9)
    expect(spiral.headingAt(999)).toBeCloseTo(pastEnd.heading, 9)
    expect(spiral.curvatureAt(50)).toBeCloseTo(spiral.curvatureAt(999), 9)
    expect(spiral.headingAt(50)).toBeCloseTo(spiral.headingAt(999), 9)

    // Before the start.
    const beforeStart = spiral.poseAt(-5)
    expect(spiral.curvatureAt(-5)).toBeCloseTo(beforeStart.curvature, 9)
    expect(spiral.headingAt(-5)).toBeCloseTo(beforeStart.heading, 9)
    expect(spiral.curvatureAt(0)).toBeCloseTo(spiral.curvatureAt(-5), 9)
    expect(spiral.headingAt(0)).toBeCloseTo(spiral.headingAt(-5), 9)
  })
})

describe('Spiral with non-zero curvature rate', () => {
  it('is additive: two half-spirals in sequence match one full spiral', () => {
    // A genuine clothoid: curvature rate is non-zero throughout.
    const k0 = 0
    const k1 = 1 / 60
    const L = 120
    const full = new Spiral(vec2(5, -3), 0.25, L, k0, k1)

    const midK = full.curvatureAt(L / 2)

    const firstHalf = new Spiral(full.start, full.heading, L / 2, k0, midK)
    const firstHalfEnd = firstHalf.poseAt(L / 2)

    const secondHalf = new Spiral(
      firstHalfEnd.position,
      firstHalfEnd.heading,
      L / 2,
      midK,
      k1,
    )
    const secondHalfEnd = secondHalf.poseAt(L / 2)

    const fullEnd = full.poseAt(L)

    expect(secondHalfEnd.position.x).toBeCloseTo(fullEnd.position.x, 6)
    expect(secondHalfEnd.position.y).toBeCloseTo(fullEnd.position.y, 6)
    expect(secondHalfEnd.heading).toBeCloseTo(fullEnd.heading, 6)
  })

  it('is additive at several interior sample points, not just the endpoint', () => {
    const k0 = -1 / 80
    const k1 = 1 / 40
    const L = 100
    const full = new Spiral(vec2(0, 0), -0.6, L, k0, k1)
    const midK = full.curvatureAt(L / 2)
    const firstHalf = new Spiral(full.start, full.heading, L / 2, k0, midK)

    for (const frac of [0.25, 0.5, 0.75, 1]) {
      const s = (L / 2) * frac
      const a = firstHalf.poseAt(s)
      const b = full.poseAt(s)
      expect(a.position.x).toBeCloseTo(b.position.x, 6)
      expect(a.position.y).toBeCloseTo(b.position.y, 6)
      expect(a.heading).toBeCloseTo(b.heading, 6)
    }
  })

  it('matches a high-resolution reference integration for genuinely curving spirals', () => {
    const cases = [
      // The reviewer's failure case: 40m, curvature swinging -1/10 to +1/10.
      new Spiral(vec2(0, 0), 0, 40, -1 / 10, 1 / 10),
      // Tight and short.
      new Spiral(vec2(2, -1), 0.7, 10, 0, 1 / 5),
      // Long and gentle.
      new Spiral(vec2(-10, 4), -0.3, 200, 1 / 150, 1 / 90),
      // Crosses zero curvature over a short length.
      new Spiral(vec2(1, 1), 1.2, 15, -1 / 6, 1 / 9),
    ]

    for (const spiral of cases) {
      for (let s = 0; s <= spiral.length; s += spiral.length / 8) {
        const actual = spiral.poseAt(s)
        const reference = referencePosition(spiral, s)
        expect(actual.position.x).toBeCloseTo(reference.x, 4)
        expect(actual.position.y).toBeCloseTo(reference.y, 4)
      }
    }
  })

  it('keeps the reviewer-reported 40m / +-1/10 case well within tolerance', () => {
    const spiral = new Spiral(vec2(0, 0), 0, 40, -1 / 10, 1 / 10)
    const actual = spiral.poseAt(40)
    const reference = referencePosition(spiral, 40)
    const error = Math.hypot(actual.position.x - reference.x, actual.position.y - reference.y)
    expect(error).toBeLessThan(5e-5)
  })
})

describe('Spiral station', () => {
  it('reports the local station', () => {
    const spiral = new Spiral(vec2(0, 0), 0, 100, 0, 1 / 50)
    expect(spiral.poseAt(0).s).toBeCloseTo(0, 9)
    expect(spiral.poseAt(60).s).toBeCloseTo(60, 9)
  })

  it('reports the clamped station', () => {
    const spiral = new Spiral(vec2(0, 0), 0, 50, 0, 1 / 100)
    expect(spiral.poseAt(999).s).toBeCloseTo(50, 9)
  })
})
