import { describe, it, expect } from 'vitest'
import { buildBridgeMesh, DECK_DEPTH, PIER_SPACING } from './bridgeMesh'
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
})
