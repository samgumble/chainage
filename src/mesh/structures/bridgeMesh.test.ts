import { describe, it, expect } from 'vitest'
import { buildBridgeMesh, DECK_DEPTH, PIER_SPACING, supportStations } from './bridgeMesh'
import { Alignment } from '../../geometry/alignment'
import { Line } from '../../geometry/primitives'
import { vec2 } from '../../geometry/vec2'
import { Heightmap } from '../../terrain/heightmap'
import type { ProfilePoint } from '../../terrain/groundProfile'
import type { StructureSpan } from './spans'

const road = (length: number) => new Alignment([new Line(vec2(0, 0), 0, length)])
const level = (length: number, z: number): ProfilePoint[] => [{ s: 0, z }, { s: length, z }]
const flat = (z: number) => Heightmap.flat(-500, -500, 50, 41, 41, z)

const span = (from: number, to: number, maxHeight: number): StructureSpan => ({
  fromStation: from, toStation: to, maxHeight,
})

const zRange = (m: { positions: Float32Array; vertexCount: number }) => {
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < m.vertexCount; i++) {
    const z = m.positions[i * 3 + 2]!
    lo = Math.min(lo, z); hi = Math.max(hi, z)
  }
  return { lo, hi }
}

/**
 * Signed volume of a triangle mesh via the divergence theorem:
 * V = (1/6) * sum over triangles of a . (b x c).
 *
 * Positive for a closed solid with outward-facing normals; negative if the
 * solid is inside-out. This is independent of the winding-vs-stored-normal
 * check in MeshBuilder, which derives a face's normal from its own winding
 * and so cannot detect a uniformly inverted shape.
 */
const signedVolume = (m: { positions: Float32Array; indices: Uint32Array }): number => {
  let volume = 0
  for (let t = 0; t < m.indices.length; t += 3) {
    const i = m.indices[t]!, j = m.indices[t + 1]!, k = m.indices[t + 2]!
    const ax = m.positions[i * 3]!, ay = m.positions[i * 3 + 1]!, az = m.positions[i * 3 + 2]!
    const bx = m.positions[j * 3]!, by = m.positions[j * 3 + 1]!, bz = m.positions[j * 3 + 2]!
    const cx = m.positions[k * 3]!, cy = m.positions[k * 3 + 1]!, cz = m.positions[k * 3 + 2]!
    const crossX = by * cz - bz * cy
    const crossY = bz * cx - bx * cz
    const crossZ = bx * cy - by * cx
    volume += ax * crossX + ay * crossY + az * crossZ
  }
  return volume / 6
}

