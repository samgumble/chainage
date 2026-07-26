import { describe, it, expect } from 'vitest'
import { Line, Arc } from './primitives'
import { vec2 } from './vec2'

describe('Line', () => {
  it('advances along its heading', () => {
    const line = new Line(vec2(10, 20), 0, 100)
    const p = line.poseAt(50)
    expect(p.position.x).toBeCloseTo(60, 9)
    expect(p.position.y).toBeCloseTo(20, 9)
    expect(p.heading).toBeCloseTo(0, 9)
    expect(p.curvature).toBe(0)
  })

  it('respects a diagonal heading', () => {
    const line = new Line(vec2(0, 0), Math.PI / 4, Math.SQRT2)
    const p = line.poseAt(Math.SQRT2)
    expect(p.position.x).toBeCloseTo(1, 9)
    expect(p.position.y).toBeCloseTo(1, 9)
  })

  it('clamps s to its length', () => {
    const line = new Line(vec2(0, 0), 0, 10)
    expect(line.poseAt(999).position.x).toBeCloseTo(10, 9)
    expect(line.poseAt(-5).position.x).toBeCloseTo(0, 9)
  })
})

describe('Arc', () => {
  it('traces a quarter circle to the left', () => {
    // Radius 100, starting at origin heading +x, curving left (CCW).
    // Centre is at (0, 100). A quarter turn ends at (100, 100) heading +y.
    const r = 100
    const arc = new Arc(vec2(0, 0), 0, (Math.PI / 2) * r, 1 / r)
    const p = arc.poseAt(arc.length)
    expect(p.position.x).toBeCloseTo(100, 6)
    expect(p.position.y).toBeCloseTo(100, 6)
    expect(p.heading).toBeCloseTo(Math.PI / 2, 9)
    expect(p.curvature).toBeCloseTo(1 / r, 9)
  })

  it('traces a quarter circle to the right with negative curvature', () => {
    const r = 100
    const arc = new Arc(vec2(0, 0), 0, (Math.PI / 2) * r, -1 / r)
    const p = arc.poseAt(arc.length)
    expect(p.position.x).toBeCloseTo(100, 6)
    expect(p.position.y).toBeCloseTo(-100, 6)
    expect(p.heading).toBeCloseTo(-Math.PI / 2, 9)
  })

  it('stays exactly one radius from its centre throughout', () => {
    const r = 250
    const arc = new Arc(vec2(5, -3), 0.7, 300, 1 / r)
    // Centre lies 90 degrees left of the start heading, r away.
    const cx = 5 + r * Math.cos(0.7 + Math.PI / 2)
    const cy = -3 + r * Math.sin(0.7 + Math.PI / 2)
    for (let s = 0; s <= 300; s += 25) {
      const p = arc.poseAt(s)
      expect(Math.hypot(p.position.x - cx, p.position.y - cy)).toBeCloseTo(r, 6)
    }
  })

  it('rejects zero curvature', () => {
    expect(() => new Arc(vec2(0, 0), 0, 10, 0)).toThrow(RangeError)
  })

  it('clamps s to its length', () => {
    const arc = new Arc(vec2(0, 0), 0, 100, 1 / 100)
    const start = arc.poseAt(0)
    const end = arc.poseAt(arc.length)
    const before = arc.poseAt(-5)
    const after = arc.poseAt(arc.length + 999)
    expect(before.position.x).toBeCloseTo(start.position.x, 9)
    expect(before.position.y).toBeCloseTo(start.position.y, 9)
    expect(after.position.x).toBeCloseTo(end.position.x, 9)
    expect(after.position.y).toBeCloseTo(end.position.y, 9)
  })
})
