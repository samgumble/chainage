import { describe, it, expect } from 'vitest'
import { classifyCrossing } from './crossingKind'
import type { Crossing } from './crossings'
import { vec2, type Vec2 } from '../geometry/vec2'

/** A crossing at a position; nothing else here depends on the rest of it. */
const crossingAt = (position: Vec2): Crossing => ({
  upper: 1,
  lower: 0,
  position,
  upperStation: 120,
  lowerStation: 340,
  clearance: 0.2,
})

describe('classifyCrossing', () => {
  const placed = [vec2(0, 0), vec2(100, 0), vec2(100, 200)]

  it('calls a crossing exactly on a placed point an intersection', () => {
    expect(classifyCrossing(crossingAt(vec2(100, 0)), placed, 0.5)).toBe('intersection')
  })

  it('calls a crossing a hair inside the tolerance an intersection', () => {
    // 0.4999m from the placed point at (100, 0), tolerance 0.5.
    expect(classifyCrossing(crossingAt(vec2(100.4999, 0)), placed, 0.5)).toBe('intersection')
  })

  it('calls a crossing a hair outside the tolerance an overpass', () => {
    // 0.5001m from the same point — the far side of the same threshold, and
    // the whole point of the pair: the classification turns over at the
    // tolerance and nowhere else.
    expect(classifyCrossing(crossingAt(vec2(100.5001, 0)), placed, 0.5)).toBe('overpass')
  })

  it('treats the tolerance itself as inside', () => {
    expect(classifyCrossing(crossingAt(vec2(100.5, 0)), placed, 0.5)).toBe('intersection')
  })

  it('calls a crossing at a placed point that is also an endpoint an intersection', () => {
    // (0, 0) is the first placed point — the start of the alignment. A road
    // that terminates on another road is the case the player is most likely
    // to draw on purpose, so an endpoint must not be treated as a lesser kind
    // of placed point than a mid-gesture click.
    expect(classifyCrossing(crossingAt(vec2(0, 0)), placed, 0.5)).toBe('intersection')

    // ...and the last one, the other end.
    expect(classifyCrossing(crossingAt(vec2(100, 200)), placed, 0.5)).toBe('intersection')
  })

  it('calls a crossing nowhere near any placed point an overpass', () => {
    expect(classifyCrossing(crossingAt(vec2(50, 0)), placed, 0.5)).toBe('overpass')
  })

  it('calls every crossing an overpass when no points were placed', () => {
    expect(classifyCrossing(crossingAt(vec2(0, 0)), [], 0.5)).toBe('overpass')
  })

  it('rejects a negative tolerance', () => {
    expect(() => classifyCrossing(crossingAt(vec2(0, 0)), placed, -1)).toThrow(RangeError)
  })
})
