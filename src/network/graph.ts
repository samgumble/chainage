import type { Alignment } from '../geometry/alignment'
import { splitAlignment } from '../geometry/split'
import { distance, type Vec2 } from '../geometry/vec2'
import type { RoadClassName } from './roadClass'
import { NodeIndex } from './nodeIndex'

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
  private readonly index = new NodeIndex(NODE_SNAP_DISTANCE)

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

  /**
   * Whether a road with this id still exists.
   *
   * An O(1) map lookup — the question a caller that only needs a yes/no
   * answer should ask, rather than either `road()` (throws, and copies the
   * road) or scanning `roads` (copies every road in the network just to
   * check membership).
   */
  hasRoad(id: RoadId): boolean {
    return this.roadMap.has(id)
  }

  node(id: NodeId): NetworkNode {
    const found = this.nodeMap.get(id)
    if (!found) throw new RangeError(`no node with id ${id}`)
    return { ...found, ends: [...found.ends] }
  }

  nodeAt(position: Vec2): NetworkNode | undefined {
    for (const candidate of this.index.nearby(position)) {
      const found = this.nodeMap.get(candidate)
      if (found) return { ...found, ends: [...found.ends] }
    }
    return undefined
  }

  /** Three or more road ends. Fewer is a dead end or a road passing through. */
  isJunction(id: NodeId): boolean {
    return this.node(id).ends.length >= 3
  }

  /**
   * Every node within a radius, nearest first.
   *
   * Distinct from `nodeAt`, which answers a different question: whether a
   * position *is* an existing node, at the half-metre threshold that defines
   * topological identity, resolving ties to the earliest-created node. This
   * answers what is nearby, at whatever radius the caller finds useful, and
   * orders by distance because a caller asking this is choosing between
   * candidates rather than establishing identity.
   */
  nodesWithin(position: Vec2, radius: number): NetworkNode[] {
    return this.index
      .nearby(position, radius)
      .flatMap((id) => {
        const found = this.nodeMap.get(id)
        return found ? [{ ...found, ends: [...found.ends] }] : []
      })
      .sort(
        (a, b) => distance(a.position, position) - distance(b.position, position),
      )
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
    this.index.insert(id, position)
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
        this.index.remove(nodeId)
      } else {
        node.ends = remaining
      }
    }
  }

  /**
   * Divide a road at a station into two roads meeting at the node they share.
   *
   * That shared node is usually new — but not always. If the cut position
   * falls within `NODE_SNAP_DISTANCE` of an already-existing node, the halves
   * snap to that node instead, the same as any other road end would. This is
   * reachable without any error: a "lollipop" road that loops back to meet
   * its own start and then keeps going, cut where the loop closes, hands
   * back its own pre-existing start node rather than a fresh one (see
   * `graph.test.ts` for a worked example). The graph stays fully consistent
   * either way — this is a contract detail to know about, not a bug to guard
   * against.
   *
   * Both halves are added before the original is removed. Removing first
   * would drop the original's last reference to its own end nodes, delete
   * them as orphans, and hand the halves freshly allocated ids for junctions
   * the split never touched — silently repointing every `NodeId` the mesh
   * layer holds for those junctions.
   */
  splitRoad(
    id: RoadId,
    s: number,
  ): { readonly first: RoadId; readonly second: RoadId; readonly node: NodeId } {
    const road = this.roadMap.get(id)
    if (!road) throw new RangeError(`no road with id ${id}`)

    if (s <= NODE_SNAP_DISTANCE || s >= road.alignment.length - NODE_SNAP_DISTANCE) {
      throw new RangeError(
        `split station ${s} must leave at least ${NODE_SNAP_DISTANCE}m on each side of a road ${road.alignment.length}m long`,
      )
    }

    const [head, tail] = splitAlignment(road.alignment, s)

    const first = this.addRoad(head, road.className)
    const second = this.addRoad(tail, road.className)
    this.removeRoad(id)

    return { first, second, node: this.road(first).endNode }
  }

  /**
   * Change a road's class.
   *
   * Deliberately unconditional: legality is `checkClassChange`'s job and, for
   * junctions, `checkUpgrade`'s. Folding the check in here would make the
   * graph import the mesh layer to ask about junction geometry, inverting the
   * dependency direction. The caller checks, then commits.
   */
  setRoadClass(id: RoadId, className: RoadClassName): void {
    const road = this.roadMap.get(id)
    if (!road) throw new RangeError(`no road with id ${id}`)
    this.roadMap.set(id, { ...road, className })
  }
}
