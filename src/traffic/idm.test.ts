import { describe, expect, it } from 'vitest'
import {
  HIGHWAY_PARAMS,
  type IdmParams,
  TOWN_PARAMS,
  idmAcceleration,
} from './idm'

const p: IdmParams = {
  maxAcceleration: 1.5,
  comfortableDeceleration: 2.0,
  desiredSpeed: 30,
  minimumGap: 2,
  headwayTime: 1.5,
}

/** No leader at all: the road ahead is clear. */
const free = (speed: number) => ({ speed, gap: Infinity, leaderSpeed: Infinity })

describe('idmAcceleration', () => {
  it('accelerates from rest on an empty road at very nearly the maximum', () => {
    const a = idmAcceleration(free(0), p)
    expect(a).toBeCloseTo(p.maxAcceleration, 9)
  })

  it('neither accelerates nor brakes at the desired speed on an empty road', () => {
    expect(idmAcceleration(free(p.desiredSpeed), p)).toBeCloseTo(0, 9)
  })

  it('brakes when above the desired speed on an empty road', () => {
    expect(idmAcceleration(free(p.desiredSpeed * 1.2), p)).toBeLessThan(0)
  })

  it('falls off as the fourth power approaching the desired speed', () => {
    // delta = 4: at 90% of desired, the free term retains 1 - 0.9^4 = 0.3439.
    const a = idmAcceleration(free(p.desiredSpeed * 0.9), p)
    expect(a).toBeCloseTo(p.maxAcceleration * (1 - 0.9 ** 4), 9)
  })

  it('brakes hard when far too close to a stopped leader', () => {
    const a = idmAcceleration({ speed: 20, gap: 3, leaderSpeed: 0 }, p)
    expect(a).toBeLessThan(-p.comfortableDeceleration)
  })

  it('sits at zero acceleration at the equilibrium gap behind a same-speed leader', () => {
    // At steady state with dv = 0, s* = s0 + v*T, and the interaction term
    // cancels the free term exactly when s = s* / sqrt(1 - (v/v0)^4).
    const v = 20
    const sStar = p.minimumGap + v * p.headwayTime
    const equilibriumGap = sStar / Math.sqrt(1 - (v / p.desiredSpeed) ** 4)

    const a = idmAcceleration({ speed: v, gap: equilibriumGap, leaderSpeed: v }, p)
    expect(a).toBeCloseTo(0, 9)
  })

  it('closes a gap larger than equilibrium and opens one smaller', () => {
    const v = 20
    const sStar = p.minimumGap + v * p.headwayTime
    const equilibrium = sStar / Math.sqrt(1 - (v / p.desiredSpeed) ** 4)

    expect(idmAcceleration({ speed: v, gap: equilibrium * 1.5, leaderSpeed: v }, p))
      .toBeGreaterThan(0)
    expect(idmAcceleration({ speed: v, gap: equilibrium * 0.7, leaderSpeed: v }, p))
      .toBeLessThan(0)
  })

  it('brakes for a leader that is slower even when the gap is comfortable', () => {
    // The closing-speed term is what makes this negative; without it a
    // generous gap would read as free road right up until the collision.
    //
    // `speed` must sit BELOW `desiredSpeed`, and that is the whole test.
    // An earlier version used 30 against a desired speed of 30, which zeroes
    // the free term — and with the free term at zero the result is
    // `-a·(s*/s)²`, negative for ANY leader at ANY gap. It passed with the
    // closing-speed term deleted, so it never tested the thing its own name
    // claims. At 20 the free term is `1 − (20/30)⁴ ≈ 0.80`, so the closing
    // term has something to overcome and its absence flips the sign.
    const closing = idmAcceleration({ speed: 20, gap: 60, leaderSpeed: 5 }, p)
    expect(closing).toBeLessThan(0)

    // And "comfortable" is asserted rather than assumed: the same car at the
    // same gap behind a leader matching its speed is still accelerating, so
    // 60m genuinely is roomy here and the braking above is caused by the
    // closing speed, not by the gap being tight.
    const matched = idmAcceleration({ speed: 20, gap: 60, leaderSpeed: 20 }, p)
    expect(matched).toBeGreaterThan(0)
  })

  it('ignores a leader that is pulling away', () => {
    // Approaching term must not reward a widening gap: max(0, ...) clamps it.
    const closing = idmAcceleration({ speed: 20, gap: 40, leaderSpeed: 20 }, p)
    const opening = idmAcceleration({ speed: 20, gap: 40, leaderSpeed: 40 }, p)
    expect(opening).toBeGreaterThan(closing)
    // But not unboundedly: it can never exceed the free-road acceleration.
    expect(opening).toBeLessThanOrEqual(idmAcceleration(free(20), p) + 1e-9)
  })

  it('never returns a non-finite number, however extreme the input', () => {
    const cases = [
      { speed: 0, gap: 0, leaderSpeed: 0 },
      { speed: 40, gap: 0, leaderSpeed: 0 },
      { speed: 0, gap: Infinity, leaderSpeed: Infinity },
      { speed: 40, gap: 1e-9, leaderSpeed: 0 },
    ]
    for (const c of cases) {
      expect(Number.isFinite(idmAcceleration(c, p))).toBe(true)
    }
  })

  it('gives the town preset twitchier parameters than the highway preset', () => {
    // Spec 4.3: low a and low T produce dramatic phantom jams; high values
    // produce calm flow. The presets exist to make that a design knob.
    expect(TOWN_PARAMS.maxAcceleration).toBeLessThan(HIGHWAY_PARAMS.maxAcceleration)
    expect(TOWN_PARAMS.headwayTime).toBeLessThan(HIGHWAY_PARAMS.headwayTime)
  })

  it('rejects parameters that would divide by zero', () => {
    expect(() => idmAcceleration(free(10), { ...p, desiredSpeed: 0 })).toThrow(RangeError)
    expect(() => idmAcceleration(free(10), { ...p, maxAcceleration: 0 })).toThrow(RangeError)
    expect(() => idmAcceleration(free(10), { ...p, comfortableDeceleration: 0 }))
      .toThrow(RangeError)
  })
})
