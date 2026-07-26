import type { Alignment } from '../geometry/alignment'
import { fromAngle, add, scale } from '../geometry/vec2'
import { designElevationAtStation, type ProfilePoint } from '../terrain/groundProfile'
import type { SectionPoint } from './crossSection'

/**
 * Renderer-agnostic mesh attributes.
 *
 * Plain typed arrays rather than a three.js BufferGeometry, so mesh generation
 * stays unit-testable without a WebGL context. `src/render/` wraps these.
 */
export type MeshData = {
  /** xyz per vertex. */
  readonly positions: Float32Array
  /** xyz per vertex, unit length. */
  readonly normals: Float32Array
  /** uv per vertex. */
  readonly uvs: Float32Array
  readonly indices: Uint32Array
  readonly vertexCount: number
  readonly triangleCount: number
}

export type RibbonOptions = {
  /** Longitudinal sample spacing, metres. Default 4. */
  readonly spacing?: number
  /** Where to start building, metres along the alignment. Default 0. */
  readonly startStation?: number
  /** Where to stop. Default the alignment length. This is what renders a road mid-construction. */
  readonly endStation?: number
  /**
   * Metres of road per V tile, so markings repeat at real-world scale.
   * Default 10. Must be positive; throws `RangeError` otherwise, since a
   * non-positive value would divide V coordinates by zero or negate them.
   */
  readonly uvTileLength?: number
}

/**
 * Minimum allowed gap between consecutive stations, in metres.
 *
 * `from + steps * spacing` can land a hair under `to` through floating-point
 * noise. Without a guard, the final-station append below would then add a
 * near-duplicate station, producing sliver triangles. Mirrors the constant
 * of the same name and purpose in `src/terrain/groundProfile.ts`.
 */
const MIN_STATION_GAP = 1e-6

const EMPTY: MeshData = {
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  uvs: new Float32Array(0),
  indices: new Uint32Array(0),
  vertexCount: 0,
  triangleCount: 0,
}

/**
 * Sweep a cross-section along an alignment into a triangle mesh.
 *
 * Stations are computed as `start + i * spacing` rather than accumulated, so
 * they cannot drift, and the final station of the range is always included.
 * V coordinates run on **arc length**, not vertex index, so lane markings
 * keep their real-world spacing through a curve instead of stretching.
 *
 * `section` is assumed sorted ascending by `offset` and symmetric about the
 * centreline (offset 0), as `crossSection.ts` produces: U normalization
 * takes `halfWidth` from the last point's offset, which is only the true
 * half-width under that assumption. Not enforced here — every current
 * caller satisfies it and a runtime check would be dead weight.
 */
