import { Heightmap } from './heightmap'

export type ValleyOptions = {
  cols: number
  rows: number
  cellSize: number
  /** Elevation of the valley floor, metres. */
  floorElevation: number
  /** How far the ridges rise above the floor, metres. */
  ridgeHeight: number
  /** Distance from the valley axis to the ridge crest, metres. */
  valleyHalfWidth: number
  seed: number
}

/**
 * A deterministic river valley running roughly west to east.
 *
 * Cross-section is a smoothstep from floor to ridge over `valleyHalfWidth`,
 * so the sides ease out at both the floor and the crest rather than meeting
 * at a crease. The axis meanders gently along x, and layered value noise adds
 * roughness without breaking the overall form.
 *
 * Deterministic by design: a seeded, repeatable terrain can be asserted
 * against in tests. Random terrain cannot.
 */
export const generateValley = (options: ValleyOptions): Heightmap => {
  const {
    cols, rows, cellSize, floorElevation, ridgeHeight, valleyHalfWidth, seed,
  } = options

  if (valleyHalfWidth <= 0) {
    throw new RangeError('valleyHalfWidth must be positive')
  }

  const elevations = new Float32Array(cols * rows)
  const worldWidth = (cols - 1) * cellSize
  const worldHeight = (rows - 1) * cellSize
  const axisY = worldHeight / 2

  for (let row = 0; row < rows; row++) {
    const y = row * cellSize
    for (let col = 0; col < cols; col++) {
      const x = col * cellSize

      // The valley axis meanders gently rather than running dead straight.
      const meander =
        Math.sin((x / worldWidth) * Math.PI * 2) * valleyHalfWidth * 0.35 +
        Math.sin((x / worldWidth) * Math.PI * 5 + seed) * valleyHalfWidth * 0.12

      const distanceFromAxis = Math.abs(y - (axisY + meander))
      const t = smoothstep(0, valleyHalfWidth, distanceFromAxis)

      const roughness =
        valueNoise(x * 0.004, y * 0.004, seed) * 14 +
        valueNoise(x * 0.017, y * 0.017, seed + 101) * 5

      elevations[row * cols + col] =
        floorElevation + t * ridgeHeight + roughness
    }
  }

  return new Heightmap(0, 0, cellSize, cols, rows, elevations)
}

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Deterministic hash to [-1, 1]. No Math.random anywhere. */
const hash2 = (ix: number, iy: number, seed: number): number => {
  let h = ix * 374761393 + iy * 668265263 + seed * 1274126177
  h = (h ^ (h >> 13)) * 1274126177
  h = h ^ (h >> 16)
  return ((h & 0x7fffffff) / 0x7fffffff) * 2 - 1
}

/** Smoothed value noise on a unit lattice. */
const valueNoise = (x: number, y: number, seed: number): number => {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy

  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)

  const n00 = hash2(ix, iy, seed)
  const n10 = hash2(ix + 1, iy, seed)
  const n01 = hash2(ix, iy + 1, seed)
  const n11 = hash2(ix + 1, iy + 1, seed)

  const bottom = n00 + (n10 - n00) * ux
  const top = n01 + (n11 - n01) * ux
  return bottom + (top - bottom) * uy
}
