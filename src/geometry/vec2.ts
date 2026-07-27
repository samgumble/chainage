export type Vec2 = { readonly x: number; readonly y: number }

export const vec2 = (x: number, y: number): Vec2 => ({ x, y })

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k })

export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x

export const length = (a: Vec2): number => Math.hypot(a.x, a.y)
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y)

export const normalize = (a: Vec2): Vec2 => {
  const len = Math.hypot(a.x, a.y)
  return len === 0 ? { x: 0, y: 0 } : { x: a.x / len, y: a.y / len }
}

export const fromAngle = (radians: number): Vec2 => ({
  x: Math.cos(radians),
  y: Math.sin(radians),
})

/**
 * The transverse direction, left of travel, for a heading.
 *
 * "Left" is that heading rotated +90 degrees (counter-clockwise), matching
 * this codebase's y-north, counter-clockwise-positive angle convention.
 * Used everywhere a cross-section or junction edge needs to step sideways
 * off a centreline: ribbon sweeps, junction corner solving, and junction
 * plate edges all offset along this same direction.
 */
export const leftNormal = (heading: number): Vec2 => fromAngle(heading + Math.PI / 2)

export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x)

/** Normalize into (-PI, PI]. Exactly -PI maps to +PI. */
export const normalizeAngle = (radians: number): number => {
  const twoPi = Math.PI * 2
  let r = radians % twoPi
  if (r > Math.PI) r -= twoPi
  else if (r <= -Math.PI) r += twoPi
  return r
}

/** Signed angle from `from` to `to`, positive counter-clockwise, in (-PI, PI]. */
export const signedAngleBetween = (from: Vec2, to: Vec2): number =>
  normalizeAngle(Math.atan2(cross(from, to), dot(from, to)))
