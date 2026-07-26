import { describe, it, expect } from 'vitest'
import {
  sideFrictionFactor, designSpeedForRadius, minimumRadiusForSpeed,
  MAX_TABULATED_SPEED_KPH,
} from './designSpeed'

describe('sideFrictionFactor', () => {
  it('returns AASHTO table values at the tabulated speeds', () => {
    expect(sideFrictionFactor(30)).toBeCloseTo(0.28, 9)
    expect(sideFrictionFactor(60)).toBeCloseTo(0.17, 9)
    expect(sideFrictionFactor(100)).toBeCloseTo(0.12, 9)
  })

  it('interpolates between tabulated speeds', () => {
    // Midway between 50 (0.19) and 60 (0.17).
    expect(sideFrictionFactor(55)).toBeCloseTo(0.18, 9)
  })

  it('clamps below and above the table', () => {
    expect(sideFrictionFactor(10)).toBeCloseTo(0.28, 9)
    expect(sideFrictionFactor(200)).toBeCloseTo(0.09, 9)
  })

  it('decreases monotonically with speed', () => {
    let previous = Infinity
    for (let v = 30; v <= 120; v += 5) {
      const f = sideFrictionFactor(v)
      expect(f).toBeLessThanOrEqual(previous)
      previous = f
    }
  })
})

describe('designSpeedForRadius', () => {
  it('increases with radius', () => {
    expect(designSpeedForRadius(500)).toBeGreaterThan(designSpeedForRadius(100))
  })

  it('lands near expected values for typical rural radii', () => {
    // Loose bounds: this is a design relationship, not a physical constant.
    expect(designSpeedForRadius(50)).toBeGreaterThan(30)
    expect(designSpeedForRadius(50)).toBeLessThan(55)
    expect(designSpeedForRadius(400)).toBeGreaterThan(90)
    expect(designSpeedForRadius(400)).toBeLessThan(130)
  })

  it('gives a higher speed with more superelevation', () => {
    expect(designSpeedForRadius(200, 0.10)).toBeGreaterThan(
      designSpeedForRadius(200, 0.02),
    )
  })

  it('rejects a non-positive radius', () => {
    expect(() => designSpeedForRadius(0)).toThrow(RangeError)
    expect(() => designSpeedForRadius(-10)).toThrow(RangeError)
  })

  it('gives a low but positive, sensible speed at a very tight radius', () => {
    const v = designSpeedForRadius(10)
    expect(v).toBeGreaterThan(0)
    expect(v).toBeLessThan(30)
  })

  it('caps at MAX_TABULATED_SPEED_KPH for a very large radius', () => {
    // Above ~756 m (at e=0.06) the uncapped solve would exceed the AASHTO
    // table's range and grow without bound (e.g. ~308 km/h at R=5000), which
    // is not physically meaningful — the curve stops being the limiting
    // factor on design speed, so the result saturates at the table's cap.
    expect(designSpeedForRadius(5000)).toBe(MAX_TABULATED_SPEED_KPH)
  })

  it('rejects a negative or non-finite superelevation', () => {
    expect(() => designSpeedForRadius(200, -0.01)).toThrow(RangeError)
    expect(() => designSpeedForRadius(200, NaN)).toThrow(RangeError)
    expect(() => designSpeedForRadius(200, Infinity)).toThrow(RangeError)
  })
})

describe('minimumRadiusForSpeed', () => {
  it('round-trips against designSpeedForRadius', () => {
    // Exact at the fixed point; assert relative error so the tolerance is
    // meaningful at both 50 m and 700 m.
    // Radii are kept below ~756 m (the R whose design speed is exactly
    // MAX_TABULATED_SPEED_KPH at e=0.06): above that, designSpeedForRadius
    // clamps to the cap and the round trip no longer holds (see the
    // "breaks above the cap" test below).
    for (const r of [50, 100, 250, 500, 700]) {
      const v = designSpeedForRadius(r)
      expect(Math.abs(minimumRadiusForSpeed(v) - r) / r).toBeLessThan(0.01)
    }
  })

  it('round-trip breaks above the cap, in the expected direction', () => {
    // designSpeedForRadius(5000) saturates at the cap instead of reporting
    // the true (physically meaningless) solved speed, so feeding it back
    // through minimumRadiusForSpeed recovers the cap's radius (~756 m), not
    // 5000 m.
    expect(designSpeedForRadius(5000)).toBe(MAX_TABULATED_SPEED_KPH)
    expect(minimumRadiusForSpeed(designSpeedForRadius(5000))).toBeLessThan(5000)
  })

  it('increases with speed', () => {
    expect(minimumRadiusForSpeed(100)).toBeGreaterThan(minimumRadiusForSpeed(50))
  })

  it('rejects a non-positive speed', () => {
    expect(() => minimumRadiusForSpeed(0)).toThrow(RangeError)
  })

  it('rejects a negative or non-finite superelevation', () => {
    expect(() => minimumRadiusForSpeed(80, -0.01)).toThrow(RangeError)
    expect(() => minimumRadiusForSpeed(80, NaN)).toThrow(RangeError)
    expect(() => minimumRadiusForSpeed(80, Infinity)).toThrow(RangeError)
  })
})
