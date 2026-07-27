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
