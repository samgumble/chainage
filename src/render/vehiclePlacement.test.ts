import { describe, it, expect } from 'vitest'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import { ROAD_CLASSES, carriagewayHalfWidth } from '../network/roadClass'
import type { ProfilePoint } from '../terrain/groundProfile'
import { DRIVING_SIDE, laneCentreOffset, placeVehicle } from './vehiclePlacement'

/** A straight from the origin, `heading` radians from +x. */
const straight = (heading: number, length = 400): Alignment =>
  new Alignment([new Line(vec2(0, 0), heading, length)])

const level = (z: number): ProfilePoint[] => [
  { s: 0, z },
  { s: 400, z },
]

describe('laneCentreOffset', () => {
  it('is the centre of the nearside lane', () => {
    expect(laneCentreOffset(ROAD_CLASSES.rural)).toBeCloseTo(1.75, 12)
    expect(laneCentreOffset(ROAD_CLASSES.arterial)).toBeCloseTo(5.25, 12)
    expect(laneCentreOffset(ROAD_CLASSES.highway)).toBeCloseTo(9.25, 12)
  })

  it('is zero on a single-lane road', () => {
    // A gravel track has one lane, so its lane centre IS its centreline.
    expect(ROAD_CLASSES.gravel.laneCount).toBe(1)
    expect(laneCentreOffset(ROAD_CLASSES.gravel)).toBe(0)
  })

  it('keeps the vehicle inside the carriageway', () => {
    for (const rc of Object.values(ROAD_CLASSES)) {
      const edgeOfLane = Math.abs(laneCentreOffset(rc)) + rc.laneWidth / 2
      expect(edgeOfLane).toBeCloseTo(carriagewayHalfWidth(rc), 12)
    }
  })

  it('is signed by the driving side', () => {
    // Not merely non-zero: the sign is what puts traffic on a side rather than
    // straddling the crown, and it is the one thing a screenshot from directly
    // behind cannot distinguish.
    expect(DRIVING_SIDE).toBe(1)
    expect(laneCentreOffset(ROAD_CLASSES.rural)).toBeGreaterThan(0)
  })
})

describe('placeVehicle', () => {
  const rural = ROAD_CLASSES.rural

  it('puts an eastbound vehicle north of the centreline', () => {
    // Heading 0 is +x (east); left of travel is +y (north).
    const pose = placeVehicle(straight(0), level(100), rural, 120)
    expect(pose.x).toBeCloseTo(120, 9)
    expect(pose.y).toBeCloseTo(1.75, 9)
    expect(pose.heading).toBeCloseTo(0, 12)
  })

  it('puts a westbound vehicle south of the centreline', () => {
    // The pair is the actual property: each direction keeps to its own left,
    // so two opposing roads sit on opposite sides of the same centreline.
    // A missing offset puts both at y = 0; a flipped sign puts both on the
    // wrong side, and neither is visible from behind a single car.
    const pose = placeVehicle(straight(Math.PI), level(100), rural, 120)
    expect(pose.x).toBeCloseTo(-120, 9)
    expect(pose.y).toBeCloseTo(-1.75, 9)
  })

  it('puts a northbound vehicle west of the centreline', () => {
    const pose = placeVehicle(straight(Math.PI / 2), level(100), rural, 120)
    expect(pose.x).toBeCloseTo(-1.75, 9)
    expect(pose.y).toBeCloseTo(120, 9)
  })

  it('drives a single-lane road down its centreline', () => {
    const pose = placeVehicle(straight(0), level(100), ROAD_CLASSES.gravel, 120)
    expect(pose.y).toBeCloseTo(0, 12)
    expect(pose.z).toBeCloseTo(100, 12)
  })

  it('follows the design profile rather than a constant elevation', () => {
    // 2% rise over 400m. A vehicle at s=200 is halfway up it, not at either
    // end and certainly not at zero.
    const climbing: ProfilePoint[] = [
      { s: 0, z: 100 },
      { s: 400, z: 108 },
    ]
    const low = placeVehicle(straight(0), climbing, ROAD_CLASSES.gravel, 0)
    const mid = placeVehicle(straight(0), climbing, ROAD_CLASSES.gravel, 200)
    const high = placeVehicle(straight(0), climbing, ROAD_CLASSES.gravel, 400)
    expect(low.z).toBeCloseTo(100, 12)
    expect(mid.z).toBeCloseTo(104, 12)
    expect(high.z).toBeCloseTo(108, 12)
  })

  it('sits on the crossfall, not on the crown', () => {
    const pose = placeVehicle(straight(0), level(100), rural, 120)
    expect(pose.z).toBeCloseTo(100 - 1.75 * rural.crossfall, 12)
    // Below the crown, never above it — a vehicle floating over the seal is
    // the failure this exists to avoid, on both sides of the road.
    expect(pose.z).toBeLessThan(100)
    expect(placeVehicle(straight(Math.PI), level(100), rural, 120).z).toBeLessThan(100)
  })

  it('carries the alignment’s heading through unchanged', () => {
    for (const heading of [0, Math.PI / 3, -Math.PI / 4]) {
      expect(placeVehicle(straight(heading), level(100), rural, 50).heading).toBeCloseTo(
        heading,
        12,
      )
    }
  })
})
