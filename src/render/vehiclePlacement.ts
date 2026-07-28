import type { Alignment } from '../geometry/alignment'
import { add, leftNormal, scale } from '../geometry/vec2'
import { carriagewayHalfWidth, type RoadClass } from '../network/roadClass'
import { designElevationAtStation, type ProfilePoint } from '../terrain/groundProfile'

/**
 * Which side of the centreline traffic drives on, as a multiplier on the
 * left-of-travel normal (`leftNormal`, which points +90° from the heading).
 *
 * `+1` keeps left; `-1` would keep right. The spec does not say which, and the
 * rest of the project reads Commonwealth throughout — chainage, formation
 * width, carriageway, wearing course — so left it is. What matters more than
 * the choice is that it is a named constant with a sign: a fleet driving down
 * the centreline and a fleet driving on the wrong side look identical from
 * anywhere but directly overhead, so this is not something to leave implicit
 * in an expression somewhere.
 */
export const DRIVING_SIDE = 1

/**
 * How far a vehicle's path sits from the road's centreline, metres, signed
 * positive to the LEFT of travel.
 *
 * The centre of the nearside lane: half the carriageway, less half a lane. For
 * a two-lane rural road that is 3.5 − 1.75 = 1.75m; for a six-lane highway,
 * 11.1 − 1.85 = 9.25m, the outermost lane rather than the middle of the six.
 *
 * A single-lane road falls out of the same expression at exactly zero — a
 * gravel track's carriageway half-width IS half a lane — which is right, and
 * is why this is one formula rather than a special case. Traffic on a
 * single-lane track drives down the middle because there is nowhere else to
 * drive.
 */
export const laneCentreOffset = (rc: RoadClass): number =>
  DRIVING_SIDE * (carriagewayHalfWidth(rc) - rc.laneWidth / 2)

/** Where a vehicle is, in the project's own convention: `(x, y)` ground with
 * `y` north, `z` up, and a heading measured counter-clockwise from +x. */
export type VehiclePose = {
  readonly x: number
  readonly y: number
  /** Elevation of the road surface under the vehicle, metres. */
  readonly z: number
  readonly heading: number
}

/**
 * Place a vehicle at a station along a road.
 *
 * Three things happen here and none of them belongs in `traffic/`, which knows
 * only that a vehicle is some number of metres along a lane:
 *
 * - the station becomes a point, via the alignment's own `poseAt`;
 * - the point steps sideways to the middle of the correct lane;
 * - and it is lifted to the elevation the road was actually *built* at.
 *
 * That last one is `designElevationAtStation` against the road's solved design
 * profile, not a constant and not the terrain: this scene's roads run through
 * cuttings, over embankments and across a bridge, and a vehicle at a fixed
 * elevation would be underground for a third of the west arm and floating over
 * the valley on the east. The caller is responsible for not asking about a
 * road with no design profile at all — `designElevationAtStation` answers zero
 * for an empty profile, which on this terrain is eighty metres underground.
 *
 * Crossfall is subtracted because the design line is the crown and the vehicle
 * is not on it. It is small (4cm out on a rural road) and it is free, and the
 * one place it is not small is the wide class where a vehicle sits nine metres
 * off the crown and would otherwise hover 23cm above the seal.
 */
export const placeVehicle = (
  alignment: Alignment,
  design: readonly ProfilePoint[],
  rc: RoadClass,
  station: number,
): VehiclePose => {
  const pose = alignment.poseAt(station)
  const offset = laneCentreOffset(rc)
  const position = add(pose.position, scale(leftNormal(pose.heading), offset))
  const crown = designElevationAtStation(design, station)

  return {
    x: position.x,
    y: position.y,
    z: crown - Math.abs(offset) * rc.crossfall,
    heading: pose.heading,
  }
}
