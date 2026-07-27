import { describe, it, expect } from 'vitest'
import { layerTopProfile, layerDepthBelowSurface } from './crossSection'
import { ROAD_CLASSES, formationHalfWidth } from '../network/roadClass'

const rural = ROAD_CLASSES.rural

describe('layerDepthBelowSurface', () => {
  it('puts the wearing course top at the design elevation', () => {
    expect(layerDepthBelowSurface(rural, 'wearing')).toBeCloseTo(0, 9)
  })

  it('puts the base top one wearing-course thickness down', () => {
    const wearing = rural.layers.find((l) => l.name === 'wearing')!
    expect(layerDepthBelowSurface(rural, 'base')).toBeCloseTo(wearing.thickness, 9)
  })

  it('puts the subgrade top below wearing plus base', () => {
    const wearing = rural.layers.find((l) => l.name === 'wearing')!
    const base = rural.layers.find((l) => l.name === 'base')!
    expect(layerDepthBelowSurface(rural, 'subgrade'))
      .toBeCloseTo(wearing.thickness + base.thickness, 9)
  })

  it('rejects an unknown layer', () => {
    // @ts-expect-error deliberately invalid layer name
    expect(() => layerDepthBelowSurface(rural, 'ballast')).toThrow(RangeError)
  })
})

describe('layerTopProfile', () => {
  it('is symmetric about the centreline', () => {
    const p = layerTopProfile(rural, 'wearing')
    const first = p[0]!
    const last = p[p.length - 1]!
    expect(first.offset).toBeCloseTo(-last.offset, 9)
    expect(first.dz).toBeCloseTo(last.dz, 9)
  })

  it('has strictly increasing offsets', () => {
    for (const name of ['subgrade', 'base', 'wearing'] as const) {
      const p = layerTopProfile(rural, name)
      for (let i = 1; i < p.length; i++) {
        expect(p[i]!.offset).toBeGreaterThan(p[i - 1]!.offset)
      }
    }
  })

  it('peaks at the crown and falls to the edges', () => {
    const p = layerTopProfile(rural, 'wearing')
    const crown = p.find((q) => Math.abs(q.offset) < 1e-9)!
    expect(crown.dz).toBeCloseTo(0, 9)
    for (const q of p) {
      if (Math.abs(q.offset) > 1e-9) expect(q.dz).toBeLessThan(crown.dz)
    }
  })

  it('applies the class crossfall from crown to formation edge', () => {
    const p = layerTopProfile(rural, 'wearing')
    const half = formationHalfWidth(rural)
    const edge = p[p.length - 1]!
    expect(edge.offset).toBeCloseTo(half, 9)
    expect(edge.dz).toBeCloseTo(-half * rural.crossfall, 9)
  })

  it('places a lower layer entirely below an upper one at the same offset', () => {
    const wearing = layerTopProfile(rural, 'wearing')
    const base = layerTopProfile(rural, 'base')
    const crownW = wearing.find((q) => Math.abs(q.offset) < 1e-9)!
    const crownB = base.find((q) => Math.abs(q.offset) < 1e-9)!
    expect(crownB.dz).toBeLessThan(crownW.dz)
  })

  it('makes lower layers wider', () => {
    const wearingHalf = layerTopProfile(rural, 'wearing').slice(-1)[0]!.offset
    const baseHalf = layerTopProfile(rural, 'base').slice(-1)[0]!.offset
    const subHalf = layerTopProfile(rural, 'subgrade').slice(-1)[0]!.offset
    expect(baseHalf).toBeGreaterThan(wearingHalf)
    expect(subHalf).toBeGreaterThan(baseHalf)
  })

  it('gives every class a usable profile', () => {
    for (const name of ['gravel', 'rural', 'arterial', 'highway'] as const) {
      const p = layerTopProfile(ROAD_CLASSES[name], 'wearing')
      expect(p.length).toBeGreaterThanOrEqual(3)
      expect(p.every((q) => Number.isFinite(q.offset) && Number.isFinite(q.dz))).toBe(true)
    }
  })

  it('includes a point at every lane boundary', () => {
    // A 2-lane road has boundaries at -3.5, 0, +3.5 plus the shoulder edges.
    const p = layerTopProfile(rural, 'wearing')
    for (const offset of [-3.5, 0, 3.5]) {
      expect(p.some((q) => Math.abs(q.offset - offset) < 1e-9)).toBe(true)
    }
  })
})
