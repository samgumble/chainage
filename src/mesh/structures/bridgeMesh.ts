import type { Alignment } from '../../geometry/alignment'
import { leftNormal, add, scale } from '../../geometry/vec2'
import type { TerrainSampler } from '../../terrain/heightmap'
import {
  type ProfilePoint, designElevationAtStation,
} from '../../terrain/groundProfile'
import type { StructureSpan } from './spans'
import { MeshBuilder, type Point3 } from '../meshBuilder'
import type { MeshData } from '../ribbon'

/** Depth of the deck slab, metres. */
export const DECK_DEPTH = 1.2
/** Distance between piers, metres. */
export const PIER_SPACING = 25
/** Half the plan size of a pier, metres. */
export const PIER_HALF_WIDTH = 1.0
/** How far the deck's top sits below the design elevation, metres. */
export const DECK_CLEARANCE = 0.6

export type BridgeOptions = {
  readonly deckDepth?: number
  readonly pierSpacing?: number
  readonly pierHalfWidth?: number
  readonly deckClearance?: number
}

/** Longitudinal resolution of the deck slab, metres. */
const DECK_STEP = 5

/**
 * Deck, abutments and piers for one span.
 *
 * The road ribbon already draws the running surface; this is what holds it up.
 * The deck's top sits `deckClearance` below the design elevation so the
 * pavement stack rests on it rather than intersecting it.
 *
 * Piers go at `pierSpacing` intervals strictly inside the span — never at its
 * ends, where the abutments already are.
 */
export const buildBridgeMesh = (
  alignment: Alignment,
  terrain: TerrainSampler,
  design: readonly ProfilePoint[],
  span: StructureSpan,
  halfWidth: number,
  options: BridgeOptions = {},
): MeshData => {
  const {
    deckDepth = DECK_DEPTH,
    pierSpacing = PIER_SPACING,
    pierHalfWidth = PIER_HALF_WIDTH,
    deckClearance = DECK_CLEARANCE,
  } = options

  const builder = new MeshBuilder()
  const length = span.toStation - span.fromStation
  if (length <= 0 || halfWidth <= 0) return builder.build()

  /** Deck cross-section at a station: left and right, top and bottom. */
  const deckSection = (s: number) => {
    const pose = alignment.poseAt(s)
    const normal = leftNormal(pose.heading)
    const top = designElevationAtStation(design, s) - deckClearance
    const left = add(pose.position, scale(normal, halfWidth))
    const right = add(pose.position, scale(normal, -halfWidth))
    return {
      leftTop: { x: left.x, y: left.y, z: top },
      rightTop: { x: right.x, y: right.y, z: top },
      leftBottom: { x: left.x, y: left.y, z: top - deckDepth },
      rightBottom: { x: right.x, y: right.y, z: top - deckDepth },
    }
  }

  // --- Deck slab, stepped along the span ---
  const steps = Math.max(1, Math.ceil(length / DECK_STEP))
  const first = deckSection(span.fromStation)
  let previous = first

  for (let i = 1; i <= steps; i++) {
    const s = span.fromStation + (length * i) / steps
    const current = deckSection(s)

    // Top face, seen from above: right then left runs counter-clockwise.
    builder.addQuad(previous.rightTop, current.rightTop, current.leftTop, previous.leftTop)
    // Underside, reversed so it faces down.
    builder.addQuad(previous.leftBottom, current.leftBottom, current.rightBottom, previous.rightBottom)
    // Left flank, facing outward to the left.
    builder.addQuad(previous.leftTop, current.leftTop, current.leftBottom, previous.leftBottom)
    // Right flank, facing outward to the right.
    builder.addQuad(previous.rightBottom, current.rightBottom, current.rightTop, previous.rightTop)

    previous = current
  }

  // End caps, closing the slab into a solid.
  //
  // Two reasons, and the second is the one that matters. Visibly, the deck
  // meets the abutments here and an uncapped slab leaves a hole straight
  // through it. For the tests, an open surface encloses no volume, so the
  // divergence-theorem check that catches an inside-out solid — the failure
  // mode `MeshBuilder`'s winding guarantee makes its own normals test blind
  // to — measured an origin-dependent number that came out positive only
  // because the support boxes outweighed the slab. Closed, it measures the
  // deck's true volume from any origin.
  //
  // Wound counter-clockwise seen from outside. At the start face the viewer
  // stands off the end looking along the road, so the road's left edge is on
  // their left and bottom-left, bottom-right, top-right, top-left runs the
  // right way round.
  builder.addQuad(first.leftBottom, first.rightBottom, first.rightTop, first.leftTop)
  builder.addQuad(previous.leftTop, previous.rightTop, previous.rightBottom, previous.leftBottom)

  // --- Abutments and piers ---
  const supports = supportStations(span.fromStation, span.toStation, pierSpacing)

  for (const s of supports) {
    const isAbutment = s === span.fromStation || s === span.toStation
    const section = deckSection(s)
    const pose = alignment.poseAt(s)
    const groundZ = terrain.sample(pose.position.x, pose.position.y)
    const topZ = section.leftBottom.z
    if (topZ <= groundZ) continue

    // An abutment carries the full road width; a pier is a slender column.
    const halfAcross = isAbutment ? halfWidth : pierHalfWidth
    // addBox centres its footprint symmetrically on the station it's given.
    // An abutment sits AT the span boundary, so a symmetric box there would
    // hang half its length past the boundary — outside the span. Shift its
    // centre inward by its own half-length so the whole box lands inside.
    const boxStation = isAbutment
      ? (s === span.fromStation ? s + pierHalfWidth : s - pierHalfWidth)
      : s
    addBox(builder, alignment, boxStation, halfAcross, pierHalfWidth, groundZ, topZ)
  }

  return builder.build()
}

