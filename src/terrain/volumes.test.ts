import { describe, it, expect } from 'vitest'
import { crossSectionAreas, computeEarthworks } from './volumes'
import { Heightmap } from './heightmap'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import type { CorridorTemplate } from './corridor'
import type { ProfilePoint } from './groundProfile'

const template: CorridorTemplate = {
  formationHalfWidth: 5,
  cutSlope: 2,
  fillSlope: 2,
}

/** Flat ground at a given elevation, large enough to hold the corridor. */
const flatGround = (z: number) => Heightmap.flat(-500, -500, 50, 41, 41, z)

/** A straight road along +x through the origin. */
const road = (length: number) => new Alignment([new Line(vec2(0, 0), 0, length)])

describe('crossSectionAreas', () => {
  it('is zero in both directions when the design sits on the ground', () => {
    const a = crossSectionAreas(road(100), flatGround(100), { s: 50, z: 100 }, template)
    expect(a.cutArea).toBeCloseTo(0, 4)
    expect(a.fillArea).toBeCloseTo(0, 4)
  })

  it('reports cut when the design is below the ground', () => {
    const a = crossSectionAreas(road(100), flatGround(100), { s: 50, z: 98 }, template)
    expect(a.cutArea).toBeGreaterThan(0)
    expect(a.fillArea).toBeCloseTo(0, 4)
  })

  it('reports fill when the design is above the ground', () => {
    const a = crossSectionAreas(road(100), flatGround(100), { s: 50, z: 102 }, template)
    expect(a.fillArea).toBeGreaterThan(0)
    expect(a.cutArea).toBeCloseTo(0, 4)
  })

  it('matches the analytic area of a trapezoidal cut', () => {
    // Depth d=2, formation width 10, side slopes 2H:1V on flat ground.
    // Trapezoid area = d * (width + slope * d) = 2 * (10 + 2*2) = 28 m^2.
    // Tolerance is relative: midpoint integration is exact on the linear
    // batters, and the only residual error is at the two kinks.
    const a = crossSectionAreas(road(100), flatGround(100), { s: 50, z: 98 }, template)
    expect(Math.abs(a.cutArea - 28) / 28).toBeLessThan(0.01)
  })

  it('matches the analytic area of a trapezoidal fill', () => {
    // Same geometry inverted: 3 * (10 + 2*3) = 48 m^2.
    const a = crossSectionAreas(road(100), flatGround(100), { s: 50, z: 103 }, template)
    expect(Math.abs(a.fillArea - 48) / 48).toBeLessThan(0.01)
  })

  it('scales with depth faster than linearly, because the batters widen', () => {
    const shallow = crossSectionAreas(road(100), flatGround(100), { s: 50, z: 99 }, template)
    const deep = crossSectionAreas(road(100), flatGround(100), { s: 50, z: 98 }, template)
    expect(deep.cutArea).toBeGreaterThan(shallow.cutArea * 2)
  })

  it('reports the station it was given', () => {
    const a = crossSectionAreas(road(100), flatGround(100), { s: 37, z: 98 }, template)
    expect(a.s).toBe(37)
  })
})

describe('computeEarthworks', () => {
  it('returns zero quantities for an empty design', () => {
    const q = computeEarthworks(road(100), flatGround(100), [], template)
    expect(q.cutVolume).toBe(0)
    expect(q.fillVolume).toBe(0)
    expect(q.netVolume).toBe(0)
    expect(q.stations).toEqual([])
  })

  it('computes volume by average end area', () => {
    // Constant 2m cut over 100m: area 28 m^2 throughout, so 2800 m^3.
    // Relative tolerance, because the per-station area error compounds over
    // the length — an absolute tolerance here would be a false precision.
    const design: ProfilePoint[] = [
      { s: 0, z: 98 }, { s: 50, z: 98 }, { s: 100, z: 98 },
    ]
    const q = computeEarthworks(road(100), flatGround(100), design, template)
    expect(Math.abs(q.cutVolume - 2800) / 2800).toBeLessThan(0.01)
    expect(q.fillVolume).toBeCloseTo(0, 4)
  })

  it('reports net volume as cut minus fill', () => {
    const design: ProfilePoint[] = [
      { s: 0, z: 98 }, { s: 100, z: 98 },
    ]
    const q = computeEarthworks(road(100), flatGround(100), design, template)
    expect(q.netVolume).toBeCloseTo(q.cutVolume - q.fillVolume, 6)
    expect(q.netVolume).toBeGreaterThan(0)
  })

  it('reports a negative net volume when fill dominates', () => {
    const design: ProfilePoint[] = [
      { s: 0, z: 103 }, { s: 100, z: 103 },
    ]
    const q = computeEarthworks(road(100), flatGround(100), design, template)
    expect(q.netVolume).toBeLessThan(0)
  })

  it('balances to near zero when equal cut and fill offset each other', () => {
    // 2m cut over the first half, 2m fill over the second, same geometry.
    const design: ProfilePoint[] = [
      { s: 0, z: 98 }, { s: 50, z: 98 },
      { s: 50.0001, z: 102 }, { s: 100, z: 102 },
    ]
    const q = computeEarthworks(road(100), flatGround(100), design, template)
    expect(Math.abs(q.netVolume)).toBeLessThan(q.cutVolume * 0.05)
  })

  it('returns one area entry per design station', () => {
    const design: ProfilePoint[] = [
      { s: 0, z: 99 }, { s: 25, z: 99 }, { s: 50, z: 99 },
    ]
    const q = computeEarthworks(road(100), flatGround(100), design, template)
    expect(q.stations).toHaveLength(3)
    expect(q.stations.map((a) => a.s)).toEqual([0, 25, 50])
  })

  it('handles a single station with zero volume', () => {
    const q = computeEarthworks(road(100), flatGround(100), [{ s: 0, z: 98 }], template)
    expect(q.stations).toHaveLength(1)
    expect(q.cutVolume).toBe(0)
  })
})
