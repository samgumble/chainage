import { describe, expect, it } from 'vitest'
import {
  MAX_BLUR_PIXELS,
  TILT_SHIFT_FRAGMENT_SHADER,
  TILT_SHIFT_UNIFORM_NAMES,
  type TiltShiftFocus,
  blurFractionAt,
} from './tiltShift'

const focus: TiltShiftFocus = { distance: 800, range: 300, falloff: 900 }

describe('blurFractionAt', () => {
  it('is sharp at the focal distance', () => {
    expect(blurFractionAt(800, focus)).toBe(0)
  })

  it('is sharp anywhere inside the focal range', () => {
    expect(blurFractionAt(800 - focus.range / 2, focus)).toBe(0)
    expect(blurFractionAt(800 + focus.range / 2, focus)).toBe(0)
  })

  it('blurs both nearer and further than the focal range', () => {
    expect(blurFractionAt(300, focus)).toBeGreaterThan(0)
    expect(blurFractionAt(1500, focus)).toBeGreaterThan(0)
  })

  it('blurs more the further from focus, in both directions', () => {
    expect(blurFractionAt(200, focus)).toBeGreaterThan(blurFractionAt(400, focus))
    expect(blurFractionAt(2000, focus)).toBeGreaterThan(blurFractionAt(1200, focus))
  })

  it('never exceeds one', () => {
    for (const depth of [0, 1, 500, 800, 5000, 1e6]) {
      expect(blurFractionAt(depth, focus)).toBeLessThanOrEqual(1)
      expect(blurFractionAt(depth, focus)).toBeGreaterThanOrEqual(0)
    }
  })

  it('reaches full blur exactly one falloff beyond the range', () => {
    const edge = 800 + focus.range / 2
    expect(blurFractionAt(edge + focus.falloff, focus)).toBeCloseTo(1, 9)
  })

  it('is symmetric about the focal distance', () => {
    const offset = 500
    expect(blurFractionAt(800 + offset, focus)).toBeCloseTo(
      blurFractionAt(800 - offset, focus),
      9,
    )
  })

  it('treats a zero range as a single sharp plane rather than dividing by zero', () => {
    const knife: TiltShiftFocus = { distance: 500, range: 0, falloff: 100 }
    expect(blurFractionAt(500, knife)).toBe(0)
    expect(Number.isFinite(blurFractionAt(600, knife))).toBe(true)
    expect(blurFractionAt(600, knife)).toBeCloseTo(1, 9)
  })

  it('rejects a non-positive falloff rather than dividing by zero', () => {
    expect(() => blurFractionAt(100, { distance: 500, range: 10, falloff: 0 })).toThrow(
      RangeError,
    )
  })

  it('handles a depth behind the camera without producing a negative blur', () => {
    expect(blurFractionAt(-50, focus)).toBeGreaterThanOrEqual(0)
    expect(blurFractionAt(-50, focus)).toBeLessThanOrEqual(1)
  })
})

describe('TILT_SHIFT_FRAGMENT_SHADER', () => {
  it('declares every uniform the pass will supply', () => {
    for (const name of TILT_SHIFT_UNIFORM_NAMES) {
      expect(TILT_SHIFT_FRAGMENT_SHADER).toMatch(
        new RegExp(`uniform\\s+\\w+\\s+${name}\\s*;`),
      )
    }
  })

  it('names no uniform the pass will not supply', () => {
    const declared = [...TILT_SHIFT_FRAGMENT_SHADER.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map(
      (m) => m[1],
    )
    for (const name of declared) {
      expect(TILT_SHIFT_UNIFORM_NAMES).toContain(name)
    }
  })

  it('writes a fragment colour', () => {
    expect(TILT_SHIFT_FRAGMENT_SHADER).toMatch(/gl_FragColor\s*=/)
  })

  it('reaches the same full-blur bound as the profile', () => {
    expect(TILT_SHIFT_FRAGMENT_SHADER).toContain(String(MAX_BLUR_PIXELS))
  })
})
