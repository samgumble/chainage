import { describe, it, expect } from 'vitest'
import { Heightmap } from './heightmap'

/** 3x3 grid, 10m cells, origin at (0,0). Elevation ramps with x only: 0, 10, 20. */
const rampX = () => {
  const e = new Float32Array([
    0, 10, 20,
    0, 10, 20,
    0, 10, 20,
  ])
  return new Heightmap(0, 0, 10, 3, 3, e)
}

describe('Heightmap construction', () => {
  it('reports its extent', () => {
    const h = rampX()
    expect(h.width).toBe(20)
    expect(h.height).toBe(20)
  })

  it('reads grid values by index', () => {
    const h = rampX()
    expect(h.elevationAtIndex(0, 0)).toBe(0)
    expect(h.elevationAtIndex(1, 0)).toBe(10)
    expect(h.elevationAtIndex(2, 2)).toBe(20)
  })

  it('rejects invalid dimensions', () => {
    const e = new Float32Array(9)
    expect(() => new Heightmap(0, 0, 0, 3, 3, e)).toThrow(RangeError)
    expect(() => new Heightmap(0, 0, 10, 1, 3, e)).toThrow(RangeError)
    expect(() => new Heightmap(0, 0, 10, 3, 3, new Float32Array(8))).toThrow(RangeError)
  })

  it('rejects out-of-range indices', () => {
    const h = rampX()
    expect(() => h.elevationAtIndex(-1, 0)).toThrow(RangeError)
    expect(() => h.elevationAtIndex(3, 0)).toThrow(RangeError)
    expect(() => h.elevationAtIndex(0, 3)).toThrow(RangeError)
  })

  it('builds a flat heightmap', () => {
    const h = Heightmap.flat(0, 0, 5, 4, 4, 42)
    expect(h.sample(7, 7)).toBeCloseTo(42, 9)
  })
})

describe('Heightmap sampling', () => {
  it('returns exact values at grid points', () => {
    const h = rampX()
    expect(h.sample(0, 0)).toBeCloseTo(0, 9)
    expect(h.sample(10, 0)).toBeCloseTo(10, 9)
    expect(h.sample(20, 20)).toBeCloseTo(20, 9)
  })

  it('interpolates linearly between grid points', () => {
    const h = rampX()
    expect(h.sample(5, 0)).toBeCloseTo(5, 9)
    expect(h.sample(15, 12)).toBeCloseTo(15, 9)
  })

  it('interpolates bilinearly in both axes', () => {
    // Corner values 0,10 / 20,30 over one 10m cell.
    const e = new Float32Array([0, 10, 20, 30])
    const h = new Heightmap(0, 0, 10, 2, 2, e)
    expect(h.sample(5, 5)).toBeCloseTo(15, 9)
    expect(h.sample(0, 10)).toBeCloseTo(20, 9)
    expect(h.sample(10, 10)).toBeCloseTo(30, 9)
  })

  it('respects a non-zero origin', () => {
    const e = new Float32Array([0, 10, 20, 30])
    const h = new Heightmap(100, 200, 10, 2, 2, e)
    expect(h.sample(100, 200)).toBeCloseTo(0, 9)
    expect(h.sample(105, 205)).toBeCloseTo(15, 9)
  })

  it('clamps to the edge outside its bounds', () => {
    const h = rampX()
    expect(h.sample(-50, 0)).toBeCloseTo(0, 9)
    expect(h.sample(999, 0)).toBeCloseTo(20, 9)
    expect(h.sample(10, -999)).toBeCloseTo(10, 9)
    expect(h.sample(10, 999)).toBeCloseTo(10, 9)
  })
})
