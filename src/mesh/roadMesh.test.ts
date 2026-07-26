import { describe, it, expect } from 'vitest'
import { buildRoadMesh } from './roadMesh'
import { ROAD_CLASSES } from './roadClass'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import type { ProfilePoint } from '../terrain/groundProfile'

const road = (length: number) => new Alignment([new Line(vec2(0, 0), 0, length)])
const level = (length: number, z: number): ProfilePoint[] => [{ s: 0, z }, { s: length, z }]
const rural = ROAD_CLASSES.rural

describe('buildRoadMesh', () => {
  it('returns all three layers bottom-up', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural)
    expect(m.layers.map((l) => l.name)).toEqual(['subgrade', 'base', 'wearing'])
  })

  it('builds every layer full length when no stations are given', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural, undefined, { spacing: 50 })
    for (const layer of m.layers) {
      expect(layer.mesh.vertexCount).toBeGreaterThan(0)
    }
  })

  it('builds lower layers further along than upper ones', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural,
      { subgrade: 200, base: 120, wearing: 40 }, { spacing: 20 })
    const count = (name: string) =>
      m.layers.find((l) => l.name === name)!.mesh.vertexCount
    expect(count('subgrade')).toBeGreaterThan(count('base'))
    expect(count('base')).toBeGreaterThan(count('wearing'))
  })

  it('yields an empty mesh for a layer not yet started', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural,
      { subgrade: 100 }, { spacing: 20 })
    expect(m.layers.find((l) => l.name === 'subgrade')!.mesh.vertexCount).toBeGreaterThan(0)
    expect(m.layers.find((l) => l.name === 'base')!.mesh.vertexCount).toBe(0)
    expect(m.layers.find((l) => l.name === 'wearing')!.mesh.vertexCount).toBe(0)
  })

  it('still returns all three entries when only one has been built', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural, { subgrade: 100 })
    expect(m.layers).toHaveLength(3)
  })

  it('places lower layers below upper ones in the mesh', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural, undefined, { spacing: 100 })
    const crownZ = (name: string) => {
      const mesh = m.layers.find((l) => l.name === name)!.mesh
      // The crown is the section point at offset 0; find the highest z.
      let highest = -Infinity
      for (let i = 0; i < mesh.vertexCount; i++) {
        const z = mesh.positions[i * 3 + 2]!
        if (z > highest) highest = z
      }
      return highest
    }
    expect(crownZ('wearing')).toBeGreaterThan(crownZ('base'))
    expect(crownZ('base')).toBeGreaterThan(crownZ('subgrade'))
  })

  it('builds wider meshes for lower layers', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural, undefined, { spacing: 100 })
    const widest = (name: string) => {
      const mesh = m.layers.find((l) => l.name === name)!.mesh
      let w = 0
      for (let i = 0; i < mesh.vertexCount; i++) {
        w = Math.max(w, Math.abs(mesh.positions[i * 3 + 1]!))
      }
      return w
    }
    expect(widest('subgrade')).toBeGreaterThan(widest('base'))
    expect(widest('base')).toBeGreaterThan(widest('wearing'))
  })

  it('clamps a station beyond the alignment length', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural,
      { subgrade: 9999, base: 9999, wearing: 9999 }, { spacing: 50 })
    const full = buildRoadMesh(road(200), level(200, 50), rural, undefined, { spacing: 50 })
    expect(m.layers[0]!.mesh.vertexCount).toBe(full.layers[0]!.mesh.vertexCount)
  })

  it('works for every road class', () => {
    for (const name of ['gravel', 'rural', 'arterial', 'highway'] as const) {
      const m = buildRoadMesh(road(200), level(200, 50), ROAD_CLASSES[name])
      expect(m.layers).toHaveLength(3)
      for (const layer of m.layers) expect(layer.mesh.triangleCount).toBeGreaterThan(0)
    }
  })
})
