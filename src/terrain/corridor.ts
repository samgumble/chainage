/**
 * The transverse shape of the earthworks at a station.
 *
 * Slopes are horizontal-to-vertical ratios, the civil convention: a value of
 * 2 means 2H:1V, so the batter runs out 2m horizontally for every 1m of
 * height. Steeper slopes have smaller numbers. Cut batters are conventionally
 * steeper than fill batters, since undisturbed ground stands better than
 * placed material.
 */
export type CorridorTemplate = {
  /** Half the formation width — carriageway plus shoulders — in metres. */
  formationHalfWidth: number
  /** Cut batter, horizontal-to-vertical. */
  cutSlope: number
  /** Fill batter, horizontal-to-vertical. */
  fillSlope: number
  /**
   * How far a batter may run out from the formation edge before a retaining
   * wall takes over, metres. Omitted means batters may run as far as needed.
   */
  maxBatterWidth?: number
}

const validate = (t: CorridorTemplate): void => {
  if (t.formationHalfWidth < 0) {
    throw new RangeError('formationHalfWidth must not be negative')
  }
  if (t.cutSlope <= 0 || t.fillSlope <= 0) {
    throw new RangeError('slopes must be positive')
  }
  if (t.maxBatterWidth !== undefined && t.maxBatterWidth < 0) {
    throw new RangeError('maxBatterWidth must not be negative')
  }
}

/** Which batter applies here — cut above the design line, fill below. */
const slopeFor = (designZ: number, groundZ: number, t: CorridorTemplate): number =>
  groundZ > designZ ? t.cutSlope : t.fillSlope

/**
 * Where a retaining wall stands and how tall it is, or null if none is needed.
 *
 * A wall is what you build when there is not enough room to run a batter out
 * to natural ground — a constrained corridor, a property boundary, a
 * watercourse. The batter is truncated at `maxBatterWidth` and a vertical
 * wall makes up whatever height it could not.
 *
 * `offset` is distance from the centreline and is always positive; the wall
 * exists symmetrically on both sides.
 */
export const retainingWall = (
  designZ: number,
  groundZ: number,
  template: CorridorTemplate,
): { readonly offset: number; readonly height: number } | null => {
  validate(template)

  const { maxBatterWidth } = template
  if (maxBatterWidth === undefined) return null

  const depth = Math.abs(groundZ - designZ)
  if (depth === 0) return null

  const slope = slopeFor(designZ, groundZ, template)
  const naturalBatterWidth = depth * slope
  if (naturalBatterWidth <= maxBatterWidth) return null

  return {
    offset: template.formationHalfWidth + maxBatterWidth,
    height: depth - maxBatterWidth / slope,
  }
}

/**
 * Elevation of the earthworks design surface at a transverse offset.
 *
 * Within the formation the surface is flat at the design elevation. Beyond
 * it, the batter runs toward natural ground and stops the moment it gets
 * there — the daylight point. Past that the design surface simply is natural
 * ground, so cut and fill areas integrate to zero out there.
 */
export const designElevationAt = (
  offset: number,
  designZ: number,
  groundZ: number,
  template: CorridorTemplate,
): number => {
  validate(template)

  const beyondFormation = Math.abs(offset) - template.formationHalfWidth
  if (beyondFormation <= 0) return designZ

  // Past a retaining wall there is no earthwork at all — the wall holds the
  // ground back and the surface beyond it is simply natural ground.
  if (
    template.maxBatterWidth !== undefined &&
    beyondFormation > template.maxBatterWidth
  ) {
    return groundZ
  }

  if (groundZ > designZ) {
    // Cut: the batter climbs outward toward the higher ground.
    const rise = beyondFormation / template.cutSlope
    return Math.min(designZ + rise, groundZ)
  }

  if (groundZ < designZ) {
    // Fill: the batter descends outward toward the lower ground.
    const drop = beyondFormation / template.fillSlope
    return Math.max(designZ - drop, groundZ)
  }

  return designZ
}

/** Has the batter met natural ground at this offset? */
export const isDaylighted = (
  offset: number,
  designZ: number,
  groundZ: number,
  template: CorridorTemplate,
): boolean => {
  validate(template)

  if (Math.abs(offset) <= template.formationHalfWidth) return false
  return designElevationAt(offset, designZ, groundZ, template) === groundZ
}
