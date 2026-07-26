import { describe, it, expect } from 'vitest'
import { sweepRibbon } from './ribbon'
import { Alignment } from '../geometry/alignment'
import { Line, Arc } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import type { ProfilePoint } from '../terrain/groundProfile'
import type { SectionPoint } from './crossSection'

/** A flat 10m-wide section: three points, no crossfall. */
const flatSection: SectionPoint[] = [
  { offset: -5, dz: 0 },
  { offset: 0, dz: 0 },
  { offset: 5, dz: 0 },
]

const straight = (length: number) => new Alignment([new Line(vec2(0, 0), 0, length)])

/** A level design profile at a constant elevation. */
const level = (length: number, z: number, step = 10): ProfilePoint[] => {
  const points: ProfilePoint[] = []
  for (let s = 0; s < length; s += step) points.push({ s, z })
  points.push({ s: length, z })
  return points
}

describe('sweepRibbon geometry', () => {
  it('emits one vertex per section point per station', () => {
    const m = sweepRibbon(straight(100), level(100, 50), flatSection, { spacing: 25 })
    // 25m spacing over 100m gives 5 stations; 3 section points each.
    expect(m.vertexCount).toBe(15)
    expect(m.positions).toHaveLength(45)
  })

  it('emits two triangles per quad', () => {
    const m = sweepRibbon(straight(100), level(100, 50), flatSection, { spacing: 25 })
    // 4 spans x 2 section gaps x 2 triangles.
    expect(m.triangleCount).toBe(16)
    expect(m.indices).toHaveLength(48)
  })

  it('places vertices at the design elevation plus the section dz', () => {
    const m = sweepRibbon(straight(100), level(100, 50), flatSection, { spacing: 50 })
    // First vertex is the left edge at station 0: x=0, y=+5 (left of +x heading), z=50.
    expect(m.positions[0]).toBeCloseTo(0, 4)
    expect(m.positions[1]).toBeCloseTo(5, 4)
    expect(m.positions[2]).toBeCloseTo(50, 4)
  })

  it('offsets transversely, perpendicular to the alignment', () => {
    const m = sweepRibbon(straight(100), level(100, 50), flatSection, { spacing: 100 })
    // Station 0 with a +x heading: left is +y, right is -y.
    expect(m.positions[1]).toBeCloseTo(5, 4)    // left edge
    expect(m.positions[7]).toBeCloseTo(-5, 4)   // right edge
  })

  it('applies section dz relative to the design elevation', () => {
    const sloped: SectionPoint[] = [
      { offset: -5, dz: -0.125 },
      { offset: 0, dz: 0 },
      { offset: 5, dz: -0.125 },
    ]
    const m = sweepRibbon(straight(100), level(100, 50), sloped, { spacing: 100 })
    expect(m.positions[2]).toBeCloseTo(49.875, 4)   // left edge is lower
    expect(m.positions[5]).toBeCloseTo(50, 4)       // crown is at design
  })

  it('follows a rising design profile', () => {
    const rising: ProfilePoint[] = [{ s: 0, z: 100 }, { s: 100, z: 110 }]
    const m = sweepRibbon(straight(100), rising, flatSection, { spacing: 50 })
    // Crown vertices are index 1, 4, 7 -> z at components 5, 14, 23.
    expect(m.positions[5]).toBeCloseTo(100, 4)
    expect(m.positions[14]).toBeCloseTo(105, 4)
    expect(m.positions[23]).toBeCloseTo(110, 4)
  })

  it('produces upward-facing normals on a level road', () => {
    const m = sweepRibbon(straight(100), level(100, 50), flatSection, { spacing: 50 })
    for (let i = 0; i < m.vertexCount; i++) {
      expect(m.normals[i * 3 + 2]).toBeGreaterThan(0.99)
    }
  })

  it('produces unit-length normals', () => {
    const curve = new Alignment([new Arc(vec2(0, 0), 0, 200, 1 / 150)])
    const m = sweepRibbon(curve, level(200, 50), flatSection, { spacing: 10 })
    for (let i = 0; i < m.vertexCount; i++) {
      const len = Math.hypot(
        m.normals[i * 3]!, m.normals[i * 3 + 1]!, m.normals[i * 3 + 2]!,
      )
      expect(len).toBeCloseTo(1, 4)
    }
  })
})

