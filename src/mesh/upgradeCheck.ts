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
import {
  MAX_TRIM_DISTANCE,
  solveJunction,
  type JunctionInfeasibility,
} from './junctionCorners'
import { junctionLegs, type JunctionLeg } from './junctionLegs'

/** One leg identified by which road end it is. */
export type JunctionLegRef = {
  readonly roadId: RoadId
  readonly end: 'start' | 'end'
}

/**
 * Why a junction obstacle cannot be built.
 *
 * `trim-too-long` carries the numbers: `ClassChangeRejection` sets the
 * standard for this feature — station, actual radius, required radius — and
 * a bare string here would leave a player unable to tell whether they are
 * one metre over the limit or forty, or which legs are the problem.
 *
 * The other two reasons carry no such numbers because none exist to carry:
 * `too-few-legs` is a fact about a dead end, and `near-parallel-legs` means
 * the corner itself has no unique position to measure a trim from.
 */
export type JunctionObstacleReason =
  | { readonly reason: 'too-few-legs' }
  | { readonly reason: 'near-parallel-legs' }
  | {
      readonly reason: 'trim-too-long'
      /** Longest pull-back any leg at this junction would need, metres. */
      readonly worstTrim: number
      /** MAX_TRIM_DISTANCE: the limit `worstTrim` exceeds, metres. */
      readonly maxTrim: number
      /** The leg(s) whose required trim reaches `worstTrim`. */
      readonly worstLegs: readonly JunctionLegRef[]
    }

export type UpgradeObstacle =
  | { readonly kind: 'alignment'; readonly rejection: ClassChangeRejection }
  | ({ readonly kind: 'junction'; readonly nodeId: NodeId } & JunctionObstacleReason)

export type UpgradeCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly obstacles: readonly UpgradeObstacle[] }

/** Three legs is the smallest thing that is a junction rather than a dead end. */
const MIN_JUNCTION_LEGS = 3

/**
 * Turn `solveJunction`'s bare failure reason into the detail a player needs.
 *
 * `trim-too-long` is the only reason with numbers to report, and it is also
 * the only one where `solveJunction` has already computed every corner
 * before discovering one leg's trim is too long. `maxTrim` only gates the
 * final length check — it plays no part in computing the corners or trims
 * themselves — so re-solving the same legs with an effectively unbounded
 * `maxTrim` reuses that same geometry and lets this function read the actual
 * worst trim and which leg it belongs to. This keeps `solveJunction`'s
 * signature, and every other caller of it, untouched.
 */
const describeJunctionFailure = (
  reason: JunctionInfeasibility,
  legs: readonly JunctionLeg[],
): JunctionObstacleReason => {
  if (reason !== 'trim-too-long') return { reason }

  const unconstrained = solveJunction(legs, Number.POSITIVE_INFINITY)
  if (!unconstrained.feasible) {
    // Should be unreachable: `maxTrim` only gates the final trim check, and
    // a genuine `trim-too-long` means every corner already solved without
    // hitting `too-few-legs` or `near-parallel-legs`. Reporting this loudly
    // is more honest than silently approximating a reason that isn't real.
    throw new Error(
      `solveJunction reported 'trim-too-long' at maxTrim=${MAX_TRIM_DISTANCE} but ` +
        `became infeasible again (reason: '${unconstrained.reason}') once maxTrim ` +
        'was raised, which should be impossible since maxTrim cannot affect corner geometry',
    )
  }

  const worstTrim = Math.max(...unconstrained.trims)
  const worstLegs = legs
    .filter((_, i) => unconstrained.trims[i] === worstTrim)
    .map((leg) => ({ roadId: leg.roadId, end: leg.end }))

  return { reason: 'trim-too-long', worstTrim, maxTrim: MAX_TRIM_DISTANCE, worstLegs }
}

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
      obstacles.push({ kind: 'junction', nodeId, ...describeJunctionFailure(solved.reason, widened) })
    }
  }

  return obstacles.length === 0 ? { ok: true } : { ok: false, obstacles }
}
