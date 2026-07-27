export type Vec3 = {
  readonly x: number
  readonly y: number
  readonly z: number
}

export type Sunlight = {
  /** Unit vector from the ground toward the sun. */
  readonly direction: Vec3
  /** Packed 0xRRGGBB. */
  readonly colour: number
  /** Zero at night, peaking at midday. */
  readonly intensity: number
}

export const SUNRISE_HOUR = 6
export const SUNSET_HOUR = 18

/**
 * How high the sun climbs at midday, radians.
 *
 * Deliberately not overhead. A sun near the zenith flattens everything: the
 * shadows that make a model read as a model are the long ones, and a scene lit
 * from straight above looks like a product photograph instead.
 */
export const MAX_SUN_ELEVATION = Math.PI / 3

/** Brightness at midday. */
const PEAK_INTENSITY = 4.5

/** Colour at midday and at the horizon, packed 0xRRGGBB. */
const OVERHEAD_COLOUR = { r: 0xff, g: 0xf4, b: 0xe2 }
const HORIZON_COLOUR = { r: 0xff, g: 0xb1, b: 0x6a }

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value)

const mix = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * Where the sun is, what colour and how bright, at an hour of the day.
 *
 * A simple arc rather than an ephemeris: it rises in the east, crosses to the
 * south at midday and sets in the west, which in this project's coordinates is
 * `+x`, then `−y`, then `−x`. Accuracy to the minute would buy nothing — what
 * matters is that the light has a direction a viewer can read as a time of day,
 * and that it is low enough to throw the long shadows a miniature needs.
 */
export const sunAt = (hourOfDay: number): Sunlight => {
  // Wrap rather than reject: a caller animating a clock should not have to
  // remember to take a modulus, and there is no such thing as an invalid hour.
  const hour = ((hourOfDay % 24) + 24) % 24

  const dayLength = SUNSET_HOUR - SUNRISE_HOUR
  // 0 at sunrise, 1 at sunset. Outside the day it leaves [0, 1] and the sun
  // sits below the horizon, which is exactly what the intensity check wants.
  const t = (hour - SUNRISE_HOUR) / dayLength
  const isDay = t >= 0 && t <= 1

  const elevation = MAX_SUN_ELEVATION * Math.sin(Math.PI * t)
  // Azimuth measured from east, sweeping south: 0 at sunrise, −pi at sunset.
  const azimuth = -Math.PI * t

  const horizontal = Math.cos(elevation)
  const direction: Vec3 = {
    x: horizontal * Math.cos(azimuth),
    y: horizontal * Math.sin(azimuth),
    z: Math.sin(elevation),
  }

  if (!isDay) {
    return { direction, colour: (HORIZON_COLOUR.r << 16) | (HORIZON_COLOUR.g << 8) | HORIZON_COLOUR.b, intensity: 0 }
  }

  // Height above the horizon, as a fraction of the day's maximum. Drives both
  // the warmth and the brightness, so a low sun is dim and orange together.
  const height = clamp01(Math.sin(elevation) / Math.sin(MAX_SUN_ELEVATION))

  const r = Math.round(mix(HORIZON_COLOUR.r, OVERHEAD_COLOUR.r, height))
  const g = Math.round(mix(HORIZON_COLOUR.g, OVERHEAD_COLOUR.g, height))
  const b = Math.round(mix(HORIZON_COLOUR.b, OVERHEAD_COLOUR.b, height))

  return {
    direction,
    colour: (r << 16) | (g << 8) | b,
    intensity: PEAK_INTENSITY * height,
  }
}
