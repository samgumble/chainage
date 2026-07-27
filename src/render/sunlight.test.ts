import { describe, expect, it } from 'vitest'
import {
  MAX_SUN_ELEVATION,
  SUNRISE_HOUR,
  SUNSET_HOUR,
  sunAt,
} from './sunlight'

const NOON = (SUNRISE_HOUR + SUNSET_HOUR) / 2

const channels = (colour: number) => ({
  r: (colour >> 16) & 0xff,
  g: (colour >> 8) & 0xff,
  b: colour & 0xff,
})

describe('sunAt', () => {
  it('always returns a unit direction', () => {
    for (let hour = 0; hour < 24; hour += 0.5) {
      const { direction } = sunAt(hour)
      const length = Math.hypot(direction.x, direction.y, direction.z)
      expect(length).toBeCloseTo(1, 9)
    }
  })

  it('puts the sun in the east at sunrise', () => {
    const { direction } = sunAt(SUNRISE_HOUR)
    expect(direction.x).toBeGreaterThan(0.9)
    expect(direction.z).toBeCloseTo(0, 3)
  })

  it('puts the sun in the west at sunset', () => {
    const { direction } = sunAt(SUNSET_HOUR)
    expect(direction.x).toBeLessThan(-0.9)
    expect(direction.z).toBeCloseTo(0, 3)
  })

  it('puts the sun to the south at midday', () => {
    const { direction } = sunAt(NOON)
    // South is -y in this project's coordinates.
    expect(direction.y).toBeLessThan(0)
    expect(Math.abs(direction.x)).toBeLessThan(0.1)
  })

  it('is highest at midday and never higher than the stated maximum', () => {
    const noon = sunAt(NOON).direction.z
    expect(noon).toBeCloseTo(Math.sin(MAX_SUN_ELEVATION), 6)

    for (let hour = SUNRISE_HOUR; hour <= SUNSET_HOUR; hour += 0.25) {
      expect(sunAt(hour).direction.z).toBeLessThanOrEqual(noon + 1e-9)
    }
  })

  it('climbs through the morning and falls through the afternoon', () => {
    const morning = [8, 9, 10, 11].map((h) => sunAt(h).direction.z)
    const afternoon = [13, 14, 15, 16].map((h) => sunAt(h).direction.z)

    for (let i = 1; i < morning.length; i++) {
      expect(morning[i]!).toBeGreaterThan(morning[i - 1]!)
    }
    for (let i = 1; i < afternoon.length; i++) {
      expect(afternoon[i]!).toBeLessThan(afternoon[i - 1]!)
    }
  })

  it('is brightest at midday and dark at night', () => {
    expect(sunAt(NOON).intensity).toBeGreaterThan(sunAt(SUNRISE_HOUR + 1).intensity)
    expect(sunAt(3).intensity).toBe(0)
    expect(sunAt(23).intensity).toBe(0)
  })

  it('is warmer near the horizon than overhead', () => {
    const low = channels(sunAt(SUNRISE_HOUR + 0.2).colour)
    const high = channels(sunAt(NOON).colour)

    // Warmth is red relative to blue, not red alone — a dimmer light has less
    // of every channel, so comparing red against red would prove nothing.
    expect(low.r / low.b).toBeGreaterThan(high.r / high.b)
  })

  it('never emits a channel outside a byte', () => {
    for (let hour = 0; hour < 24; hour += 0.5) {
      const { r, g, b } = channels(sunAt(hour).colour)
      for (const value of [r, g, b]) {
        expect(Number.isInteger(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(255)
      }
    }
  })

  it('treats the hour cyclically rather than throwing', () => {
    expect(sunAt(24 + NOON).direction.z).toBeCloseTo(sunAt(NOON).direction.z, 9)
    expect(sunAt(-24 + NOON).direction.z).toBeCloseTo(sunAt(NOON).direction.z, 9)
  })
})
