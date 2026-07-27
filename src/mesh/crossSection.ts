import {
  type RoadClass, type LayerName,
  carriagewayHalfWidth, formationHalfWidth,
} from '../network/roadClass'

/**
 * One point across the road.
 *
 * `offset` is metres from the centreline, negative to the left of the
 * direction of travel. `dz` is metres relative to the **design elevation**,
 * which is defined as the top of the wearing course at the crown — so the
 * wearing course crown has `dz` of exactly zero and everything else is below.
 */
export type SectionPoint = {
  readonly offset: number
  readonly dz: number
}

const layerOf = (rc: RoadClass, layer: LayerName) => {
  const found = rc.layers.find((l) => l.name === layer)
  if (!found) {
    throw new RangeError(`road class ${rc.name} has no layer named ${layer}`)
  }
  return found
}

/** How far the top of a layer sits below the design elevation. */
export const layerDepthBelowSurface = (rc: RoadClass, layer: LayerName): number => {
  layerOf(rc, layer) // validates
  let depth = 0
  // Layers are ordered bottom-up, so walk down from the top.
  for (let i = rc.layers.length - 1; i >= 0; i--) {
    const l = rc.layers[i]!
    if (l.name === layer) return depth
    depth += l.thickness
  }
  return depth
}

/**
 * The top surface of one layer, left edge to right edge.
 *
 * Points land at the crown, every lane boundary, the carriageway edge and the
 * layer's own outer edge, so the swept mesh has vertices exactly where lane
 * markings and the shoulder change need them.
 *
 * The whole profile drops by the class crossfall away from the crown, and the
 * whole layer sits at its own depth below the design elevation.
 */
export const layerTopProfile = (rc: RoadClass, layer: LayerName): SectionPoint[] => {
  const spec = layerOf(rc, layer)
  const depth = layerDepthBelowSurface(rc, layer)

  const carriageway = carriagewayHalfWidth(rc)
  const formation = formationHalfWidth(rc)
  const outer = formation + spec.widthExtension

  // Unique offsets on the right half, ascending; mirrored for the left.
  const rightOffsets = new Set<number>([0])
  for (let i = 1; i <= rc.laneCount / 2; i++) {
    rightOffsets.add(Math.min(i * rc.laneWidth, carriageway))
  }
  rightOffsets.add(carriageway)
  rightOffsets.add(outer)

  const right = [...rightOffsets].sort((a, b) => a - b)

  const pointAt = (offset: number): SectionPoint => ({
    offset,
    dz: -depth - Math.abs(offset) * rc.crossfall,
  })

  const left = right.filter((o) => o > 0).reverse().map((o) => pointAt(-o))
  return [...left, ...right.map(pointAt)]
}
