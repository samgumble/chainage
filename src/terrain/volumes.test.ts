import { describe, it, expect } from 'vitest'
import { crossSectionAreas, computeEarthworks } from './volumes'
import { Heightmap } from './heightmap'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2, angleOf, sub, distance } from '../geometry/vec2'
import type { CorridorTemplate } from './corridor'
import type { ProfilePoint } from './groundProfile'
import { generateValley } from './generate'
import { sampleGroundProfile } from './groundProfile'
import { solveGradeProfile } from './gradeSolver'

const template: CorridorTemplate = {
  formationHalfWidth: 5,
  cutSlope: 2,
  fillSlope: 2,
}

/** Flat ground at a given elevation, large enough to hold the corridor. */
const flatGround = (z: number) => Heightmap.flat(-500, -500, 50, 41, 41, z)

/** A straight road along +x through the origin. */
const road = (length: number) => new Alignment([new Line(vec2(0, 0), 0, length)])

/**
 * Ground that is flat at `base` on the downhill side (offset < 0, i.e. y < 0
 * for a road running along +x) and climbs at `slopePerMetre` on the uphill
 * side (offset >= 0). Grid is coarse but the surface is linear in y and
 * constant in x, so bilinear sampling reproduces it exactly regardless of
 * cell size.
 *
 * Extends to +-520m so it also covers sections that march all the way to
 * MAX_SECTION_HALF_WIDTH (500m).
 */
const crossSlopedGround = (base: number, slopePerMetre: number): Heightmap => {
  const originX = -520
  const originY = -520
  const cellSize = 10
  const cols = 105 // (520 * 2) / 10 + 1
  const rows = 105
  const e = new Float32Array(cols * rows)
  for (let row = 0; row < rows; row++) {
    const y = originY + row * cellSize
    const z = y >= 0 ? base + slopePerMetre * y : base
    for (let col = 0; col < cols; col++) {
      e[row * cols + col] = z
    }
  }
  return new Heightmap(originX, originY, cellSize, cols, rows, e)
}

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

describe('daylighting on cross-sloped ground', () => {
  it('reports more cut area than the same design over flat ground', () => {
    // The old bound guessed a daylight distance from the centreline depth
    // alone. Here the ground rises steadily away from the centreline
    // (uphill on the +offset side), so the true daylight point lies well
    // beyond that guess, and the flat comparison is exactly the case the old
    // bound got right — proving the new number is bigger for the right
    // reason, not by construction error.
    const flat = crossSectionAreas(road(100), flatGround(100), { s: 50, z: 98 }, template)
    const sloped = crossSectionAreas(road(100), crossSlopedGround(100, 0.3), { s: 50, z: 98 }, template)
    expect(sloped.cutArea).toBeGreaterThan(flat.cutArea)
  })

  it('is not truncated for a moderate cross-slope that daylights within the cap', () => {
    // Ground rises at 0.3 m per metre, batter climbs at 1/cutSlope = 0.5 m
    // per metre, so the batter is still gaining on the ground and daylights
    // at a finite, well-inside-the-cap distance (~22.5m from the offset
    // formula: (formationHalfWidth + slope*depth) reasoning).
    const a = crossSectionAreas(road(100), crossSlopedGround(100, 0.3), { s: 50, z: 98 }, template)
    expect(a.truncated).toBe(false)
  })

  it('reports truncation when the cross-slope out-climbs the batter', () => {
    // Ground rises at 0.6 m per metre; the cutSlope=2 batter only climbs at
    // 1/2 = 0.5 m per metre, so it never catches natural ground — the
    // degenerate case where daylighting never occurs. The section must be
    // truncated at the safety cap, and computeEarthworks must surface that.
    const steep = crossSlopedGround(100, 0.6)
    const a = crossSectionAreas(road(100), steep, { s: 50, z: 98 }, template)
    expect(a.truncated).toBe(true)

    const design: ProfilePoint[] = [{ s: 0, z: 98 }, { s: 100, z: 98 }]
    const q = computeEarthworks(road(100), steep, design, template)
    expect(q.truncatedStations).toBeGreaterThan(0)
  })

  it('still matches the analytic trapezoid on flat ground after marching', () => {
    // Same 28 m^2 figure as the original analytic test, re-asserted here to
    // prove the outward-marching algorithm did not change the numerics for
    // the case every other test fixture uses.
    const a = crossSectionAreas(road(100), flatGround(100), { s: 50, z: 98 }, template)
    expect(Math.abs(a.cutArea - 28) / 28).toBeLessThan(0.01)
  })

  it('throws RangeError for a non-positive transverseStep', () => {
    expect(() =>
      crossSectionAreas(road(100), flatGround(100), { s: 50, z: 98 }, template, 0),
    ).toThrow(RangeError)
    expect(() =>
      crossSectionAreas(road(100), flatGround(100), { s: 50, z: 98 }, template, -0.5),
    ).toThrow(RangeError)
  })
})

