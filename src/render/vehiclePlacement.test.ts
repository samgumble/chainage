import { describe, it, expect } from 'vitest'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import { ROAD_CLASSES, carriagewayHalfWidth, type RoadClass } from '../network/roadClass'
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
    // Below the crown, never above it — a vehicle floating over the seal is the
    // failure this exists to avoid.
    expect(pose.z).toBeLessThan(100)
  })

  /**
   * A class whose lane centre falls on the OTHER side of the crown.
   *
   * `laneCentreOffset` is `DRIVING_SIDE * laneWidth * (laneCount - 1) / 2`, so
   * replacing `laneCount` with `2 - laneCount` negates it exactly, for every
   * class, leaving everything else the crossfall arithmetic reads untouched.
   * That is the only way to drive `placeVehicle` with a negative offset from a
   * test: `DRIVING_SIDE` is a module constant and cannot be flipped at runtime,
   * and with it set to `+1` no real class produces one.
   *
   * The lane count itself is meaningless here and nothing asserts on it. What
   * is being asserted is the sign of the offset the function is handed.
   */
  const mirrored = (rc: RoadClass): RoadClass => ({ ...rc, laneCount: 2 - rc.laneCount })

  it('drops below the crown on either side of it, not only the nearside', () => {
    // The `Math.abs` in the crossfall term. With `DRIVING_SIDE = +1` every real
    // class's offset is non-negative, so dropping the `abs` changes nothing
    // anyone can measure — until someone sets it to `-1` for right-hand drive,
    // at which point every vehicle in the scene floats above the seal by twice
    // the crossfall drop instead of sitting on it.
    //
    // Reversing the ROAD does not exercise this, which is what the version of
    // this test being replaced tried: `straight(0)` and `straight(Math.PI)` are
    // two headings, and the offset is measured FROM the heading, so both have
    // the same +1.75m and the second assertion was the first one again.
    for (const rc of Object.values(ROAD_CLASSES)) {
      const nearside = laneCentreOffset(rc)
      const offside = laneCentreOffset(mirrored(rc))
      expect(offside).toBeCloseTo(-nearside, 12)

      const left = placeVehicle(straight(0), level(100), rc, 120)
      const right = placeVehicle(straight(0), level(100), mirrored(rc), 120)

      // The two sit on opposite sides of the centreline...
      expect(right.y).toBeCloseTo(-left.y, 12)
      // ...at the same height, because a crown sheds both ways.
      expect(right.z).toBeCloseTo(left.z, 12)
      expect(right.z).toBeCloseTo(100 - Math.abs(nearside) * rc.crossfall, 12)
      // And never above the crown. Without the `abs` this is the assertion that
      // fails, by twice the drop.
      expect(right.z).toBeLessThanOrEqual(100)
    }
  })

  it('would put the offside vehicle measurably above the seal without the abs', () => {
    // The size of the defect the `abs` prevents, so "provably dead code" and
    // "harmless" are not confused. On a six-lane highway the offside lane centre
    // is 9.25m from the crown: without the `abs` a vehicle there sits 23cm above
    // the road instead of 23cm below it.
    const highway = mirrored(ROAD_CLASSES.highway)
    const offset = laneCentreOffset(highway)
    const withAbs = placeVehicle(straight(0), level(100), highway, 120).z
    const withoutAbs = 100 - offset * ROAD_CLASSES.highway.crossfall

    expect(offset).toBeCloseTo(-9.25, 12)
    expect(withAbs).toBeCloseTo(100 - 0.23125, 12)
    expect(withoutAbs).toBeGreaterThan(100)
    expect(withoutAbs - withAbs).toBeCloseTo(2 * 9.25 * ROAD_CLASSES.highway.crossfall, 12)
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
