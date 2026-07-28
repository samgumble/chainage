import { describe, it, expect } from 'vitest'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import { RoadNetwork } from '../network/graph'
import { ROAD_CLASSES, formationHalfWidth } from '../network/roadClass'
import { junctionLegs } from './junctionLegs'
import { solveJunction } from './junctionCorners'
import { roadsWithTrafficEntry, trafficEntryStations } from './junctionClearance'

/** The demo's own shape: two rural arms east-west, a gravel branch north. */
const tJunction = (at = vec2(0, 0)) => {
  const network = new RoadNetwork()
  const west = network.addRoad(new Alignment([new Line(at, Math.PI, 750)]), 'rural')
  const east = network.addRoad(new Alignment([new Line(at, 0, 750)]), 'rural')
  const branch = network.addRoad(new Alignment([new Line(at, Math.PI / 2, 300)]), 'gravel')
  return { network, west, east, branch }
}

const RURAL_HALF = formationHalfWidth(ROAD_CLASSES.rural)
const GRAVEL_HALF = formationHalfWidth(ROAD_CLASSES.gravel)
const LENGTH = 4.5

describe('trafficEntryStations', () => {
  it('clears the junction plate by a whole vehicle on every leg', () => {
    // Hand-computed rather than read back out of the solver. The corner between
    // the east arm and the branch is where the arm's LEFT edge meets the
    // branch's RIGHT edge: (gravel half-width, rural half-width). Projected
    // along the arm that is the gravel half-width; projected along the branch it
    // is the rural one. So each arm is pulled back by how wide the branch is and
    // the branch by how wide the arms are, which is what a T junction looks
    // like: the narrow road cuts a narrow notch and the wide roads a wide one.
    const { network, west, east, branch } = tJunction()
    const stations = trafficEntryStations(network, LENGTH)

    expect(stations.get(west)).toBeCloseTo(GRAVEL_HALF + LENGTH, 9)
    expect(stations.get(east)).toBeCloseTo(GRAVEL_HALF + LENGTH, 9)
    expect(stations.get(branch)).toBeCloseTo(RURAL_HALF + LENGTH, 9)

    // The demo's actual numbers, so a change to either class shows up here.
    expect(stations.get(east)).toBeCloseTo(6.5, 9)
    expect(stations.get(branch)).toBeCloseTo(9.5, 9)
  })

  it('is the solver’s own trim, not a second estimate of it', () => {
    // The station has to track the plate `buildNetworkMesh` actually builds. If
    // this were computed from half-widths independently it could agree today
    // and drift the moment `solveJunction` changed.
    const { network } = tJunction()
    const node = network.nodes.find((n) => n.ends.length >= 3)!
    const legs = junctionLegs(network, node.id)
    const geometry = solveJunction(legs)
    expect(geometry.feasible).toBe(true)
    if (!geometry.feasible) return

    const stations = trafficEntryStations(network, LENGTH)
    legs.forEach((leg, i) => {
      expect(stations.get(leg.roadId)).toBeCloseTo(geometry.trims[i]! + LENGTH, 9)
    })
  })

  it('leaves a road that starts nowhere in particular at station 0', () => {
    // Two roads end to end make a node with two ends, which is a road passing
    // through and not a junction. Nothing to be moved clear of.
    const network = new RoadNetwork()
    const first = network.addRoad(new Alignment([new Line(vec2(0, 0), 0, 100)]), 'rural')
    const second = network.addRoad(new Alignment([new Line(vec2(100, 0), 0, 100)]), 'rural')

    const stations = trafficEntryStations(network, LENGTH)
    expect(stations.has(first)).toBe(false)
    expect(stations.has(second)).toBe(false)
    expect([...roadsWithTrafficEntry(network, LENGTH)].map((r) => r.spawnStation))
      .toEqual([0, 0])
  })

  it('moves only the legs attached by their start end', () => {
    // A leg that FINISHES at the junction has its station 0 somewhere else
    // entirely, and `Fleet` only ever puts a vehicle on at station 0. Moving
    // that leg's entry point would push its traffic along for no reason.
    const network = new RoadNetwork()
    // Arrives at the origin from the west, so its END is the junction.
    const arriving = network.addRoad(new Alignment([new Line(vec2(-750, 0), 0, 750)]), 'rural')
    const leaving = network.addRoad(new Alignment([new Line(vec2(0, 0), 0, 750)]), 'rural')
    const branch = network.addRoad(new Alignment([new Line(vec2(0, 0), Math.PI / 2, 300)]), 'gravel')

    const stations = trafficEntryStations(network, LENGTH)
    expect(stations.has(arriving)).toBe(false)
    expect(stations.get(leaving)).toBeCloseTo(GRAVEL_HALF + LENGTH, 9)
    expect(stations.get(branch)).toBeGreaterThan(0)
  })

  it('scales with the vehicle it is clearing room for', () => {
    // The vehicle length is a parameter and not a constant in here, which is
    // what keeps junction geometry free of any dependency on `src/traffic/`.
    const { network, east } = tJunction()
    expect(trafficEntryStations(network, 10).get(east)! -
      trafficEntryStations(network, 4).get(east)!).toBeCloseTo(6, 9)
  })

  it('falls back to the widest leg when the junction cannot be solved', () => {
    // Three legs leaving on the same bearing: no corners, no plate, and the
    // ribbons run straight over each other at the node. There are no trims to
    // read, so the widest leg's formation half-width stands in — which is wider
    // than any trim would have been, the right direction for a fallback.
    const network = new RoadNetwork()
    const a = network.addRoad(new Alignment([new Line(vec2(0, 0), 0, 400)]), 'rural')
    const b = network.addRoad(new Alignment([new Line(vec2(0, 0), 0, 300)]), 'gravel')
    const c = network.addRoad(new Alignment([new Line(vec2(0, 0), 0, 200)]), 'gravel')

    const node = network.nodes.find((n) => n.ends.length >= 3)!
    expect(solveJunction(junctionLegs(network, node.id)).feasible).toBe(false)

    const stations = trafficEntryStations(network, LENGTH)
    for (const id of [a, b, c]) {
      expect(stations.get(id)).toBeCloseTo(RURAL_HALF + LENGTH, 9)
    }
  })
})

describe('roadsWithTrafficEntry', () => {
  it('carries every road through with its station attached', () => {
    const { network, east, branch } = tJunction(vec2(900, 1280))
    const roads = roadsWithTrafficEntry(network, LENGTH)

    expect(roads).toHaveLength(network.roads.length)
    for (const road of roads) {
      // The road itself is unchanged — same id, same alignment object, same
      // class — so this stays a `DrivableRoad` the fleet can take as it is.
      expect(road.alignment).toBe(network.road(road.id).alignment)
      expect(road.className).toBe(network.road(road.id).className)
    }

    expect(roads.find((r) => r.id === east)!.spawnStation).toBeCloseTo(6.5, 9)
    expect(roads.find((r) => r.id === branch)!.spawnStation).toBeCloseTo(9.5, 9)
  })
})
