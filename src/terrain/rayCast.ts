import type { Vec2 } from '../geometry/vec2'
import type { TerrainSampler } from './heightmap'

export type Vec3 = {
  readonly x: number
  readonly y: number
  readonly z: number
}

export type Ray3 = {
  readonly origin: Vec3
  /** Need not be normalized. */
  readonly direction: Vec3
}

/** Coarse step along the ray, metres. */
const STEP = 4

/** Bisection passes once a crossing is bracketed. */
const REFINEMENT_PASSES = 24

/** Default search length along the ray, metres. */
const DEFAULT_MAX_DISTANCE = 20000

/**
 * Where a ray meets the ground.
 *
 * Marches the heightfield rather than raycasting the rendered mesh, so the
 * answer does not change with the terrain's level of detail — a picked
 * position stays put when the mesh is rebuilt at a different resolution.
 *
 * Returns the horizontal position of the hit. A ray that never passes below
 * ground within `maxDistance` misses: the player is pointing at the sky.
 */
export const rayTerrainIntersection = (
  ray: Ray3,
  terrain: TerrainSampler,
  maxDistance: number = DEFAULT_MAX_DISTANCE,
): Vec2 | undefined => {
  const { origin, direction } = ray
  const magnitude = Math.hypot(direction.x, direction.y, direction.z)
  if (!(magnitude > 0)) {
    throw new RangeError('ray direction must be non-zero')
  }

  const step = {
    x: direction.x / magnitude,
    y: direction.y / magnitude,
    z: direction.z / magnitude,
  }

  /** Height above ground at a distance along the ray. Negative is underground. */
  const clearanceAt = (t: number): number => {
    const x = origin.x + step.x * t
    const y = origin.y + step.y * t
    const z = origin.z + step.z * t
    return z - terrain.sample(x, y)
  }

  if (clearanceAt(0) <= 0) {
    return { x: origin.x, y: origin.y }
  }

  let previous = 0
  for (let t = STEP; t <= maxDistance; t += STEP) {
    if (clearanceAt(t) <= 0) {
      // Bracketed: above ground at `previous`, below at `t`.
      let low = previous
      let high = t
      for (let i = 0; i < REFINEMENT_PASSES; i++) {
        const mid = (low + high) / 2
        if (clearanceAt(mid) > 0) low = mid
        else high = mid
      }
      const hit = (low + high) / 2
      return { x: origin.x + step.x * hit, y: origin.y + step.y * hit }
    }
    previous = t
  }

  return undefined
}