/**
 * Stations for the abutments (span ends) and piers within a span.
 *
 * Piers are evenly spaced strictly inside the span. `pierCount` is chosen to
 * land as close to the requested `pierSpacing` as an even split allows —
 * rounding to the nearest whole number of gaps rather than flooring, so the
 * achieved spacing does not come out systematically tighter than requested.
 * For a 100m span at 25m spacing this gives 3 piers at exactly 25m gaps,
 * rather than flooring to 4 piers at 20m gaps.
 */
export const supportStations = (
  fromStation: number,
  toStation: number,
  pierSpacing: number,
): number[] => {
  const length = toStation - fromStation
  const stations: number[] = [fromStation, toStation]
  const pierCount = Math.max(0, Math.round(length / pierSpacing) - 1)
  for (let i = 1; i <= pierCount; i++) {
    stations.push(fromStation + (length * i) / (pierCount + 1))
  }
  return stations
}

/**
 * A rectangular column, aligned to the road at that station.
 *
 * `halfAcross` is its half size transverse to the road, `halfAlong` its half
 * size along it.
 */
const addBox = (
  builder: MeshBuilder,
  alignment: Alignment,
  s: number,
  halfAcross: number,
  halfAlong: number,
  bottomZ: number,
  topZ: number,
): void => {
  const pose = alignment.poseAt(s)
  const across = leftNormal(pose.heading)
  const along = { x: Math.cos(pose.heading), y: Math.sin(pose.heading) }

  const corner = (a: number, b: number, z: number): Point3 => {
    const p = add(
      add(pose.position, scale(across, a * halfAcross)),
      scale(along, b * halfAlong),
    )
    return { x: p.x, y: p.y, z }
  }

  // Plan corners, clockwise seen from above (t[0..3] = NW, NE, SE, SW).
  const t = [corner(1, -1, topZ), corner(1, 1, topZ), corner(-1, 1, topZ), corner(-1, -1, topZ)]
  const b = [corner(1, -1, bottomZ), corner(1, 1, bottomZ), corner(-1, 1, bottomZ), corner(-1, -1, bottomZ)]

  // Top face: walked in reverse (SW, SE, NE, NW) so it's counter-clockwise
  // from above and its normal points up, out of the solid.
  builder.addQuad(t[3]!, t[2]!, t[1]!, t[0]!)
  // Bottom face: walked in plan order (NW, NE, SE, SW), clockwise from above,
  // so its normal points down, out of the solid.
  builder.addQuad(b[0]!, b[1]!, b[2]!, b[3]!)

  // Side faces: top-then-bottom around each edge in plan order gives an
  // outward-facing normal on every one of the four walls (verified per-wall,
  // not by a general winding rule, since the top and bottom faces above
  // deliberately use opposite traversal directions).
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    builder.addQuad(t[i]!, t[j]!, b[j]!, b[i]!)
  }
}
