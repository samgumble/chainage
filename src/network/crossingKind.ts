import { distance, type Vec2 } from '../geometry/vec2'
import type { Crossing } from './crossings'
import type { RoadId } from './graph'

/**
 * What a player meant by two roads meeting in plan.
 *
 * `'intersection'` — they meant them to connect. The crossing sits on a point
 * the player placed, which is the only evidence available that the meeting
 * was deliberate. Both roads are split there and share a node, so the two
 * carriageways join at grade.
 *
 * `'overpass'` — they did not. The crossing fell between placed points: the
 * alignment happened to run across another road on its way somewhere else.
 * The roads are left unsplit and separated vertically instead.
 */
export type CrossingKind = 'intersection' | 'overpass'

/**
 * A crossing that had to be raised clear of the road below and could not be.
 *
 * Lives here rather than with whatever produces it so that the tool layer can
 * describe one without depending on the scene that built it — the same
 * arrangement `UpgradeObstacle` already has with `messages.ts`.
 *
 * Not a warning. There is no correct road to build for this: dropping the lift
 * builds one road through another, and keeping it builds a climb steeper than
 * the class allows. The road gets no design profile at all and this says why.
 */
export type InfeasibleCrossing = {
  /** The road that had to be lifted — always the newer of the two. */
  readonly road: RoadId
  /** The road it had to clear. Its profile is untouched. */
  readonly crosses: RoadId
  /** Station on `road` where the crossing falls, metres. */
  readonly station: number
  /** Design elevation `road` needed there to clear `crosses`, metres. */
  readonly requiredElevation: number
  /** Station where the grade solve ran out of room, metres. */
  readonly failedAtStation: number
}

/**
 * A crossing too shallow for an honest overpass deck, built to a clamped one.
 *
 * A deck has to keep the lifted road's earthwork out of a band either side of
 * the road below, and the station length that takes grows as `1 / sin θ` in
 * the angle between the two alignments — without bound as they approach
 * parallel. Something has to stop it, so the derivation is clamped; but a
 * clamped deck is a deck that is genuinely too short, and the earthwork it
 * fails to hold back lands on the road underneath. That is the same defect
 * the grade separation exists to fix, so it is reported rather than left to be
 * discovered by looking at it.
 *
 * A separate channel from `InfeasibleCrossing` because the outcome is
 * different: an infeasible crossing produces no road at all, while this one
 * produces a road, and a deck, and a known-wrong overlap at the crossing.
 */
export type ShallowCrossing = {
  /** The road that was lifted — always the newer of the two. */
  readonly road: RoadId
  /** The road it was lifted over. */
  readonly crosses: RoadId
  /** Station on `road` where the crossing falls, metres. */
  readonly station: number
  /** Angle between the two alignments at the crossing, radians. */
  readonly angle: number
  /** Half-length the deck was actually built to, metres. */
  readonly deckHalfLength: number
  /**
   * Half-length the crossing angle actually called for, metres.
   *
   * `Infinity` for two exactly parallel alignments — which `findCrossings`
   * cannot report, since parallel segments never intersect, but which the
   * arithmetic here reaches honestly rather than by a special case.
   */
  readonly requiredHalfLength: number
}

/**
 * Whether a crossing is a junction the player asked for or a road they drew
 * across another one.
 *
 * The whole distinction rests on the placed points, and deliberately so. Two
 * alignments crossing in plan is not, by itself, evidence of anything: the
 * player's intent is recorded exactly once, in where they chose to click. A
 * click on an existing road says "join here"; an alignment that runs over one
 * between two clicks says nothing at all about it, and the honest reading of
 * silence is that they wanted to get past it, not into it.
 *
 * Deriving it from geometry instead — angle of crossing, road classes, which
 * design line happens to sit higher — would be guessing at intent from
 * evidence that does not contain it, and would make the same drawn road
 * become a junction or an overpass depending on terrain it was never drawn
 * against.
 *
 * `tolerance` is the caller's, because what counts as "on a placed point"
 * depends on how the crossing position was obtained. A crossing found by
 * intersecting sampled polylines carries the sampling's own error, which a
 * caller comparing against exact click positions has to allow for.
 */
export const classifyCrossing = (
  crossing: Crossing,
  placedPoints: readonly Vec2[],
  tolerance: number,
): CrossingKind => {
  if (tolerance < 0) {
    throw new RangeError('tolerance must not be negative')
  }

  for (const point of placedPoints) {
    if (distance(point, crossing.position) <= tolerance) return 'intersection'
  }
  return 'overpass'
}
