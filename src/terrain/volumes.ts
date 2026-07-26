import type { Alignment } from '../geometry/alignment'
import type { Vec2 } from '../geometry/vec2'
import { fromAngle, add, scale } from '../geometry/vec2'
import type { Heightmap } from './heightmap'
import type { ProfilePoint } from './groundProfile'
import { designElevationAt, isDaylighted, type CorridorTemplate } from './corridor'

export type StationAreas = {
  readonly s: number
  /** Cross-sectional area of material to be excavated, m^2. */
  readonly cutArea: number
  /** Cross-sectional area of material to be placed, m^2. */
  readonly fillArea: number
  /** True when the section reached the safety cap without daylighting, so the areas are an under-estimate. */
  readonly truncated: boolean
}

export type EarthworkQuantities = {
  readonly stations: StationAreas[]
  readonly cutVolume: number
  readonly fillVolume: number
  /** cut − fill. Positive is surplus to dispose of; negative must be imported. */
  readonly netVolume: number
  /** How many stations were truncated. Non-zero means the quantities are an under-estimate. */
  readonly truncatedStations: number
}

const DEFAULT_TRANSVERSE_STEP = 0.5

/**
 * Hard safety cap on how far a cross-section may be integrated from the
 * centreline, on each side, in metres.
 *
 * Far beyond any credible road section. It exists only so a pathological
 * cross-slope — ground climbing as fast as, or faster than, the batter can
 * climb — cannot make the marching loop run without end. If a side hits this
 * cap without confirming daylight, the section is truncated and its area is
 * an under-estimate.
 */
const MAX_SECTION_HALF_WIDTH = 500

/**
 * How many consecutive daylighted samples confirm the batter has genuinely
 * met natural ground, rather than merely grazing it at a single point.
 */
const DAYLIGHT_CONFIRMATION_SAMPLES = 4

type SideResult = {
  readonly cutArea: number
  readonly fillArea: number
  readonly truncated: boolean
}

/**
 * Integrates one side of a cross-section — negative or positive offsets,
 * chosen by `sign` — marching outward from the centreline in
 * `transverseStep` increments, sampling at the midpoint of each step.
 *
 * Ground rises at different rates on either side of a cross-sloped corridor,
 * so the two sides daylight at different distances and must be marched
 * independently. Marching stops once natural ground and the design surface
 * have coincided for `DAYLIGHT_CONFIRMATION_SAMPLES` consecutive samples, or
 * unconditionally at `MAX_SECTION_HALF_WIDTH`, whichever comes first.
 */
const marchSide = (
  sign: 1 | -1,
  position: Vec2,
  normal: Vec2,
  terrain: Heightmap,
  station: ProfilePoint,
  template: CorridorTemplate,
  transverseStep: number,
): SideResult => {
  let cutArea = 0
  let fillArea = 0
  let consecutiveDaylight = 0
  let k = 0

  for (;;) {
    const offset = sign * (k + 0.5) * transverseStep
    if (Math.abs(offset) > MAX_SECTION_HALF_WIDTH) {
      return { cutArea, fillArea, truncated: true }
    }

    const p = add(position, scale(normal, offset))
    const groundZ = terrain.sample(p.x, p.y)
    const surfaceZ = designElevationAt(offset, station.z, groundZ, template)

    // Midpoint rule, not left-Riemann. The batters are linear ramps, and the
    // midpoint rule integrates a linear function exactly while a left sum
    // overestimates it by step/2 x slope on every side — about 1 m^2 of error
    // on a 2m cut, which is far too much when this figure drives both cost
    // and construction duration. Residual error comes only from the two
    // kinks (formation edge and daylight point) and is on the order of
    // 0.01 m^2.
    const difference = groundZ - surfaceZ
    if (difference > 0) cutArea += difference * transverseStep
    else fillArea += -difference * transverseStep

    if (isDaylighted(offset, station.z, groundZ, template)) {
      consecutiveDaylight++
      if (consecutiveDaylight >= DAYLIGHT_CONFIRMATION_SAMPLES) {
        return { cutArea, fillArea, truncated: false }
      }
    } else {
      consecutiveDaylight = 0
    }

    k++
  }
}

/**
 * Cut and fill areas at one station, by transverse numerical integration.
 *
 * Marches outward from the centreline on each side independently, sampling
 * natural ground and the design surface and accumulating the signed
 * difference, until daylighting is confirmed (or the safety cap is hit — see
 * `truncated`). Past the daylight point the two surfaces coincide and
 * contribute nothing further.
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

  const left = marchSide(-1, pose.position, normal, terrain, station, template, transverseStep)
  const right = marchSide(1, pose.position, normal, terrain, station, template, transverseStep)

  return {
    s: station.s,
    cutArea: left.cutArea + right.cutArea,
    fillArea: left.fillArea + right.fillArea,
    truncated: left.truncated || right.truncated,
  }
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
    return { stations: [], cutVolume: 0, fillVolume: 0, netVolume: 0, truncatedStations: 0 }
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

  const truncatedStations = stations.filter((s) => s.truncated).length

  return {
    stations,
    cutVolume,
    fillVolume,
    netVolume: cutVolume - fillVolume,
    truncatedStations,
  }
}
