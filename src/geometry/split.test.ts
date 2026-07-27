import { describe, expect, it } from 'vitest'
import { Alignment } from './alignment'
import { Arc, Line, type Primitive } from './primitives'
import { Spiral } from './spiral'
import { splitAlignment, splitPrimitive } from './split'

/**
 * The two halves must reproduce the original everywhere, not merely add up to
 * its length. Position alone is not enough: an arc half constructed with the
 * wrong start heading can still trace positions that look plausible at a
 * glance, so heading and curvature are checked at every sample too.
 */
const expectSplitReproducesOriginal = (original: Primitive, cut: number) => {
  const [head, tail] = splitPrimitive(original, cut)

  expect(head.length).toBeCloseTo(cut, 9)
  expect(tail.length).toBeCloseTo(original.length - cut, 9)

  const samples = 40
  for (let i = 0; i <= samples; i++) {
    const s = (i / samples) * original.length
    const expected = original.poseAt(s)
    const actual = s <= cut ? head.poseAt(s) : tail.poseAt(s - cut)

    expect(actual.position.x).toBeCloseTo(expected.position.x, 6)
    expect(actual.position.y).toBeCloseTo(expected.position.y, 6)
    expect(Math.cos(actual.heading)).toBeCloseTo(Math.cos(expected.heading), 6)
    expect(Math.sin(actual.heading)).toBeCloseTo(Math.sin(expected.heading), 6)
    expect(actual.curvature).toBeCloseTo(expected.curvature, 6)
  }
}

describe('splitPrimitive', () => {
  it('splits a line', () => {
    expectSplitReproducesOriginal(new Line({ x: 10, y: -5 }, 0.7, 120), 43)
  })

  it('splits an arc', () => {
    expectSplitReproducesOriginal(new Arc({ x: 0, y: 0 }, 0.3, 90, 1 / 60), 31)
  })

  it('splits a right-hand arc', () => {
    expectSplitReproducesOriginal(new Arc({ x: 4, y: 2 }, -1.1, 75, -1 / 40), 50)
  })

  it('splits a spiral', () => {
    expectSplitReproducesOriginal(
      new Spiral({ x: 0, y: 0 }, 0.2, 80, 0, 1 / 50),
      29,
    )
  })

  it('splits a spiral that unwinds', () => {
    expectSplitReproducesOriginal(
      new Spiral({ x: -3, y: 7 }, 1.4, 60, 1 / 30, -1 / 90),
      37,
    )
  })

  it('rejects a cut at either end', () => {
    const line = new Line({ x: 0, y: 0 }, 0, 100)
    expect(() => splitPrimitive(line, 0)).toThrow(RangeError)
    expect(() => splitPrimitive(line, 100)).toThrow(RangeError)
    expect(() => splitPrimitive(line, -1)).toThrow(RangeError)
    expect(() => splitPrimitive(line, 101)).toThrow(RangeError)
  })
})

describe('splitAlignment', () => {
  const chain = () =>
    new Alignment([
      new Line({ x: 0, y: 0 }, 0, 50),
      new Arc({ x: 50, y: 0 }, 0, 40, 1 / 80),
      new Line(new Arc({ x: 50, y: 0 }, 0, 40, 1 / 80).poseAt(40).position, 0.5, 30),
    ])

  it('reproduces the original across the cut', () => {
    const a = chain()
    const [head, tail] = splitAlignment(a, 70)

    expect(head.length).toBeCloseTo(70, 9)
    expect(tail.length).toBeCloseTo(a.length - 70, 9)

    for (let i = 0; i <= 40; i++) {
      const s = (i / 40) * a.length
      const expected = a.poseAt(s)
      const actual = s <= 70 ? head.poseAt(s) : tail.poseAt(s - 70)
      expect(actual.position.x).toBeCloseTo(expected.position.x, 6)
      expect(actual.position.y).toBeCloseTo(expected.position.y, 6)
    }
  })

  it('produces no zero-length primitive when the cut lands on a joint', () => {
    const a = chain()
    const [head, tail] = splitAlignment(a, 50)

    expect(head.primitives).toHaveLength(1)
    expect(tail.primitives).toHaveLength(2)
    for (const p of [...head.primitives, ...tail.primitives]) {
      expect(p.length).toBeGreaterThan(0)
    }
  })

  it('keeps both halves continuous', () => {
    const [head, tail] = splitAlignment(chain(), 70)
    expect(head.isContinuous).toBe(true)
    expect(tail.isContinuous).toBe(true)
  })

  it('rejects a cut at either end and an empty alignment', () => {
    const a = chain()
    expect(() => splitAlignment(a, 0)).toThrow(RangeError)
    expect(() => splitAlignment(a, a.length)).toThrow(RangeError)
    expect(() => splitAlignment(new Alignment([]), 1)).toThrow(RangeError)
  })
})