export const sweepRibbon = (
  alignment: Alignment,
  design: readonly ProfilePoint[],
  section: readonly SectionPoint[],
  options: RibbonOptions = {},
): MeshData => {
  const {
    spacing = 4,
    startStation = 0,
    endStation = alignment.length,
    uvTileLength = 10,
  } = options

  if (section.length < 2) {
    throw new RangeError('a cross-section needs at least two points')
  }
  if (spacing <= 0) {
    throw new RangeError('spacing must be positive')
  }
  if (endStation < startStation) {
    throw new RangeError('endStation must not be less than startStation')
  }
  if (uvTileLength <= 0) {
    throw new RangeError('uvTileLength must be positive')
  }
  if (alignment.isEmpty) return EMPTY

  const from = Math.max(0, Math.min(startStation, alignment.length))
  const to = Math.max(0, Math.min(endStation, alignment.length))
  const span = to - from
  if (span <= 0) return EMPTY

  // Stations across the range, always including the last.
  const stations: number[] = []
  const steps = Math.floor(span / spacing)
  for (let i = 0; i <= steps; i++) stations.push(from + i * spacing)
  const lastStation = stations[stations.length - 1]!
  if (to - lastStation > MIN_STATION_GAP) {
    stations.push(to)
  } else if (lastStation !== to) {
    stations[stations.length - 1] = to
  }
  if (stations.length < 2) return EMPTY

  const across = section.length
  const vertexCount = stations.length * across
  const triangleCount = (stations.length - 1) * (across - 1) * 2

  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  const indices = new Uint32Array(triangleCount * 3)

  const outerOffset = Math.abs(section[across - 1]!.offset)
  const halfWidth = outerOffset === 0 ? 1 : outerOffset

  let v = 0
  for (const s of stations) {
    const pose = alignment.poseAt(s)
    // Left of the direction of travel.
    const normal = fromAngle(pose.heading + Math.PI / 2)
    const designZ = designElevationAtStation(design, s)

    for (let j = 0; j < across; j++) {
      const point = section[j]!
      // `normal` points left; `point.offset` is negative to the left
      // (crossSection.ts), so the displacement along `normal` is `-offset`.
      const p = add(pose.position, scale(normal, -point.offset))

      positions[v * 3] = p.x
      positions[v * 3 + 1] = p.y
      positions[v * 3 + 2] = designZ + point.dz

      // U runs across the road, V along it by arc length so markings tile
      // at a real-world rate regardless of curvature.
      uvs[v * 2] = (point.offset + halfWidth) / (2 * halfWidth)
      uvs[v * 2 + 1] = s / uvTileLength

      v++
    }
  }

  // Normals from the cross-product of the along and across tangents, computed
  // by finite difference over the neighbouring vertices.
  const nAt = (row: number, col: number) => (row * across + col) * 3
  for (let row = 0; row < stations.length; row++) {
    for (let col = 0; col < across; col++) {
      const rowPrev = Math.max(0, row - 1)
      const rowNext = Math.min(stations.length - 1, row + 1)
      const colPrev = Math.max(0, col - 1)
      const colNext = Math.min(across - 1, col + 1)

      const a = nAt(rowNext, col)
      const b = nAt(rowPrev, col)
      const c = nAt(row, colNext)
      const d = nAt(row, colPrev)

      const alongX = positions[a]! - positions[b]!
      const alongY = positions[a + 1]! - positions[b + 1]!
      const alongZ = positions[a + 2]! - positions[b + 2]!

      const acrossX = positions[c]! - positions[d]!
      const acrossY = positions[c + 1]! - positions[d + 1]!
      const acrossZ = positions[c + 2]! - positions[d + 2]!

      // across x along, which points up for a left-handed transverse axis.
      let nx = acrossY * alongZ - acrossZ * alongY
      let ny = acrossZ * alongX - acrossX * alongZ
      let nz = acrossX * alongY - acrossY * alongX

      const len = Math.hypot(nx, ny, nz)
      if (len > 0) {
        nx /= len
        ny /= len
        nz /= len
      } else {
        nx = 0
        ny = 0
        nz = 1
      }

      const o = nAt(row, col)
      normals[o] = nx
      normals[o + 1] = ny
      normals[o + 2] = nz
    }
  }

  // Winding must agree with the vertex normals computed above. For a
  // triangle (A, B, C) the face normal is (B-A) x (C-A). For the first
  // triangle (topLeft, topRight, bottomLeft), B-A is the across step and
  // C-A is the along step, giving across x along: up, matching the vertex
  // normals. For the second (topRight, bottomRight, bottomLeft), B-A is
  // along and C-A is (along - across), and along x (along - across) =
  // -(along x across) = across x along: also up. Get this backwards (e.g.
  // topLeft, bottomLeft, topRight) and every face normal points down
  // instead of up: under three.js's counter-clockwise front-face
  // convention the whole road would be backface-culled and invisible from
  // above, the only angle anyone looks at it from.
  let t = 0
  for (let row = 0; row < stations.length - 1; row++) {
    for (let col = 0; col < across - 1; col++) {
      const topLeft = row * across + col
      const topRight = topLeft + 1
      const bottomLeft = topLeft + across
      const bottomRight = bottomLeft + 1

      indices[t++] = topLeft
      indices[t++] = topRight
      indices[t++] = bottomLeft

      indices[t++] = topRight
      indices[t++] = bottomRight
      indices[t++] = bottomLeft
    }
  }

  return { positions, normals, uvs, indices, vertexCount, triangleCount }
}
