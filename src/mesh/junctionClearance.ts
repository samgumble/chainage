import type { NodeId, Road, RoadId, RoadNetwork } from '../network/graph'
import { junctionLegs } from './junctionLegs'
import { solveJunction } from './junctionCorners'

/**
 * A road, plus the station its traffic should enter at.
 *
 * Structurally a `DrivableRoad` (see `traffic/fleet.ts`), which is how the
 * scene hands both facts to `TrafficView.sync` in one object without this
 * module importing anything from `src/traffic/`.
 */
export type RoadWithEntry = Road & { readonly spawnStation: number }

/**
 * How far along a leg the junction plate reaches, metres.
 *
 * `solveJunction`'s own `trims` — the distance each leg is pulled back from
 * the node so its ribbon starts where the plate ends. Read out of the solver
 * rather than estimated a second time, so this is the plate `buildNetworkMesh`
 * actually builds and not a parallel guess that can drift from it.
 *
 * When the solve is infeasible there are no trims and no plate: the ribbons
 * run straight over the node on top of each other, and the reach of that
 * overlap is bounded by the widest leg's own formation half-width. Wider than
 * the trims would have been, which is the right direction for a fallback.
 */
const plateReach = (network: RoadNetwork, nodeId: NodeId): ReadonlyMap<RoadId, number> => {
  const legs = junctionLegs(network, nodeId)
  const geometry = solveJunction(legs)
  const widest = Math.max(...legs.map((leg) => leg.halfWidth))

  const reach = new Map<RoadId, number>()
  legs.forEach((leg, i) => {
    // Only the legs attached by their START end matter: station 0 is the only
    // place `Fleet` puts a vehicle on, so a road that merely *finishes* here
    // has nothing to be moved clear of.
    if (leg.end !== 'start') return
    reach.set(leg.roadId, geometry.feasible ? geometry.trims[i]! : widest)
  })
  return reach
}

/**
 * The station each road's traffic should enter at, metres from its own
 * station 0.
 *
 * Zero for a road that starts nowhere in particular. For a road that starts at
 * a junction it is the plate's reach along that leg plus `vehicleLength`, and
 * both terms are doing work:
 *
 * - the plate's reach, because a vehicle put on inside the junction surface is
 *   a vehicle standing where every other leg's traffic also stands;
 * - a whole vehicle, because a vehicle's box reaches half its length behind
 *   its own centre and the thing it might hit reaches half of its own length
 *   forward. A whole length clears both, and leaves the entering vehicle's
 *   rear bumper half a length clear of the plate edge rather than flush with
 *   it.
 *
 * Nothing here is a chosen number: on the demo's T junction it comes out at
 * 6.5m for each rural arm (a 2.0m trim against the gravel branch's half-width)
 * and 9.5m for the branch (a 5.0m trim against the rural arms'), so a wider
 * class, a narrower one or a longer vehicle all move it on their own.
 *
 * This is what keeps traffic out of a junction the simulation cannot yet give
 * way at. The alternative — building the legs so they arrive at the junction
 * rather than leave it — has been measured and does not work: arriving cars
 * converge on the node exactly as spawning cars diverged from it, and moving
 * every leg's station 0 to its far end moves `solveGradeProfile`'s only
 * terrain-faithful point away from the junction as well.
 */
export const trafficEntryStations = (
  network: RoadNetwork,
  vehicleLength: number,
): ReadonlyMap<RoadId, number> => {
  const stations = new Map<RoadId, number>()

  for (const node of network.nodes) {
    if (!network.isJunction(node.id)) continue
    for (const [roadId, reach] of plateReach(network, node.id)) {
      stations.set(roadId, reach + vehicleLength)
    }
  }

  return stations
}

/** Every road in the network, carrying the station its traffic enters at. */
export const roadsWithTrafficEntry = (
  network: RoadNetwork,
  vehicleLength: number,
): readonly RoadWithEntry[] => {
  const stations = trafficEntryStations(network, vehicleLength)
  return network.roads.map((road) => ({
    ...road,
    spawnStation: stations.get(road.id) ?? 0,
  }))
}
