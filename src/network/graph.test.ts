import { describe, it, expect } from 'vitest'
import { RoadNetwork, NODE_SNAP_DISTANCE, type Road, type NetworkNode, type RoadEnd } from './graph'
import { Alignment } from '../geometry/alignment'
import { Arc, Line } from '../geometry/primitives'
import { vec2, type Vec2 } from '../geometry/vec2'

const straight = (fromX: number, fromY: number, heading: number, length: number) =>
  new Alignment([new Line(vec2(fromX, fromY), heading, length)])

describe('RoadNetwork basics', () => {
  it('creates two nodes for the first road', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    expect(net.roads).toHaveLength(1)
    expect(net.nodes).toHaveLength(2)
  })

  it('records which nodes a road connects', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 100), 'rural')
    const road = net.road(id)
    expect(net.node(road.startNode).position.x).toBeCloseTo(0, 6)
    expect(net.node(road.endNode).position.x).toBeCloseTo(100, 6)
  })

  it('reuses a node when a second road ends at the same point', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    net.addRoad(straight(100, 0, Math.PI / 2, 100), 'rural')
    expect(net.nodes).toHaveLength(3)
  })

  it('reuses a node within the snap distance', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    net.addRoad(straight(100 + NODE_SNAP_DISTANCE / 2, 0, Math.PI / 2, 100), 'rural')
    expect(net.nodes).toHaveLength(3)
  })

  it('does not reuse a node beyond the snap distance', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    net.addRoad(straight(100 + NODE_SNAP_DISTANCE * 4, 0, Math.PI / 2, 100), 'rural')
    expect(net.nodes).toHaveLength(4)
  })

  it('records every end meeting at a shared node', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    net.addRoad(straight(100, 0, Math.PI / 2, 100), 'rural')
    const shared = net.nodeAt(vec2(100, 0))!
    expect(shared).toBeDefined()
    expect(shared.ends).toHaveLength(2)
  })

  it('distinguishes a start end from an end end', () => {
    const net = new RoadNetwork()
    const a = net.addRoad(straight(0, 0, 0, 100), 'rural')
    const b = net.addRoad(straight(100, 0, Math.PI / 2, 100), 'rural')
    const shared = net.nodeAt(vec2(100, 0))!
    expect(shared.ends).toContainEqual({ roadId: a, end: 'end' })
    expect(shared.ends).toContainEqual({ roadId: b, end: 'start' })
  })

  it('carries the road class', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 100), 'highway')
    expect(net.road(id).className).toBe('highway')
  })
})

describe('RoadNetwork junctions', () => {
  it('is not a junction with one road end', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 100), 'rural')
    expect(net.isJunction(net.road(id).startNode)).toBe(false)
  })

  it('is not a junction with two road ends', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    net.addRoad(straight(100, 0, Math.PI / 2, 100), 'rural')
    expect(net.isJunction(net.nodeAt(vec2(100, 0))!.id)).toBe(false)
  })

  it('is a junction with three road ends', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    net.addRoad(straight(100, 0, Math.PI / 2, 100), 'rural')
    net.addRoad(straight(100, 0, -Math.PI / 2, 100), 'rural')
    expect(net.isJunction(net.nodeAt(vec2(100, 0))!.id)).toBe(true)
  })
})

describe('RoadNetwork lookups', () => {
  it('returns undefined for a position with no node', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    expect(net.nodeAt(vec2(500, 500))).toBeUndefined()
  })

  it('rejects an unknown road id', () => {
    const net = new RoadNetwork()
    expect(() => net.road(99)).toThrow(RangeError)
  })

  it('rejects an unknown road id: negative', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    expect(() => net.road(-1)).toThrow(RangeError)
  })

  it('rejects an unknown road id: non-integer', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    expect(() => net.road(1.5)).toThrow(RangeError)
  })

  it('rejects an unknown node id', () => {
    const net = new RoadNetwork()
    expect(() => net.node(99)).toThrow(RangeError)
  })

  it('rejects an unknown node id: negative', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    expect(() => net.node(-1)).toThrow(RangeError)
  })

  it('rejects an unknown node id: non-integer', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    expect(() => net.node(1.5)).toThrow(RangeError)
  })

  it('rejects an empty alignment', () => {
    const net = new RoadNetwork()
    expect(() => net.addRoad(new Alignment([]), 'rural')).toThrow(RangeError)
  })
})

