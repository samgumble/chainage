import {
  type ClassChangeRejection,
  checkClassChange,
} from '../network/classChange'
import type { NodeId, RoadId, RoadNetwork } from '../network/graph'
import {
  ROAD_CLASSES,
  type RoadClassName,
  formationHalfWidth,
} from '../network/roadClass'
import type { JunctionInfeasibility } from './junctionCorners'
import { solveJunction } from './junctionCorners'
import { junctionLegs } from './junctionLegs'

export type UpgradeObstacle =
  | { readonly kind: 'alignment'; readonly rejection: ClassChangeRejection }
  | {
      readonly kind: 'junction'
      readonly nodeId: NodeId
      readonly reason: JunctionInfeasibility
    }

export type UpgradeCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly obstacles: readonly UpgradeObstacle[] }

/** Three legs is the smallest thing that is a junction rather than a dead end. */
const MIN_JUNCTION_LEGS = 3

/**
 * Whether a road can become another class without breaking itself or its ends.
 *
 * Two questions, asked in the two layers that can answer them. The road's own
 * curves are a `network/` question; whether its junctions still solve once the
 * formation widens is a `mesh/` one, because trim distances come from leg
 * half-widths and widening one leg pulls every other leg at that node back.
 *
 * Every obstacle is reported, not the first. Fixing one problem only to be
 * shown another is how a tool teaches a player to stop trusting it.
 */
export const checkUpgrade = (
  network: RoadNetwork,
  roadId: RoadId,
  to: RoadClassName,
): UpgradeCheck => {
  // Throws for an unknown id, which is the intended behaviour.
  const road = network.road(roadId)

  const obstacles: UpgradeObstacle[] = []

  const alignment = checkClassChange(road, to)
  if (!alignment.ok) {
    obstacles.push({ kind: 'alignment', rejection: alignment.rejection })
  }

  const newHalfWidth = formationHalfWidth(ROAD_CLASSES[to])

  for (const nodeId of new Set([road.startNode, road.endNode])) {
    const legs = junctionLegs(network, nodeId)
    if (legs.length < MIN_JUNCTION_LEGS) continue

    // Substitute the upgraded road's new width. Both of its ends are replaced
    // when a road loops back to its own node.
    const widened = legs.map((leg) =>
      leg.roadId === roadId ? { ...leg, halfWidth: newHalfWidth } : leg,
    )

    const solved = solveJunction(widened)
    if (!solved.feasible) {
      obstacles.push({ kind: 'junction', nodeId, reason: solved.reason })
    }
  }

  return obstacles.length === 0 ? { ok: true } : { ok: false, obstacles }
}
