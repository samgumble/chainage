import { describe, it, expect } from 'vitest'
import { TerrainEditLayer } from './editLayer'
import { Heightmap } from './heightmap'
import { sampleGroundProfile } from './groundProfile'
import { computeEarthworks } from './volumes'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import type { CorridorTemplate } from './corridor'
import type { ProfilePoint } from './groundProfile'

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

  it('a zero delta does not count as an edit', () => {
    const layer = new TerrainEditLayer(base())
    layer.setDelta(1, 1, -5)
    layer.setDelta(1, 1, 0)
    expect(layer.editCount).toBe(0)
    expect(layer.sample(10, 10)).toBeCloseTo(100, 9)
  })

  it('a zero delta on an untouched point stays untouched', () => {
    const layer = new TerrainEditLayer(base())
    layer.setDelta(0, 0, 0)
    expect(layer.editCount).toBe(0)
  })

  it('a zero delta still validates its index', () => {
    const layer = new TerrainEditLayer(base())
    expect(() => layer.setDelta(-1, 0, 0)).toThrow(RangeError)
  })

  it('clear on an already-empty layer is safe', () => {
    const layer = new TerrainEditLayer(base())
    layer.clear()
    expect(layer.editCount).toBe(0)
  })

  it('flatten returns a distinct object from the base', () => {
    const layer = new TerrainEditLayer(base())
    layer.setDelta(1, 1, -5)
    const flat = layer.flatten()
    expect(flat).not.toBe(layer.base)
  })
})

describe('TerrainEditLayer as a TerrainSampler', () => {
  // sampleGroundProfile and computeEarthworks only ever call `.sample`, so a
  // TerrainEditLayer should be usable directly, without first flattening it
  // — flattening is a lossy, one-way bake that would defeat the entire point
  // of a non-destructive edit layer.
  const road = (length: number) => new Alignment([new Line(vec2(0, 10), 0, length)])

  it('can be passed to sampleGroundProfile, and an edit visibly changes the profile', () => {
    const layer = new TerrainEditLayer(base())
    const before = sampleGroundProfile(road(20), layer, 10)
    expect(before.every((p) => p.z === 100)).toBe(true)

    // Edit affects grid points near x=10 (col 1), under the alignment.
    layer.setDelta(1, 1, -15)
    const after = sampleGroundProfile(road(20), layer, 10)

    expect(after.some((p, i) => p.z !== before[i]!.z)).toBe(true)
  })

  it('can be passed to computeEarthworks, and an edit visibly changes the quantities', () => {
    const layer = new TerrainEditLayer(base())
    // A design station at s=10 (x=10) so its cross-section falls exactly on
    // the edited grid column.
    const design: ProfilePoint[] = [
      { s: 0, z: 100 }, { s: 10, z: 100 }, { s: 20, z: 100 },
    ]
    const template: CorridorTemplate = { formationHalfWidth: 5, cutSlope: 2, fillSlope: 2 }

    const before = computeEarthworks(road(20), layer, design, template)
    expect(before.cutVolume).toBeCloseTo(0, 6)
    expect(before.fillVolume).toBeCloseTo(0, 6)

    // A cut-shaped edit under the corridor should now register as cut volume.
    // Raising the whole column at col 1 (x=10) keeps the bump uniform along
    // y, so it shows up regardless of exactly where the transverse march
    // samples.
    layer.setDelta(1, 0, 10)
    layer.setDelta(1, 1, 10)
    layer.setDelta(1, 2, 10)
    const after = computeEarthworks(road(20), layer, design, template)

    expect(after.cutVolume).toBeGreaterThan(before.cutVolume)
  })
})
