import { describe, it, expect } from 'vitest'
import { generateValley, type ValleyOptions } from './generate'

const opts = (over: Partial<ValleyOptions> = {}): ValleyOptions => ({
  cols: 65,
  rows: 65,
  cellSize: 20,
  floorElevation: 100,
  ridgeHeight: 60,
  valleyHalfWidth: 250,
  seed: 1,
  ...over,
})

describe('generateValley', () => {
  it('produces a heightmap of the requested size', () => {
    const h = generateValley(opts())
    expect(h.cols).toBe(65)
    expect(h.rows).toBe(65)
    expect(h.cellSize).toBe(20)
  })

  it('is deterministic for a given seed', () => {
    const a = generateValley(opts())
    const b = generateValley(opts())
    expect(Array.from(a.elevations)).toEqual(Array.from(b.elevations))
  })

  it('differs between seeds', () => {
    const a = generateValley(opts({ seed: 1 }))
    const b = generateValley(opts({ seed: 2 }))
    expect(Array.from(a.elevations)).not.toEqual(Array.from(b.elevations))
  })

  it('is lowest along the valley axis and rises toward the sides', () => {
    const h = generateValley(opts())
    const midY = h.originY + h.height / 2
    const onAxis = h.sample(h.originX + h.width / 2, midY)
    const offAxis = h.sample(h.originX + h.width / 2, midY + 500)
    expect(offAxis).toBeGreaterThan(onAxis)
  })

  it('runs the valley floor roughly along the x axis', () => {
    const h = generateValley(opts())
    const midY = h.originY + h.height / 2
    const a = h.sample(h.originX + h.width * 0.25, midY)
    const b = h.sample(h.originX + h.width * 0.75, midY)
    // Both near the floor, and neither near ridge height.
    expect(Math.abs(a - b)).toBeLessThan(40)
    expect(a).toBeLessThan(100 + 60)
    expect(b).toBeLessThan(100 + 60)
  })

  it('stays within the floor-to-ridge band plus roughness', () => {
    const options = opts()
    const h = generateValley(options)
    // Roughness allowance: combined amplitude of noise octaves (14 + 5) with headroom
    const roughnessAllowance = 30
    const floor = options.floorElevation - roughnessAllowance
    const ceiling = options.floorElevation + options.ridgeHeight + roughnessAllowance
    for (const z of h.elevations) {
      expect(z).toBeGreaterThan(floor)
      expect(z).toBeLessThan(ceiling)
    }
  })

  it('rejects a non-positive valley width', () => {
    expect(() => generateValley(opts({ valleyHalfWidth: 0 }))).toThrow(RangeError)
    expect(() => generateValley(opts({ valleyHalfWidth: -100 }))).toThrow(RangeError)
  })
})
