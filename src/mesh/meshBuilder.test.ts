import { describe, it, expect } from 'vitest'
import { MeshBuilder } from './meshBuilder'

/** A unit square in the z=0 plane, counter-clockwise seen from above. */
const flatQuad = (b: MeshBuilder, z = 0) => {
  b.addQuad(
    { x: 0, y: 0, z }, { x: 1, y: 0, z }, { x: 1, y: 1, z }, { x: 0, y: 1, z },
  )
}

describe('MeshBuilder counts', () => {
  it('starts empty', () => {
    const b = new MeshBuilder()
    expect(b.vertexCount).toBe(0)
    expect(b.triangleCount).toBe(0)
  })

  it('emits four vertices and two triangles per quad', () => {
    const b = new MeshBuilder()
    flatQuad(b)
    expect(b.vertexCount).toBe(4)
    expect(b.triangleCount).toBe(2)
  })

  it('emits three vertices and one triangle per triangle', () => {
    const b = new MeshBuilder()
    b.addTriangle({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })
    expect(b.vertexCount).toBe(3)
    expect(b.triangleCount).toBe(1)
  })

  it('does not share vertices between faces', () => {
    const b = new MeshBuilder()
    flatQuad(b)
    flatQuad(b)
    expect(b.vertexCount).toBe(8)
  })

  it('builds an empty mesh when nothing was added', () => {
    const m = new MeshBuilder().build()
    expect(m.vertexCount).toBe(0)
    expect(m.triangleCount).toBe(0)
    expect(m.positions).toHaveLength(0)
    expect(m.indices).toHaveLength(0)
  })
})

