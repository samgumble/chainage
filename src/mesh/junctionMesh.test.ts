import { describe, it, expect } from 'vitest'
import { buildJunctionMesh } from './junctionMesh'
import { solveJunction } from './junctionCorners'
import type { JunctionLeg } from './junctionLegs'
import type { JunctionGeometry } from './junctionCorners'
import type { MeshData } from './ribbon'
import { vec2, fromAngle } from '../geometry/vec2'

const legsAt = (bearingsDeg: number[], halfWidth = 5): JunctionLeg[] =>
  bearingsDeg
    .map((deg, i) => {
      const bearing = (deg * Math.PI) / 180
      return {
        roadId: i, end: 'start' as const,
        direction: fromAngle(bearing), halfWidth, bearing,
      }
    })
    .sort((a, b) => a.bearing - b.bearing)

const crossroads = () => {
  const legs = legsAt([0, 90, 180, -90])
  return { legs, geometry: solveJunction(legs) }
}

/** Check that every triangle in a mesh is wound counter-clockwise with positive signed area. */
const assertAllTrianglesWindCCW = (m: MeshData) => {
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t]!, b = m.indices[t + 1]!, c = m.indices[t + 2]!
    const ax = m.positions[a * 3]!, ay = m.positions[a * 3 + 1]!
    const bx = m.positions[b * 3]!, by = m.positions[b * 3 + 1]!
    const cx = m.positions[c * 3]!, cy = m.positions[c * 3 + 1]!
    // Signed area of the triangle in plan; positive means counter-clockwise,
    // which with an upward normal is a front face.
    const twiceArea = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    expect(twiceArea).toBeGreaterThan(0)
  }
}

