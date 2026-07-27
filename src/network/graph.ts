import type { Alignment } from '../geometry/alignment'
import { type Vec2, distance } from '../geometry/vec2'
import type { RoadClassName } from '../mesh/roadClass'

export type NodeId = number
export type RoadId = number

/** Which end of which road. A road contributes one of each to the network. */
export type RoadEnd = {
  readonly roadId: RoadId
  readonly end: 'start' | 'end'
}

export type NetworkNode = {
  readonly id: NodeId
  readonly position: Vec2
  readonly ends: readonly RoadEnd[]
}

export type Road = {
  readonly id: RoadId
  readonly alignment: Alignment
  readonly className: RoadClassName
  readonly startNode: NodeId
  readonly endNode: NodeId
}

/**
 * Two road ends closer than this are treated as the same node.
 *
 * Half a metre: far below any meaningful road separation, far above the
 * floating-point noise of two alignments computed independently.
 *
 * **Order-dependent behavior:** The first node created within this distance of a
 * position "wins" — subsequent ends within the radius snap to that node. Snapping
 * does NOT transitively merge: a chain of ends each within the radius of the last
 * does not merge into a single node if the first and last are beyond the radius.
 */
export const NODE_SNAP_DISTANCE = 0.5

/**
 * Which roads exist and which ends meet where.
 *
 * Pure topology over alignment references. No geometry is generated here —
 * junction surfaces and trimmed ribbons belong to `src/mesh/`. Keeping the
 * graph free of geometry means it can be queried, mutated and reasoned about
 * without touching a vertex buffer.
 */
export class RoadNetwork {
  private readonly roadList: Road[] = []
  private readonly nodeList: { id: NodeId; position: Vec2; ends: RoadEnd[] }[] = []

  get roads(): readonly Road[] {
    return [...this.roadList]
  }

  get nodes(): readonly NetworkNode[] {
    return this.nodeList.map((n) => ({ ...n, ends: [...n.ends] }))
  }

  road(id: RoadId): Road {
    const found = this.roadList[id]
    if (!found) throw new RangeError(`no road with id ${id}`)
    return { ...found }
  }

  node(id: NodeId): NetworkNode {
    const found = this.nodeList[id]
    if (!found) throw new RangeError(`no node with id ${id}`)
    return { ...found, ends: [...found.ends] }
  }

  nodeAt(position: Vec2): NetworkNode | undefined {
    const found = this.nodeList.find(
      (n) => distance(n.position, position) <= NODE_SNAP_DISTANCE,
    )
    return found ? { ...found, ends: [...found.ends] } : undefined
  }

  /** Three or more road ends. Fewer is a dead end or a road passing through. */
  isJunction(id: NodeId): boolean {
    return this.node(id).ends.length >= 3
  }

  addRoad(alignment: Alignment, className: RoadClassName): RoadId {
    if (alignment.isEmpty) {
      throw new RangeError('cannot add a road with an empty alignment')
    }

    const roadId = this.roadList.length
    const startPosition = alignment.poseAt(0).position
    const endPosition = alignment.poseAt(alignment.length).position

    const startNode = this.nodeFor(startPosition)
    const endNode = this.nodeFor(endPosition)

    this.nodeList[startNode]!.ends.push({ roadId, end: 'start' })
    this.nodeList[endNode]!.ends.push({ roadId, end: 'end' })

    this.roadList.push({ id: roadId, alignment, className, startNode, endNode })
    return roadId
  }

  /**
   * An existing node within snapping distance, or a new one.
   *
   * Snapping is order-dependent: the first node created at a location wins.
   * If multiple road ends are added at positions within NODE_SNAP_DISTANCE,
   * they snap to whichever node was created first — not necessarily to a
   * common node, since snapping does not transitively merge a chain of ends
   * each within the radius of the last.
   */
  private nodeFor(position: Vec2): NodeId {
    const existing = this.nodeAt(position)
    if (existing) return existing.id

    const id = this.nodeList.length
    this.nodeList.push({ id, position, ends: [] })
    return id
  }
}