describe('MeshBuilder geometry', () => {
  it('writes the corner positions it was given', () => {
    const b = new MeshBuilder()
    flatQuad(b, 7)
    const m = b.build()
    expect(m.positions[0]).toBeCloseTo(0, 6)
    expect(m.positions[1]).toBeCloseTo(0, 6)
    expect(m.positions[2]).toBeCloseTo(7, 6)
  })

  it('gives an upward normal to a counter-clockwise horizontal quad', () => {
    const b = new MeshBuilder()
    flatQuad(b)
    const m = b.build()
    for (let i = 0; i < m.vertexCount; i++) {
      expect(m.normals[i * 3 + 2]).toBeCloseTo(1, 6)
    }
  })

  it('gives a downward normal when the corners are reversed', () => {
    const b = new MeshBuilder()
    b.addQuad(
      { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 },
    )
    const m = b.build()
    expect(m.normals[2]).toBeCloseTo(-1, 6)
  })

  it('gives a horizontal normal to a vertical quad', () => {
    const b = new MeshBuilder()
    // A wall in the x=0 plane, facing +x.
    b.addQuad(
      { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 1 }, { x: 0, y: 0, z: 1 },
    )
    const m = b.build()
    expect(m.normals[0]).toBeCloseTo(1, 6)
    expect(m.normals[2]).toBeCloseTo(0, 6)
  })

  it('gives unit-length normals', () => {
    const b = new MeshBuilder()
    b.addQuad(
      { x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 1 }, { x: 3, y: 2, z: 4 }, { x: 0, y: 2, z: 3 },
    )
    const m = b.build()
    for (let i = 0; i < m.vertexCount; i++) {
      expect(Math.hypot(m.normals[i * 3]!, m.normals[i * 3 + 1]!, m.normals[i * 3 + 2]!))
        .toBeCloseTo(1, 5)
    }
  })

  it('winds every triangle to agree with its normal', () => {
    const b = new MeshBuilder()
    flatQuad(b)
    b.addQuad(
      { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 1 }, { x: 0, y: 0, z: 1 },
    )
    const m = b.build()
    for (let t = 0; t < m.indices.length; t += 3) {
      const [i, j, k] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!]
      const ax = m.positions[i * 3]!, ay = m.positions[i * 3 + 1]!, az = m.positions[i * 3 + 2]!
      const ux = m.positions[j * 3]! - ax, uy = m.positions[j * 3 + 1]! - ay, uz = m.positions[j * 3 + 2]! - az
      const vx = m.positions[k * 3]! - ax, vy = m.positions[k * 3 + 1]! - ay, vz = m.positions[k * 3 + 2]! - az
      const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx
      const dot = fx * m.normals[i * 3]! + fy * m.normals[i * 3 + 1]! + fz * m.normals[i * 3 + 2]!
      expect(dot).toBeGreaterThan(0)
    }
  })

  it('emits a zero normal rather than NaN for a degenerate face', () => {
    const b = new MeshBuilder()
    const p = { x: 1, y: 1, z: 1 }
    b.addTriangle(p, p, p)
    const m = b.build()
    for (let i = 0; i < 3; i++) {
      expect(Number.isFinite(m.normals[i])).toBe(true)
    }
  })

  it('projects UV from the dominant normal axis so a vertical face varies across its height', () => {
    const b = new MeshBuilder()
    // A tall retaining-wall panel in the x=0 plane, facing +x: 1m wide (y),
    // 3m tall (z). A plain (x, y) projection would pin every vertex's U to
    // x/4 = 0 and leave V depending only on y — moving straight up the wall
    // (constant x, constant y) would not move the UV at all, collapsing the
    // whole height to one texture point.
    b.addQuad(
      { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 3 }, { x: 0, y: 0, z: 3 },
    )
    const m = b.build()
    const uvAt = (i: number): [number, number] => [m.uvs[i * 2]!, m.uvs[i * 2 + 1]!]
    const bottom = uvAt(0) // (x=0, y=0, z=0)
    const top = uvAt(3) // (x=0, y=0, z=3) — directly above `bottom`
    // Moving straight up the wall must move the UV: the normal is mostly
    // +x, so U/V come from (y, z), and z changed even though x and y did not.
    expect(Math.abs(top[0] - bottom[0]) + Math.abs(top[1] - bottom[1])).toBeGreaterThan(0.1)
    expect(bottom).toEqual([0, 0])
    expect(top[1]).toBeCloseTo(3 / 4, 6)
  })

  it('averages both triangle normals for a non-planar quad, and keeps both triangles winding to agree with it', () => {
    const b = new MeshBuilder()
    // a, b, c lie in z=0; d is lifted well out of that plane. On a curve,
    // consecutive wall posts are exactly this: the two triangles making up
    // the panel are not coplanar, so (a,b,c)'s normal and (a,c,d)'s normal
    // genuinely diverge.
    b.addQuad(
      { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 3 },
    )
    const m = b.build()
    // Every vertex of the quad must carry the same (averaged) normal.
    const n0 = [m.normals[0]!, m.normals[1]!, m.normals[2]!]
    for (let i = 1; i < m.vertexCount; i++) {
      expect(m.normals[i * 3]).toBeCloseTo(n0[0]!, 6)
      expect(m.normals[i * 3 + 1]).toBeCloseTo(n0[1]!, 6)
      expect(m.normals[i * 3 + 2]).toBeCloseTo(n0[2]!, 6)
    }
    // Both triangles' true (actual-geometry) normals must still agree in
    // direction with the stored, averaged normal.
    for (let t = 0; t < m.indices.length; t += 3) {
      const [i, j, k] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!]
      const ax = m.positions[i * 3]!, ay = m.positions[i * 3 + 1]!, az = m.positions[i * 3 + 2]!
      const ux = m.positions[j * 3]! - ax, uy = m.positions[j * 3 + 1]! - ay, uz = m.positions[j * 3 + 2]! - az
      const vx = m.positions[k * 3]! - ax, vy = m.positions[k * 3 + 1]! - ay, vz = m.positions[k * 3 + 2]! - az
      const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx
      const dot = fx * m.normals[i * 3]! + fy * m.normals[i * 3 + 1]! + fz * m.normals[i * 3 + 2]!
      expect(dot).toBeGreaterThan(0)
    }
  })

  it('tessellates a concave quad as a fan, not a strip', () => {
    const b = new MeshBuilder()
    // A concave ("dart") planar quad, CCW: c is pulled in near the a-d edge,
    // making it a reflex vertex. For a convex quad, fan tessellation
    // (a,b,c),(a,c,d) and strip tessellation (a,b,c),(b,c,d) give identical
    // winding, counts and total area — indistinguishable by any test that
    // only checks those. Only a concave quad tells them apart: the fan
    // covers the whole quad; the strip's second triangle (b,c,d) does not,
    // and even winds the opposite way.
    b.addQuad(
      { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 0, y: 4, z: 0 },
    )
    const m = b.build()
    // First triangle is always (a, b, c).
    expect(Array.from(m.indices.slice(0, 3))).toEqual([0, 1, 2])
    // Second triangle must be the fan diagonal (a, c, d) = (base, base+2,
    // base+3), not the strip diagonal (b, c, d) = (base+1, base+2, base+3).
    expect(Array.from(m.indices.slice(3, 6))).toEqual([0, 2, 3])
  })
})
