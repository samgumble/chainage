import { describe, it, expect } from 'vitest'
import { TerrainEditLayer } from './editLayer'
import { Heightmap } from './heightmap'

const base = () => Heightmap.flat(0, 0, 10, 3, 3, 100)

describe('TerrainEditLayer', () => {
  it('starts empty and samples the base unchanged', () => {
    const layer = new TerrainEditLayer(base())
    expect(layer.editCount).toBe(0)
    expect(layer.sample(15, 15)).toBeCloseTo(100, 9)
  })

  it('applies a delta at a grid point', () => {
    const layer = new TerrainEditLayer(base())
    layer.setDelta(1, 1, -5)
    expect(layer.deltaAt(1, 1)).toBe(-5)
    expect(layer.sample(10, 10)).toBeCloseTo(95, 9)
  })

  it('reports zero delta where untouched', () => {
    const layer = new TerrainEditLayer(base())
    layer.setDelta(1, 1, -5)
    expect(layer.deltaAt(0, 0)).toBe(0)
    expect(layer.sample(0, 0)).toBeCloseTo(100, 9)
  })

  it('interpolates deltas bilinearly between grid points', () => {
    const layer = new TerrainEditLayer(base())
    layer.setDelta(0, 0, -10)
    // Halfway between the edited corner and its untouched neighbour.
    expect(layer.sample(5, 0)).toBeCloseTo(95, 9)
  })

  it('overwrites rather than accumulating on repeated set', () => {
    const layer = new TerrainEditLayer(base())
    layer.setDelta(1, 1, -5)
    layer.setDelta(1, 1, -8)
    expect(layer.deltaAt(1, 1)).toBe(-8)
    expect(layer.editCount).toBe(1)
  })

  it('counts only distinct edited points', () => {
    const layer = new TerrainEditLayer(base())
    layer.setDelta(0, 0, 1)
    layer.setDelta(1, 0, 2)
    layer.setDelta(0, 0, 3)
    expect(layer.editCount).toBe(2)
  })

  it('restores the base exactly when cleared — the undo guarantee', () => {
    const layer = new TerrainEditLayer(base())
    layer.setDelta(1, 1, -20)
    layer.setDelta(2, 2, 15)
    layer.clear()
    expect(layer.editCount).toBe(0)
    expect(layer.sample(10, 10)).toBeCloseTo(100, 9)
    expect(layer.sample(20, 20)).toBeCloseTo(100, 9)
  })

  it('never mutates the base heightmap', () => {
    const b = base()
    const before = Array.from(b.elevations)
    const layer = new TerrainEditLayer(b)
    layer.setDelta(1, 1, -50)
    expect(Array.from(b.elevations)).toEqual(before)
  })

  it('rejects out-of-range grid indices', () => {
    const layer = new TerrainEditLayer(base())
    expect(() => layer.setDelta(-1, 0, 1)).toThrow(RangeError)
    expect(() => layer.setDelta(3, 0, 1)).toThrow(RangeError)
    expect(() => layer.deltaAt(0, 3)).toThrow(RangeError)
  })

  it('bakes edits into a new heightmap on flatten', () => {
    const layer = new TerrainEditLayer(base())
    layer.setDelta(1, 1, -5)
    const flat = layer.flatten()
    expect(flat.elevationAtIndex(1, 1)).toBeCloseTo(95, 4)
    expect(flat.elevationAtIndex(0, 0)).toBeCloseTo(100, 4)
  })

  it('leaves the layer usable after flatten', () => {
    const layer = new TerrainEditLayer(base())
    layer.setDelta(1, 1, -5)
    layer.flatten()
    expect(layer.editCount).toBe(1)
    expect(layer.sample(10, 10)).toBeCloseTo(95, 9)
  })

  it('clamps outside its bounds like the base does', () => {
    const layer = new TerrainEditLayer(base())
    layer.setDelta(0, 0, -10)
    expect(layer.sample(-999, -999)).toBeCloseTo(90, 9)
  })
})
