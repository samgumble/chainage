import { describe, it, expect } from 'vitest'
import { buildNetworkMesh, MAX_JUNCTION_ELEVATION_SPREAD } from './networkMesh'
import { RoadNetwork } from '../network/graph'
import { Alignment } from '../geometry/alignment'
import { Line, Arc } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import type { ProfilePoint } from '../terrain/groundProfile'
import type { RoadId } from '../network/graph'

const level = (length: number, z: number): ProfilePoint[] => [{ s: 0, z }, { s: length, z }]

/** Three rural roads meeting at (100, 0). */
const tJunction = () => {
  const net = new RoadNetwork()
  const west = net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 100)]), 'rural')
  const north = net.addRoad(new Alignment([new Line(vec2(100, 0), Math.PI / 2, 100)]), 'rural')
  const south = net.addRoad(new Alignment([new Line(vec2(100, 0), -Math.PI / 2, 100)]), 'rural')
  const designs = new Map<RoadId, ProfilePoint[]>([
    [west, level(100, 50)], [north, level(100, 50)], [south, level(100, 50)],
  ])
  return { net, designs, west, north, south }
}

describe('buildNetworkMesh', () => {
  it('produces a mesh for every road', () => {
    const { net, designs } = tJunction()
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    expect(m.roads.size).toBe(3)
  })

  it('produces a junction surface where three roads meet', () => {
    const { net, designs } = tJunction()
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    const junction = net.nodeAt(vec2(100, 0))!
    expect(m.junctions.get(junction.id)!.vertexCount).toBeGreaterThan(0)
  })

  it('produces no junction surface at a dead end', () => {
    const { net, designs } = tJunction()
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    const deadEnd = net.nodeAt(vec2(0, 0))!
    expect(m.junctions.has(deadEnd.id)).toBe(false)
  })

  it('trims a road back from the junction it runs into', () => {
    const { net, designs, west } = tJunction()
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    const wearing = m.roads.get(west)!.layers.find((l) => l.name === 'wearing')!.mesh
    let furthestX = -Infinity
    for (let i = 0; i < wearing.vertexCount; i++) {
      furthestX = Math.max(furthestX, wearing.positions[i * 3]!)
    }
    // The road's alignment ends at x=100; trimming must pull it short of that.
    expect(furthestX).toBeLessThan(100)
  })

  it('does not trim a road at its dead end', () => {
    const { net, designs, west } = tJunction()
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    const wearing = m.roads.get(west)!.layers.find((l) => l.name === 'wearing')!.mesh
    let smallestX = Infinity
    for (let i = 0; i < wearing.vertexCount; i++) {
      smallestX = Math.min(smallestX, wearing.positions[i * 3]!)
    }
    expect(smallestX).toBeCloseTo(0, 4)
  })

  it('records nothing as infeasible for a sound network', () => {
    const { net, designs } = tJunction()
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    expect(m.infeasibleJunctions.size).toBe(0)
  })

  it('records a reason for an infeasible junction', () => {
    const net = new RoadNetwork()
    // Two nearly-parallel roads plus one more, meeting at a point.
    net.addRoad(new Alignment([new Line(vec2(100, 0), 0, 100)]), 'rural')
    net.addRoad(new Alignment([new Line(vec2(100, 0), 0.0005, 100)]), 'rural')
    net.addRoad(new Alignment([new Line(vec2(100, 0), Math.PI, 100)]), 'rural')
    const designs = new Map<RoadId, ProfilePoint[]>([
      [0, level(100, 50)], [1, level(100, 50)], [2, level(100, 50)],
    ])
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    const junction = net.nodeAt(vec2(100, 0))!
    expect(m.infeasibleJunctions.has(junction.id)).toBe(true)
    expect(m.infeasibleJunctions.get(junction.id)).toBe('near-parallel-legs')
  })

  it('emits no junction mesh where the junction is infeasible', () => {
    const net = new RoadNetwork()
    net.addRoad(new Alignment([new Line(vec2(100, 0), 0, 100)]), 'rural')
    net.addRoad(new Alignment([new Line(vec2(100, 0), 0.0005, 100)]), 'rural')
    net.addRoad(new Alignment([new Line(vec2(100, 0), Math.PI, 100)]), 'rural')
    const designs = new Map<RoadId, ProfilePoint[]>([
      [0, level(100, 50)], [1, level(100, 50)], [2, level(100, 50)],
    ])
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    const junction = net.nodeAt(vec2(100, 0))!
    expect(m.junctions.get(junction.id)?.vertexCount ?? 0).toBe(0)
  })

  it('keeps a road entry even when trimmed to nothing', () => {
    const net = new RoadNetwork()
    // A very short road between two junctions will be trimmed away entirely.
    net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 100)]), 'rural')
    net.addRoad(new Alignment([new Line(vec2(100, 0), 0, 4)]), 'rural')
    net.addRoad(new Alignment([new Line(vec2(100, 0), Math.PI / 2, 100)]), 'rural')
    net.addRoad(new Alignment([new Line(vec2(104, 0), Math.PI / 2, 100)]), 'rural')
    const designs = new Map<RoadId, ProfilePoint[]>([
      [0, level(100, 50)], [1, level(4, 50)], [2, level(100, 50)], [3, level(100, 50)],
    ])
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    expect(m.roads.has(1)).toBe(true)
    expect(m.roads.get(1)!.layers).toHaveLength(3)
  })

  it('applies per-road construction stations', () => {
    const { net, designs, west } = tJunction()
    const m = buildNetworkMesh(net, designs, {
      spacing: 10,
      stations: new Map([[west, { subgrade: 60 }]]),
    })
    const road = m.roads.get(west)!
    expect(road.layers.find((l) => l.name === 'subgrade')!.mesh.vertexCount).toBeGreaterThan(0)
    expect(road.layers.find((l) => l.name === 'wearing')!.mesh.vertexCount).toBe(0)
  })

  describe('junction elevation', () => {
    it('sets the junction to the shared elevation when all legs agree', () => {
      const { net, designs } = tJunction()
      const m = buildNetworkMesh(net, designs, { spacing: 10 })
      const junction = net.nodeAt(vec2(100, 0))!
      const mesh = m.junctions.get(junction.id)!
      for (let i = 0; i < mesh.vertexCount; i++) {
        expect(mesh.positions[i * 3 + 2]).toBeCloseTo(50, 6)
      }
      expect(m.elevationMismatches.has(junction.id)).toBe(false)
    })

    it('sets the junction to the mean of disagreeing legs and records the spread', () => {
      const { net, west, north, south } = tJunction()
      // West's own attach station reads 50; north and south are offset by
      // +0.6 and -0.6, an even split so the mean stays exactly 50.
      const designs = new Map<RoadId, ProfilePoint[]>([
        [west, level(100, 50)], [north, level(100, 50.6)], [south, level(100, 49.4)],
      ])
      const m = buildNetworkMesh(net, designs, { spacing: 10 })
      const junction = net.nodeAt(vec2(100, 0))!
      const mesh = m.junctions.get(junction.id)!
      for (let i = 0; i < mesh.vertexCount; i++) {
        expect(mesh.positions[i * 3 + 2]).toBeCloseTo(50, 6)
      }
      expect(m.elevationMismatches.get(junction.id)).toBeCloseTo(1.2, 6)
    })

    it('does not record a spread below the threshold', () => {
      const { net, west, north, south } = tJunction()
      const designs = new Map<RoadId, ProfilePoint[]>([
        [west, level(100, 50)], [north, level(100, 50.1)], [south, level(100, 49.95)],
      ])
      // Spread is 0.15m, comfortably under MAX_JUNCTION_ELEVATION_SPREAD (0.25m).
      const m = buildNetworkMesh(net, designs, { spacing: 10 })
      expect(0.15).toBeLessThan(MAX_JUNCTION_ELEVATION_SPREAD)
      const junction = net.nodeAt(vec2(100, 0))!
      expect(m.elevationMismatches.has(junction.id)).toBe(false)
    })
  })

  it('handles a road that loops back to its own node', () => {
    const net = new RoadNetwork()
    // A full circle: both ends land on the same point, so this road
    // contributes two independent legs to one node.
    const radius = 30
    const loopStart = vec2(200, 0)
    const loop = net.addRoad(
      new Alignment([new Arc(loopStart, 0, 2 * Math.PI * radius, 1 / radius)]),
      'rural',
    )
    // A third leg at the same node so it qualifies as a junction.
    const spur = net.addRoad(new Alignment([new Line(loopStart, Math.PI / 2, 100)]), 'rural')

    const designs = new Map<RoadId, ProfilePoint[]>([
      [loop, level(2 * Math.PI * radius, 50)], [spur, level(100, 50)],
    ])
    const m = buildNetworkMesh(net, designs, { spacing: 10 })

    const node = net.nodeAt(loopStart)!
    expect(m.infeasibleJunctions.has(node.id)).toBe(false)

    const wearing = m.roads.get(loop)!.layers.find((l) => l.name === 'wearing')!.mesh
    expect(wearing.vertexCount).toBeGreaterThan(0)

    // Both the loop's start and end stations map to the same physical point
    // (loopStart). If either trim had failed to apply — `from` left at 0 or
    // `to` left at the full length — a vertex would sit right on it. Seeing
    // none confirms both ends were trimmed, not just one.
    for (let i = 0; i < wearing.vertexCount; i++) {
      const x = wearing.positions[i * 3]!
      const y = wearing.positions[i * 3 + 1]!
      expect(Math.hypot(x - loopStart.x, y - loopStart.y)).toBeGreaterThan(0.1)
    }
  })
})
