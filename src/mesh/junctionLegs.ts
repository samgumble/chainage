import type { RoadNetwork, NodeId, RoadId } from '../network/graph'
import { type Vec2, fromAngle, normalizeAngle } from '../geometry/vec2'
import { ROAD_CLASSES, formationHalfWidth } from './roadClass'

/**
 * One road end arriving at a junction node.
 *
 * `direction` always points AWAY from the node, whichever end of the road is
 * attached — a road arriving from the west contributes a leg pointing west.
 * Uniform outward directions are what make the corner and trim maths below
 * work without per-end special cases.
 */
export type JunctionLeg = {
  readonly roadId: RoadId
  readonly end: 'start' | 'end'
  readonly direction: Vec2
  readonly halfWidth: number
  /** Angle of `direction`, radians in (-PI, PI]. */
  readonly bearing: number
}

/**
 * The legs of a node, sorted counter-clockwise by bearing.
 *
 * The ordering is load-bearing: corners are formed between *adjacent* legs,
 * and "adjacent" only means anything once the legs are in angular order.
 */
export const junctionLegs = (
  network: RoadNetwork,
  nodeId: NodeId,
): JunctionLeg[] => {
  const node = network.node(nodeId)

  const legs = node.ends.map((roadEnd) => {
    const road = network.road(roadEnd.roadId)

    // Outward from the node: the start end leaves along its own heading; the
    // end end leaves back the way the road came.
    const bearing =
      roadEnd.end === 'start'
        ? road.alignment.poseAt(0).heading
        : normalizeAngle(road.alignment.poseAt(road.alignment.length).heading + Math.PI)

    return {
      roadId: roadEnd.roadId,
      end: roadEnd.end,
      direction: fromAngle(bearing),
      halfWidth: formationHalfWidth(ROAD_CLASSES[road.className]),
      bearing,
    }
  })

  return legs.sort((a, b) => a.bearing - b.bearing)
}
