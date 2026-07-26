import { describe, it, expect } from 'vitest'
import { buildNetworkMesh } from './networkMesh'
import { RoadNetwork } from '../network/graph'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
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
})
