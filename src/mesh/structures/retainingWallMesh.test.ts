import { describe, it, expect } from 'vitest'
import { wallSegments, buildRetainingWallMesh } from './retainingWallMesh'
import { Alignment } from '../../geometry/alignment'
import { Line, Arc } from '../../geometry/primitives'
import { vec2 } from '../../geometry/vec2'
import { Heightmap } from '../../terrain/heightmap'
import type { ProfilePoint } from '../../terrain/groundProfile'
import { retainingWall, type CorridorTemplate } from '../../terrain/corridor'

const road = (length: number) => new Alignment([new Line(vec2(0, 0), 0, length)])
const level = (length: number, z: number): ProfilePoint[] => [{ s: 0, z }, { s: length, z }]
const flat = (z: number) => Heightmap.flat(-500, -500, 50, 41, 41, z)

/** Batters capped at 1m, so anything deeper than 0.5m needs a wall at 2H:1V. */
const walled: CorridorTemplate = {
  formationHalfWidth: 5, cutSlope: 2, fillSlope: 3, maxBatterWidth: 1,
}
const unwalled: CorridorTemplate = { formationHalfWidth: 5, cutSlope: 2, fillSlope: 3 }

describe('wallSegments', () => {
  it('finds no wall where the batter has room', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 98), unwalled, 25)
    expect(segments).toHaveLength(0)
  })

  it('finds no wall where the design sits on the ground', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 100), walled, 25)
    expect(segments).toHaveLength(0)
  })

  it('finds walls on both sides of a constrained cut', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 95), walled, 25)
    expect(segments.filter((w) => w.side === 'left').length).toBeGreaterThan(0)
    expect(segments.filter((w) => w.side === 'right').length).toBeGreaterThan(0)
  })

  it('places the two sides at mirrored offsets', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 95), walled, 50)
    const left = segments.find((w) => w.side === 'left')!
    const right = segments.find((w) => w.side === 'right')!
    expect(left.offset).toBeCloseTo(-right.offset, 6)
  })

  it('puts the wall top above its bottom', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 95), walled, 25)
    for (const w of segments) expect(w.topZ).toBeGreaterThan(w.bottomZ)
  })

  it('makes the wall taller for a deeper cut', () => {
    const shallow = wallSegments(road(100), flat(100), level(100, 98.5), walled, 50)
    const deep = wallSegments(road(100), flat(100), level(100, 94), walled, 50)
    const height = (ws: { topZ: number; bottomZ: number }[]) =>
      Math.max(...ws.map((w) => w.topZ - w.bottomZ))
    expect(height(deep)).toBeGreaterThan(height(shallow))
  })

  it('ignores a wall below the minimum height', () => {
    // A 0.6m cut at 2H:1V needs 1.2m of batter; 1m is allowed, so the wall is
    // 0.6 - 1/2 = 0.1m — a kerb, not a wall.
    const segments = wallSegments(road(100), flat(100), level(100, 99.4), walled, 25)
    expect(segments).toHaveLength(0)
  })

  it('records the station of each segment', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 95), walled, 50)
    const stations = [...new Set(segments.map((w) => w.s))].sort((a, b) => a - b)
    expect(stations[0]).toBeCloseTo(0, 6)
    expect(stations[stations.length - 1]).toBeCloseTo(100, 6)
  })

  it('finds walls in fill as well as cut', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 105), walled, 25)
    expect(segments.length).toBeGreaterThan(0)
  })
})

