import type { LayerName } from '../network/roadClass'

/**
 * Every surface the world draws.
 *
 * The pavement layers come from `LayerName` so the two cannot drift; the rest
 * are the surfaces that are not part of a pavement.
 */
export type SurfaceName = LayerName | 'concrete' | 'terrain' | 'cutFace'

export type Surface = {
  /** Base colour, packed 0xRRGGBB. */
  readonly colour: number
  /** 0 is a mirror, 1 is entirely diffuse. */
  readonly roughness: number
  /** Non-metals sit at 0; nothing here is metal. */
  readonly metalness: number
}

/**
 * What each surface is made of.
 *
 * Roughness is doing most of the work. A sealed wearing course reflects the sky
 * along its length and a granular base does not, and that difference is more of
 * what makes a render read as physical than the colours are — which is why the
 * tests assert the *relationships* between these numbers rather than the
 * numbers themselves. The values are free to be tuned; asphalt being smoother
 * and darker than the base it sits on is not.
 */
export const SURFACES: Readonly<Record<SurfaceName, Surface>> = {
  /** Compacted earth: dull, mid-brown, and completely diffuse. */
  subgrade: { colour: 0x6b5a45, roughness: 0.95, metalness: 0 },
  /** Unsealed granular base: paler, still rough. */
  base: { colour: 0x8a8175, roughness: 0.9, metalness: 0 },
  /** Sealed asphalt: dark, and smooth enough to catch the sky. */
  wearing: { colour: 0x33363a, roughness: 0.55, metalness: 0 },
  /** Structural concrete — bridge decks, abutments, retaining walls. */
  concrete: { colour: 0x9d9a93, roughness: 0.7, metalness: 0 },
  /** Undisturbed ground. */
  terrain: { colour: 0x7f8f5e, roughness: 0.95, metalness: 0 },
  /** Freshly cut earth, exposed by excavation: rawer than the ground above it. */
  cutFace: { colour: 0x7a6547, roughness: 0.95, metalness: 0 },
}

export const surfaceFor = (name: SurfaceName): Surface => SURFACES[name]
