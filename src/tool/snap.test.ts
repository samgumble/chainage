import { describe, expect, it } from 'vitest'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { RoadNetwork } from '../network/graph'
import { resolveSnap } from './snap'

const straight = (x: number, y: number, heading: number, length: number) =>
  new Alignment([new Line({ x, y }, heading, length)])

describe('resolveSnap', () => {
  it('reports free ground away from everything', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')

    const result = resolveSnap(net, { x: 500, y: 500 }, 20)
    expect(result).toEqual({ kind: 'free', position: { x: 500, y: 500 } })
  })

  it('snaps to a node and reports the node position, not the pointer', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 100), 'rural')
    const startNode = net.road(id).startNode

    const result = resolveSnap(net, { x: 3, y: 4 }, 20)
    expect(result.kind).toBe('node')
    if (result.kind !== 'node') return
    expect(result.nodeId).toBe(startNode)
    expect(result.position).toEqual({ x: 0, y: 0 })
  })

  it('prefers the nearest node when two are in range', () => {
    const net = new RoadNetwork()
    // Node at (0,0) is created first; node at (0,30) is nearer to the query.
    net.addRoad(straight(0, 0, 0, 10), 'rural')
    const second = net.addRoad(straight(0, 30, 0, 10), 'rural')
    const nearer = net.road(second).startNode

    const result = resolveSnap(net, { x: 0, y: 28 }, 50)
    expect(result.kind).toBe('node')
    if (result.kind !== 'node') return
    // Nearest wins here, unlike nodeAt's first-created-wins identity rule.
    expect(result.nodeId).toBe(nearer)
  })

  it('snaps to a road, reporting the station and the point on the centreline', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 200), 'rural')

    const result = resolveSnap(net, { x: 120, y: 6 }, 20)
    expect(result.kind).toBe('road')
    if (result.kind !== 'road') return
    expect(result.roadId).toBe(id)
    expect(result.station).toBeCloseTo(120, 1)
    expect(result.position.x).toBeCloseTo(120, 1)
    expect(result.position.y).toBeCloseTo(0, 6)
  })

  it('prefers a node to a road when both are in range', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 200), 'rural')
    // Near the start node and also right on the road.
    const result = resolveSnap(net, { x: 2, y: 1 }, 20)
    expect(result.kind).toBe('node')
  })

  it('ignores a road outside the radius', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 200), 'rural')
    const result = resolveSnap(net, { x: 100, y: 60 }, 20)
    expect(result.kind).toBe('free')
  })

  it('picks the nearer of two roads', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 200), 'rural')
    const near = net.addRoad(straight(0, 40, 0, 200), 'rural')

    const result = resolveSnap(net, { x: 100, y: 35 }, 20)
    expect(result.kind).toBe('road')
    if (result.kind !== 'road') return
    expect(result.roadId).toBe(near)
  })

  it('returns free ground on an empty network', () => {
    const result = resolveSnap(new RoadNetwork(), { x: 1, y: 2 }, 20)
    expect(result).toEqual({ kind: 'free', position: { x: 1, y: 2 } })
  })
})
