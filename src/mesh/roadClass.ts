export type RoadClassName = 'gravel' | 'rural' | 'arterial' | 'highway'

/** Pavement layers, named bottom-up. */
export type LayerName = 'subgrade' | 'base' | 'wearing'

export type PavementLayer = {
  readonly name: LayerName
  /** Vertical thickness, metres. A 40mm wearing course is 0.04. */
  readonly thickness: number
  /**
   * How far this layer extends beyond the formation edge on each side, metres.
   *
   * Lower layers are built wider than upper ones — the base course has to
   * support the seal right to its edge, so it cannot stop in the same place.
   * The wearing course defines the formation edge and so extends by zero.
   */
  readonly widthExtension: number
}

export type RoadClass = {
  readonly name: RoadClassName
  readonly laneCount: number
  /** Width of one lane, metres. */
  readonly laneWidth: number
  /** Width of the shoulder on each side, metres. */
  readonly shoulderWidth: number
  /**
   * Cross slope from crown to edge for normal drainage on straight road, as a fraction.
   * 2.5% is 0.025. This is the normal-crown drainage slope, not superelevation.
   *
   * Superelevation (curve banking) is handled separately in designSpeedForRadius in
   * src/geometry/designSpeed.ts and should NOT be passed as crossfall — they are
   * physically distinct: crossfall drains water on straight road, superelevation
   * banks curves. Conflating them would understate curve capability by roughly half.
   */
  readonly crossfall: number
  readonly designSpeedKph: number
  /** Bottom-up: subgrade, base, wearing. */
  readonly layers: readonly PavementLayer[]
}

/**
 * The four classes, with figures in the range real road standards use.
 *
 * Crossfall exists to shed water: too little and the surface ponds, too much
 * and a driver feels the camber. Every class sits in the usual 2.5–3% band.
 */
export const ROAD_CLASSES: Readonly<Record<RoadClassName, RoadClass>> = {
  gravel: {
    name: 'gravel',
    laneCount: 1,
    /** 3.0 m, not 3.5: single-lane unsealed roads rarely carry two standard vehicles side by side. */
    laneWidth: 3.0,
    shoulderWidth: 0.5,
    crossfall: 0.03,
    designSpeedKph: 40,
    layers: [
      { name: 'subgrade', thickness: 0.20, widthExtension: 0.4 },
      { name: 'base', thickness: 0.15, widthExtension: 0.2 },
      { name: 'wearing', thickness: 0.05, widthExtension: 0 },
    ],
  },
  rural: {
    name: 'rural',
    laneCount: 2,
    laneWidth: 3.5,
    shoulderWidth: 1.5,
    crossfall: 0.025,
    designSpeedKph: 80,
    layers: [
      { name: 'subgrade', thickness: 0.25, widthExtension: 0.6 },
      { name: 'base', thickness: 0.20, widthExtension: 0.3 },
      { name: 'wearing', thickness: 0.05, widthExtension: 0 },
    ],
  },
  arterial: {
    name: 'arterial',
    laneCount: 4,
    laneWidth: 3.5,
    shoulderWidth: 2.0,
    crossfall: 0.025,
    designSpeedKph: 90,
    layers: [
      { name: 'subgrade', thickness: 0.30, widthExtension: 0.8 },
      { name: 'base', thickness: 0.25, widthExtension: 0.4 },
      { name: 'wearing', thickness: 0.06, widthExtension: 0 },
    ],
  },
  highway: {
    name: 'highway',
    laneCount: 6,
    laneWidth: 3.7,
    shoulderWidth: 3.0,
    crossfall: 0.025,
    designSpeedKph: 110,
    layers: [
      { name: 'subgrade', thickness: 0.35, widthExtension: 1.0 },
      { name: 'base', thickness: 0.30, widthExtension: 0.5 },
      { name: 'wearing', thickness: 0.08, widthExtension: 0 },
    ],
  },
}

/** Half the sealed width, excluding shoulders. */
export const carriagewayHalfWidth = (rc: RoadClass): number =>
  (rc.laneCount * rc.laneWidth) / 2

/** Half the full built width, including shoulders. */
export const formationHalfWidth = (rc: RoadClass): number =>
  carriagewayHalfWidth(rc) + rc.shoulderWidth

export const totalPavementThickness = (rc: RoadClass): number =>
  rc.layers.reduce((sum, l) => sum + l.thickness, 0)
