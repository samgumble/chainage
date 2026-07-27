import { describe, it, expect } from 'vitest'
import { findCrossings, MIN_OVERPASS_CLEARANCE } from './crossings'
import { RoadNetwork, type RoadId, NODE_SNAP_DISTANCE } from './graph'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2, distance } from '../geometry/vec2'
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

  it('reports a genuine crossing away from a node two roads also share', () => {
    const net = new RoadNetwork()

    // Road A: a straight spine from (0, 0) to (200, 0).
    const a = net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 200)]), 'rural')

    // Road B starts exactly at A's end node (200, 0) — a genuine junction —
    // then loops up and back down, crossing A a second time mid-span. Two
    // Line segments: up to (200, 50), then diagonally down through y=0 to
    // (50, -50).
    const p0 = vec2(200, 0)
    const p1 = vec2(200, 50)
    const p2 = vec2(50, -50)
    const seg1Heading = Math.atan2(p1.y - p0.y, p1.x - p0.x)
    const seg1Length = Math.hypot(p1.x - p0.x, p1.y - p0.y)
    const seg2Heading = Math.atan2(p2.y - p1.y, p2.x - p1.x)
    const seg2Length = Math.hypot(p2.x - p1.x, p2.y - p1.y)

    const b = net.addRoad(
      new Alignment([
        new Line(p0, seg1Heading, seg1Length),
        new Line(p1, seg2Heading, seg2Length),
      ]),
      'rural',
    )

    const designs = new Map<RoadId, ProfilePoint[]>([
      [a, level(200, 100)],
      [b, level(seg1Length + seg2Length, 108)],
    ])

    const crossings = findCrossings(net, designs)
    expect(crossings).toHaveLength(1)

    const crossing = crossings[0]!
    // The genuine crossing sits near the diagonal segment's midpoint
    // (x=125), well clear of the shared node at (200, 0).
    expect(crossing.position.x).toBeCloseTo(125, 0)
    expect(crossing.position.y).toBeCloseTo(0, 0)
    expect(distance(crossing.position, p0)).toBeGreaterThan(NODE_SNAP_DISTANCE)
  })

  it('finds both crossings where two roads cross twice and share no node', () => {
    const net = new RoadNetwork()

    // Road A: a straight spine from (0, 0) to (400, 0).
    const a = net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 400)]), 'rural')

    // Road B is a two-segment zigzag that dips below the spine, crosses up
    // through it, back down through it, ending below again — crossing A
    // twice without either road's endpoints coming near the other's. This is
    // simpler than an S-curve of two opposed Arcs and produces the same
    // double crossing, so it is used here instead.
    const q0 = vec2(100, -50)
    const q1 = vec2(150, 50)
    const q2 = vec2(300, -50)
    const seg1Heading = Math.atan2(q1.y - q0.y, q1.x - q0.x)
    const seg1Length = Math.hypot(q1.x - q0.x, q1.y - q0.y)
    const seg2Heading = Math.atan2(q2.y - q1.y, q2.x - q1.x)
    const seg2Length = Math.hypot(q2.x - q1.x, q2.y - q1.y)

    const b = net.addRoad(
      new Alignment([
        new Line(q0, seg1Heading, seg1Length),
        new Line(q1, seg2Heading, seg2Length),
      ]),
      'rural',
    )

    const designs = new Map<RoadId, ProfilePoint[]>([
      [a, level(400, 100)],
      [b, level(seg1Length + seg2Length, 108)],
    ])

    const crossings = findCrossings(net, designs)
    expect(crossings).toHaveLength(2)

    const xs = crossings.map((c) => c.position.x).sort((x, y) => x - y)
    expect(xs[0]).toBeCloseTo(125, 0)
    expect(xs[1]).toBeCloseTo(225, 0)
    expect(xs[1]! - xs[0]!).toBeGreaterThan(NODE_SNAP_DISTANCE)
  })

  it('does not double-report a crossing landing on a polyline sample vertex', () => {
    const net = new RoadNetwork()
    const a = net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 200)]), 'rural')
    const b = net.addRoad(new Alignment([new Line(vec2(100, -100), Math.PI / 2, 200)]), 'rural')
    const designs = new Map<RoadId, ProfilePoint[]>([[a, level(200, 100)], [b, level(200, 108)]])

    // Default spacing is 5m, and x=100 is a sample station on both
    // polylines, so the crossing at (100, 0) lands exactly on a vertex of
    // each — the case where the same intersection can be found twice, once
    // per adjoining segment.
    expect(findCrossings(net, designs)).toHaveLength(1)
  })

  it('omits a crossing where neither road has a design profile', () => {
    const { net } = crossingPair(100, 108)
    expect(findCrossings(net, new Map())).toHaveLength(0)
  })

  it('omits a crossing where only one road has a design profile', () => {
    const { net, a } = crossingPair(100, 108)
    const designs = new Map<RoadId, ProfilePoint[]>([[a, level(200, 100)]])
    expect(findCrossings(net, designs)).toHaveLength(0)
  })

  it('omits a crossing where a road has an empty design profile', () => {
    const { net, a, b } = crossingPair(100, 108)
    const designs = new Map<RoadId, ProfilePoint[]>([[a, level(200, 100)], [b, []]])
    expect(findCrossings(net, designs)).toHaveLength(0)
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
