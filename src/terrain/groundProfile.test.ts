import { describe, it, expect } from 'vitest'
import { sampleGroundProfile, designElevationAtStation, type ProfilePoint } from './groundProfile'
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

  it('rejects a spacing smaller than MIN_STATION_GAP', () => {
    // A positive but sub-gap spacing would still produce interior stations
    // too close together for the downstream grade solver's divide-by-gap
    // arithmetic to be safe.
    expect(() => sampleGroundProfile(straightAlongX(100), rampX(), 1e-9)).toThrow(RangeError)
  })

  it('computes stations as exact multiples of spacing, not accumulated sums', () => {
    // 0.1 is not exactly representable in binary floating point, so an
    // accumulating (`s += spacing`) implementation would drift measurably
    // over 1000 steps, while `i * spacing` stays exact to the ULP.
    const steps = 1000
    const spacing = 0.1
    const length = steps * spacing
    const p = sampleGroundProfile(straightAlongX(length), rampX(), spacing)

    for (let i = 0; i <= steps; i++) {
      expect(p[i]!.s).toBeCloseTo(i * spacing, 12)
    }
  })

  it('does not produce a near-duplicate final station under floating-point drift', () => {
    // alignment.length lands one ULP above an exact multiple of spacing (25),
    // reproducing the drift that caused a ~1e-14 metre station gap.
    const length = 100 + Number.EPSILON * 100
    const p = sampleGroundProfile(straightAlongX(length), rampX(), 25)

    for (let i = 1; i < p.length; i++) {
      expect(p[i]!.s - p[i - 1]!.s).toBeGreaterThan(1e-6)
    }
    expect(p[p.length - 1]!.s).toBe(length)
  })
})

describe('designElevationAtStation', () => {
  const profile: ProfilePoint[] = [
    { s: 0, z: 100 },
    { s: 10, z: 110 },
    { s: 30, z: 130 },
  ]

  it('returns the exact elevation at an exact station', () => {
    expect(designElevationAtStation(profile, 10)).toBeCloseTo(110, 9)
  })

  it('interpolates linearly between two stations', () => {
    // Halfway between s=10 (z=110) and s=30 (z=130).
    expect(designElevationAtStation(profile, 20)).toBeCloseTo(120, 9)
  })

  it('clamps to the first elevation below the first station', () => {
    expect(designElevationAtStation(profile, -50)).toBeCloseTo(100, 9)
  })

  it('clamps to the last elevation above the last station', () => {
    expect(designElevationAtStation(profile, 500)).toBeCloseTo(130, 9)
  })

  it('returns 0 for an empty profile', () => {
    expect(designElevationAtStation([], 10)).toBe(0)
  })

  it('does not produce NaN for two coincident stations', () => {
    const withDuplicate: ProfilePoint[] = [
      { s: 0, z: 100 },
      { s: 10, z: 110 },
      { s: 10, z: 110 }, // coincident with the previous station
      { s: 30, z: 130 },
    ]
    expect(designElevationAtStation(withDuplicate, 10)).not.toBeNaN()
    expect(designElevationAtStation(withDuplicate, 10)).toBeCloseTo(110, 9)
  })
})
