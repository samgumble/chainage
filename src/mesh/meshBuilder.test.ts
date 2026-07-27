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
})
