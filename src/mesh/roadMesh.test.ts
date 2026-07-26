import { describe, it, expect } from 'vitest'
import { buildRoadMesh } from './roadMesh'
import { ROAD_CLASSES, type LayerName } from './roadClass'
import { layerTopProfile } from './crossSection'
import type { MeshData } from './ribbon'
import { Alignment } from '../geometry/alignment'
import { Line, Arc } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import type { ProfilePoint } from '../terrain/groundProfile'

const road = (length: number) => new Alignment([new Line(vec2(0, 0), 0, length)])
const curvedRoad = (length: number) => new Alignment([new Arc(vec2(0, 0), 0, length, 1 / 150)])
const level = (length: number, z: number): ProfilePoint[] => [{ s: 0, z }, { s: length, z }]
const rural = ROAD_CLASSES.rural

/** Highest z across a layer's vertices, i.e. the crown (offset 0) elevation. */
const crownElevation = (mesh: MeshData): number => {
  let highest = -Infinity
  for (let i = 0; i < mesh.vertexCount; i++) {
    const z = mesh.positions[i * 3 + 2]!
    if (z > highest) highest = z
  }
  return highest
}

/**
 * A layer's section width at station 0, measured directly rather than by
 * scanning world-space |y|.
 *
 * Vertices are emitted station-major, so the first `across` vertices are
 * station 0's full cross-section, where `across` is the layer's own section
 * point count. The width is the distance between the first and last of
 * those vertices — robust on any alignment, since it never assumes the
 * centreline sits at y=0 or that the transverse normal is axis-aligned.
 */
const sectionWidthAt0 = (mesh: MeshData, layer: LayerName): number => {
  const across = layerTopProfile(rural, layer).length
  const ax = mesh.positions[0]!
  const ay = mesh.positions[1]!
  const az = mesh.positions[2]!
  const bi = (across - 1) * 3
  const bx = mesh.positions[bi]!
  const by = mesh.positions[bi + 1]!
  const bz = mesh.positions[bi + 2]!
  return Math.hypot(bx - ax, by - ay, bz - az)
}

describe('buildRoadMesh', () => {
  it('returns all three layers bottom-up, with geometry matching each name', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural)
    expect(m.layers.map((l) => l.name)).toEqual(['subgrade', 'base', 'wearing'])

    // Name order alone wouldn't catch mislabelled geometry; tie it to the
    // actual crown elevations, which are stacked wearing-highest,
    // subgrade-lowest by construction.
    const crownZ = (name: LayerName) => crownElevation(m.layers.find((l) => l.name === name)!.mesh)
    expect(crownZ('wearing')).toBeGreaterThan(crownZ('base'))
    expect(crownZ('base')).toBeGreaterThan(crownZ('subgrade'))
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
    const crownZ = (name: string) =>
      crownElevation(m.layers.find((l) => l.name === name)!.mesh)
    expect(crownZ('wearing')).toBeGreaterThan(crownZ('base'))
    expect(crownZ('base')).toBeGreaterThan(crownZ('subgrade'))
  })

  it('builds wider meshes for lower layers', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural, undefined, { spacing: 100 })
    const width = (name: LayerName) =>
      sectionWidthAt0(m.layers.find((l) => l.name === name)!.mesh, name)
    expect(width('subgrade')).toBeGreaterThan(width('base'))
    expect(width('base')).toBeGreaterThan(width('wearing'))
  })

  it('builds wider meshes for lower layers on a curved alignment', () => {
    // Same measure, a non-axis-aligned alignment: the centreline's y drifts
    // with station and the transverse normal is no longer ±y, so this proves
    // sectionWidthAt0 measures section width rather than centreline drift.
    const m = buildRoadMesh(curvedRoad(200), level(200, 50), rural, undefined, { spacing: 20 })
    const width = (name: LayerName) =>
      sectionWidthAt0(m.layers.find((l) => l.name === name)!.mesh, name)
    expect(width('subgrade')).toBeGreaterThan(width('base'))
    expect(width('base')).toBeGreaterThan(width('wearing'))
  })

  it('ignores startStation/endStation supplied in options, in favour of per-layer stations', () => {
    const stations = { subgrade: 200, base: 120, wearing: 40 }
    // endStation: 10 would produce a much smaller mesh if it won, so this
    // genuinely discriminates a regression that lets caller options through.
    const withBogusOptions = buildRoadMesh(road(200), level(200, 50), rural, stations,
      { spacing: 20, startStation: 50, endStation: 10 })
    const withoutStationOptions = buildRoadMesh(road(200), level(200, 50), rural, stations,
      { spacing: 20 })
    expect(withBogusOptions).toEqual(withoutStationOptions)
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