describe('sweepRibbon winding', () => {
  /**
   * For every triangle, the face normal computed from vertex *positions*
   * ((v1-v0) x (v2-v0)) must agree with the stored vertex *normal* at v0.
   * The normals array is built independently of the index array, so this is
   * the only check that ties winding to the normals it is supposed to match
   * — a backwards index order (front face pointing down) would sail through
   * every other test in this file while rendering the road inside-out.
   */
  const expectWindingMatchesNormals = (m: ReturnType<typeof sweepRibbon>) => {
    for (let i = 0; i < m.indices.length; i += 3) {
      const i0 = m.indices[i]!
      const i1 = m.indices[i + 1]!
      const i2 = m.indices[i + 2]!

      const v0x = m.positions[i0 * 3]!, v0y = m.positions[i0 * 3 + 1]!, v0z = m.positions[i0 * 3 + 2]!
      const v1x = m.positions[i1 * 3]!, v1y = m.positions[i1 * 3 + 1]!, v1z = m.positions[i1 * 3 + 2]!
      const v2x = m.positions[i2 * 3]!, v2y = m.positions[i2 * 3 + 1]!, v2z = m.positions[i2 * 3 + 2]!

      const ex = v1x - v0x, ey = v1y - v0y, ez = v1z - v0z
      const fx = v2x - v0x, fy = v2y - v0y, fz = v2z - v0z

      const nx = ey * fz - ez * fy
      const ny = ez * fx - ex * fz
      const nz = ex * fy - ey * fx

      const dot = nx * m.normals[i0 * 3]! + ny * m.normals[i0 * 3 + 1]! + nz * m.normals[i0 * 3 + 2]!
      expect(dot).toBeGreaterThan(0)
    }
  }

  it('winds triangles so the face normal agrees with the vertex normal on a straight road', () => {
    const m = sweepRibbon(straight(100), level(100, 50), flatSection, { spacing: 20 })
    expectWindingMatchesNormals(m)
  })

  it('winds triangles so the face normal agrees with the vertex normal through a curve', () => {
    const curve = new Alignment([new Arc(vec2(0, 0), 0, 200, 1 / 150)])
    const m = sweepRibbon(curve, level(200, 50), flatSection, { spacing: 10 })
    expectWindingMatchesNormals(m)
  })
})

describe('sweepRibbon station range', () => {
  it('builds only the requested range', () => {
    const full = sweepRibbon(straight(100), level(100, 50), flatSection, { spacing: 25 })
    const half = sweepRibbon(straight(100), level(100, 50), flatSection, {
      spacing: 25, endStation: 50,
    })
    expect(half.vertexCount).toBeLessThan(full.vertexCount)
  })

  it('starts the range where asked', () => {
    const m = sweepRibbon(straight(100), level(100, 50), flatSection, {
      spacing: 50, startStation: 50,
    })
    // First crown vertex sits at x=50, not x=0.
    expect(m.positions[3]).toBeCloseTo(50, 4)
  })

  it('always includes the final station of the range', () => {
    const m = sweepRibbon(straight(100), level(100, 50), flatSection, {
      spacing: 30, endStation: 100,
    })
    const lastCrownX = m.positions[(m.vertexCount - 2) * 3]!
    expect(lastCrownX).toBeCloseTo(100, 4)
  })

  it('returns an empty mesh for a zero-length range', () => {
    const m = sweepRibbon(straight(100), level(100, 50), flatSection, {
      startStation: 40, endStation: 40,
    })
    expect(m.vertexCount).toBe(0)
    expect(m.triangleCount).toBe(0)
    expect(m.positions).toHaveLength(0)
    expect(m.indices).toHaveLength(0)
  })

  it('clamps a range beyond the alignment', () => {
    const m = sweepRibbon(straight(100), level(100, 50), flatSection, {
      spacing: 50, endStation: 999,
    })
    const lastCrownX = m.positions[(m.vertexCount - 2) * 3]!
    expect(lastCrownX).toBeCloseTo(100, 4)
  })
})

describe('sweepRibbon validation', () => {
  it('rejects a section with fewer than two points', () => {
    expect(() => sweepRibbon(straight(100), level(100, 50), [{ offset: 0, dz: 0 }]))
      .toThrow(RangeError)
  })

  it('rejects non-positive spacing', () => {
    expect(() => sweepRibbon(straight(100), level(100, 50), flatSection, { spacing: 0 }))
      .toThrow(RangeError)
  })

  it('rejects an inverted station range', () => {
    expect(() => sweepRibbon(straight(100), level(100, 50), flatSection, {
      startStation: 80, endStation: 20,
    })).toThrow(RangeError)
  })

  it('rejects non-positive uvTileLength', () => {
    expect(() => sweepRibbon(straight(100), level(100, 50), flatSection, { uvTileLength: 0 }))
      .toThrow(RangeError)
    expect(() => sweepRibbon(straight(100), level(100, 50), flatSection, { uvTileLength: -5 }))
      .toThrow(RangeError)
  })
})

describe('sweepRibbon station tolerance', () => {
  it('does not append a near-duplicate final station from floating-point noise', () => {
    // 100 / 3 * 3 lands a hair off 100 in floating point; the range should
    // still end in exactly one final station at 100, not a sliver on top.
    const m = sweepRibbon(straight(100), level(100, 50), flatSection, { spacing: 100 / 3 })
    const stationCount = m.vertexCount / flatSection.length
    // 3 steps of ~33.33 plus a snapped-to-100 final station: 4 stations total,
    // not 5 (which a strict `<` comparison would produce from the fp residue).
    expect(stationCount).toBe(4)

    const lastCrownX = m.positions[(m.vertexCount - 2) * 3]!
    expect(lastCrownX).toBeCloseTo(100, 4)
  })
})
