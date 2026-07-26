import { describe, it, expect } from 'vitest'
import { Alignment, checkContinuity } from './alignment'
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

  it('does not produce a near-duplicate final station under floating-point drift', () => {
    // this.length lands one ULP above an exact multiple of spacing (25),
    // reproducing the drift that MIN_STATION_GAP guards against in
    // sampleGroundProfile and sweepRibbon.
    const length = 100 + Number.EPSILON * 100
    const a = new Alignment([new Line(vec2(0, 0), 0, length)])
    const poses = a.sample(25)

    for (let i = 1; i < poses.length; i++) {
      expect(poses[i]!.s - poses[i - 1]!.s).toBeGreaterThan(1e-6)
    }
    expect(poses[poses.length - 1]!.s).toBe(length)
  })
})

describe('Alignment station reporting', () => {
  it('reports the alignment-wide station, not the primitive-local one', () => {
    const a = new Alignment([
      new Line(vec2(0, 0), 0, 50),
      new Line(vec2(50, 0), 0, 50),
    ])
    // 70 is 20m into the second primitive; the alignment must still say 70.
    expect(a.poseAt(70).s).toBeCloseTo(70, 9)
    expect(a.poseAt(0).s).toBeCloseTo(0, 9)
    expect(a.poseAt(100).s).toBeCloseTo(100, 9)
  })

  it('reports the clamped station', () => {
    const a = new Alignment([new Line(vec2(0, 0), 0, 50)])
    expect(a.poseAt(999).s).toBeCloseTo(50, 9)
    expect(a.poseAt(-10).s).toBeCloseTo(0, 9)
  })

  it('carries the station through sample()', () => {
    const a = new Alignment([new Line(vec2(0, 0), 0, 100)])
    const poses = a.sample(25)
    expect(poses.map((p) => p.s)).toEqual([0, 25, 50, 75, 100])
  })
})

describe('Alignment.primitiveAt', () => {
  const twoLines = () => new Alignment([
    new Line(vec2(0, 0), 0, 50),
    new Line(vec2(50, 0), 0, 30),
  ])

  it('identifies the owning primitive and the local station', () => {
    const a = twoLines()
    expect(a.primitiveAt(20)).toEqual({ index: 0, localS: 20 })
    expect(a.primitiveAt(60)).toEqual({ index: 1, localS: 10 })
  })

  it('assigns a boundary station to the later primitive', () => {
    const a = twoLines()
    expect(a.primitiveAt(50)).toEqual({ index: 1, localS: 0 })
  })

  it('clamps beyond either end', () => {
    const a = twoLines()
    expect(a.primitiveAt(-5)).toEqual({ index: 0, localS: 0 })
    expect(a.primitiveAt(999)).toEqual({ index: 1, localS: 30 })
  })

  it('agrees with poseAt', () => {
    const a = twoLines()
    const { index, localS } = a.primitiveAt(65)
    const direct = a.poseAt(65)
    const viaPrimitive = a.primitives[index]!.poseAt(localS)
    expect(viaPrimitive.position.x).toBeCloseTo(direct.position.x, 9)
    expect(viaPrimitive.position.y).toBeCloseTo(direct.position.y, 9)
  })

  it('throws on an empty alignment', () => {
    expect(() => new Alignment([]).primitiveAt(0)).toThrow(RangeError)
  })
})

describe('Alignment continuity', () => {
  it('reports no breaks for a sound chain', () => {
    const a = new Alignment([
      new Line(vec2(0, 0), 0, 50),
      new Line(vec2(50, 0), 0, 50),
    ])
    expect(a.continuityBreaks).toEqual([])
    expect(a.isContinuous).toBe(true)
  })

  it('reports no breaks for a line meeting an arc tangentially', () => {
    const a = new Alignment([
      new Line(vec2(0, 0), 0, 50),
      new Arc(vec2(50, 0), 0, 100, 1 / 200),
    ])
    expect(a.isContinuous).toBe(true)
  })

  it('detects a position gap', () => {
    const a = new Alignment([
      new Line(vec2(0, 0), 0, 50),
      new Line(vec2(51, 0), 0, 50),   // starts 1m past where the first ends
    ])
    expect(a.isContinuous).toBe(false)
    expect(a.continuityBreaks).toHaveLength(1)
    expect(a.continuityBreaks[0]!.index).toBe(1)
    expect(a.continuityBreaks[0]!.positionGap).toBeCloseTo(1, 6)
  })

  it('detects a heading kink even when positions match', () => {
    const a = new Alignment([
      new Line(vec2(0, 0), 0, 50),
      new Line(vec2(50, 0), 0.3, 50),   // same point, 0.3 rad kink
    ])
    expect(a.isContinuous).toBe(false)
    expect(a.continuityBreaks[0]!.headingGap).toBeCloseTo(0.3, 6)
    expect(a.continuityBreaks[0]!.positionGap).toBeCloseTo(0, 6)
  })

  it('tolerates a sub-millimetre position gap', () => {
    const a = new Alignment([
      new Line(vec2(0, 0), 0, 50),
      new Line(vec2(50.0001, 0), 0, 50),
    ])
    expect(a.isContinuous).toBe(true)
  })

  it('measures the heading gap across the PI wraparound', () => {
    // Both headings point very nearly west; naive subtraction would give ~2*PI.
    const a = new Alignment([
      new Line(vec2(0, 0), Math.PI - 1e-6, 50),
      new Line(new Line(vec2(0, 0), Math.PI - 1e-6, 50).poseAt(50).position, -Math.PI + 1e-6, 50),
    ])
    expect(a.isContinuous).toBe(true)
  })

  it('reports every break in a chain with several', () => {
    const a = new Alignment([
      new Line(vec2(0, 0), 0, 10),
      new Line(vec2(11, 0), 0, 10),
      new Line(vec2(30, 0), 0, 10),
    ])
    expect(a.continuityBreaks).toHaveLength(2)
    expect(a.continuityBreaks.map((b) => b.index)).toEqual([1, 2])
  })

  it('treats an empty or single-primitive alignment as continuous', () => {
    expect(new Alignment([]).isContinuous).toBe(true)
    expect(new Alignment([new Line(vec2(0, 0), 0, 10)]).isContinuous).toBe(true)
  })

  it('exposes checkContinuity independently of the class', () => {
    const breaks = checkContinuity([
      new Line(vec2(0, 0), 0, 50),
      new Line(vec2(55, 0), 0, 50),
    ])
    expect(breaks).toHaveLength(1)
    expect(breaks[0]!.positionGap).toBeCloseTo(5, 6)
  })
})
