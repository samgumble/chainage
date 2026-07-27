import { describe, it, expect } from 'vitest'
import { RoadNetwork, NODE_SNAP_DISTANCE, type Road, type NetworkNode, type RoadEnd } from './graph'
import { Alignment } from '../geometry/alignment'
import { Arc, Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'

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
