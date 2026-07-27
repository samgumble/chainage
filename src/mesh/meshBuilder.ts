import type { MeshData } from './ribbon'

export type Point3 = {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** Metres of world per UV tile. Structures are concrete; the scale is arbitrary but consistent. */
const UV_METRES_PER_TILE = 4

/**
 * Accumulates flat-shaded faces into a mesh.
 *
 * Vertices are never shared between faces — each face carries its own, so its
 * normal is exactly its face normal. Structures are boxes and panels; smooth
 * shading across their edges would be wrong.
 *
 * Winding is enforced in one place. Pass a quad's corners counter-clockwise as
 * seen from the front, and the emitted triangles and normal agree by
 * construction. Getting winding wrong has cost this project two separate bugs
 * — an inside-out road ribbon and an inside-out junction plate — and both were
 * caught only by a test comparing face normals against stored normals. Doing
 * it once here means the later tasks cannot repeat it.
 */
export class MeshBuilder {
  private readonly positions: number[] = []
  private readonly normals: number[] = []
  private readonly uvs: number[] = []
  private readonly indices: number[] = []

  get vertexCount(): number {
    return this.positions.length / 3
  }

  get triangleCount(): number {
    return this.indices.length / 3
  }

  addTriangle(a: Point3, b: Point3, c: Point3): void {
    const base = this.vertexCount
    const normal = faceNormal(a, b, c)
    for (const point of [a, b, c]) this.push(point, normal)
    this.indices.push(base, base + 1, base + 2)
  }

  addQuad(a: Point3, b: Point3, c: Point3, d: Point3): void {
    const base = this.vertexCount
    // The normal comes from the first three corners; a quad is assumed planar
    // enough that the fourth agrees, which is true for every box face here.
    const normal = faceNormal(a, b, c)
    for (const point of [a, b, c, d]) this.push(point, normal)
    this.indices.push(base, base + 1, base + 2)
    this.indices.push(base, base + 2, base + 3)
  }

  build(): MeshData {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      indices: new Uint32Array(this.indices),
      vertexCount: this.vertexCount,
      triangleCount: this.triangleCount,
    }
  }

  private push(point: Point3, normal: Point3): void {
    this.positions.push(point.x, point.y, point.z)
    this.normals.push(normal.x, normal.y, normal.z)
    this.uvs.push(point.x / UV_METRES_PER_TILE, point.y / UV_METRES_PER_TILE)
  }
}

/** (b − a) × (c − a), normalized. Zero for a degenerate face rather than NaN. */
const faceNormal = (a: Point3, b: Point3, c: Point3): Point3 => {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z
  const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z

  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx

  const len = Math.hypot(nx, ny, nz)
  if (len === 0) return { x: 0, y: 0, z: 0 }
  return { x: nx / len, y: ny / len, z: nz / len }
}