describe('wallSegments elevations', () => {
  // Same template drives both cases below: formationHalfWidth 5, cutSlope
  // 2H:1V, fillSlope 3H:1V, batters truncated at 4m.
  const template: CorridorTemplate = {
    formationHalfWidth: 5, cutSlope: 2, fillSlope: 3, maxBatterWidth: 4,
  }

  it('spans from the truncated batter end up to natural ground in cut', () => {
    // Ground 105, design 100: the batter runs the full 4m allowed at 2H:1V,
    // rising 2m from the design surface to z=102. The wall then holds the
    // remaining 3m up to natural ground at 105, so the wall spans [102, 105].
    const wall = retainingWall(100, 105, template)!
    expect(wall).toEqual({ offset: 9, height: 3 })

    const segments = wallSegments(road(100), flat(105), level(100, 100), template, 25)
    expect(segments.length).toBeGreaterThan(0)
    for (const w of segments) {
      expect(w.bottomZ).toBeCloseTo(102, 6)
      expect(w.topZ).toBeCloseTo(105, 6)
      // Height agreement: the recorded span must match what retainingWall reports.
      expect(w.topZ - w.bottomZ).toBeCloseTo(wall.height, 6)
      // The wall must actually reach natural ground on one side or the other.
      expect(Math.min(Math.abs(w.topZ - 105), Math.abs(w.bottomZ - 105))).toBeLessThan(1e-6)
    }
  })

  it('spans from natural ground up to the truncated batter end in fill', () => {
    // Ground 97, design 100: the batter runs the full 4m allowed at 3H:1V,
    // dropping 4/3 m from the design surface to z=100-4/3=98.6667. The wall
    // then holds the remaining depth down to natural ground at 97, so the
    // wall spans [97, 98.6667].
    const wall = retainingWall(100, 97, template)!
    expect(wall.offset).toBeCloseTo(9, 6)
    expect(wall.height).toBeCloseTo(5 / 3, 6) // depth 3, minus 4/3 of batter

    const expectedBatterEnd = 100 - 4 / 3
    const segments = wallSegments(road(100), flat(97), level(100, 100), template, 25)
    expect(segments.length).toBeGreaterThan(0)
    for (const w of segments) {
      expect(w.bottomZ).toBeCloseTo(97, 6)
      expect(w.topZ).toBeCloseTo(expectedBatterEnd, 6)
      // Height agreement: the recorded span must match what retainingWall reports.
      expect(w.topZ - w.bottomZ).toBeCloseTo(wall.height, 6)
      // The wall must actually reach natural ground on one side or the other.
      expect(Math.min(Math.abs(w.topZ - 97), Math.abs(w.bottomZ - 97))).toBeLessThan(1e-6)
    }
  })
})

describe('buildRetainingWallMesh', () => {
  it('returns an empty mesh with no segments', () => {
    const m = buildRetainingWallMesh(road(100), [])
    expect(m.vertexCount).toBe(0)
    expect(m.triangleCount).toBe(0)
  })

  it('returns an empty mesh with a single segment per side', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 95), walled, 1000)
    const m = buildRetainingWallMesh(road(100), segments)
    expect(m.triangleCount).toBe(0)
  })

  it('emits panels between consecutive segments', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 95), walled, 25)
    const m = buildRetainingWallMesh(road(100), segments)
    expect(m.triangleCount).toBeGreaterThan(0)
  })

  it('places wall vertices between the recorded top and bottom', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 95), walled, 25)
    const lowest = Math.min(...segments.map((w) => w.bottomZ))
    const highest = Math.max(...segments.map((w) => w.topZ))
    const m = buildRetainingWallMesh(road(100), segments)
    for (let i = 0; i < m.vertexCount; i++) {
      const z = m.positions[i * 3 + 2]!
      expect(z).toBeGreaterThanOrEqual(lowest - 1e-6)
      expect(z).toBeLessThanOrEqual(highest + 1e-6)
    }
  })

  it('gives every panel a roughly horizontal normal', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 95), walled, 25)
    const m = buildRetainingWallMesh(road(100), segments)
    for (let i = 0; i < m.vertexCount; i++) {
      expect(Math.abs(m.normals[i * 3 + 2]!)).toBeLessThan(0.2)
    }
  })

  it('winds every triangle to agree with its normal', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 95), walled, 25)
    const m = buildRetainingWallMesh(road(100), segments)
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

  it('rejects non-positive spacing', () => {
    expect(() => wallSegments(road(100), flat(100), level(100, 95), walled, 0)).toThrow(RangeError)
  })

  it('winds every triangle to agree with its normal on a curved alignment', () => {
    // Straight fixtures make every wall quad planar by construction, so this
    // is the only test exercising MeshBuilder.addQuad's normal averaging for
    // a genuinely non-planar quad.
    const curved = new Alignment([new Arc(vec2(0, 0), 0, 100, 0.01)])
    const segments = wallSegments(curved, flat(100), level(100, 95), walled, 10)
    const m = buildRetainingWallMesh(curved, segments)
    expect(m.triangleCount).toBeGreaterThan(0)
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
})
