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

  // THE DEFECT, in the shape it was measured in. The demo scene's east arm
  // carries a span over stations 273-423 (a 279-417 structure run plus a 3m
  // abutment extension at each end), while the earthworks it used to derive
  // independently stopped at 280 and resumed at 420. Nodes in 273-280 and
  // 420-423 were therefore claimed by earthwork AND covered by an abutment:
  // a bare terrain cliff at each bridge end and an embankment standing over
  // the west abutment. The property that forbids it is stated directly —
  // nothing strictly inside a carried range may be claimed by the sweep.
  it('leaves every node under a structure range unclaimed', () => {
    // A 500m alignment over the same flat ground, sampled at the same 5m
    // grid the fixture above uses. Every station is a multiple of the
    // 5m cell size, so a swept sample's nearest grid column sits exactly on
    // its own station — the nearest-station figures below carry no
    // rounding slack that could hide a node just inside the range.
    const longTerrain = new Heightmap(0, -50, 5, 121, 21, new Float32Array(121 * 21).fill(100))
    const longAlignment = new Alignment([new Line(vec2(0, 0), 0, 500)])
    const longProfile: ProfilePoint[] = [{ s: 0, z: 96 }, { s: 500, z: 96 }]

    const params: Omit<SweepParams, 'structureRanges'> = {
      ...baseParams,
      alignment: longAlignment,
      profile: longProfile,
      terrain: longTerrain,
      stationSpacing: 5,
    }

    /**
     * The nearest station on the alignment to a claimed node.
     *
     * The alignment is a straight line east from the origin, so every point's
     * nearest station is its own x clamped to the alignment's length — no
     * projection machinery needed, and none of its approximation either.
     */
    const nearestStation = (col: number): number => {
      const x = longTerrain.originX + col * longTerrain.cellSize
      return Math.min(Math.max(x, 0), longAlignment.length)
    }

    const stationsClaimed = (x: CorridorExcavation): number[] => {
      const stations = new Set<number>()
      for (let row = 0; row < longTerrain.rows; row++) {
        for (let col = 0; col < longTerrain.cols; col++) {
          if (x.has(col, row)) stations.add(nearestStation(col))
        }
      }
      return [...stations].sort((a, b) => a - b)
    }

    const carried = { fromStation: 273, toStation: 423 }
    const inside = (s: number): boolean => s > carried.fromStation && s < carried.toStation

    const covered = new CorridorExcavation(longTerrain.cols, longTerrain.rows)
    sweepCorridor({ ...params, structureRanges: [carried] }, covered)

    expect(stationsClaimed(covered).filter(inside)).toEqual([])

    // Not vacuous twice over: the sweep did claim ground right up to both
    // ends of the span, and the same sweep with no structure range claims
    // the span's whole interior — so the assertion above is discriminating
    // the guard, not an empty excavation or an alignment nothing reaches.
    expect(stationsClaimed(covered)).toContain(270)
    expect(stationsClaimed(covered)).toContain(425)

    const unguarded = new CorridorExcavation(longTerrain.cols, longTerrain.rows)
    sweepCorridor({ ...params, structureRanges: [] }, unguarded)
    expect(stationsClaimed(unguarded).filter(inside).length).toBeGreaterThan(0)
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
