import type { Alignment } from '../../geometry/alignment'
import { leftNormal, add, scale } from '../../geometry/vec2'
import type { TerrainSampler } from '../../terrain/heightmap'
import {
  type ProfilePoint, designElevationAtStation,
} from '../../terrain/groundProfile'
import { type RoadClass, totalPavementThickness } from '../../network/roadClass'
import type { StructureSpan } from './spans'
import { MeshBuilder, type Point3 } from '../meshBuilder'
import type { MeshData } from '../ribbon'

/** Depth of the deck slab, metres. */
export const DECK_DEPTH = 1.2
/** Distance between piers, metres. */
export const PIER_SPACING = 25
/** Half the plan size of a pier, metres. */
export const PIER_HALF_WIDTH = 1.0

/**
 * How far the top of every support (abutment or pier) sits below the deck's
 * true underside at its own station, metres.
 *
 * Without this, a support's top face and the deck's underside face would be
 * exactly coincident — same station, same elevation — which is a textbook
 * z-fight: two faces at the same depth flicker unpredictably because the
 * renderer's depth buffer cannot consistently order them. Embedding the
 * support's top slightly INTO the deck instead removes the ambiguity: the two
 * faces are then unambiguously separated in depth, and the overlap itself is
 * invisible, since it sits inside the closed deck solid and is never the
 * frontmost surface from any camera position.
 *
 * 0.05m matches `EXCAVATION_ZFIGHT_MARGIN` (terrain/excavation.ts), which
 * was sized for the same renderer and the same order of viewing distance
 * (debug/roadScene.ts's camera: near=1, far=6000) — a few centimetres is well
 * clear of that depth buffer's resolution at bridge-scale ranges, without
 * visibly shortening the shortest support (a pier, metres tall).
 */
export const SUPPORT_DECK_MARGIN = 0.05

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
 * pavement stack rests on it rather than intersecting it. `deckClearance`
 * defaults to `roadClass`'s own `totalPavementThickness` — that IS the
 * distance from the design line (the top of the wearing course) down to the
 * deck, since the pavement stack occupies exactly that gap. A caller may
 * still override it via `options.deckClearance`, but there is no legitimate
 * reason to: two different bridges on the same class would then rest their
 * pavement at two different depths into the deck.
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
  roadClass: RoadClass,
  options: BridgeOptions = {},
): MeshData => {
  const {
    deckDepth = DECK_DEPTH,
    pierSpacing = PIER_SPACING,
    pierHalfWidth = PIER_HALF_WIDTH,
    // The pavement stack sits ON the deck, so the deck's own top has to sit
    // exactly one pavement-stack thickness below the design elevation.
    // Hardcoding this instead (as a bare constant, independent of class) is
    // what used to leave the deck's top 0.1m below the pavement's true
    // underside for a rural road — one class's thickness borrowed by every
    // other class, wrong in whichever direction that class's own thickness
    // differs from it.
    deckClearance = totalPavementThickness(roadClass),
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
    // An abutment carries the full road width; a pier is a slender column.
    const halfAcross = isAbutment ? halfWidth : pierHalfWidth
    // addBox centres its footprint symmetrically on the station it's given.
    // An abutment sits AT the span boundary, so a symmetric box there would
    // hang half its length past the boundary — outside the span. Shift its
    // centre inward by its own half-length so the whole box lands inside.
    const boxStation = isAbutment
      ? (s === span.fromStation ? s + pierHalfWidth : s - pierHalfWidth)
      : s

    // Ground and deck underside are both measured at the box's OWN station,
    // not at `s`. For a pier the two are the same station, so this changes
    // nothing; for an abutment the box is shifted inward by `pierHalfWidth`,
    // and on a graded design line that shift changes the deck's true
    // underside elevation there. Measuring at `s` instead (the old code) left
    // the abutment's top up to `grade * pierHalfWidth` away from where the
    // deck underside actually sits above the box's real footprint — on this
    // codebase's demo scene, about 0.07m, sometimes short of the deck,
    // sometimes into it, either way wrong.
    const pose = alignment.poseAt(boxStation)
    const groundZ = terrain.sample(pose.position.x, pose.position.y)
    // See `SUPPORT_DECK_MARGIN`: the support's top is pulled down into the
    // deck by a fixed margin so the two faces are never coincident.
    const topZ = deckSection(boxStation).leftBottom.z - SUPPORT_DECK_MARGIN
    if (topZ <= groundZ) continue

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
