import { describe, expect, it } from 'vitest'
import { ROAD_CLASSES } from '../network/roadClass'
import { SURFACES, type SurfaceName, surfaceFor } from './materials'

const luminance = (colour: number): number => {
  const r = (colour >> 16) & 0xff
  const g = (colour >> 8) & 0xff
  const b = colour & 0xff
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

describe('SURFACES', () => {
  it('covers every pavement layer the road classes name', () => {
    const layers = new Set(
      Object.values(ROAD_CLASSES).flatMap((rc) => rc.layers.map((l) => l.name)),
    )
    for (const layer of layers) {
      expect(SURFACES).toHaveProperty(layer)
    }
  })

  it('gives every surface a physically sane roughness and metalness', () => {
    for (const [name, surface] of Object.entries(SURFACES)) {
      expect(surface.roughness, name).toBeGreaterThan(0)
      expect(surface.roughness, name).toBeLessThanOrEqual(1)
      expect(surface.metalness, name).toBeGreaterThanOrEqual(0)
      expect(surface.metalness, name).toBeLessThanOrEqual(1)
    }
  })

  it('makes nothing metallic, because none of it is metal', () => {
    for (const [name, surface] of Object.entries(SURFACES)) {
      expect(surface.metalness, name).toBeLessThan(0.2)
    }
  })

  it('keeps every colour inside a byte per channel', () => {
    for (const [name, surface] of Object.entries(SURFACES)) {
      expect(Number.isInteger(surface.colour), name).toBe(true)
      expect(surface.colour, name).toBeGreaterThanOrEqual(0)
      expect(surface.colour, name).toBeLessThanOrEqual(0xffffff)
    }
  })

  it('makes the wearing course darker than the base it sits on', () => {
    // Sealed asphalt against an unsealed granular base: the seal is much darker.
    expect(luminance(SURFACES.wearing.colour)).toBeLessThan(
      luminance(SURFACES.base.colour),
    )
  })

  it('makes the sealed surface smoother than the granular ones', () => {
    expect(SURFACES.wearing.roughness).toBeLessThan(SURFACES.base.roughness)
    expect(SURFACES.wearing.roughness).toBeLessThan(SURFACES.subgrade.roughness)
  })

  it('makes concrete lighter than asphalt, and keeps its roughness nearer the sealed wearing course than the granular base', () => {
    expect(luminance(SURFACES.concrete.colour)).toBeGreaterThan(
      luminance(SURFACES.wearing.colour),
    )
    // Concrete reads as a structural, semi-sealed surface — rougher than the
    // wearing course it is not, but nowhere near as coarse as an unsealed
    // granular base either. Comparing only against `base` (as this test used
    // to) is nearly no check at all: `base` is the roughest surface in the
    // table, so almost any value short of it passes, including one rough
    // enough to read as granular — the midpoint between `wearing` and `base`
    // is the actual claim this test's name makes, and the one the mutation
    // sweep found this test wasn't making.
    const midpoint = (SURFACES.wearing.roughness + SURFACES.base.roughness) / 2
    expect(SURFACES.concrete.roughness).toBeLessThan(midpoint)
  })

  it('never makes a surface a perfect mirror or perfectly matte', () => {
    // Both extremes read as computer-generated rather than as a real material.
    for (const [name, surface] of Object.entries(SURFACES)) {
      expect(surface.roughness, name).toBeGreaterThan(0.05)
      expect(surface.roughness, name).toBeLessThan(1)
    }
  })
})

describe('surfaceFor', () => {
  it('returns the named surface', () => {
    expect(surfaceFor('wearing')).toBe(SURFACES.wearing)
  })

  it('has an entry for every name in the union', () => {
    const names: SurfaceName[] = [
      'subgrade',
      'base',
      'wearing',
      'concrete',
      'terrain',
      'cutFace',
    ]
    for (const name of names) {
      expect(surfaceFor(name)).toBeDefined()
    }
  })
})
