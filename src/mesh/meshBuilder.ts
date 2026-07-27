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
 *
 * But note what that guarantee costs the test that caught those two bugs.
 * Because each face's stored normal is derived from that face's own winding,
 * "computed normal agrees with stored normal" is now true by construction for
 * anything built through here — it is a tautology, not a check. It still
 * catches a mesh assembled some other way, and it still catches faces that
 * disagree with each OTHER, but it cannot see a solid that is uniformly
 * inside-out: flip every face and every face still agrees with itself. That
 * is exactly how the bridge's pier and abutment boxes originally shipped.
 *
 * For a closed solid the real test is the signed volume by the divergence
 * theorem, which is positive only with outward normals and independent of the
 * origin. It requires the solid actually to be closed — an open surface has
 * no enclosed volume and its "volume" moves with the origin — so caps that
 * look merely cosmetic are load-bearing for the test.
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
    // A planar quad's two triangles, (a, b, c) and (a, c, d), share one true
    // normal. A non-planar quad's do not — that happens for real on curves,
    // where consecutive wall posts along an alignment are not coplanar. We
    // average the two triangle normals and store that on all four vertices,
    // splitting the error between them instead of loading it all onto the
    // second triangle.
    const n1 = faceNormal(a, b, c)
    const n2 = faceNormal(a, c, d)
    const normal = averageNormal(n1, n2)
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
    const [u, v] = projectUV(point, normal)
    this.uvs.push(u, v)
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

/** Average of two face normals, re-normalized. Zero if they cancel exactly. */
const averageNormal = (a: Point3, b: Point3): Point3 => {
  const x = a.x + b.x, y = a.y + b.y, z = a.z + b.z
  const len = Math.hypot(x, y, z)
  if (len === 0) return { x: 0, y: 0, z: 0 }
  return { x: x / len, y: y / len, z: z / len }
}

/**
 * Dominant-axis planar UV projection.
 *
 * A single (x, y) projection collapses vertical faces — retaining wall
 * panels, bridge piers, abutments — to a near-constant UV down their whole
 * height, since x and y barely change as you move up a vertical face. Instead
 * we pick the two world axes to project from whichever component of the
 * face's normal is largest in magnitude, so the projection always spans the
 * two axes the face actually varies across:
 *  - normal mostly ±x (a face looking along x) → project (y, z)
 *  - normal mostly ±y → project (x, z)
 *  - normal mostly ±z (a horizontal face, e.g. a deck top) → project (x, y)
 */
const projectUV = (point: Point3, normal: Point3): readonly [number, number] => {
  const ax = Math.abs(normal.x)
  const ay = Math.abs(normal.y)
  const az = Math.abs(normal.z)
  if (ax >= ay && ax >= az) return [point.y / UV_METRES_PER_TILE, point.z / UV_METRES_PER_TILE]
  if (ay >= ax && ay >= az) return [point.x / UV_METRES_PER_TILE, point.z / UV_METRES_PER_TILE]
  return [point.x / UV_METRES_PER_TILE, point.y / UV_METRES_PER_TILE]
}
