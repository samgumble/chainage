import { describe, it, expect } from 'vitest'
import { designElevationAt, isDaylighted, retainingWall, type CorridorTemplate } from './corridor'

const template = (over: Partial<CorridorTemplate> = {}): CorridorTemplate => ({
  formationHalfWidth: 5,
  cutSlope: 2,   // 2H:1V
  fillSlope: 3,  // 3H:1V
  ...over,
})

describe('designElevationAt — formation', () => {
  it('is flat across the formation width', () => {
    const t = template()
    for (const offset of [-5, -2.5, 0, 2.5, 5]) {
      expect(designElevationAt(offset, 100, 95, t)).toBeCloseTo(100, 9)
    }
  })

  it('is flat regardless of whether the section is in cut or fill', () => {
    const t = template()
    expect(designElevationAt(0, 100, 90, t)).toBeCloseTo(100, 9)
    expect(designElevationAt(0, 100, 110, t)).toBeCloseTo(100, 9)
  })
})

describe('designElevationAt — cut sections', () => {
  it('rises away from the road when ground is above the design line', () => {
    // Ground 10m above design: this is a cut, so the batter climbs outward.
    const t = template()
    // 3m beyond the formation edge at 2H:1V rises 1.5m.
    expect(designElevationAt(8, 100, 110, t)).toBeCloseTo(101.5, 9)
  })

  it('stops rising once it reaches natural ground', () => {
    const t = template()
    // Ground only 2m up; at 2H:1V that daylights 4m beyond the edge.
    expect(designElevationAt(9, 100, 102, t)).toBeCloseTo(102, 9)
    expect(designElevationAt(50, 100, 102, t)).toBeCloseTo(102, 9)
  })

  it('is symmetric left and right', () => {
    const t = template()
    expect(designElevationAt(-8, 100, 110, t)).toBeCloseTo(
      designElevationAt(8, 100, 110, t), 9,
    )
  })
})

describe('designElevationAt — fill sections', () => {
  it('falls away from the road when ground is below the design line', () => {
    const t = template()
    // 3m beyond the edge at 3H:1V drops 1m.
    expect(designElevationAt(8, 100, 90, t)).toBeCloseTo(99, 9)
  })

  it('stops falling once it reaches natural ground', () => {
    const t = template()
    // Ground 1m down; at 3H:1V that daylights 3m beyond the edge.
    expect(designElevationAt(8.5, 100, 99, t)).toBeCloseTo(99, 9)
    expect(designElevationAt(50, 100, 99, t)).toBeCloseTo(99, 9)
  })

  it('uses the fill slope, not the cut slope', () => {
    const t = template({ cutSlope: 2, fillSlope: 4 })
    // 4m beyond the edge at 4H:1V drops exactly 1m.
    expect(designElevationAt(9, 100, 80, t)).toBeCloseTo(99, 9)
  })
})

describe('isDaylighted', () => {
  it('is false within the formation', () => {
    expect(isDaylighted(0, 100, 110, template())).toBe(false)
  })

  it('is false on the batter before it meets ground', () => {
    expect(isDaylighted(6, 100, 110, template())).toBe(false)
  })

  it('is true once the batter has met ground', () => {
    expect(isDaylighted(50, 100, 102, template())).toBe(true)
  })

  it('is true immediately when design and ground coincide', () => {
    expect(isDaylighted(6, 100, 100, template())).toBe(true)
  })
})

describe('retaining walls', () => {
  it('needs no wall when the batter has room to daylight', () => {
    // 2m cut at 2H:1V needs 4m of batter; 10m is available.
    expect(retainingWall(100, 102, template({ maxBatterWidth: 10 }))).toBeNull()
  })

  it('needs no wall when maxBatterWidth is not set', () => {
    expect(retainingWall(100, 130, template())).toBeNull()
  })

  it('stands the wall at the end of the permitted batter', () => {
    // 5m cut at 2H:1V wants 10m of batter, but only 4m is available.
    const wall = retainingWall(100, 105, template({ maxBatterWidth: 4 }))!
    expect(wall).not.toBeNull()
    expect(wall.offset).toBeCloseTo(9, 9)   // formationHalfWidth 5 + 4
  })

  it('makes up exactly the height the batter could not', () => {
    // depth 5, batter covers 4/2 = 2m of it, so the wall is 3m.
    const wall = retainingWall(100, 105, template({ maxBatterWidth: 4 }))!
    expect(wall.height).toBeCloseTo(3, 9)
  })

  it('gives a full-depth wall when no batter is allowed at all', () => {
    const wall = retainingWall(100, 105, template({ maxBatterWidth: 0 }))!
    expect(wall.height).toBeCloseTo(5, 9)
    expect(wall.offset).toBeCloseTo(5, 9)
  })

  it('gives exactly zero height when the allowance equals what is needed', () => {
    // 3m fill at 3H:1V needs exactly 9m of batter.
    expect(retainingWall(100, 97, template({ maxBatterWidth: 9 }))).toBeNull()
  })

  it('uses the fill slope on fill sections', () => {
    // 4m fill at 3H:1V wants 12m; only 6m allowed, so batter covers 2m.
    const wall = retainingWall(100, 96, template({ maxBatterWidth: 6 }))!
    expect(wall.height).toBeCloseTo(2, 9)
  })

  it('needs no wall where design sits on natural ground', () => {
    expect(retainingWall(100, 100, template({ maxBatterWidth: 0 }))).toBeNull()
  })

  it('truncates the design surface at the wall', () => {
    const t = template({ maxBatterWidth: 4 })
    // Inside the permitted batter the surface still climbs.
    expect(designElevationAt(7, 100, 105, t)).toBeCloseTo(101, 9)
    // Beyond the wall there is no earthwork — the surface is natural ground.
    expect(designElevationAt(12, 100, 105, t)).toBeCloseTo(105, 9)
  })
})

describe('designElevationAt — validation', () => {
  it('rejects an invalid template', () => {
    expect(() => designElevationAt(0, 100, 95, template({ formationHalfWidth: -1 }))).toThrow(RangeError)
    expect(() => designElevationAt(0, 100, 95, template({ cutSlope: 0 }))).toThrow(RangeError)
    expect(() => designElevationAt(0, 100, 95, template({ fillSlope: -2 }))).toThrow(RangeError)
    expect(() => designElevationAt(0, 100, 95, template({ maxBatterWidth: -1 }))).toThrow(RangeError)
  })
})