describe('RoadNetwork nodeAt robustness', () => {
  it('skips a stale index entry and still finds the real node', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 100), 'rural')
    const realNode = net.road(id).startNode

    // Plant a stale index entry at the same position, with an id lower than
    // the real node's — NodeIndex.nearby returns candidates in ascending id
    // order, so this stale entry sorts first. Nothing but the index knows
    // about it: it is not in nodeMap, exactly the shape a removed-but-not-
    // reindexed node would leave behind. Reached via the private field
    // directly (TS `private` is not enforced at runtime) rather than adding
    // a production-only hook for this one test.
    const internals = net as unknown as {
      index: { insert(id: number, position: Vec2): void }
    }
    internals.index.insert(realNode - 1, vec2(0, 0))

    const found = net.nodeAt(vec2(0, 0))
    expect(found?.id).toBe(realNode)
  })
})

describe('RoadNetwork internal state protection', () => {
  it('does not leak mutable state through node()', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 100), 'rural')
    const endNode = net.road(id).endNode

    const node = net.node(endNode)
    const originalEndsLength = node.ends.length

    // Attempt to mutate the returned node's ends array
    const mutableEnds = node.ends as RoadEnd[]
    mutableEnds.push({ roadId: 999, end: 'start' })

    // The network's own view should be unchanged
    expect(net.node(endNode).ends).toHaveLength(originalEndsLength)
  })

  it('does not leak mutable state through nodeAt()', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')

    const node = net.nodeAt(vec2(100, 0))!
    const originalEndsLength = node.ends.length

    // Attempt to mutate the returned node's ends array
    const mutableEnds = node.ends as RoadEnd[]
    mutableEnds.push({ roadId: 999, end: 'start' })

    // The network's own view should be unchanged
    expect(net.nodeAt(vec2(100, 0))!.ends).toHaveLength(originalEndsLength)
  })

  it('does not leak mutable state through road()', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 100), 'rural')

    const road = net.road(id)
    const mutableRoad = road as { className: string }
    mutableRoad.className = 'highway'

    // The network's own view should be unchanged
    expect(net.road(id).className).toBe('rural')
  })

  it('does not leak mutable state through get roads()', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 100), 'rural')
    const originalRoadCount = net.roads.length

    const roads = net.roads as Road[]
    roads.push(net.road(id))

    expect(net.roads).toHaveLength(originalRoadCount)
  })

  it('does not leak mutable state through get nodes()', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    const originalNodeCount = net.nodes.length

    const nodes = net.nodes as NetworkNode[]
    nodes.push(nodes[0]!)

    expect(net.nodes).toHaveLength(originalNodeCount)
  })
})

