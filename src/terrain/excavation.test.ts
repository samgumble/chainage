import { describe, it, expect } from 'vitest'
import { CorridorExcavation, sweepCorridor, type SweepParams } from './excavation'
import { Heightmap } from './heightmap'
import { TerrainEditLayer } from './editLayer'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import type { ProfilePoint } from './groundProfile'
import type { CorridorTemplate } from './corridor'

const flatGround = (elevation: number): Heightmap => {
  const cols = 8, rows = 8
  const elevations = new Float32Array(cols * rows).fill(elevation)
  return new Heightmap(0, 0, 10, cols, rows, elevations)
}

describe('CorridorExcavation arbitration', () => {
  it('records a single offer', () => {
    const x = new CorridorExcavation(8, 8)
    x.offer(2, 3, 95, 4)
    expect(x.has(2, 3)).toBe(true)
    expect(x.targetAt(2, 3)).toBe(95)
    expect(x.nodeCount).toBe(1)
  })

  it('lets a nearer offer replace a farther one', () => {
    const x = new CorridorExcavation(8, 8)
    x.offer(2, 3, 95, 12)
    x.offer(2, 3, 91, 4)
    expect(x.targetAt(2, 3)).toBe(91)
  })

  // THE DEFECT. Last-write-wins made this fail: road B's far-offset
  // sample, which wanted natural ground, overwrote road A's deep cut.
  it('does not let a farther offer replace a nearer one', () => {
    const x = new CorridorExcavation(8, 8)
    x.offer(2, 3, 91, 4)
    x.offer(2, 3, 95, 12)
    expect(x.targetAt(2, 3)).toBe(91)
  })

  // The same defect in the exact shape measured at the junction: the
  // far sample's target EQUALS natural ground, so under the old code it
  // produced delta 0 and setDelta deleted the entry outright.
  it('does not let a farther no-change offer erase a nearer cut', () => {
    const x = new CorridorExcavation(8, 8)
    x.offer(2, 3, 98.34, 3)    // road A cuts 1.66m below ground at 100
    x.offer(2, 3, 100, 27)     // road B: beyond its batter, natural ground
    expect(x.targetAt(2, 3)).toBe(98.34)
  })

  it('keeps the first of two offers at an equal offset', () => {
    const x = new CorridorExcavation(8, 8)
    x.offer(2, 3, 91, 7)
    x.offer(2, 3, 95, 7)
    expect(x.targetAt(2, 3)).toBe(91)
  })

  // A node whose corridor target happens to equal natural ground is
  // still IN the corridor. roadScene colours cut nodes brown by asking
  // this, not by asking whether the delta is non-zero.
  it('reports a node as present even when its target equals ground', () => {
    const x = new CorridorExcavation(8, 8)
    x.offer(2, 3, 100, 27)
    expect(x.has(2, 3)).toBe(true)
    expect(x.targetAt(2, 3)).toBe(100)
  })

  it('ignores offers outside the grid rather than throwing', () => {
    const x = new CorridorExcavation(8, 8)
    x.offer(-1, 3, 95, 4)
    x.offer(2, 99, 95, 4)
    expect(x.nodeCount).toBe(0)
  })

  it('applies the resolved target as a delta from base ground', () => {
    const x = new CorridorExcavation(8, 8)
    x.offer(2, 3, 98.34, 3)
    const layer = new TerrainEditLayer(flatGround(100))
    x.applyTo(layer)
    expect(layer.deltaAt(2, 3)).toBeCloseTo(-1.66, 6)
  })
})

describe('sweepCorridor', () => {
  // A straight 100m alignment along the x-axis over flat ground at 100m,
  // with a flat design line at 96m. Because the alignment runs due east,
  // its transverse normal is due north/south (0, 1): every station's
  // samples land on a single terrain column (worldX === station, since the
  // normal has zero x-component), and stations 10m apart on a 5m-cell grid
  // land on distinct, non-overlapping columns. That property is what makes
  // the structure-range tests below able to fail for the right reason: a
  // node's column identifies exactly one station, so "was this station
  // swept" and "was this column claimed" are the same question.
  const terrain = new Heightmap(0, -50, 5, 21, 21, new Float32Array(21 * 21).fill(100))
  const alignment = new Alignment([new Line(vec2(0, 0), 0, 100)])
  const profile: ProfilePoint[] = [
    { s: 0, z: 96 },
    { s: 100, z: 96 },
  ]
  const template: CorridorTemplate = {
    cutSlope: 2,
    fillSlope: 3,
    formationHalfWidth: 5,
  }

  const baseParams: Omit<SweepParams, 'structureRanges'> = {
    alignment,
    profile,
    terrain,
    template,
    pavementDepth: 0.5,
    maxSlope: 3,
    margin: 2,
    stationSpacing: 10,
    transverseSpacing: 5,
  }

  /** Station s lands on terrain column s / cellSize, since the alignment's
   * transverse normal is purely in y. */
  const columnForStation = (s: number): number => Math.round((s - terrain.originX) / terrain.cellSize)

  /** Whether any row at this column was claimed. */
  const columnClaimed = (x: CorridorExcavation, col: number): boolean => {
    for (let row = 0; row < terrain.rows; row++) {
      if (x.has(col, row)) return true
    }
    return false
  }

  it('claims nodes along the alignment', () => {
    const x = new CorridorExcavation(terrain.cols, terrain.rows)
    sweepCorridor({ ...baseParams, structureRanges: [] }, x)
    expect(x.nodeCount).toBeGreaterThan(0)
  })

  it('skips stations inside a structure range', () => {
    const full = new CorridorExcavation(terrain.cols, terrain.rows)
    sweepCorridor({ ...baseParams, structureRanges: [] }, full)

    // The middle third of the ten station-spacing steps: stations
    // 30, 40, 50, 60, 70 all fall inside [30, 70] inclusive.
    const covered = new CorridorExcavation(terrain.cols, terrain.rows)
    sweepCorridor(
      { ...baseParams, structureRanges: [{ fromStation: 30, toStation: 70 }] },
      covered,
    )

    expect(covered.nodeCount).toBeLessThan(full.nodeCount)

    const carriedStations = [30, 40, 50, 60, 70]
    const freeStations = [0, 10, 20, 80, 90, 100]

    for (const s of carriedStations) {
      const col = columnForStation(s)
      // Without the structureRanges guard, this station's column would be
      // claimed (it is, in `full`) — so this assertion genuinely
      // discriminates the carried-range behaviour rather than passing
      // vacuously.
      expect(columnClaimed(full, col)).toBe(true)
      expect(columnClaimed(covered, col)).toBe(false)
    }
    for (const s of freeStations) {
      const col = columnForStation(s)
      expect(columnClaimed(covered, col)).toBe(true)
    }
  })

  it('claims the station exactly at a structure range boundary as carried', () => {
    // fromStation and toStation are inclusive: a zero-width range at
    // exactly station 30 must still carry that one station, proving both
    // ends of the comparison (s >= from && s <= to) are inclusive rather
    // than exclusive at either boundary.
    const x = new CorridorExcavation(terrain.cols, terrain.rows)
    sweepCorridor(
      { ...baseParams, structureRanges: [{ fromStation: 30, toStation: 30 }] },
      x,
    )

    expect(columnClaimed(x, columnForStation(30))).toBe(false)
    // Neighbouring stations, not covered by the range, must still be swept —
    // otherwise this would pass even if the whole sweep were broken.
    expect(columnClaimed(x, columnForStation(20))).toBe(true)
    expect(columnClaimed(x, columnForStation(40))).toBe(true)
  })
})
