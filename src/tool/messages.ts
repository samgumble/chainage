import type { PolylineRejection } from '../geometry/polyline'
import type { UpgradeObstacle } from '../mesh/upgradeCheck'
import type { InfeasibleCrossing, ShallowCrossing } from '../network/crossingKind'
import type { RoadId } from '../network/graph'
import type { SplitOutcome } from './selectTool'

/**
 * Round to one decimal place for display.
 *
 * A metre to the millimetre is noise nobody clicking with a mouse produced,
 * and an unrounded float sitting in a sentence reads as a bug rather than a
 * measurement.
 */
const fmt = (metres: number): string => metres.toFixed(1)

/**
 * Turn a refused polyline into a sentence a player can act on.
 *
 * Every variant names the point it is about using the caller's own
 * one-based numbering: indices are zero-based everywhere in the geometry
 * code, but a person counting clicks starts from one.
 */
export const describePolylineRejection = (rejection: PolylineRejection): string => {
  switch (rejection.reason) {
    case 'too-few-points':
      return 'A road needs at least two points before it can be built.'
    case 'corner-too-sharp':
      return `The corner at point ${rejection.index + 1} turns too sharply for a curve to fit there.`
    case 'curves-overlap':
      return (
        `The straight after point ${rejection.index + 1} needs ${fmt(rejection.required)}m ` +
        `for its curves, but only ${fmt(rejection.available)}m of straight is available.`
      )
    case 'segment-too-short':
      return (
        `The straight after point ${rejection.index + 1} is only ${fmt(rejection.length)}m ` +
        `long, short of the ${fmt(rejection.limit)}m minimum.`
      )
  }
}

/**
 * Turn one obstacle to an upgrade into a sentence.
 *
 * `curve-too-tight` and `trim-too-long` are the two variants with numbers to
 * report, and both get them: the station and radii for a curve, the trim and
 * its limit for a junction. `too-few-legs` and `near-parallel-legs` carry no
 * numbers because none exist — a dead end has no radius to be too tight, and
 * a corner with no unique position has no trim to measure — so their
 * sentences stay purely qualitative rather than reaching for something to
 * print.
 *
 * Every junction sentence names which end of the road it is about (`start`
 * or `end`, from `UpgradeObstacle.roadEnd`) rather than the raw `nodeId` —
 * an internal counter with no meaning to a player — so a road with obstacles
 * at both its ends produces two sentences a player can actually tell apart,
 * not two copies of the same wording.
 */
export const describeUpgradeObstacle = (obstacle: UpgradeObstacle): string => {
  if (obstacle.kind === 'alignment') {
    const { station, actualRadius, requiredRadius } = obstacle.rejection
    return (
      `At station ${fmt(station)}, the curve there has a radius of ${fmt(actualRadius)}m, ` +
      `tighter than the ${fmt(requiredRadius)}m this class requires.`
    )
  }

  const end = obstacle.roadEnd

  switch (obstacle.reason) {
    case 'too-few-legs':
      return `The junction at the road's ${end} does not have enough legs to widen safely.`
    case 'near-parallel-legs':
      return `The junction at the road's ${end} has legs too close to parallel to find a stable corner.`
    case 'trim-too-long':
      return (
        `A leg at the junction at the road's ${end} would need to pull back ${fmt(obstacle.worstTrim)}m, ` +
        `beyond the ${fmt(obstacle.maxTrim)}m limit.`
      )
  }
}

/**
 * Turn every obstacle blocking an upgrade into one message.
 *
 * Reports all of them, never only the first: a player who fixes the one
 * problem they were shown, only to be told of another the tool already
 * knew about, stops trusting it.
 */
export const describeUpgradeObstacles = (obstacles: readonly UpgradeObstacle[]): string =>
  obstacles.map(describeUpgradeObstacle).join(' ')

/** Turn a select-tool split attempt into a sentence. */
export const describeSplitOutcome = (outcome: SplitOutcome): string => {
  if (outcome.ok) {
    return 'Split the road into two at the new junction.'
  }

  switch (outcome.reason) {
    case 'nothing-selected':
      return 'Select a road before trying to split it.'
    case 'not-on-the-selected-road':
      return "That point isn't on the selected road."
    case 'too-near-an-end':
      return 'That point is too close to the end of the road to split there.'
  }
}

/**
 * Summarise the roads whose vertical alignment could not be solved.
 *
 * Empty for the common case of a run where every road found a legal grade
 * line, so a caller can test the result for truthiness instead of comparing
 * against a sentinel. Otherwise names how many failed and where the first of
 * them gives up, since that is the one a player is most likely to fix first.
 */
export const describeInfeasibleRoads = (infeasible: ReadonlyMap<RoadId, number>): string => {
  const entries = [...infeasible.entries()]
  const first = entries[0]
  if (!first) return ''

  const count = entries.length
  const [, firstStation] = first
  const roadWord = count === 1 ? 'road' : 'roads'
  return (
    `${count} ${roadWord} could not find a legal vertical grade line; the first gives up ` +
    `at station ${fmt(firstStation)}m.`
  )
}

/**
 * Summarise the crossings that could not be raised clear of the road below.
 *
 * A separate channel from `describeInfeasibleRoads`, not a variant of it,
 * because the cause and the fix are different things. A road in
 * `infeasibleRoads` cannot be graded against the terrain at all and wants a
 * different alignment; a road here grades perfectly well on its own and only
 * fails once it has to climb over something, so the fix is to cross somewhere
 * else — or to click on the other road and make it a junction instead.
 *
 * Empty when nothing failed, so a caller can test it for truthiness, exactly
 * as `describeInfeasibleRoads` is used.
 */
export const describeInfeasibleCrossings = (
  crossings: readonly InfeasibleCrossing[],
): string => {
  const first = crossings[0]
  if (!first) return ''

  const count = crossings.length
  const word = count === 1 ? 'crossing' : 'crossings'
  return (
    `${count} ${word} could not be carried over the road below; the first needs ` +
    `road ${first.road} at ${fmt(first.requiredElevation)}m by station ` +
    `${fmt(first.station)}m to clear road ${first.crosses}, and its grade line ` +
    `gives up at station ${fmt(first.failedAtStation)}m.`
  )
}

/**
 * Summarise the crossings that were decked to a clamped length.
 *
 * A third channel again, and for the same reason the second one exists: the
 * outcome is different from either of the others. These roads graded, got
 * their lift and got a deck — the deck is simply too short for the angle, so
 * the crossing is built and known to be wrong, rather than refused. The fix
 * available to the player is different too: not a different alignment, and not
 * a different place to cross, but a squarer angle to cross at.
 *
 * Empty when nothing was clamped, so a caller can test it for truthiness,
 * exactly as the other two are used.
 */
export const describeShallowCrossings = (
  crossings: readonly ShallowCrossing[],
): string => {
  const first = crossings[0]
  if (!first) return ''

  const count = crossings.length
  const word = count === 1 ? 'crossing' : 'crossings'
  const degrees = (first.angle * 180) / Math.PI
  return (
    `${count} ${word} cross too shallowly to deck; the first has road ${first.road} ` +
    `over road ${first.crosses} at ${fmt(degrees)} degrees, which needs ` +
    `${fmt(first.requiredHalfLength)}m of deck each way but was built with ` +
    `${fmt(first.deckHalfLength)}m, so its earthwork falls on the road below.`
  )
}