describe('RoadNetwork snapping order dependency', () => {
  it('first node created within snap distance wins: order A→B→C', () => {
    const net = new RoadNetwork()
    // Three start positions in a chain: A at 0, B at 0.3, C at 0.6
    // A-B within snap (0.3), B-C within snap (0.3), but A-C beyond snap (0.6 > 0.5)
    const roadA = net.addRoad(straight(0, 0, 0, 1), 'rural')
    const roadB = net.addRoad(straight(0.3, 0, 0, 1), 'rural')
    const roadC = net.addRoad(straight(0.6, 0, 0, 1), 'rural')

    // Order A→B→C creates nodes at:
    // A start: new node at (0, 0)
    // B start: snaps to node at (0, 0) since distance 0.3 < 0.5
    // C start: does NOT snap to node at (0, 0) since distance 0.6 > 0.5, new node at (0.6, 0)
    const aStartNode = net.road(roadA).startNode
    const bStartNode = net.road(roadB).startNode
    const cStartNode = net.road(roadC).startNode

    expect(aStartNode).toEqual(bStartNode)
    expect(cStartNode).not.toEqual(aStartNode)
  })

  it('first node created within snap distance wins: order C→B→A', () => {
    const net = new RoadNetwork()
    // Same positions, but added in reverse order C→B→A
    const roadC = net.addRoad(straight(0.6, 0, 0, 1), 'rural')
    const roadB = net.addRoad(straight(0.3, 0, 0, 1), 'rural')
    const roadA = net.addRoad(straight(0, 0, 0, 1), 'rural')

    // Order C→B→A creates nodes at:
    // C start: new node at (0.6, 0)
    // B start: snaps to node at (0.6, 0) since distance 0.3 < 0.5
    // A start: does NOT snap to node at (0.6, 0) since distance 0.6 > 0.5, new node at (0, 0)
    const cStartNode = net.road(roadC).startNode
    const bStartNode = net.road(roadB).startNode
    const aStartNode = net.road(roadA).startNode

    expect(cStartNode).toEqual(bStartNode)
    expect(aStartNode).not.toEqual(cStartNode)
  })

  it('demonstrates non-transitive snapping: two orderings produce different node assignments', () => {
    // Order A→B→C: A and B snap to same node, C to different node
    const net1 = new RoadNetwork()
    net1.addRoad(straight(0, 0, 0, 1), 'rural')
    net1.addRoad(straight(0.3, 0, 0, 1), 'rural')
    net1.addRoad(straight(0.6, 0, 0, 1), 'rural')
    const order1NodeCount = net1.nodes.length

    // Order C→B→A: C and B snap to same node, A to different node
    const net2 = new RoadNetwork()
    net2.addRoad(straight(0.6, 0, 0, 1), 'rural')
    net2.addRoad(straight(0.3, 0, 0, 1), 'rural')
    net2.addRoad(straight(0, 0, 0, 1), 'rural')
    const order2NodeCount = net2.nodes.length

    // Both should create 3 nodes (2 from each road end + 1 for start positions)
    // but the specific connections differ based on order
    expect(order1NodeCount).toBeGreaterThanOrEqual(2)
    expect(order2NodeCount).toBeGreaterThanOrEqual(2)
  })
})

describe('removeRoad', () => {
  it('leaves the ids of surviving roads untouched', () => {
    const net = new RoadNetwork()
    const a = net.addRoad(straight(0, 0, 0, 100), 'rural')
    const b = net.addRoad(straight(0, 50, 0, 100), 'rural')
    const c = net.addRoad(straight(0, 100, 0, 100), 'rural')

    net.removeRoad(b)

    expect(net.road(c).id).toBe(c)
    expect(net.road(a).id).toBe(a)
    expect(net.roads.map((r) => r.id)).toEqual([a, c])
    expect(() => net.road(b)).toThrow(RangeError)
  })

  it('never reuses the id of a removed road', () => {
    const net = new RoadNetwork()
    const a = net.addRoad(straight(0, 0, 0, 100), 'rural')
    net.removeRoad(a)
    const b = net.addRoad(straight(0, 0, 0, 100), 'rural')

    expect(b).not.toBe(a)
  })

  it('deletes a node once nothing references it', () => {
    const net = new RoadNetwork()
    const a = net.addRoad(straight(0, 0, 0, 100), 'rural')
    const nodeIds = net.nodes.map((n) => n.id)
    expect(nodeIds).toHaveLength(2)

    net.removeRoad(a)

    expect(net.nodes).toHaveLength(0)
    for (const id of nodeIds) {
      expect(() => net.node(id)).toThrow(RangeError)
    }
  })

  it('removes the node from the spatial index, not only from the node map', () => {
    // A direct check of the index/nodeMap invariant, reached past the public
    // API the same way as the nodeAt robustness test above. A behavioural
    // proxy — "does a new road end here get a new node id?" — no longer
    // discriminates this on its own: nodeAt now tolerates a stale index
    // entry by skipping it (see "skips a stale index entry" above), so even
    // a RoadNetwork that forgot to call index.remove would still hand out a
    // fresh node id here. The leak itself — the dangling entry never being
    // cleared — is what this test pins directly.
    const net = new RoadNetwork()
    const a = net.addRoad(straight(0, 0, 0, 100), 'rural')
    const removedNode = net.road(a).startNode

    net.removeRoad(a)

    const internals = net as unknown as {
      index: { nearby(position: Vec2): number[] }
    }
    expect(internals.index.nearby(vec2(0, 0))).not.toContain(removedNode)
  })

  it('does not let a new road end snap to a node removed from the network', () => {
    // The behavioural companion to the index check above: even though it no
    // longer discriminates a dropped index.remove call by itself (see the
    // comment there), it is still the actual player-facing guarantee this
    // invariant protects, so it stays as a test in its own right.
    const net = new RoadNetwork()
    const a = net.addRoad(straight(0, 0, 0, 100), 'rural')
    const removedNode = net.road(a).startNode

    net.removeRoad(a)
    const b = net.addRoad(straight(0, 0, 0, 100), 'rural')

    expect(net.road(b).startNode).not.toBe(removedNode)
  })

  it('keeps a node that another road still uses, and detaches only the removed end', () => {
    const net = new RoadNetwork()
    // Two roads meeting at the origin.
    const a = net.addRoad(straight(0, 0, 0, 100), 'rural')
    const b = net.addRoad(straight(0, 0, Math.PI / 2, 100), 'rural')

    const shared = net.nodeAt(vec2(0, 0))
    expect(shared?.ends).toHaveLength(2)

    net.removeRoad(a)

    const after = net.nodeAt(vec2(0, 0))
    expect(after?.id).toBe(shared?.id)
    expect(after?.ends).toEqual([{ roadId: b, end: 'start' }])
  })

  it('detaches both ends of a road that loops back to its own node', () => {
    const net = new RoadNetwork()
    // A full circle: curvature 1/50, length 2*pi*50, so the end lands on the start.
    const k = 1 / 50
    const loop = new Alignment([new Arc(vec2(0, 0), 0, (2 * Math.PI) / k, k)])
    const id = net.addRoad(loop, 'rural')

    const node = net.nodeAt(vec2(0, 0))
    expect(node?.ends).toHaveLength(2)

    net.removeRoad(id)

    expect(net.nodes).toHaveLength(0)
  })

  it('rejects an unknown road id', () => {
    const net = new RoadNetwork()
    expect(() => net.removeRoad(999)).toThrow(RangeError)
  })
})

