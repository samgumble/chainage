import type { Alignment } from '../geometry/alignment'
import { fromAngle, add, scale } from '../geometry/vec2'
import type { Heightmap } from './heightmap'
import type { ProfilePoint } from './groundProfile'
import { designElevationAt, type CorridorTemplate } from './corridor'

export type StationAreas = {
  readonly s: number
  /** Cross-sectional area of material to be excavated, m^2. */
  readonly cutArea: number
  /** Cross-sectional area of material to be placed, m^2. */
  readonly fillArea: number
}

export type EarthworkQuantities = {
  readonly stations: StationAreas[]
  readonly cutVolume: number
  readonly fillVolume: number
  /** cut − fill. Positive is surplus to dispose of; negative must be imported. */
  readonly netVolume: number
}

const DEFAULT_TRANSVERSE_STEP = 0.5

/**
 * How far either side of the centreline to integrate.
 *
 * The batter must have daylighted well before this, or the section is
 * truncated and the area under-reported. Generous, since sampling a few extra
 * metres of zero costs almost nothing.
 */
const maxHalfWidth = (template: CorridorTemplate, depth: number): number =>
  template.formationHalfWidth +
  Math.max(template.cutSlope, template.fillSlope) * Math.abs(depth) +
  10

/**
 * Cut and fill areas at one station, by transverse numerical integration.
 *
 * Steps across the section perpendicular to the alignment, sampling natural
 * ground and the design surface at each offset and accumulating the signed
 * difference. Past the daylight point the two coincide and contribute
 * nothing, so the integration bound only has to be generous, not exact.
 */
export const crossSectionAreas = (
  alignment: Alignment,
  terrain: Heightmap,
  station: ProfilePoint,
  template: CorridorTemplate,
  transverseStep: number = DEFAULT_TRANSVERSE_STEP,
): StationAreas => {
  if (transverseStep <= 0) {
    throw new RangeError('transverseStep must be positive')
  }

  const pose = alignment.poseAt(station.s)
  // Perpendicular to the direction of travel, pointing left.
  const normal = fromAngle(pose.heading + Math.PI / 2)

  const centreGround = terrain.sample(pose.position.x, pose.position.y)
  const half = maxHalfWidth(template, station.z - centreGround)

  let cutArea = 0
  let fillArea = 0

  // Midpoint rule, not left-Riemann. The batters are linear ramps, and the
  // midpoint rule integrates a linear function exactly while a left sum
  // overestimates it by step/2 x slope on every side — about 1 m^2 of error
  // on a 2m cut, which is far too much when this figure drives both cost and
  // construction duration. Residual error comes only from the two kinks
  // (formation edge and daylight point) and is on the order of 0.01 m^2.
  const steps = Math.ceil((2 * half) / transverseStep)
  for (let i = 0; i < steps; i++) {
    const offset = -half + (i + 0.5) * transverseStep
    const p = add(pose.position, scale(normal, offset))
    const groundZ = terrain.sample(p.x, p.y)
    const surfaceZ = designElevationAt(offset, station.z, groundZ, template)

    const difference = groundZ - surfaceZ
    if (difference > 0) cutArea += difference * transverseStep
    else fillArea += -difference * transverseStep
  }

  return { s: station.s, cutArea, fillArea }
}

/**
 * Earthwork quantities for a whole road, by the average end-area method.
 *
 * Volume between two stations is the mean of their cross-sectional areas
 * times the distance between them. This is how quantities are actually taken
 * off a set of drawings, and it feeds both construction cost and — via
 * productivity rates — how long the road takes to build.
 */
export const computeEarthworks = (
  alignment: Alignment,
  terrain: Heightmap,
  design: readonly ProfilePoint[],
  template: CorridorTemplate,
  transverseStep: number = DEFAULT_TRANSVERSE_STEP,
): EarthworkQuantities => {
  if (design.length === 0) {
    return { stations: [], cutVolume: 0, fillVolume: 0, netVolume: 0 }
  }

  const stations = design.map((station) =>
    crossSectionAreas(alignment, terrain, station, template, transverseStep),
  )

  let cutVolume = 0
  let fillVolume = 0

  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1]!
    const b = stations[i]!
    const distance = b.s - a.s
    cutVolume += ((a.cutArea + b.cutArea) / 2) * distance
    fillVolume += ((a.fillArea + b.fillArea) / 2) * distance
  }

  return {
    stations,
    cutVolume,
    fillVolume,
    netVolume: cutVolume - fillVolume,
  }
}