describe('buildJunctionMesh', () => {
  it('collapses a square crossroads to its four corners', () => {
    // Every leg's trimmed edge point coincides with the corner that set its
    // trim, so the polygon is genuinely just the four corners plus the centre.
    const { legs, geometry } = crossroads()
    const m = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    expect(m.vertexCount).toBe(1 + 4)
  })

  it('emits one triangle per boundary edge', () => {
    const { legs, geometry } = crossroads()
    const m = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    expect(m.triangleCount).toBe(m.vertexCount - 1)
  })

  it('leaves no degenerate triangle in the fan', () => {
    const { legs, geometry } = crossroads()
    const m = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    for (let t = 0; t < m.indices.length; t += 3) {
      const a = m.indices[t]!, b = m.indices[t + 1]!, c = m.indices[t + 2]!
      const twiceArea =
        (m.positions[b * 3]! - m.positions[a * 3]!) * (m.positions[c * 3 + 1]! - m.positions[a * 3 + 1]!) -
        (m.positions[b * 3 + 1]! - m.positions[a * 3 + 1]!) * (m.positions[c * 3]! - m.positions[a * 3]!)
      expect(Math.abs(twiceArea)).toBeGreaterThan(1e-6)
    }
  })

  it('places the centre vertex at the node', () => {
    const { legs, geometry } = crossroads()
    const m = buildJunctionMesh(vec2(120, -40), 50, legs, geometry)
    expect(m.positions[0]).toBeCloseTo(120, 6)
    expect(m.positions[1]).toBeCloseTo(-40, 6)
    expect(m.positions[2]).toBeCloseTo(50, 6)
  })

  it('puts every vertex at the given elevation', () => {
    const { legs, geometry } = crossroads()
    const m = buildJunctionMesh(vec2(0, 0), 87.5, legs, geometry)
    for (let i = 0; i < m.vertexCount; i++) {
      expect(m.positions[i * 3 + 2]).toBeCloseTo(87.5, 6)
    }
  })

  it('offsets the whole junction by the node position', () => {
    const { legs, geometry } = crossroads()
    const atOrigin = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    const moved = buildJunctionMesh(vec2(1000, 2000), 50, legs, geometry)
    for (let i = 0; i < atOrigin.vertexCount; i++) {
      expect(moved.positions[i * 3]! - atOrigin.positions[i * 3]!).toBeCloseTo(1000, 4)
      expect(moved.positions[i * 3 + 1]! - atOrigin.positions[i * 3 + 1]!).toBeCloseTo(2000, 4)
    }
  })

  it('points every normal up', () => {
    const { legs, geometry } = crossroads()
    const m = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    for (let i = 0; i < m.vertexCount; i++) {
      expect(m.normals[i * 3 + 2]).toBeCloseTo(1, 6)
    }
  })

  it('winds every triangle to agree with its normals on a symmetric square crossroads', () => {
    const { legs, geometry } = crossroads()
    const m = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    assertAllTrianglesWindCCW(m)
  })

  it('winds every triangle to agree with its normals on a T junction', () => {
    const legs = legsAt([180, 90, -90])
    const geometry = solveJunction(legs)
    const m = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    assertAllTrianglesWindCCW(m)
  })

  it('winds every triangle to agree with its normals on an asymmetric junction', () => {
    const legs = legsAt([0, 100, 210])
    const geometry = solveJunction(legs)
    const m = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    assertAllTrianglesWindCCW(m)
  })

  it('winds every triangle to agree with its normals on an unequal-width junction', () => {
    // Three legs with different half-widths at different bearings
    const bearingsDeg = [-90, 90, 180]
    const halfWidths = [4, 9, 5]
    const legs = bearingsDeg
      .map((deg, i) => {
        const bearing = (deg * Math.PI) / 180
        return {
          roadId: i, end: 'start' as const,
          direction: fromAngle(bearing), halfWidth: halfWidths[i]!, bearing,
        }
      })
      .sort((a, b) => a.bearing - b.bearing)
    const geometry = solveJunction(legs)
    const m = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    assertAllTrianglesWindCCW(m)
  })

  it('reaches at least the trim distance along each leg', () => {
    const { legs, geometry } = crossroads()
    expect(geometry.feasible).toBe(true)
    if (!geometry.feasible) return
    const m = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    let furthest = 0
    for (let i = 0; i < m.vertexCount; i++) {
      furthest = Math.max(furthest, Math.hypot(m.positions[i * 3]!, m.positions[i * 3 + 1]!))
    }
    expect(furthest).toBeGreaterThanOrEqual(Math.max(...geometry.trims) - 1e-6)
  })

  it('returns an empty mesh for infeasible geometry', () => {
    const legs = legsAt([0, 180])
    const geometry = solveJunction(legs)
    expect(geometry.feasible).toBe(false)
    const m = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    expect(m.vertexCount).toBe(0)
    expect(m.triangleCount).toBe(0)
    expect(m.positions).toHaveLength(0)
    expect(m.indices).toHaveLength(0)
  })

  it('collapses a T junction to five boundary points', () => {
    // Two arm ends plus the through road's straight outer side.
    const legs = legsAt([180, 90, -90])
    const geometry = solveJunction(legs)
    const m = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    expect(m.vertexCount).toBe(1 + 5)
    expect(m.triangleCount).toBe(5)
  })

  it('handles a five-leg junction without degenerate triangles', () => {
    const legs = legsAt([0, 72, 144, -144, -72])
    const geometry = solveJunction(legs)
    const m = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    expect(m.vertexCount).toBeGreaterThanOrEqual(1 + 5)
    for (let t = 0; t < m.indices.length; t += 3) {
      const a = m.indices[t]!, b = m.indices[t + 1]!, c = m.indices[t + 2]!
      const twiceArea =
        (m.positions[b * 3]! - m.positions[a * 3]!) * (m.positions[c * 3 + 1]! - m.positions[a * 3 + 1]!) -
        (m.positions[b * 3 + 1]! - m.positions[a * 3 + 1]!) * (m.positions[c * 3]! - m.positions[a * 3]!)
      expect(Math.abs(twiceArea)).toBeGreaterThan(1e-6)
    }
  })

  it('returns an empty mesh when boundary collapses below three points', () => {
    // Hand-constructed geometry where all trimmed edge points and corners
    // collapse to a single point after deduplication.
    // With tiny halfWidths (1e-7) and zero trims, all right/left edge points
    // cluster at the origin within BOUNDARY_TOLERANCE. All corners at the same
    // location also cluster there. Result: 1 unique point after dedup, < 3.
    const bearingsDeg = [-90, 90, 180]
    const legs = bearingsDeg
      .map((deg, i) => {
        const bearing = (deg * Math.PI) / 180
        return {
          roadId: i, end: 'start' as const,
          direction: fromAngle(bearing), halfWidth: 1e-7, bearing,
        }
      })
      .sort((a, b) => a.bearing - b.bearing)
    const geometry: JunctionGeometry = {
      feasible: true,
      corners: [
        { position: vec2(0, 0), beforeLeg: 0, afterLeg: 1 },
        { position: vec2(0, 0), beforeLeg: 1, afterLeg: 2 },
        { position: vec2(0, 0), beforeLeg: 2, afterLeg: 0 },
      ],
      trims: [0, 0, 0],
    }
    const m = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    expect(m.vertexCount).toBe(0)
    expect(m.triangleCount).toBe(0)
    expect(m.positions).toHaveLength(0)
    expect(m.indices).toHaveLength(0)
  })
})
