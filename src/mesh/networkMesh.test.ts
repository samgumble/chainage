import { describe, it, expect } from 'vitest'
import { buildNetworkMesh, MAX_JUNCTION_ELEVATION_SPREAD } from './networkMesh'
import { RoadNetwork } from '../network/graph'
import { Alignment } from '../geometry/alignment'
import { Line, Arc } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import { ROAD_CLASSES, formationHalfWidth } from '../network/roadClass'
import type { ProfilePoint } from '../terrain/groundProfile'
import type { RoadId } from '../network/graph'

/** Half the crossfall drop for a rural road: what the plate sits below crown by. */
const RURAL_CROSSFALL_DROP =
  (formationHalfWidth(ROAD_CLASSES.rural) * ROAD_CLASSES.rural.crossfall) / 2

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
    it('sets the junction to the shared elevation when all legs agree, minus half the crossfall drop', () => {
      const { net, designs } = tJunction()
      const m = buildNetworkMesh(net, designs, { spacing: 10 })
      const junction = net.nodeAt(vec2(100, 0))!
      const mesh = m.junctions.get(junction.id)!
      for (let i = 0; i < mesh.vertexCount; i++) {
        expect(mesh.positions[i * 3 + 2]).toBeCloseTo(50 - RURAL_CROSSFALL_DROP, 6)
      }
      expect(m.elevationMismatches.has(junction.id)).toBe(false)
    })

    it('sets the junction to the mean of disagreeing legs and records the spread', () => {
      const { net, west, north, south } = tJunction()
      // West's own attach station reads 50; north and south are offset by
      // +0.6 and -0.6, an even split so the mean stays exactly 50 (before
      // the half-crossfall-drop term, which is identical across all three
      // legs and so shifts the mean without touching the spread).
      const designs = new Map<RoadId, ProfilePoint[]>([
        [west, level(100, 50)], [north, level(100, 50.6)], [south, level(100, 49.4)],
      ])
      const m = buildNetworkMesh(net, designs, { spacing: 10 })
      const junction = net.nodeAt(vec2(100, 0))!
      const mesh = m.junctions.get(junction.id)!
      for (let i = 0; i < mesh.vertexCount; i++) {
        expect(mesh.positions[i * 3 + 2]).toBeCloseTo(50 - RURAL_CROSSFALL_DROP, 6)
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

    it('sits below crown height by half the crossfall drop for a level junction', () => {
      // All three legs agree exactly on 50m everywhere: no grade, no
      // disagreement. A flat plate still can't sit at crown height, because
      // the ribbon's edges (at the trim station) are `formationHalfWidth *
      // crossfall` below their own crown — the plate should split that
      // difference and sit half that far below 50, not at 50 itself.
      const { net, designs } = tJunction()
      const m = buildNetworkMesh(net, designs, { spacing: 10 })
      const junction = net.nodeAt(vec2(100, 0))!
      const mesh = m.junctions.get(junction.id)!
      expect(RURAL_CROSSFALL_DROP).toBeCloseTo(0.0625, 6)
      for (let i = 0; i < mesh.vertexCount; i++) {
        expect(mesh.positions[i * 3 + 2]).toBeCloseTo(50 - RURAL_CROSSFALL_DROP, 6)
      }
    })

    it('matches the ribbon design elevation at the trim station, not the node, on a graded approach', () => {
      // West is on a 5% grade (50 -> 55 over 100m) and meets the junction at
      // its `end`, so the node is at station 100 but the ribbon actually
      // stops at the trim station, 95 (trim = formationHalfWidth = 5 for a
      // rural road). North and south are flat at exactly the design
      // elevation west's ribbon has at station 95, so if the junction
      // correctly samples at the trim station all three legs agree and the
      // plate sits flush; sampling at the node (the old, wrong behaviour)
      // would instead read west's elevation as 55, a full 0.25m off.
      const { net, west, north, south } = tJunction()
      const gradedTrimElevation = 54.75 // designElevationAtStation(west, 95)
      const designs = new Map<RoadId, ProfilePoint[]>([
        [west, [{ s: 0, z: 50 }, { s: 100, z: 55 }]],
        [north, level(100, gradedTrimElevation)],
        [south, level(100, gradedTrimElevation)],
      ])
      const m = buildNetworkMesh(net, designs, { spacing: 10 })
      const junction = net.nodeAt(vec2(100, 0))!
      const mesh = m.junctions.get(junction.id)!

      const expectedElevation = gradedTrimElevation - RURAL_CROSSFALL_DROP
      for (let i = 0; i < mesh.vertexCount; i++) {
        expect(mesh.positions[i * 3 + 2]).toBeCloseTo(expectedElevation, 6)
      }
      // Sampling at the node instead (west's design elevation at station
      // 100) would have put the plate at 55 minus the crossfall term — well
      // off the correct value.
      expect(mesh.positions[2]).not.toBeCloseTo(55 - RURAL_CROSSFALL_DROP, 2)
      // All legs agree once sampled correctly, so no mismatch is recorded.
      expect(m.elevationMismatches.has(junction.id)).toBe(false)
    })

    it('measures elevationMismatches at trim stations, catching legs that agree at the node but disagree at their trims', () => {
      // All three legs share exactly z=50 at the node-touching end of their
      // profile, so a node-station comparison (the old, wrong behaviour)
      // sees zero spread and reports nothing. But each profile bends sharply
      // in the last few metres before the node, so at the actual trim
      // stations the legs disagree by 1.5m.
      const { net, west, north, south } = tJunction()
      const designs = new Map<RoadId, ProfilePoint[]>([
        // West meets the junction at its end (station 100); trim station 95.
        [west, [{ s: 0, z: 50 }, { s: 95, z: 49 }, { s: 100, z: 50 }]],
        // North and south meet at their start (station 0); trim station 5.
        [north, [{ s: 0, z: 50 }, { s: 5, z: 50.5 }, { s: 100, z: 60 }]],
        [south, [{ s: 0, z: 50 }, { s: 5, z: 49.7 }, { s: 100, z: 40 }]],
      ])
      const m = buildNetworkMesh(net, designs, { spacing: 10 })
      const junction = net.nodeAt(vec2(100, 0))!
      // Raw trim-station elevations are 49, 50.5, 49.7 — a spread of 1.5m.
      // The crossfall term is identical across all three (same road class),
      // so it cancels out of the spread entirely.
      expect(m.elevationMismatches.get(junction.id)).toBeCloseTo(1.5, 6)
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

import { Heightmap } from '../terrain/heightmap'
import type { CorridorBatters } from '../terrain/corridor'
import { networkStructureSpans } from './structures/spans'

const flatGround = (z: number) => Heightmap.flat(-1000, -1000, 100, 41, 41, z)
const template: CorridorBatters = { cutSlope: 2, fillSlope: 3, maxBatterWidth: 1 }

/**
 * The ground-and-spans half of a structures build.
 *
 * `structureSpans` is required alongside `terrain` (see `NetworkMeshOptions`),
 * and deriving it here rather than letting `buildNetworkMesh` do it is the
 * point of the requirement: a caller who excavates has to derive spans first
 * and hand over the very list it stopped its earthworks at. These tests do not
 * excavate, so they derive the same list from the same function the scene
 * uses, which is exactly the arrangement the option asks for.
 */
const onGround = (
  net: RoadNetwork,
  designs: ReadonlyMap<RoadId, readonly ProfilePoint[]>,
  terrain: Heightmap,
  maxFillHeight: number,
  spacing = 10,
) => ({
  spacing,
  terrain,
  maxFillHeight,
  structureSpans: networkStructureSpans(net.roads, { designs, terrain, maxFillHeight, spacing }),
})

describe('buildNetworkMesh structures', () => {
  it('builds no structures without a terrain', () => {
    const { net, designs } = tJunction()
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    expect(m.structures.size).toBe(0)
  })

  it('builds a structure entry per road when a terrain is given', () => {
    const { net, designs } = tJunction()
    const m = buildNetworkMesh(net, designs, {
      ...onGround(net, designs, flatGround(50), 10), corridorBatters: template,
    })
    expect(m.structures.size).toBe(3)
  })

  it('builds a bridge where the design stands high above ground', () => {
    const { net, designs, west } = tJunction()
    // Ground 40m below the roads, so every station needs a structure.
    const m = buildNetworkMesh(net, designs, {
      ...onGround(net, designs, flatGround(10), 10), corridorBatters: template,
    })
    expect(m.structures.get(west)!.vertexCount).toBeGreaterThan(0)
  })

  it('builds nothing where the road sits on the ground', () => {
    const { net, designs, west } = tJunction()
    const m = buildNetworkMesh(net, designs, {
      ...onGround(net, designs, flatGround(50), 10),
      corridorBatters: { cutSlope: 2, fillSlope: 3 },
    })
    expect(m.structures.get(west)!.vertexCount).toBe(0)
  })

  // A retaining wall holds back an earthwork. Where a bridge carries the
  // road there is no earthwork to hold, so a wall there would stand in mid
  // air beside the deck, retaining nothing.
  it('builds no retaining wall where a bridge carries the road', () => {
    const { net, designs, west } = tJunction()
    const options = onGround(net, designs, flatGround(10), 10)
    // 40m of fill puts the whole road on a structure. Without the span, this
    // template would wall every station of it.
    const withWalls = buildNetworkMesh(net, designs, { ...options, corridorBatters: template })
    const bridgeOnly = buildNetworkMesh(net, designs, options)
    expect(bridgeOnly.structures.get(west)!.vertexCount).toBeGreaterThan(0)
    expect(withWalls.structures.get(west)!.vertexCount)
      .toBe(bridgeOnly.structures.get(west)!.vertexCount)
  })

  // A wall stands at `formationHalfWidth + maxBatterWidth` from the
  // centreline, and formation width is a property of the road class. One
  // network-wide template made every road's wall stand where the rural road's
  // would, so the gravel branch's walls floated 3m clear of its own formation.
  it('stands each road wall against its own class formation width', () => {
    const net = new RoadNetwork()
    // Two parallel roads far enough apart to share no node.
    const main = net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 200)]), 'rural')
    const track = net.addRoad(new Alignment([new Line(vec2(0, 1000), 0, 200)]), 'gravel')
    const designs = new Map<RoadId, ProfilePoint[]>([
      [main, level(200, 50)], [track, level(200, 50)],
    ])
    // 10m of fill at 3H:1V wants a 30m batter; 4m of room means a wall.
    // maxFillHeight of 20 keeps the fill well short of a bridge.
    const m = buildNetworkMesh(net, designs, {
      ...onGround(net, designs, flatGround(40), 20),
      corridorBatters: { cutSlope: 2, fillSlope: 3, maxBatterWidth: 4 },
    })

    /** Furthest a road's structure vertices sit from its own centreline. */
    const reach = (id: RoadId, centreY: number) => {
      const mesh = m.structures.get(id)!
      let furthest = 0
      for (let i = 0; i < mesh.vertexCount; i++) {
        furthest = Math.max(furthest, Math.abs(mesh.positions[i * 3 + 1]! - centreY))
      }
      return furthest
    }

    expect(reach(main, 0)).toBeCloseTo(formationHalfWidth(ROAD_CLASSES.rural) + 4, 6)
    expect(reach(track, 1000)).toBeCloseTo(formationHalfWidth(ROAD_CLASSES.gravel) + 4, 6)
  })

  // The fill allowance is the caller's, not the mesh layer's: it is whatever
  // the caller solved the design line with. The same terrain and the same
  // design must classify differently under different allowances, or a caller
  // who grades to a different allowance silently gets the wrong answer.
  it('classifies a bridge against the caller-supplied fill allowance', () => {
    const { net, designs, west } = tJunction()
    // Roads at z=50 over ground at z=45: a 5m embankment.
    const generous = buildNetworkMesh(net, designs, onGround(net, designs, flatGround(45), 10))
    const mean = buildNetworkMesh(net, designs, onGround(net, designs, flatGround(45), 3))
    expect(generous.structures.get(west)!.vertexCount).toBe(0)
    expect(mean.structures.get(west)!.vertexCount).toBeGreaterThan(0)
  })

  // A bridge needs ground and a fill allowance; only a wall needs to know
  // where the batter runs out of room. Coupling them cost the terrain-only
  // caller its bridges.
  it('still builds bridges for a caller who supplies no corridor template', () => {
    const { net, designs, west } = tJunction()
    const m = buildNetworkMesh(net, designs, onGround(net, designs, flatGround(10), 10))
    expect(m.structures.get(west)!.vertexCount).toBeGreaterThan(0)
  })

  it('refuses a terrain without the fill allowance it was graded to', () => {
    const { net, designs } = tJunction()
    expect(() =>
      // @ts-expect-error terrain without maxFillHeight is exactly the mistake
      buildNetworkMesh(net, designs, { spacing: 10, terrain: flatGround(45) }),
    ).toThrow(RangeError)
  })

  // The other half of the same requirement, and the one that had teeth: this
  // used to fall back to deriving the spans here, which cannot see a deck the
  // caller forced onto a lifted road. Same network, same designs, 296
  // structure vertices one way and 208 the other.
  it('refuses a terrain without the spans its earthworks were stopped at', () => {
    const { net, designs } = tJunction()
    expect(() =>
      // @ts-expect-error terrain without structureSpans is the same mistake
      buildNetworkMesh(net, designs, { spacing: 10, terrain: flatGround(45), maxFillHeight: 10 }),
    ).toThrow(RangeError)
  })

  it('reports a crossing that is too tight', () => {
    const net = new RoadNetwork()
    const a = net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 200)]), 'rural')
    const b = net.addRoad(new Alignment([new Line(vec2(100, -100), Math.PI / 2, 200)]), 'rural')
    const designs = new Map<RoadId, ProfilePoint[]>([
      [a, level(200, 50)], [b, level(200, 51)],
    ])
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    expect(m.tightCrossings.size).toBe(1)
  })

  it('does not report a crossing with adequate clearance', () => {
    const net = new RoadNetwork()
    const a = net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 200)]), 'rural')
    const b = net.addRoad(new Alignment([new Line(vec2(100, -100), Math.PI / 2, 200)]), 'rural')
    const designs = new Map<RoadId, ProfilePoint[]>([
      [a, level(200, 50)], [b, level(200, 60)],
    ])
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    expect(m.tightCrossings.size).toBe(0)
  })

  // `findCrossings` was fixed to report every crossing of a pair, not just
  // the first; keying the report by "upper:lower" collapsed them again.
  it('reports both tight crossings of a pair that crosses twice', () => {
    const net = new RoadNetwork()
    const a = net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 400)]), 'rural')

    // A zigzag that crosses the spine up and then back down again.
    const q0 = vec2(100, -50), q1 = vec2(150, 50), q2 = vec2(300, -50)
    const leg = (from: typeof q0, to: typeof q0) => ({
      heading: Math.atan2(to.y - from.y, to.x - from.x),
      length: Math.hypot(to.x - from.x, to.y - from.y),
    })
    const leg1 = leg(q0, q1)
    const leg2 = leg(q1, q2)
    const b = net.addRoad(
      new Alignment([
        new Line(q0, leg1.heading, leg1.length),
        new Line(q1, leg2.heading, leg2.length),
      ]),
      'rural',
    )

    const designs = new Map<RoadId, ProfilePoint[]>([
      [a, level(400, 100)],
      [b, level(leg1.length + leg2.length, 100.5)],
    ])

    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    expect(m.tightCrossings.size).toBe(2)
    for (const clearance of m.tightCrossings.values()) {
      expect(clearance).toBeCloseTo(0.5, 6)
    }
  })

  // An absent design profile reads as elevation 0 in `designElevationAtStation`.
  // Two undesigned roads therefore both read 0, compute a 0m gap, and get
  // reported as a collision that nobody has yet had the chance to cause.
  it('does not report a crossing between roads with no design profile', () => {
    const net = new RoadNetwork()
    net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 200)]), 'rural')
    net.addRoad(new Alignment([new Line(vec2(100, -100), Math.PI / 2, 200)]), 'rural')
    const m = buildNetworkMesh(net, new Map(), { spacing: 10 })
    expect(m.tightCrossings.size).toBe(0)
  })

  it('does not report roads meeting at a junction as a tight crossing', () => {
    const { net, designs } = tJunction()
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    expect(m.tightCrossings.size).toBe(0)
  })
})
