import { describe, it, expect } from 'vitest'
import { sampleGroundProfile } from './groundProfile'
import { Heightmap } from './heightmap'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'

/** Ground rises 1m per 1m of x: 0 at x=0, 100 at x=100. */
const rampX = () => {
  const cols = 11
  const rows = 3
  const e = new Float32Array(cols * rows)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      e[row * cols + col] = col * 10
    }
  }
  return new Heightmap(0, 0, 10, cols, rows, e)
}

const straightAlongX = (length: number) =>
  new Alignment([new Line(vec2(0, 10), 0, length)])

describe('sampleGroundProfile', () => {
  it('samples at the requested spacing including both endpoints', () => {
    const p = sampleGroundProfile(straightAlongX(100), rampX(), 25)
    expect(p).toHaveLength(5)
    expect(p[0]!.s).toBeCloseTo(0, 9)
    expect(p[4]!.s).toBeCloseTo(100, 9)
  })

  it('records ground elevation beneath the alignment', () => {
    const p = sampleGroundProfile(straightAlongX(100), rampX(), 25)
    expect(p[0]!.z).toBeCloseTo(0, 4)
    expect(p[1]!.z).toBeCloseTo(25, 4)
    expect(p[4]!.z).toBeCloseTo(100, 4)
  })

  it('always includes the final station even when spacing does not divide evenly', () => {
    const p = sampleGroundProfile(straightAlongX(100), rampX(), 30)
    expect(p[p.length - 1]!.s).toBeCloseTo(100, 9)
    expect(p[p.length - 1]!.z).toBeCloseTo(100, 4)
  })

  it('produces stations that increase monotonically', () => {
    const p = sampleGroundProfile(straightAlongX(100), rampX(), 30)
    for (let i = 1; i < p.length; i++) {
      expect(p[i]!.s).toBeGreaterThan(p[i - 1]!.s)
    }
  })

  it('returns an empty array for an empty alignment', () => {
    expect(sampleGroundProfile(new Alignment([]), rampX(), 10)).toEqual([])
  })

  it('rejects non-positive spacing', () => {
    expect(() => sampleGroundProfile(straightAlongX(100), rampX(), 0)).toThrow(RangeError)
    expect(() => sampleGroundProfile(straightAlongX(100), rampX(), -5)).toThrow(RangeError)
  })
})
