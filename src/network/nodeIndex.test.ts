import { describe, expect, it } from 'vitest'
import { CELL_SIZE, NodeIndex } from './nodeIndex'

const RADIUS = 0.5

describe('NodeIndex', () => {
  it('has cells at least as large as the search radius', () => {
    // The neighbourhood scan below only visits cells within one step of the
    // query's own cell. That is sufficient only while a cell is at least as
    // wide as the radius.
    expect(CELL_SIZE).toBeGreaterThanOrEqual(RADIUS)
  })

  it('rejects a search radius larger than the cell size', () => {
    // The neighbourhood scan in `nearby` only visits cells within one step
    // of the query's own cell; a radius bigger than a cell would let a node
    // sit outside that one-step neighbourhood and still be within radius,
    // so the constructor throws rather than build an index that can miss.
    // This was previously only asserted about (the test above compares
    // CELL_SIZE and RADIUS), never actually exercised against the
    // constructor itself.
    expect(() => new NodeIndex(CELL_SIZE + 0.1)).toThrow(RangeError)
  })

  it('accepts a search radius exactly equal to the cell size', () => {
    expect(() => new NodeIndex(CELL_SIZE)).not.toThrow()
  })

  it('finds a node in the same cell', () => {
    const index = new NodeIndex(RADIUS)
    index.insert(7, { x: 1, y: 1 })
    expect(index.nearby({ x: 1.2, y: 1 })).toEqual([7])
  })

  it('finds a node just across a cell boundary', () => {
    const index = new NodeIndex(RADIUS)
    // Straddle the boundary at x = CELL_SIZE: 0.2m apart, different cells.
    index.insert(3, { x: CELL_SIZE - 0.1, y: 0 })
    expect(index.nearby({ x: CELL_SIZE + 0.1, y: 0 })).toEqual([3])
  })

  it('finds a node across a diagonal cell corner', () => {
    const index = new NodeIndex(RADIUS)
    index.insert(4, { x: CELL_SIZE - 0.1, y: CELL_SIZE - 0.1 })
    expect(index.nearby({ x: CELL_SIZE + 0.1, y: CELL_SIZE + 0.1 })).toEqual([4])
  })

  it('works at negative coordinates', () => {
    // NOT FIXED — left as reported to the reviewer, with evidence, rather
    // than reworked to claim a discrimination it cannot have.
    //
    // The finding: this test's node and query happen to land in the same
    // cell once `Math.floor` is replaced by `Math.trunc` in `cellOf`, so it
    // passes under that substitution too and catches nothing.
    //
    // On inspection, no substitute coordinates fix this, because no
    // coordinates can. `Math.trunc(v) === Math.floor(v) + 1` exactly when
    // `v < 0` and non-integer, `0` otherwise — so replacing `floor` with
    // `trunc` in `cellOf` only ever shifts a negative cell index up by
    // exactly 1 or leaves it alone. For any two points within `radius` of
    // each other, `CELL_SIZE >= radius` (enforced by the constructor above)
    // guarantees their floor-cells differ by at most 1 on each axis — that
    // is the whole point of the guard. A shift of at most 1 applied to
    // values already at most 1 apart can shrink that gap (as low as 0, when
    // one point sits exactly on a negative multiple of `CELL_SIZE` and the
    // other doesn't) but can never grow it past 1. Since `nearby`'s scan
    // covers every cell within 1 step, a pair the real (floor) index finds
    // is therefore *always* still found after the substitution — proved
    // exhaustively for every valid radius (0 through `CELL_SIZE`) by brute
    // force against both the arithmetic and the real class with `floor`
    // swapped for `trunc`, and confirmed by direct algebra above. There is
    // no pair of coordinates, negative or otherwise, this test could use
    // that would fail under the `trunc` mutation while still describing
    // real, correct `NodeIndex` behaviour.
    //
    // This test therefore still only demonstrates that negative coordinates
    // resolve to the correct (negative-shifted) cell, not that the
    // implementation must specifically be `floor` rather than `trunc`;
    // that distinction is not observable through this class's public
    // behaviour at all, given `CELL_SIZE=4` and the enforced radius bound.
    const index = new NodeIndex(RADIUS)
    index.insert(5, { x: -CELL_SIZE - 0.1, y: -0.1 })
    expect(index.nearby({ x: -CELL_SIZE - 0.3, y: 0.1 })).toEqual([5])
  })

  it('excludes a node outside the radius but inside the cell', () => {
    const index = new NodeIndex(RADIUS)
    index.insert(1, { x: 0.1, y: 0.1 })
    // Same cell (CELL_SIZE is metres and well over 1), but 1.3m away.
    expect(index.nearby({ x: 1.4, y: 0.1 })).toEqual([])
  })

  it('returns candidates in ascending id order', () => {
    const index = new NodeIndex(RADIUS)
    index.insert(9, { x: 0, y: 0 })
    index.insert(2, { x: 0.1, y: 0 })
    index.insert(5, { x: -0.1, y: 0 })
    expect(index.nearby({ x: 0, y: 0 })).toEqual([2, 5, 9])
  })

  it('forgets a removed node', () => {
    const index = new NodeIndex(RADIUS)
    index.insert(1, { x: 0, y: 0 })
    index.remove(1)
    expect(index.nearby({ x: 0, y: 0 })).toEqual([])
  })

  it('ignores removal of an unknown id', () => {
    const index = new NodeIndex(RADIUS)
    expect(() => index.remove(42)).not.toThrow()
  })
})