/**
 * Ground on a uniform cross-slope across the whole corridor width — rising
 * at `slopePerMetre` per metre of offset in every direction, with no flat
 * portion on either side. A classic sidehill section: cut on the uphill
 * side, fill on the downhill side, both diverging from the design surface
 * without bound.
 */
const sidehillGround = (base: number, slopePerMetre: number): Heightmap => {
  const originX = -520
  const originY = -520
  const cellSize = 10
  const cols = 105
  const rows = 105
  const e = new Float32Array(cols * rows)
  for (let row = 0; row < rows; row++) {
    const y = originY + row * cellSize
    const z = base + slopePerMetre * y
    for (let col = 0; col < cols; col++) {
      e[row * cols + col] = z
    }
  }
  return new Heightmap(originX, originY, cellSize, cols, rows, e)
}

describe('marchSide respects maxBatterWidth', () => {
  // Reviewer's counterexample: without the fix, requiredHalfWidth grows
  // without bound on a cross-slope this steep, so both sides march to
  // MAX_SECTION_HALF_WIDTH and truncated is falsely set on a section whose
  // areas are already exact, because designElevationAt contributes nothing
  // past the wall.
  const wallTemplate: CorridorTemplate = {
    formationHalfWidth: 5,
    cutSlope: 2,
    fillSlope: 3,
    maxBatterWidth: 8,
  }

  it('computes correct areas with truncated: false on a steep sidehill cross-slope with walls both sides', () => {
    const terrain = sidehillGround(98, 0.6)
    const a = crossSectionAreas(road(100), terrain, { s: 50, z: 98 }, wallTemplate)

    expect(a.truncated).toBe(false)
    // Analytic areas (flat formation contribution plus the batter integral up
    // to the wall at offset 13 = formationHalfWidth 5 + maxBatterWidth 8):
    // cut 34.7 m^2, fill ~40.03 m^2.
    expect(a.cutArea).toBeCloseTo(34.7, 1)
    expect(a.fillArea).toBeCloseTo(40.03, 1)
  })
})

/**
 * Ground on the uphill side (offset >= 0, i.e. y >= 0) that is flat at
 * `base` out to `notchLowY`, dips down across `[notchLowY, notchHighY]` to
 * exactly track the cut batter (`designZ + (y - formationHalfWidth) /
 * cutSlope`) — a notch that briefly, genuinely touches the design surface —
 * and then follows `afterNotch` beyond `notchHighY`. The downhill side
 * (y < 0) is flat at `designZ`, so it daylights immediately and contributes
 * nothing, keeping the fixture focused on the one side under test.
 *
 * `cellSize` is 1m and the notch boundaries are whole metres, so bilinear
 * sampling reproduces every linear segment of this piecewise function
 * exactly, with no smoothing at the segment boundaries.
 */
const benchGround = (
  base: number,
  designZ: number,
  formationHalfWidth: number,
  cutSlope: number,
  notchLowY: number,
  notchHighY: number,
  afterNotch: (y: number) => number,
  extentY: number,
): Heightmap => {
  const cellSize = 1
  const originX = -5
  const originY = -10
  const cols = 111 // covers x in [-5, 105], enough for a 100m road
  const rows = extentY - originY + 1
  const e = new Float32Array(cols * rows)
  for (let row = 0; row < rows; row++) {
    const y = originY + row * cellSize
    let z: number
    if (y < 0) {
      z = designZ
    } else if (y < notchLowY) {
      z = base
    } else if (y <= notchHighY) {
      z = designZ + (y - formationHalfWidth) / cutSlope
    } else {
      z = afterNotch(y)
    }
    for (let col = 0; col < cols; col++) e[row * cols + col] = z
  }
  return new Heightmap(originX, originY, cellSize, cols, rows, e)
}