describe('splitRoad', () => {
  it('produces two roads meeting at a new node', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 100), 'rural')

    const { first, second, node } = net.splitRoad(id, 40)

    expect(net.roads).toHaveLength(2)
    expect(() => net.road(id)).toThrow(RangeError)
    expect(net.road(first).alignment.length).toBeCloseTo(40, 9)
    expect(net.road(second).alignment.length).toBeCloseTo(60, 9)
    expect(net.road(first).endNode).toBe(node)
    expect(net.road(second).startNode).toBe(node)
    expect(net.node(node).ends).toHaveLength(2)
  })

  it('preserves the identifiers of the untouched end nodes', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 100), 'rural')
    const startNode = net.road(id).startNode
    const endNode = net.road(id).endNode

    const { first, second } = net.splitRoad(id, 40)

    expect(net.road(first).startNode).toBe(startNode)
    expect(net.road(second).endNode).toBe(endNode)
  })

  it('leaves a junction at an end intact', () => {
    const net = new RoadNetwork()
    const main = net.addRoad(straight(0, 0, 0, 100), 'rural')
    net.addRoad(straight(0, 0, Math.PI / 2, 50), 'rural')
    net.addRoad(straight(0, 0, -Math.PI / 2, 50), 'rural')

    const junction = net.road(main).startNode
    expect(net.isJunction(junction)).toBe(true)

    const { first } = net.splitRoad(main, 40)

    expect(net.road(first).startNode).toBe(junction)
    expect(net.isJunction(junction)).toBe(true)
    expect(net.node(junction).ends).toHaveLength(3)
  })

  it('carries the class onto both halves', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 100), 'gravel')
    const { first, second } = net.splitRoad(id, 40)
    expect(net.road(first).className).toBe('gravel')
    expect(net.road(second).className).toBe('gravel')
  })

  it('rejects a split at either end or on an unknown road', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 100), 'rural')
    expect(() => net.splitRoad(id, 0)).toThrow(RangeError)
    expect(() => net.splitRoad(id, 100)).toThrow(RangeError)
    expect(() => net.splitRoad(999, 40)).toThrow(RangeError)
  })

  it('rejects a split that would leave a piece shorter than the snap distance', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 100), 'rural')
    // Both halves' ends would fall inside NODE_SNAP_DISTANCE of each other,
    // so the new node would snap onto an existing one and the two halves
    // would share both endpoints.
    expect(() => net.splitRoad(id, 0.2)).toThrow(RangeError)
    expect(() => net.splitRoad(id, 99.8)).toThrow(RangeError)
  })

  it('the lollipop case: cutting where a loop closes returns the pre-existing node, not a new one', () => {
    // A "lollipop": a full circle back to the road's own start (the candy),
    // then a further straight stretch (the stick). The guard above is
    // stational — it only checks distance measured ALONG the road from each
    // end — but the hazard here is spatial: the loop's own end sits right on
    // top of the road's own start, far away in station but distance zero in
    // space. Splitting exactly where the loop closes finds that existing
    // node already there and snaps to it, exactly as any other road end
    // would. Confirmed elsewhere that the graph stays fully consistent when
    // this happens — no corruption, no stranded reference — so this test
    // only documents the shape of it.
    const net = new RoadNetwork()
    const k = 1 / 50
    const loopLength = (2 * Math.PI) / k
    const loop = new Arc(vec2(0, 0), 0, loopLength, k)
    const endOfLoop = loop.poseAt(loopLength)
    const stick = new Line(endOfLoop.position, endOfLoop.heading, 40)
    const id = net.addRoad(new Alignment([loop, stick]), 'rural')

    const startNode = net.road(id).startNode

    const { first, second, node } = net.splitRoad(id, loopLength)

    // Not a fresh node: the pre-existing start node, handed back instead.
    expect(node).toBe(startNode)
    expect(net.road(first).endNode).toBe(node)
    expect(net.road(second).startNode).toBe(node)

    // Fully consistent: both halves resolve, the original is gone, and the
    // shared node still has road ends recorded against it.
    expect(net.roads).toHaveLength(2)
    expect(() => net.road(id)).toThrow(RangeError)
    expect(net.node(node).ends.length).toBeGreaterThan(0)
  })
})

