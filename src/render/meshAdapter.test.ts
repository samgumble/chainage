import { describe, it, expect } from 'vitest'
import { toBufferGeometry } from './meshAdapter'
import type { MeshData } from '../mesh/ribbon'

const mesh = (): MeshData => ({
  positions: new Float32Array([1, 2, 3, 4, 5, 6]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 0, 1, 1]),
  indices: new Uint32Array([0, 1, 0]),
  vertexCount: 2,
  triangleCount: 1,
})

describe('toBufferGeometry', () => {
  it('maps plan (x, y, z) to three (x, z, -y)', () => {
    const g = toBufferGeometry(mesh())
    const p = g.getAttribute('position').array
    // (1, 2, 3) -> (1, 3, -2)
    expect(p[0]).toBeCloseTo(1, 5)
    expect(p[1]).toBeCloseTo(3, 5)
    expect(p[2]).toBeCloseTo(-2, 5)
    // (4, 5, 6) -> (4, 6, -5)
    expect(p[3]).toBeCloseTo(4, 5)
    expect(p[4]).toBeCloseTo(6, 5)
    expect(p[5]).toBeCloseTo(-5, 5)
  })

  it('applies the same mapping to normals', () => {
    const g = toBufferGeometry(mesh())
    const n = g.getAttribute('normal').array
    // Plan-up (0, 0, 1) becomes three-up (0, 1, 0).
    expect(n[0]).toBeCloseTo(0, 5)
    expect(n[1]).toBeCloseTo(1, 5)
    expect(n[2]).toBeCloseTo(0, 5)
  })

  it('carries uvs through unchanged', () => {
    const g = toBufferGeometry(mesh())
    const uv = g.getAttribute('uv').array
    expect(Array.from(uv)).toEqual([0, 0, 1, 1])
  })

  it('carries indices through unchanged', () => {
    const g = toBufferGeometry(mesh())
    expect(Array.from(g.getIndex()!.array)).toEqual([0, 1, 0])
  })

  it('handles an empty mesh without throwing', () => {
    const empty: MeshData = {
      positions: new Float32Array(0), normals: new Float32Array(0),
      uvs: new Float32Array(0), indices: new Uint32Array(0),
      vertexCount: 0, triangleCount: 0,
    }
    const g = toBufferGeometry(empty)
    expect(g.getAttribute('position').count).toBe(0)
  })
})
