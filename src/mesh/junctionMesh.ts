import type { JunctionLeg } from './junctionLegs'
import type { JunctionGeometry } from './junctionCorners'
import type { MeshData } from './ribbon'
import { type Vec2, add, scale, leftNormal } from '../geometry/vec2'

const EMPTY: MeshData = {
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  uvs: new Float32Array(0),
  indices: new Uint32Array(0),
  vertexCount: 0,
  triangleCount: 0,
}

/** Two boundary points closer than this are the same point. */
export const BOUNDARY_TOLERANCE = 1e-6

/** Drop consecutive duplicates, including the wrap from last back to first. */
const dedupeConsecutive = (points: readonly Vec2[]): Vec2[] => {
  const kept: Vec2[] = []
  for (const point of points) {
    const previous = kept[kept.length - 1]
    if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) <= BOUNDARY_TOLERANCE) {
      continue
    }
    kept.push(point)
  }
  const first = kept[0]
  const last = kept[kept.length - 1]
  if (kept.length > 1 && first && last &&
      Math.hypot(last.x - first.x, last.y - first.y) <= BOUNDARY_TOLERANCE) {
    kept.pop()
  }
  return kept
}

/**
 * The surface filling the gap that trimmed ribbons leave at a junction.
 *
 * Laid out as a triangle fan: the node centre first, then the boundary
 * counter-clockwise. Each leg contributes three boundary points — its trimmed
 * right edge, its trimmed left edge, and the corner between it and the next
 * leg. A fan is valid here because a junction polygon is star-shaped about its
 * own node for any geometry that is not already reported infeasible.
 *
 * Flat at a single elevation. Warping the surface to meet legs on different
 * grades is a later problem; a flat junction is what almost every real one is.
 */
export const buildJunctionMesh = (
  node: Vec2,
  elevation: number,
  legs: readonly JunctionLeg[],
  geometry: JunctionGeometry,
): MeshData => {
  if (!geometry.feasible) return EMPTY

  const n = legs.length
  const raw: Vec2[] = []

  for (let i = 0; i < n; i++) {
    const leg = legs[i]!
    const trim = geometry.trims[i]!
    const left = leftNormal(leg.bearing)
    const along = scale(leg.direction, trim)

    // Right edge first, then left, so the boundary runs counter-clockwise.
    raw.push(add(along, scale(left, -leg.halfWidth)))
    raw.push(add(along, scale(left, leg.halfWidth)))
    raw.push(geometry.corners[i]!.position)
  }

  // A leg's trim is derived from its corners, so whenever a corner is the one
  // that set the trim, that corner and the leg's trimmed edge point are the
  // same point. On a square crossroads every one of them collapses and the
  // polygon is genuinely just its four corners. Leaving the duplicates in
  // produces zero-area triangles.
  const boundary = dedupeConsecutive(raw)
  if (boundary.length < 3) return EMPTY

  const vertexCount = 1 + boundary.length
  const triangleCount = boundary.length

  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  const indices = new Uint32Array(triangleCount * 3)

  // Centre.
  positions[0] = node.x
  positions[1] = node.y
  positions[2] = elevation
  uvs[0] = 0.5
  uvs[1] = 0.5

  // Boundary, offset by the node position — the solve works about the origin.
  boundary.forEach((point, i) => {
    const v = i + 1
    positions[v * 3] = node.x + point.x
    positions[v * 3 + 1] = node.y + point.y
    positions[v * 3 + 2] = elevation
    // UVs are a crude radial projection; junction markings are a later task.
    uvs[v * 2] = 0.5 + point.x * 0.05
    uvs[v * 2 + 1] = 0.5 + point.y * 0.05
  })

  for (let i = 0; i < vertexCount; i++) {
    normals[i * 3] = 0
    normals[i * 3 + 1] = 0
    normals[i * 3 + 2] = 1
  }

  // Fan. Counter-clockwise boundary with an upward normal gives front faces,
  // matching the ribbon's winding convention.
  for (let i = 0; i < boundary.length; i++) {
    const current = i + 1
    const next = ((i + 1) % boundary.length) + 1
    indices[i * 3] = 0
    indices[i * 3 + 1] = current
    indices[i * 3 + 2] = next
  }

  return { positions, normals, uvs, indices, vertexCount, triangleCount }
}
