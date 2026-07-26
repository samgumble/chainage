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
): RoadMesh => {
  const layers = roadClass.layers.map((spec) => {
    const endStation = stations === undefined
      ? alignment.length
      : stations[spec.name] ?? 0

    const section = layerTopProfile(roadClass, spec.name)
    const mesh = sweepRibbon(alignment, design, section, {
      ...options,
      startStation: 0,
      endStation,
    })

    return { name: spec.name, mesh }
  })

  return { layers }
}