describe('buildBridgeMesh', () => {
  it('produces geometry for a span', () => {
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(50, 150, 40), 5)
    expect(m.vertexCount).toBeGreaterThan(0)
    expect(m.triangleCount).toBeGreaterThan(0)
  })

  it('returns an empty mesh for a zero-length span', () => {
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(80, 80, 40), 5)
    expect(m.vertexCount).toBe(0)
  })

  it('keeps the deck below the design elevation', () => {
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(50, 150, 40), 5)
    expect(zRange(m).hi).toBeLessThan(100)
  })

  it('reaches down to the ground', () => {
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(50, 150, 40), 5)
    expect(zRange(m).lo).toBeCloseTo(60, 0)
  })

  it('makes a taller structure over deeper ground', () => {
    const shallow = buildBridgeMesh(road(200), flat(90), level(200, 100), span(50, 150, 10), 5)
    const deep = buildBridgeMesh(road(200), flat(50), level(200, 100), span(50, 150, 50), 5)
    const height = (m: ReturnType<typeof buildBridgeMesh>) => {
      const r = zRange(m)
      return r.hi - r.lo
    }
    expect(height(deep)).toBeGreaterThan(height(shallow))
  })

  it('gives the deck the requested depth', () => {
    const m = buildBridgeMesh(road(200), flat(99), level(200, 100), span(50, 150, 1), 5, {
      pierSpacing: 1000,
    })
    // Ground almost at design, so the whole structure is essentially the deck.
    const r = zRange(m)
    expect(r.hi - r.lo).toBeGreaterThanOrEqual(DECK_DEPTH - 0.5)
  })

  it('adds more piers to a longer span', () => {
    const shortSpan = buildBridgeMesh(road(400), flat(60), level(400, 100), span(50, 90, 40), 5)
    const longSpan = buildBridgeMesh(road(400), flat(60), level(400, 100), span(50, 350, 40), 5)
    expect(longSpan.vertexCount).toBeGreaterThan(shortSpan.vertexCount)
  })

  it('places no pier when the span is shorter than the pier spacing', () => {
    const withPiers = buildBridgeMesh(road(400), flat(60), level(400, 100), span(50, 350, 40), 5)
    const withoutPiers = buildBridgeMesh(
      road(400), flat(60), level(400, 100), span(50, 350, 40), 5, { pierSpacing: 10000 },
    )
    expect(withoutPiers.vertexCount).toBeLessThan(withPiers.vertexCount)
  })

  it('spans the full road width', () => {
    const halfWidth = 7
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(50, 150, 40), halfWidth)
    let widest = 0
    for (let i = 0; i < m.vertexCount; i++) {
      widest = Math.max(widest, Math.abs(m.positions[i * 3 + 1]!))
    }
    expect(widest).toBeCloseTo(halfWidth, 4)
  })

  it('stays within the span stations', () => {
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(50, 150, 40), 5)
    for (let i = 0; i < m.vertexCount; i++) {
      const x = m.positions[i * 3]!
      expect(x).toBeGreaterThanOrEqual(50 - 1e-4)
      expect(x).toBeLessThanOrEqual(150 + 1e-4)
    }
  })

  it('gives unit-length normals', () => {
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(50, 150, 40), 5)
    for (let i = 0; i < m.vertexCount; i++) {
      const len = Math.hypot(m.normals[i * 3]!, m.normals[i * 3 + 1]!, m.normals[i * 3 + 2]!)
      expect(len).toBeCloseTo(1, 4)
    }
  })

  it('winds every triangle to agree with its normal', () => {
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(50, 150, 40), 5)
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

  it('exports sane defaults', () => {
    expect(DECK_DEPTH).toBeGreaterThan(0)
    expect(PIER_SPACING).toBeGreaterThan(DECK_DEPTH)
  })

  // Signed-volume checks: a winding-vs-normal test (see above) is true by
  // construction in MeshBuilder and cannot catch a uniformly inverted solid.
  // A short span over deep ground makes the abutment/pier boxes dominate the
  // mesh, so the sign of the divergence-theorem volume is unambiguous even
  // though the deck itself is an open surface with no meaningful volume.

  it('has positive signed volume for an abutments-only bridge', () => {
    const m = buildBridgeMesh(road(200), flat(10), level(200, 100), span(90, 110, 90), 5, {
      pierSpacing: 1000, // longer than the span, so only abutments are placed
    })
    expect(signedVolume(m)).toBeGreaterThan(0)
  })

  it('has positive signed volume for a bridge with piers', () => {
    const m = buildBridgeMesh(road(200), flat(10), level(200, 100), span(50, 150, 90), 5, {
      pierSpacing: 25,
    })
    expect(signedVolume(m)).toBeGreaterThan(0)
  })

  describe('supportStations', () => {
    it('places piers at exactly the requested spacing for 100m at 25m', () => {
      const stations = supportStations(0, 100, 25)
      // 2 abutments + 3 piers, at 25m gaps: 0, 25, 50, 75, 100.
      expect(stations).toHaveLength(5)
      const sorted = [...stations].sort((a, b) => a - b)
      expect(sorted).toEqual([0, 25, 50, 75, 100])
    })

    it('never places a pier on a span end', () => {
      for (const spacing of [5, 10, 17, 25, 33, 50]) {
        const stations = supportStations(0, 100, spacing)
        for (const s of stations.slice(2)) {
          expect(s).toBeGreaterThan(0)
          expect(s).toBeLessThan(100)
        }
      }
    })
  })
})