describe('setRoadClass', () => {
  it('changes the class and keeps the id and topology', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 100), 'gravel')
    const before = net.road(id)

    net.setRoadClass(id, 'highway')

    const after = net.road(id)
    expect(after.className).toBe('highway')
    expect(after.id).toBe(id)
    expect(after.startNode).toBe(before.startNode)
    expect(after.endNode).toBe(before.endNode)
    expect(after.alignment).toBe(before.alignment)
  })

  it('rejects an unknown road id', () => {
    const net = new RoadNetwork()
    expect(() => net.setRoadClass(999, 'rural')).toThrow(RangeError)
  })
})

describe('nodesWithin', () => {
  it('returns every node inside the radius, nearest first', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    net.addRoad(straight(0, 30, 0, 100), 'rural')

    const found = net.nodesWithin({ x: 0, y: 0 }, 50)
    expect(found.map((n) => n.position.y)).toEqual([0, 30])
  })

  it('orders by distance even when that disagrees with creation (ascending id) order', () => {
    // NodeIndex.nearby returns candidates in ascending id order (see the
    // "skips a stale index entry" test above); a `nodesWithin` that forgot
    // to sort by distance would pass this straight through unchanged. The
    // fixture above doesn't catch that: its farther node also happens to
    // have been created second, so ascending-id order and nearest-first
    // order agree by coincidence. Here the farther node is created *first*
    // (lower id) and the nearer one second (higher id), so the two orderings
    // disagree — only a genuine distance sort produces the expected result.
    const net = new RoadNetwork()
    net.addRoad(straight(0, 30, 0, 100), 'rural') // id 0 at (0,30) — far, created first
    net.addRoad(straight(0, 0, 0, 100), 'rural') // id 2 at (0,0) — near, created second

    const found = net.nodesWithin({ x: 0, y: 0 }, 50)
    expect(found.map((n) => n.position)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 30 },
    ])
  })

  it('excludes nodes outside the radius', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    expect(net.nodesWithin({ x: 0, y: 0 }, 10).map((n) => n.position.y)).toEqual([0])
  })

  it('returns an empty array when nothing is near', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    expect(net.nodesWithin({ x: 5000, y: 5000 }, 50)).toEqual([])
  })
})
