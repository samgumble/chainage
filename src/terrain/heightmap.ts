/**
 * A regular grid of ground elevations.
 *
 * Grid point (col, row) sits at world position
 *   (originX + col * cellSize, originY + row * cellSize)
 * and `elevations` is row-major: index = row * cols + col.
 *
 * Sampling between grid points is bilinear. Sampling outside the grid clamps
 * to the nearest edge rather than throwing, so an alignment that strays past
 * the map still yields a usable ground profile.
 */
export class Heightmap {
  constructor(
    readonly originX: number,
    readonly originY: number,
    readonly cellSize: number,
    readonly cols: number,
    readonly rows: number,
    readonly elevations: Float32Array,
  ) {
    if (cellSize <= 0) {
      throw new RangeError('cellSize must be positive')
    }
    if (!Number.isFinite(cellSize)) {
      throw new RangeError('cellSize must be finite')
    }
    if (!Number.isInteger(cols)) {
      throw new RangeError('cols must be an integer')
    }
    if (!Number.isInteger(rows)) {
      throw new RangeError('rows must be an integer')
    }
    if (cols < 2 || rows < 2) {
      throw new RangeError('heightmap must be at least 2x2')
    }
    if (!Number.isFinite(originX)) {
      throw new RangeError('originX must be finite')
    }
    if (!Number.isFinite(originY)) {
      throw new RangeError('originY must be finite')
    }
    if (elevations.length !== cols * rows) {
      throw new RangeError(
        `elevations length ${elevations.length} does not match ${cols}x${rows}`,
      )
    }
  }

  get width(): number {
    return (this.cols - 1) * this.cellSize
  }

  get height(): number {
    return (this.rows - 1) * this.cellSize
  }

  elevationAtIndex(col: number, row: number): number {
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) {
      throw new RangeError(`grid index (${col}, ${row}) out of range`)
    }
    return this.elevations[row * this.cols + col]!
  }

  sample(x: number, y: number): number {
    // Continuous grid coordinates, clamped so we never index outside.
    const gx = clampNumber((x - this.originX) / this.cellSize, 0, this.cols - 1)
    const gy = clampNumber((y - this.originY) / this.cellSize, 0, this.rows - 1)

    const col0 = Math.min(Math.floor(gx), this.cols - 2)
    const row0 = Math.min(Math.floor(gy), this.rows - 2)
    const tx = gx - col0
    const ty = gy - row0

    const z00 = this.elevationAtIndex(col0, row0)
    const z10 = this.elevationAtIndex(col0 + 1, row0)
    const z01 = this.elevationAtIndex(col0, row0 + 1)
    const z11 = this.elevationAtIndex(col0 + 1, row0 + 1)

    const bottom = z00 + (z10 - z00) * tx
    const top = z01 + (z11 - z01) * tx
    return bottom + (top - bottom) * ty
  }

  static flat(
    originX: number,
    originY: number,
    cellSize: number,
    cols: number,
    rows: number,
    elevation: number,
  ): Heightmap {
    const e = new Float32Array(cols * rows)
    e.fill(elevation)
    return new Heightmap(originX, originY, cellSize, cols, rows, e)
  }
}

const clampNumber = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v
