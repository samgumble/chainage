import type { Alignment } from '../geometry/alignment'
import { fromAngle } from '../geometry/vec2'
import { type ProfilePoint, designElevationAtStation } from './groundProfile'
import { type CorridorTemplate, designSurfaceAtOffset } from './corridor'
import type { TerrainEditLayer } from './editLayer'
import type { Heightmap } from './heightmap'

/**
 * Which road corridor owns each terrain grid node, and what elevation it
 * wants there.
 *
 * Corridors overlap — at every junction, and anywhere two roads run close.
 * A node inside two of them cannot have two elevations, so one must win.
 * The rule is **nearest centreline**: the node belongs to the road whose
 * formation is closer to it.
 *
 * The rule this replaced was last-write-wins, which had two failure modes
 * that compounded. Beyond its `maxBatterWidth` a corridor's design surface
 * is natural ground, so a road sweeping past a node it does not actually
 * touch still wrote to it — and wrote a zero delta, which
 * `TerrainEditLayer.setDelta` deletes. A second road therefore erased a
 * first road's cut simply by passing nearby, and the road it belonged to
 * was left buried under a metre of unexcavated ground. Nearest-centreline
 * fixes both: the far sample loses, and it loses regardless of which road
 * was created first, so the result no longer depends on insertion order.
 *
 * Presence is tracked separately from elevation. A node whose corridor
 * target equals natural ground is still inside the corridor — callers that
 * ask "is this node in a road corridor" (the terrain colour rule does) must
 * ask `has`, never `deltaAt(...) !== 0`.
 */
export class CorridorExcavation {
  /** Keyed by `row * cols + col`, matching `TerrainEditLayer`. */
  private readonly chosen = new Map<number, { targetZ: number; offset: number }>()

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    if (!Number.isInteger(cols) || cols <= 0) {
      throw new RangeError('cols must be a positive integer')
    }
    if (!Number.isInteger(rows) || rows <= 0) {
      throw new RangeError('rows must be a positive integer')
    }
  }

  get nodeCount(): number {
    return this.chosen.size
  }

  /**
   * Propose an elevation for a node, from a sample `offset` metres from its
   * road's centreline.
   *
   * Out-of-grid nodes are dropped rather than throwing: a corridor sweep
   * legitimately runs off the edge of the terrain, and that is not an error
   * at the call site. Ties keep the earlier offer, so a given set of offers
   * always resolves the same way.
   */
  offer(col: number, row: number, targetZ: number, offset: number): void {
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return

    const distance = Math.abs(offset)
    const index = row * this.cols + col
    const existing = this.chosen.get(index)
    if (existing && existing.offset <= distance) return

    this.chosen.set(index, { targetZ, offset: distance })
  }

  /** Whether any corridor claimed this node. */
  has(col: number, row: number): boolean {
    return this.chosen.has(row * this.cols + col)
  }

  /** The winning target elevation, or `undefined` if no corridor claimed it. */
  targetAt(col: number, row: number): number | undefined {
    return this.chosen.get(row * this.cols + col)?.targetZ
  }

  /**
   * Write every resolved node into an edit layer as a delta from base ground.
   *
   * The layer's base heightmap supplies the ground each delta is measured
   * from, so this cannot be called against a layer built over different
   * terrain than the sweep sampled.
   */
  applyTo(layer: TerrainEditLayer): void {
    if (layer.base.cols !== this.cols || layer.base.rows !== this.rows) {
      throw new RangeError(
        `edit layer is ${layer.base.cols}x${layer.base.rows}, excavation is ${this.cols}x${this.rows}`,
      )
    }
    for (const [index, { targetZ }] of this.chosen) {
      const col = index % this.cols
      const row = (index - col) / this.cols
      layer.setDelta(col, row, targetZ - layer.base.elevationAtIndex(col, row))
    }
  }
}

export type SweepParams = {
  readonly alignment: Alignment
  readonly profile: readonly ProfilePoint[]
  readonly terrain: Heightmap
  readonly template: CorridorTemplate
  /** Full pavement stack thickness plus any z-fight margin, metres. */
  readonly pavementDepth: number
  /** Steepest batter slope as run-over-rise; sizes the swept half-width. */
  readonly maxSlope: number
  /** Extra half-width swept beyond the computed batter, metres. */
  readonly margin: number
  /** Station spacing along the alignment, metres. */
  readonly stationSpacing: number
  /** Transverse sample spacing, metres. */
  readonly transverseSpacing: number
  /**
   * Station ranges carried on a structure, which this sweep must not touch.
   *
   * These come from `structureSpans`, so earthwork stops exactly where the
   * abutment stands rather than where a per-station fill test happens to
   * trip. The two used to be derived independently and disagreed by several
   * stations, which left an unsupported notch past the deck and a bare
   * terrain cliff at each bridge end.
   */
  readonly structureRanges: readonly { readonly fromStation: number; readonly toStation: number }[]
  /**
   * The fill allowance the design line was graded to, metres.
   *
   * Not used to change what is swept — it is used to REPORT. See
   * `UnsupportedFill`. A number rather than anything from the mesh layer,
   * deliberately: `terrain/` does not import `mesh/`, and the allowance is
   * whatever the caller handed the grade solver anyway.
   */
  readonly maxFillHeight: number
}

