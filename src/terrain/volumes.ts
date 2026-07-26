import type { Alignment } from '../geometry/alignment'
import type { Vec2 } from '../geometry/vec2'
import { fromAngle, add, scale } from '../geometry/vec2'
import type { TerrainSampler } from './heightmap'
import type { ProfilePoint } from './groundProfile'
import { designSurfaceAtOffset, isDaylighted, type CorridorTemplate } from './corridor'

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
  readonly stations: readonly StationAreas[]
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

// DAYLIGHT_CONFIRMATION_SAMPLES has been removed. A fixed count of
// consecutive daylighted samples only proves the batter has grazed natural
// ground for a short stretch — it cannot distinguish a genuine daylight point
// from a bench: a stretch where ground happens to sit on the design surface
// for a few samples before diverging again farther out. Real terrain,
// especially the layered value noise `generateValley` adds, produces benches
// routinely. `marchSide` below replaces the fixed count with an adaptive
// bound driven by the worst depth actually observed.

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
 * independently. Marching stops once the current sample is daylighted *and*
 * the march has gone far enough that, given every sample seen so far on this
 * side, the batter must already have daylighted — see the `requiredHalfWidth`
 * computation below — or unconditionally at `MAX_SECTION_HALF_WIDTH`,
 * whichever comes first.
 */
const marchSide = (
  sign: 1 | -1,
  position: Vec2,
  normal: Vec2,
  terrain: TerrainSampler,
  station: ProfilePoint,
  template: CorridorTemplate,
  transverseStep: number,
): SideResult => {
  let cutArea = 0
  let fillArea = 0

  // The greatest depth (natural ground below the design elevation, i.e. a
  // fill) and the greatest height (ground above it, i.e. a cut) seen
  // anywhere on this side so far. A batter climbing or descending at
  // 1-in-`slope` needs `slope` metres of horizontal run for every metre of
  // depth it must cover, so these are what bound how much farther the
  // daylight point *could* possibly be, given only what has been observed.
  let maxCutDepthSeen = 0
  let maxFillDepthSeen = 0
  let k = 0

  for (;;) {
    const offset = sign * (k + 0.5) * transverseStep
    const absOffset = Math.abs(offset)
    if (absOffset > MAX_SECTION_HALF_WIDTH) {
      return { cutArea, fillArea, truncated: true }
    }

    const p = add(position, scale(normal, offset))
    const groundZ = terrain.sample(p.x, p.y)
    const surfaceZ = designSurfaceAtOffset(offset, station.z, groundZ, template)

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

    // Depth relative to the flat design elevation (not the batter surface,
    // which already tracks toward ground) — how far above or below the
    // formation natural ground sits at this sample, regardless of offset.
    const rawDepth = groundZ - station.z
    if (rawDepth > maxCutDepthSeen) maxCutDepthSeen = rawDepth
    if (-rawDepth > maxFillDepthSeen) maxFillDepthSeen = -rawDepth

    // The adaptive bound. A single-point graze — the old bug's original
    // target — is defeated because one sample barely moves maxDepthSeen, so
    // the bound barely moves either, and the *next* rule (below) still fires
    // almost immediately. A bench — flat ground that happens to sit on the
    // design surface for a stretch before the terrain diverges again — is
    // defeated too, and by the same mechanism: the bench itself cannot grow
    // maxDepthSeen (it is, by definition, no deeper than what came before),
    // so it cannot push this bound outward, and the march does not mistake
    // a temporary coincidence for daylighting. Only genuine, ever-increasing
    // divergence between ground and the design elevation keeps expanding the
    // bound and keeps the march going; ground that truly levels off leaves
    // the bound fixed, and the march stops there instead of running out to
    // the safety cap.
    let requiredHalfWidth =
      template.formationHalfWidth +
      Math.max(template.cutSlope * maxCutDepthSeen, template.fillSlope * maxFillDepthSeen) +
      transverseStep

    // Past a retaining wall, `designSurfaceAtOffset` returns natural ground and
    // the march contributes exactly zero area from there outward — there is
    // nothing left to integrate. Without this clamp, a cross-slope steeper
    // than the batter (about 1/(2*cutSlope) or 1/(2*fillSlope) for the
    // default templates, which valley flanks exceed routinely) keeps
    // `maxCutDepthSeen`/`maxFillDepthSeen` growing forever, so the bound
    // above never catches up and the march runs to `MAX_SECTION_HALF_WIDTH`
    // and reports `truncated: true` on a section whose areas are already
    // exactly correct. Clamping to the wall's offset stops the march exactly
    // where the design surface goes flat against natural ground for good.
    if (template.maxBatterWidth !== undefined) {
      requiredHalfWidth = Math.min(
        requiredHalfWidth,
        template.formationHalfWidth + template.maxBatterWidth,
      )
    }

    if (absOffset >= requiredHalfWidth && isDaylighted(offset, station.z, groundZ, template)) {
      return { cutArea, fillArea, truncated: false }
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
  terrain: TerrainSampler,
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
  terrain: TerrainSampler,
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
