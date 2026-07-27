import { type Vec2, distance } from '../geometry/vec2'

/**
 * Grid cell size, metres.
 *
 * Must be at least the search radius, or the one-cell neighbourhood scan in
 * `nearby` would miss a node two cells away. Four metres keeps the
 * neighbourhood small while making the cell count for a city-sized network
 * comfortably sparse.
 */
export const CELL_SIZE = 4

/**
 * A uniform grid over node positions.
 *
 * Deliberately holds ids, not nodes: the graph owns node state, and a second
 * copy of a position that the graph can change is a desynchronisation waiting
 * to happen. The graph re-inserts on move.
 */
export class NodeIndex {
  private readonly cells = new Map<string, number[]>()
  private readonly positions = new Map<number, Vec2>()

  constructor(private readonly radius: number) {
    if (radius > CELL_SIZE) {
      throw new RangeError(
        `search radius ${radius} exceeds cell size ${CELL_SIZE}; the neighbourhood scan would miss nodes`,
      )
    }
  }

  private static key(cx: number, cy: number): string {
    return `${cx},${cy}`
  }

  private static cellOf(position: Vec2): [number, number] {
    return [Math.floor(position.x / CELL_SIZE), Math.floor(position.y / CELL_SIZE)]
  }

  insert(id: number, position: Vec2): void {
    this.remove(id)
    const [cx, cy] = NodeIndex.cellOf(position)
    const key = NodeIndex.key(cx, cy)
    const bucket = this.cells.get(key)
    if (bucket) bucket.push(id)
    else this.cells.set(key, [id])
    this.positions.set(id, position)
  }

  remove(id: number): void {
    const position = this.positions.get(id)
    if (!position) return
    const [cx, cy] = NodeIndex.cellOf(position)
    const key = NodeIndex.key(cx, cy)
    const bucket = this.cells.get(key)
    if (bucket) {
      const next = bucket.filter((n) => n !== id)
      if (next.length === 0) this.cells.delete(key)
      else this.cells.set(key, next)
    }
    this.positions.delete(id)
  }

  /**
   * Every indexed id within the radius of a position, ascending.
   *
   * Ascending order is not cosmetic. Ids are allocated from a counter, so
   * ascending id is creation order, and the graph's documented snapping rule
   * is that the first node created at a location wins. A grid scan visits
   * cells in an order that has nothing to do with creation, so the sort is
   * what keeps the answer identical to the linear scan it replaces.
   */
  nearby(position: Vec2): number[] {
    const [cx, cy] = NodeIndex.cellOf(position)
    const found: number[] = []

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this.cells.get(NodeIndex.key(cx + dx, cy + dy))
        if (!bucket) continue
        for (const id of bucket) {
          const p = this.positions.get(id)
          if (p && distance(p, position) <= this.radius) found.push(id)
        }
      }
    }

    return found.sort((a, b) => a - b)
  }
}