/**
 * A station the sweep embanked higher than the fill allowance permits.
 *
 * Somebody has to notice this. The old code skipped any station where
 * `roadZ - centreGroundZ > MAX_FILL_HEIGHT`, which stopped the embankment and
 * left an unsupported notch in the road instead — wrong in a different
 * direction, and silent about it too. That skip was replaced by the span list,
 * which is right for a high run long enough to become a span and does nothing
 * at all for one that is not: a run shorter than `MIN_SPAN_LENGTH` is
 * discarded as terrain noise, and the sweep then builds whatever embankment
 * the design line asks for. Measured on a 20m-wide, 18m-deep notch: a 16.40m
 * embankment against a declared allowance of 10m, 48 grid nodes different from
 * the old behaviour, worst case 0.00m before and +16.40m after.
 *
 * Neither answer is right, and picking between two wrong ones quietly is the
 * thing this codebase does not do. So the embankment is built — it is at least
 * continuous, which the notch was not — and every station that exceeded the
 * allowance is handed back for the caller to report.
 */
export type UnsupportedFill = {
  /** Station along the alignment, metres. */
  readonly station: number
  /** How far the design line stands above natural ground there, metres. */
  readonly height: number
  /** The allowance it exceeded, metres. */
  readonly allowance: number
}

/**
 * Walk an alignment and offer every corridor sample into `into`.
 *
 * Returns the stations it embanked above the fill allowance without a
 * structure under them — see `UnsupportedFill`. An empty array is the common
 * case and means what it says.
 */
export const sweepCorridor = (
  params: SweepParams,
  into: CorridorExcavation,
): UnsupportedFill[] => {
  const {
    alignment, profile, terrain, template, pavementDepth,
    maxSlope, margin, stationSpacing, transverseSpacing, structureRanges, maxFillHeight,
  } = params

  if (stationSpacing <= 0) throw new RangeError('stationSpacing must be positive')
  if (transverseSpacing <= 0) throw new RangeError('transverseSpacing must be positive')

  const carried = (s: number): boolean =>
    structureRanges.some((r) => s >= r.fromStation && s <= r.toStation)

  const steps = Math.max(1, Math.ceil(alignment.length / stationSpacing))
  const unsupportedFill: UnsupportedFill[] = []

  for (let i = 0; i <= steps; i++) {
    const s = Math.min(i * stationSpacing, alignment.length)
    if (carried(s)) continue

    const pose = alignment.poseAt(s)
    const roadZ = designElevationAtStation(profile, s)
    const designZ = roadZ - pavementDepth

    const centreGroundZ = terrain.sample(pose.position.x, pose.position.y)

    // Measured on the design line against natural ground, exactly as the old
    // per-station skip measured it, so the report fires on precisely the
    // stations that skip used to swallow.
    if (roadZ - centreGroundZ > maxFillHeight) {
      unsupportedFill.push({
        station: s,
        height: roadZ - centreGroundZ,
        allowance: maxFillHeight,
      })
    }

    const depth = Math.abs(centreGroundZ - designZ)
    const half = template.formationHalfWidth + maxSlope * depth + margin

    const normal = fromAngle(pose.heading + Math.PI / 2)
    const transverseSteps = Math.max(1, Math.ceil(half / transverseSpacing))

    for (let j = -transverseSteps; j <= transverseSteps; j++) {
      const offset = (half * j) / transverseSteps
      const worldX = pose.position.x + normal.x * offset
      const worldY = pose.position.y + normal.y * offset

      const col = Math.round((worldX - terrain.originX) / terrain.cellSize)
      const row = Math.round((worldY - terrain.originY) / terrain.cellSize)
      if (col < 0 || col >= terrain.cols || row < 0 || row >= terrain.rows) continue

      const groundZ = terrain.elevationAtIndex(col, row)
      into.offer(col, row, designSurfaceAtOffset(offset, designZ, groundZ, template), offset)
    }
  }

  return unsupportedFill
}
