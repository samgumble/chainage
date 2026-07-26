import { Heightmap } from './heightmap'

/**
 * Terrain deformation held separately from the ground it deforms.
 *
 * Edits are sparse elevation deltas keyed by grid index; the base heightmap
 * is never touched. Undo is therefore exact and free — dropping the delta
 * restores the original ground bit for bit, with no accumulated drift from
 * applying and reversing an operation.
 *
 * This is the direct answer to the most-complained-about flaw in Cities:
 * Skylines 2, where terrain edits are destructive and cannot be undone.
 */
export class TerrainEditLayer {
  /** Sparse deltas, keyed by `row * cols + col`. */
  private readonly deltas = new Map<number, number>()

  constructor(readonly base: Heightmap) {}

  get editCount(): number {
    return this.deltas.size
  }

  private indexOf(col: number, row: number): number {
    if (col < 0 || col >= this.base.cols || row < 0 || row >= this.base.rows) {
      throw new RangeError(`grid index (${col}, ${row}) out of range`)
    }
    return row * this.base.cols + col
  }

  setDelta(col: number, row: number, delta: number): void {
    const index = this.indexOf(col, row)
    if (delta === 0) {
      this.deltas.delete(index)
    } else {
      this.deltas.set(index, delta)
    }
  }

  deltaAt(col: number, row: number): number {
    return this.deltas.get(this.indexOf(col, row)) ?? 0
  }

  clear(): void {
    this.deltas.clear()
  }

  /**
   * Base elevation plus deformation, bilinearly interpolated.
   *
   * Mirrors `Heightmap.sample` exactly, including edge clamping, so an edited
   * terrain behaves identically to an unedited one everywhere.
   */
  sample(x: number, y: number): number {

    const baseZ = this.base.sample(x, y)
    if (this.deltas.size === 0) return baseZ

    const { originX, originY, cellSize, cols, rows } = this.base

    const gx = clampNumber((x - originX) / cellSize, 0, cols - 1)
    const gy = clampNumber((y - originY) / cellSize, 0, rows - 1)

    const col0 = Math.min(Math.floor(gx), cols - 2)
    const row0 = Math.min(Math.floor(gy), rows - 2)
    const tx = gx - col0
    const ty = gy - row0

    const d00 = this.deltaAt(col0, row0)
    const d10 = this.deltaAt(col0 + 1, row0)
    const d01 = this.deltaAt(col0, row0 + 1)
    const d11 = this.deltaAt(col0 + 1, row0 + 1)

    const bottom = d00 + (d10 - d00) * tx
    const top = d01 + (d11 - d01) * tx

    return baseZ + bottom + (top - bottom) * ty
  }

  /**
   * A new heightmap with the edits baked in. This layer is left untouched.
   *
   * Values are narrowed to float32 precision and the operation cannot be
   * reversed to recover the exact original deltas — unlike `clear()`, this is
   * a lossy one-way bake.
   */
  flatten(): Heightmap {
    const { originX, originY, cellSize, cols, rows } = this.base
    const elevations = new Float32Array(cols * rows)

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        elevations[row * cols + col] =
          this.base.elevationAtIndex(col, row) + this.deltaAt(col, row)
      }
    }

    return new Heightmap(originX, originY, cellSize, cols, rows, elevations)
  }
}

const clampNumber = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v
