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
  private readonly roadMap = new Map<RoadId, Road>()
  private readonly nodeMap = new Map<
    NodeId,
    { id: NodeId; position: Vec2; ends: RoadEnd[] }
  >()

  /**
   * Identifiers come from a counter, never from a position.
   *
   * The mesh layer, the crossing detector and the scene all hold `RoadId` and
   * `NodeId` keys across rebuilds. An index-derived id would renumber every
   * later element on removal and silently repoint all of them. A counter that
   * never reuses a value means a stale id is a lookup that throws, which is a
   * bug you find, rather than a lookup that succeeds against the wrong road,
   * which is a bug you ship.
   */
  private nextRoadId: RoadId = 0
  private nextNodeId: NodeId = 0

  get roads(): readonly Road[] {
    return [...this.roadMap.values()]
  }

  get nodes(): readonly NetworkNode[] {
    return [...this.nodeMap.values()].map((n) => ({ ...n, ends: [...n.ends] }))
  }

  road(id: RoadId): Road {
    const found = this.roadMap.get(id)
    if (!found) throw new RangeError(`no road with id ${id}`)
    return { ...found }
  }

  node(id: NodeId): NetworkNode {
    const found = this.nodeMap.get(id)
    if (!found) throw new RangeError(`no node with id ${id}`)
    return { ...found, ends: [...found.ends] }
  }

  nodeAt(position: Vec2): NetworkNode | undefined {
    for (const n of this.nodeMap.values()) {
      if (distance(n.position, position) <= NODE_SNAP_DISTANCE) {
        return { ...n, ends: [...n.ends] }
      }
    }
    return undefined
  }

  /** Three or more road ends. Fewer is a dead end or a road passing through. */
  isJunction(id: NodeId): boolean {
    return this.node(id).ends.length >= 3
  }

  addRoad(alignment: Alignment, className: RoadClassName): RoadId {
    if (alignment.isEmpty) {
      throw new RangeError('cannot add a road with an empty alignment')
    }

    const roadId = this.nextRoadId++
    const startPosition = alignment.poseAt(0).position
    const endPosition = alignment.poseAt(alignment.length).position

    const startNode = this.nodeFor(startPosition)
    const endNode = this.nodeFor(endPosition)

    this.nodeMap.get(startNode)!.ends.push({ roadId, end: 'start' })
    this.nodeMap.get(endNode)!.ends.push({ roadId, end: 'end' })

    this.roadMap.set(roadId, { id: roadId, alignment, className, startNode, endNode })
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

    const id = this.nextNodeId++
    this.nodeMap.set(id, { id, position, ends: [] })
    return id
  }

  /**
   * Remove a road and any node it leaves unreferenced.
   *
   * A node exists to record that road ends meet there. Once the last end is
   * gone the node is not an empty junction, it is nothing, and leaving it
   * behind would make it a snap target for roads drawn nowhere near an
   * existing one.
   */
  removeRoad(id: RoadId): void {
    const road = this.roadMap.get(id)
    if (!road) throw new RangeError(`no road with id ${id}`)

    this.roadMap.delete(id)

    // A road may begin and end at the same node; the Set visits it once, and
    // the filter below drops both of that road's ends in that one visit.
    for (const nodeId of new Set([road.startNode, road.endNode])) {
      const node = this.nodeMap.get(nodeId)
      if (!node) continue

      const remaining = node.ends.filter((e) => e.roadId !== id)
      if (remaining.length === 0) {
        this.nodeMap.delete(nodeId)
      } else {
        node.ends = remaining
      }
    }
  }
}
