import { describe, it, expect } from 'vitest'
import { findCrossings, MIN_OVERPASS_CLEARANCE } from './crossings'
import { RoadNetwork, type RoadId } from './graph'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import type { ProfilePoint } from '../terrain/groundProfile'

const level = (length: number, z: number): ProfilePoint[] => [{ s: 0, z }, { s: length, z }]

/** Two roads crossing at (100, 0) at the given elevations, sharing no node. */
const crossingPair = (zA: number, zB: number) => {
  const net = new RoadNetwork()
  const a = net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 200)]), 'rural')
  const b = net.addRoad(new Alignment([new Line(vec2(100, -100), Math.PI / 2, 200)]), 'rural')
  const designs = new Map<RoadId, ProfilePoint[]>([[a, level(200, zA)], [b, level(200, zB)]])
  return { net, designs, a, b }
}

describe('findCrossings', () => {
  it('finds a crossing where two roads cross', () => {
    const { net, designs } = crossingPair(100, 108)
    expect(findCrossings(net, designs)).toHaveLength(1)
  })

  it('finds nothing where roads do not cross', () => {
    const net = new RoadNetwork()
    const a = net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 100)]), 'rural')
    const b = net.addRoad(new Alignment([new Line(vec2(0, 500), 0, 100)]), 'rural')
    const designs = new Map<RoadId, ProfilePoint[]>([[a, level(100, 100)], [b, level(100, 100)]])
    expect(findCrossings(net, designs)).toEqual([])
  })

  it('excludes roads that share a node — that is a junction', () => {
    const net = new RoadNetwork()
    const a = net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 100)]), 'rural')
    const b = net.addRoad(new Alignment([new Line(vec2(100, 0), Math.PI / 2, 100)]), 'rural')
    const designs = new Map<RoadId, ProfilePoint[]>([[a, level(100, 100)], [b, level(100, 100)]])
    expect(findCrossings(net, designs)).toEqual([])
  })

  it('locates the crossing point', () => {
    const { net, designs } = crossingPair(100, 108)
    const c = findCrossings(net, designs)[0]!
    expect(c.position.x).toBeCloseTo(100, 0)
    expect(c.position.y).toBeCloseTo(0, 0)
  })

  it('names the higher road as upper', () => {
    const { net, designs, b } = crossingPair(100, 108)
    expect(findCrossings(net, designs)[0]!.upper).toBe(b)
  })

  it('names the lower road as lower', () => {
    const { net, designs, a } = crossingPair(100, 108)
    expect(findCrossings(net, designs)[0]!.lower).toBe(a)
  })

  it('reports the vertical gap as clearance', () => {
    const { net, designs } = crossingPair(100, 108)
    expect(findCrossings(net, designs)[0]!.clearance).toBeCloseTo(8, 0)
  })

  it('reports a small clearance for roads at the same level', () => {
    const { net, designs } = crossingPair(100, 100)
    expect(findCrossings(net, designs)[0]!.clearance).toBeCloseTo(0, 1)
  })

  it('never reports a negative clearance', () => {
    const { net, designs } = crossingPair(108, 100)
    expect(findCrossings(net, designs)[0]!.clearance).toBeGreaterThanOrEqual(0)
  })

  it('records a station on each road', () => {
    const { net, designs } = crossingPair(100, 108)
    const c = findCrossings(net, designs)[0]!
    expect(c.upperStation).toBeGreaterThan(0)
    expect(c.lowerStation).toBeGreaterThan(0)
  })

  it('finds two crossings where a road crosses two others', () => {
    const net = new RoadNetwork()
    const spine = net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 400)]), 'rural')
    const first = net.addRoad(new Alignment([new Line(vec2(100, -50), Math.PI / 2, 100)]), 'rural')
    const second = net.addRoad(new Alignment([new Line(vec2(300, -50), Math.PI / 2, 100)]), 'rural')
    const designs = new Map<RoadId, ProfilePoint[]>([
      [spine, level(400, 100)], [first, level(100, 110)], [second, level(100, 110)],
    ])
    expect(findCrossings(net, designs)).toHaveLength(2)
  })

  it('rejects non-positive spacing', () => {
    const { net, designs } = crossingPair(100, 108)
    expect(() => findCrossings(net, designs, 0)).toThrow(RangeError)
  })

  it('exports a sane minimum clearance', () => {
    expect(MIN_OVERPASS_CLEARANCE).toBeGreaterThan(3)
    expect(MIN_OVERPASS_CLEARANCE).toBeLessThan(10)
  })
})