describe('adaptive daylight bound vs. non-monotonic ground (benches)', () => {
  // Ground: flat at 106 (an 8m cut) from the formation edge out to 7m, a
  // notch from 7-9m that exactly tracks the batter (design + (y-5)/2, i.e.
  // 99 at y=7 and 100 at y=9) — a genuine, if brief, daylight touch — then
  // back up to flat at 106 (still an 8m cut, not daylighted) from 9-15m,
  // then a ridge climbing 3 m/m beyond 15m, forever.
  //
  // A rule based on counting consecutive daylighted samples confirms
  // daylight during the notch (around y=9) and stops there, reporting
  // ~26.875 m^2 and never seeing the ridge — the exact silent under-report
  // the reviewer's counterexample describes. The adaptive bound does not,
  // because maxCutDepthSeen is already 8 (from the flat ground before the
  // notch) by the time the notch is reached, so the notch's shallower
  // touch cannot pull the required half-width in to meet it.
  const base = 106
  const designZ = 98

  it('is not fooled by a bench into ignoring a ridge beyond it', () => {
    const terrain = benchGround(
      base, designZ, template.formationHalfWidth, template.cutSlope, 7, 9,
      (y) => (y <= 15 ? base : base + 3 * (y - 15)),
      500,
    )
    const a = crossSectionAreas(road(100), terrain, { s: 50, z: designZ }, template)

    // The batter climbs at 1/cutSlope = 0.5 m/m; the ridge climbs at 3 m/m,
    // six times faster, so the batter can never catch it and the section
    // must reach the safety cap. Either outcome the reviewer names is
    // acceptable, but this fixture is built to force truncation specifically.
    expect(a.truncated || a.cutArea > 26.875 * 1.5).toBe(true)
  })

  it('terminates well inside the cap when a bench genuinely ends the section', () => {
    // Same notch, but ground beyond it stays flat at 100 forever — exactly
    // where the notch left off — so the batter (still climbing past that
    // point) is capped at natural ground from y=9 onward for good. This is
    // a real daylight point, not a bench, and the march must find it well
    // short of the 500m cap.
    const terrain = benchGround(
      base, designZ, template.formationHalfWidth, template.cutSlope, 7, 9,
      () => 100,
      30,
    )
    const a = crossSectionAreas(road(100), terrain, { s: 50, z: designZ }, template)

    expect(a.truncated).toBe(false)
    expect(a.cutArea).toBeGreaterThan(0)
    expect(Number.isFinite(a.cutArea)).toBe(true)
  })
})

describe('adaptive daylight bound on real generated terrain', () => {
  it('computes finite, untruncated areas everywhere on a road across generateValley terrain', () => {
    // Same ValleyOptions as the long-section debug view: a deterministic
    // river valley with two octaves of value noise layered on top, so
    // benches and terraces show up as the ordinary shape of the terrain,
    // not a contrived edge case. This is the case the fix actually exists
    // for.
    const terrain = generateValley({
      cols: 129, rows: 129, cellSize: 20,
      floorElevation: 100, ridgeHeight: 70, valleyHalfWidth: 400, seed: 7,
    })

    // A road climbing from the valley floor up over the ridge, so its
    // cross-sections cut across real transverse slope, not just noise.
    const start = vec2(200, 1280)
    const end = vec2(2200, 2200)
    const alignment = new Alignment([
      new Line(start, angleOf(sub(end, start)), distance(start, end)),
    ])

    const ground = sampleGroundProfile(alignment, terrain, 10)
    const solution = solveGradeProfile(ground, {
      maxGrade: 0.07, maxCutDepth: 15, maxFillHeight: 12,
    })
    expect(solution.feasible).toBe(true)
    if (!solution.feasible) return

    const q = computeEarthworks(alignment, terrain, solution.profile, template)

    expect(q.truncatedStations).toBe(0)
    for (const s of q.stations) {
      expect(s.truncated).toBe(false)
      expect(Number.isFinite(s.cutArea)).toBe(true)
      expect(Number.isFinite(s.fillArea)).toBe(true)
      expect(s.cutArea).toBeGreaterThanOrEqual(0)
      expect(s.fillArea).toBeGreaterThanOrEqual(0)
    }
    // The road genuinely does earthworks somewhere along its length — this
    // isn't a degenerate all-zero fixture.
    expect(q.stations.some((s) => s.cutArea > 0 || s.fillArea > 0)).toBe(true)
  })
})
