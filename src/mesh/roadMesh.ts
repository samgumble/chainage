import type { Alignment } from '../geometry/alignment'
import type { ProfilePoint } from '../terrain/groundProfile'
import type { RoadClass, LayerName } from './roadClass'
import { layerTopProfile } from './crossSection'
import { sweepRibbon, type MeshData, type RibbonOptions } from './ribbon'

/**
 * How far each pavement layer has been built, metres along the alignment.
 *
 * A missing layer has not been started. These are the construction stations
 * from the construction spec — subgrade runs ahead of base, base ahead of
 * seal — and rendering each layer only to its own station is what makes a
 * road visibly half-built.
 */
export type LayerStations = Readonly<Partial<Record<LayerName, number>>>

export type RoadMesh = {
  /** Bottom-up, matching the road class's own layer order. */
  readonly layers: readonly { readonly name: LayerName; readonly mesh: MeshData }[]
}

/**
 * The stations between which a road physically exists.
 *
 * A road running into a junction is trimmed back so its ribbon does not
 * overlap the junction surface, which means it can start after its alignment
 * starts and end before its alignment ends. Stations stay **absolute** —
 * chainage is measured from the alignment origin and never renumbered, which
 * is the whole point of the measurement the game is named after.
 */
export type RoadExtent = {
  readonly from: number
  readonly to: number
}

/**
 * Build every pavement layer of a road.
 *
 * Omit `stations` for a finished road. All three layers are always present in
 * the result even when a layer has no geometry yet, so a consumer can hold a
 * stable set of meshes and simply see one of them go from empty to populated.
 */
export const buildRoadMesh = (
  alignment: Alignment,
  design: readonly ProfilePoint[],
  roadClass: RoadClass,
  stations?: LayerStations,
  options: RibbonOptions = {},
  extent?: RoadExtent,
): RoadMesh => {
  const from = extent ? extent.from : 0
  const to = extent ? extent.to : alignment.length

  if (to < from) {
    throw new RangeError('extent.to must not be less than extent.from')
  }

  const layers = roadClass.layers.map((spec) => {
    // A construction station is an absolute alignment station. Clamp it into
    // the extent: past the end means fully built, before the start means not
    // started. Omitting the layer entirely also means not started.
    const requested = stations === undefined ? to : stations[spec.name] ?? from
    const endStation = requested < from ? from : requested > to ? to : requested

    const section = layerTopProfile(roadClass, spec.name)
    const mesh = sweepRibbon(alignment, design, section, {
      ...options,
      startStation: from,
      endStation,
    })

    return { name: spec.name, mesh }
  })

  return { layers }
}
