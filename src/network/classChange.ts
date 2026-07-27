import { minimumRadiusForSpeed } from '../geometry/designSpeed'
import type { Road } from './graph'
import { ROAD_CLASSES, type RoadClassName } from './roadClass'

export type ClassChangeRejection = {
  readonly reason: 'curve-too-tight'
  /** Station on the road carrying the tightest curve, metres. */
  readonly station: number
  /** Radius there, metres. */
  readonly actualRadius: number
  /** Radius the new class's design speed requires, metres. */
  readonly requiredRadius: number
}

export type ClassChangeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejection: ClassChangeRejection }

/**
 * Whether a road's own geometry permits it to become another class.
 *
 * A higher class carries a higher design speed, and a higher design speed
 * demands a larger minimum radius. A winding rural road cannot become a
 * highway without its own curves becoming illegal. Saying so is the point:
 * silently building a highway that violates the standard it claims to meet
 * would hide exactly the consequence this project exists to show.
 *
 * Only the road's own alignment is examined here. Whether its junctions still
 * solve at the wider formation is a mesh-layer question — see
 * `src/mesh/upgradeCheck.ts`.
 *
 * Curvature is checked at each primitive's two endpoints, never sampled
 * along its length. Every primitive this project has is either constant in
 * curvature (`Line`: 0, `Arc`: its fixed value) or linear in station
 * (`Spiral`, from `startCurvature` to `endCurvature`) — a function like that,
 * on a closed interval, attains its extreme at an endpoint. So evaluating
 * both ends of every primitive finds the alignment-wide maximum exactly, with
 * no resolution parameter and nothing to miss. Do not reintroduce a sampling
 * loop here: a sub-metre fillet arc or a spiral endpoint that doesn't land on
 * a sample grid would slip through it (see classChange.test.ts for fixtures
 * that demonstrate exactly that failure).
 */
export const checkClassChange = (
  road: Road,
  to: RoadClassName,
): ClassChangeResult => {
  const requiredRadius = minimumRadiusForSpeed(ROAD_CLASSES[to].designSpeedKph)

  let worstCurvature = 0
  let worstStation = 0

  let start = 0
  for (const primitive of road.alignment.primitives) {
    for (const localS of [0, primitive.length]) {
      const pose = primitive.poseAt(localS)
      const magnitude = Math.abs(pose.curvature)
      if (magnitude > worstCurvature) {
        worstCurvature = magnitude
        worstStation = start + pose.s
      }
    }
    start += primitive.length
  }

  if (worstCurvature === 0) return { ok: true }

  const actualRadius = 1 / worstCurvature
  if (actualRadius >= requiredRadius) return { ok: true }

  return {
    ok: false,
    rejection: {
      reason: 'curve-too-tight',
      station: worstStation,
      actualRadius,
      requiredRadius,
    },
  }
}
