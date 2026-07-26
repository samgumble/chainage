import { describe, it, expect } from 'vitest'
import { Alignment } from './alignment'
import { Line, Arc } from './primitives'
import { vec2 } from './vec2'

const straightThenLeftTurn = () => {
  const r = 100
  const line = new Line(vec2(0, 0), 0, 50)
  // Continue from the line's end, in the same direction.
  const arc = new Arc(vec2(50, 0), 0, (Math.PI / 2) * r, 1 / r)
  return new Alignment([line, arc])
}

describe('Alignment', () => {
  it('sums the lengths of its primitives', () => {
    const a = straightThenLeftTurn()
    expect(a.length).toBeCloseTo(50 + (Math.PI / 2) * 100, 9)
  })

  it('reports empty for no primitives', () => {
    expect(new Alignment([]).isEmpty).toBe(true)
    expect(new Alignment([]).length).toBe(0)
    expect(straightThenLeftTurn().isEmpty).toBe(false)
  })

  it('dispatches s to the correct primitive', () => {
    const a = straightThenLeftTurn()
    const onLine = a.poseAt(25)
    expect(onLine.position.x).toBeCloseTo(25, 6)
    expect(onLine.curvature).toBe(0)

    const onArc = a.poseAt(50 + (Math.PI / 4) * 100)
    expect(onArc.curvature).toBeCloseTo(1 / 100, 9)
  })

  it('is continuous across the primitive boundary', () => {
    const a = straightThenLeftTurn()
    const before = a.poseAt(50 - 1e-6)
    const after = a.poseAt(50 + 1e-6)
    expect(after.position.x).toBeCloseTo(before.position.x, 5)
    expect(after.position.y).toBeCloseTo(before.position.y, 5)
    expect(after.heading).toBeCloseTo(before.heading, 5)
  })

  it('clamps s beyond either end', () => {
    const a = straightThenLeftTurn()
    expect(a.poseAt(-10).position.x).toBeCloseTo(0, 9)
    const end = a.poseAt(a.length)
    expect(a.poseAt(a.length + 500).position.x).toBeCloseTo(end.position.x, 9)
  })

  it('samples at the requested spacing, including both endpoints', () => {
    const a = new Alignment([new Line(vec2(0, 0), 0, 100)])
    const poses = a.sample(25)
    expect(poses).toHaveLength(5)
    expect(poses[0]!.position.x).toBeCloseTo(0, 9)
    expect(poses[4]!.position.x).toBeCloseTo(100, 9)
  })

  it('includes the final endpoint even when spacing does not divide evenly', () => {
    const a = new Alignment([new Line(vec2(0, 0), 0, 100)])
    const poses = a.sample(30)
    const last = poses[poses.length - 1]!
    expect(last.position.x).toBeCloseTo(100, 9)
  })

  it('rejects non-positive spacing', () => {
    const a = straightThenLeftTurn()
    expect(() => a.sample(0)).toThrow(RangeError)
    expect(() => a.sample(-1)).toThrow(RangeError)
  })
})
