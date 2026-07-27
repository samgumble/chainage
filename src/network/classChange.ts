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

/** How often the alignment's curvature is inspected, metres. */
const DEFAULT_SAMPLE_SPACING = 1

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
 */
export const checkClassChange = (
  road: Road,
  to: RoadClassName,
  sampleSpacing: number = DEFAULT_SAMPLE_SPACING,
): ClassChangeResult => {
  const requiredRadius = minimumRadiusForSpeed(ROAD_CLASSES[to].designSpeedKph)

  let worstCurvature = 0
  let worstStation = 0

  for (const pose of road.alignment.sample(sampleSpacing)) {
    const magnitude = Math.abs(pose.curvature)
    if (magnitude > worstCurvature) {
      worstCurvature = magnitude
      worstStation = pose.s
    }
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
