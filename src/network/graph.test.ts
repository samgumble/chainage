import { describe, it, expect } from 'vitest'
import { RoadNetwork, NODE_SNAP_DISTANCE } from './graph'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
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

  it('rejects an unknown node id', () => {
    const net = new RoadNetwork()
    expect(() => net.node(99)).toThrow(RangeError)
  })

  it('rejects an empty alignment', () => {
    const net = new RoadNetwork()
    expect(() => net.addRoad(new Alignment([]), 'rural')).toThrow(RangeError)
  })
})
