import { describe, it, expect } from 'vitest'
import { wallSegments, buildRetainingWallMesh, type WallSegment } from './retainingWallMesh'
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

  // Handcrafted segments rather than `wallSegments()` output — these two
  // tests are about the join logic in `buildRetainingWallMesh` alone, not
  // about when `wallSegments`/networkMesh decide a wall is needed.
  describe('station gaps', () => {
    // A straight, heading-0 Line starting at the origin: `poseAt(s).position`
    // is `(s, 0)` and `leftNormal` for heading 0 is `(0, 1)`, so every
    // vertex's x-coordinate is exactly the station of the segment it came
    // from — which is what lets the assertions below check adjacency
    // directly off the emitted geometry instead of trusting a triangle count.
    const straight = road(1000)

    const seg = (s: number, side: 'left' | 'right'): WallSegment => ({
      s,
      side,
      offset: side === 'left' ? -5 : 5,
      topZ: 10,
      bottomZ: 3,
    })

    // The station any vertex came from, recovered from its x-coordinate.
    const stationOf = (m: ReturnType<typeof buildRetainingWallMesh>, vertex: number): number =>
      m.positions[vertex * 3]!

    it('does not join two segments separated by a station gap', () => {
      // Segments at stations 100, 105, 110 — then 300, 305, 310. Spacing
      // within each run is 5m, so the 110 -> 300 jump is a 190m gap, not an
      // adjacency, even though the two runs are consecutive entries once
      // sorted by station.
      const stations = [100, 105, 110, 300, 305, 310]
      const segments: WallSegment[] = stations.flatMap((s) => [seg(s, 'left'), seg(s, 'right')])
      const mesh = buildRetainingWallMesh(straight, segments)

      // The two small runs must still produce panels — this is not "does
      // the whole thing come out empty", it is specifically "is the 190m
      // gap absent from the geometry".
      expect(mesh.triangleCount).toBeGreaterThan(0)

      // Assert on the geometry itself, not a triangle/quad count a wrong
      // implementation could equally satisfy: no triangle may join two
      // vertices whose source stations are more than one nominal step (5m)
      // apart. A triangle spanning the 190m gap would blow this bound by
      // nearly 40x and is exactly the defect under test.
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const stationsOfTri = [0, 1, 2].map((k) => stationOf(mesh, mesh.indices[t + k]!))
        const spread = Math.max(...stationsOfTri) - Math.min(...stationsOfTri)
        expect(spread).toBeLessThanOrEqual(5 + 1e-6)
      }
    })

    it('still joins genuinely adjacent segments into one panel', () => {
      // Segments at 100, 105, 110 with no gap must remain a single
      // continuous panel — the fix must not shatter every wall into
      // per-segment quads, which is the failure mode a naive "never join"
      // change would produce while still passing the test above.
      const stations = [100, 105, 110]
      const segments: WallSegment[] = stations.flatMap((s) => [seg(s, 'left'), seg(s, 'right')])
      const mesh = buildRetainingWallMesh(straight, segments)

      expect(mesh.triangleCount).toBeGreaterThan(0)

      // Structural continuity, not a count: every triangle must still
      // respect the one-step bound (as above)...
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const stationsOfTri = [0, 1, 2].map((k) => stationOf(mesh, mesh.indices[t + k]!))
        const spread = Math.max(...stationsOfTri) - Math.min(...stationsOfTri)
        expect(spread).toBeLessThanOrEqual(5 + 1e-6)
      }

      // ...and the geometry must actually reach both ends of the run — if
      // the 105 -> 110 step were wrongly rejected alongside a genuine gap,
      // the mesh would stop at station 105 rather than covering 100 to 110.
      const allStations = Array.from({ length: mesh.vertexCount }, (_, i) => stationOf(mesh, i))
      expect(Math.min(...allStations)).toBeCloseTo(100, 6)
      expect(Math.max(...allStations)).toBeCloseTo(110, 6)
    })
  })
})
