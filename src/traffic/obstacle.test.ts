import { describe, expect, it } from 'vitest'
import { type IdmParams, idmAcceleration } from './idm'
import { Lane, VEHICLE_LENGTH } from './lane'
import { REACTION_TIME, canClearBeforeStopping } from './obstacle'

const p: IdmParams = {
  maxAcceleration: 1.5,
  comfortableDeceleration: 2.0,
  desiredSpeed: 30,
  minimumGap: 2,
  headwayTime: 1.5,
}

/**
 * The road a vehicle at `v` needs to stop at the comfortable deceleration,
 * derived rather than tabulated: reaction distance plus braking distance. This
 * is the right-hand side of the dilemma-zone rule, written out independently
 * of the implementation so the tests below assert against the physics.
 */
const stoppingDistance = (v: number, q: IdmParams): number =>
  (v * v) / (2 * q.comfortableDeceleration) + v * REACTION_TIME

/** Run a lane for a while at a fixed step. */
const run = (lane: Lane, seconds: number, dt = 0.2): void => {
  for (let t = 0; t < seconds; t += dt) lane.step(dt, p)
}

/** Hardest braking any vehicle in the lane does over `seconds`, m/s². */
const worstDeceleration = (lane: Lane, seconds: number, dt = 0.1): number => {
  let worst = 0
  for (let t = 0; t < seconds; t += dt) {
    const before = Array.from({ length: lane.count }, (_, i) => lane.speedOf(i))
    lane.step(dt, p)
    for (let i = 0; i < lane.count; i++) {
      worst = Math.max(worst, (before[i]! - lane.speedOf(i)) / dt)
    }
  }
  return worst
}

describe('canClearBeforeStopping', () => {
  it('flips at exactly the comfortable stopping distance', () => {
    const v = 20
    const d = stoppingDistance(v, p)   // 100m of braking + 20m of reacting

    // The boundary belongs to stopping: at exactly `d` the vehicle can still
    // make the line at deceleration `b`, so it does.
    expect(canClearBeforeStopping({ speed: v, distance: d }, p)).toBe(false)
    expect(canClearBeforeStopping({ speed: v, distance: d + 0.5 }, p)).toBe(false)
    expect(canClearBeforeStopping({ speed: v, distance: d - 0.5 }, p)).toBe(true)
  })

  it('counts the distance covered while the driver is still reacting', () => {
    // Between the two thresholds: far enough to brake to rest in `v²/(2b)`,
    // but not once a second of reaction time is spent first. Dropping the
    // reaction term is invisible everywhere except this band, and inside it
    // the answer inverts.
    const v = 20
    const brakingOnly = (v * v) / (2 * p.comfortableDeceleration)   // 100m
    const d = brakingOnly + v * REACTION_TIME * 0.5                 // 110m

    expect(d).toBeGreaterThan(brakingOnly)
    expect(d).toBeLessThan(stoppingDistance(v, p))
    expect(canClearBeforeStopping({ speed: v, distance: d }, p)).toBe(true)
  })

  it('scales the zone with the square of speed, not with speed', () => {
    // Doubling the speed roughly quadruples the zone. A vehicle at 30 m/s is
    // committed at a distance a vehicle at 15 m/s stops comfortably from.
    const d = stoppingDistance(30, p) * 0.9

    expect(canClearBeforeStopping({ speed: 30, distance: d }, p)).toBe(true)
    expect(canClearBeforeStopping({ speed: 15, distance: d }, p)).toBe(false)
  })

  it('never sends a stopped vehicle through', () => {
    // Both terms vanish at rest, so the threshold is zero and any vehicle at
    // or short of the line stops. A rule that let a stationary car at the line
    // "proceed" would discharge a queue through a red.
    expect(canClearBeforeStopping({ speed: 0, distance: 0 }, p)).toBe(false)
    expect(canClearBeforeStopping({ speed: 0, distance: 30 }, p)).toBe(false)
  })

  it('lets a vehicle already past the line carry on', () => {
    expect(canClearBeforeStopping({ speed: 10, distance: -1 }, p)).toBe(true)
    expect(canClearBeforeStopping({ speed: 0, distance: -1 }, p)).toBe(true)
  })

  it('rejects nonsense', () => {
    expect(() => canClearBeforeStopping({ speed: -1, distance: 10 }, p)).toThrow(RangeError)
    expect(() => canClearBeforeStopping({ speed: Number.NaN, distance: 10 }, p)).toThrow(RangeError)
    expect(() => canClearBeforeStopping({ speed: 10, distance: Number.NaN }, p)).toThrow(RangeError)
    expect(() =>
      canClearBeforeStopping({ speed: 10, distance: 10 }, { ...p, comfortableDeceleration: 0 }),
    ).toThrow(RangeError)
  })
})

describe('Lane obstacles', () => {
  it('records and clears the stop line', () => {
    const lane = new Lane(1000)
    expect(lane.obstacle).toBeUndefined()
    lane.setObstacle(500)
    expect(lane.obstacle).toBe(500)
    lane.setObstacle(undefined)
    expect(lane.obstacle).toBeUndefined()
    expect(() => lane.setObstacle(Number.NaN)).toThrow(RangeError)
    expect(() => lane.setObstacle(Infinity)).toThrow(RangeError)
  })

  it('brings an approaching vehicle to rest just short of the line', () => {
    // The whole point of the task: before this, a Lane had nothing that could
    // hold a vehicle stationary — vehicle 0 always had open road and drove
    // away from any standstill.
    const lane = new Lane(2000)
    lane.setObstacle(500)
    lane.add(100, 20)

    run(lane, 200)

    expect(lane.speedOf(0)).toBe(0)
    // Stopped `minimumGap` short of the line, not a vehicle length further
    // back and not over it. IDM's equilibrium gap at zero closing speed is
    // exactly `s0`, so this number is the model's, not a fudge.
    expect(lane.positionOf(0)).toBeCloseTo(500 - p.minimumGap, 3)
  })

  it('treats the phantom as a stationary vehicle with its rear bumper on the line', () => {
    // Pinned against the model in one step, because the two mistakes available
    // here — putting the phantom a vehicle length off, or giving it a speed —
    // both produce queues that stop in plausible-looking places.
    const lane = new Lane(2000)
    lane.setObstacle(500)
    lane.add(400, 20)

    const gapToLine = 100
    const expected = idmAcceleration({ speed: 20, gap: gapToLine, leaderSpeed: 0 }, p)
    const ifLengthSubtracted = idmAcceleration(
      { speed: 20, gap: gapToLine - VEHICLE_LENGTH, leaderSpeed: 0 },
      p,
    )
    const ifPhantomDrifted = idmAcceleration(
      { speed: 20, gap: gapToLine, leaderSpeed: 5 },
      p,
    )
    // The assertion can only tell these apart if they are actually apart.
    expect(Math.abs(expected - ifLengthSubtracted)).toBeGreaterThan(0.1)
    expect(Math.abs(expected - ifPhantomDrifted)).toBeGreaterThan(0.1)

    lane.step(0.2, p)
    expect((lane.speedOf(0) - 20) / 0.2).toBeCloseTo(expected, 9)
  })

  it('parks a queue behind the line at the standstill spacing', () => {
    const lane = new Lane(2000)
    lane.setObstacle(500)
    for (let i = 0; i < 5; i++) lane.add(400 - i * 30, 15)

    run(lane, 200)

    const standstill = p.minimumGap + VEHICLE_LENGTH
    for (let i = 0; i < 5; i++) {
      expect(lane.speedOf(i)).toBe(0)
      expect(lane.positionOf(i)).toBeCloseTo(500 - p.minimumGap - i * standstill, 3)
    }
  })

  it('discharges the queue from the front when the line is cleared', () => {
    const lane = new Lane(2000)
    lane.setObstacle(500)
    for (let i = 0; i < 5; i++) lane.add(400 - i * 30, 15)
    run(lane, 200)

    lane.setObstacle(undefined)
    lane.step(0.2, p)

    // One step after the light changes only the vehicle at the line has moved.
    // Everyone behind it is still `minimumGap` off a stationary leader, and
    // the two-pass step means the news travels one vehicle at a time — which
    // is the start-up shockwave, not a whole queue lurching together.
    expect(lane.speedOf(0)).toBeGreaterThan(0)
    for (let i = 1; i < 5; i++) expect(lane.speedOf(i)).toBe(0)

    // And given time the queue really does clear rather than crawl.
    run(lane, 60)
    for (let i = 0; i < 5; i++) expect(lane.speedOf(i)).toBeGreaterThan(10)
  })

  it('ignores a line a vehicle has already passed', () => {
    // The obvious off-by-one, and it would have cars braking for lights
    // behind them. Held to bit-for-bit equality with an unobstructed lane.
    const build = (): Lane => {
      const lane = new Lane(2000)
      lane.add(600, 20)   // past the line
      lane.add(400, 20)   // short of it
      return lane
    }
    const obstructed = build()
    obstructed.setObstacle(500)
    const clear = build()

    for (let k = 0; k < 250; k++) {
      obstructed.step(0.2, p)
      clear.step(0.2, p)
      expect(obstructed.positionOf(0)).toBe(clear.positionOf(0))
      expect(obstructed.speedOf(0)).toBe(clear.speedOf(0))
    }

    // The fixture is not vacuous: the vehicle short of the line did stop.
    expect(obstructed.speedOf(1)).toBe(0)
    expect(clear.speedOf(1)).toBeGreaterThan(10)
  })

  it('does not let a vehicle stopped exactly on the line creep through', () => {
    // A phantom on top of a vehicle divides by a zero gap. The IDM clamps it,
    // so the answer is an enormous but finite braking — never NaN, which would
    // reach a vertex buffer silently.
    const lane = new Lane(2000)
    lane.setObstacle(500)
    lane.add(500, 0)

    run(lane, 20)

    expect(Number.isFinite(lane.positionOf(0))).toBe(true)
    expect(Number.isFinite(lane.speedOf(0))).toBe(true)
    expect(lane.speedOf(0)).toBe(0)
    expect(lane.positionOf(0)).toBe(500)
  })

  it('follows the nearer of the real leader and the line', () => {
    // Both vehicles are short of the line, so vehicle 1's real leader is
    // always the closer of the two and the phantom must not override it.
    const lane = new Lane(2000)
    lane.setObstacle(500)
    lane.add(480, 15)
    lane.add(460, 15)

    const followingLeader = idmAcceleration(
      { speed: 15, gap: 480 - 460 - VEHICLE_LENGTH, leaderSpeed: 15 },
      p,
    )
    const followingLine = idmAcceleration({ speed: 15, gap: 500 - 460, leaderSpeed: 0 }, p)
    expect(Math.abs(followingLeader - followingLine)).toBeGreaterThan(0.1)

    lane.step(0.2, p)
    expect((lane.speedOf(1) - 15) / 0.2).toBeCloseTo(followingLeader, 9)
  })
})

describe('the dilemma zone', () => {
  it('would emergency-brake a vehicle too close to stop', () => {
    // Why the rule exists. At 60% of the comfortable stopping distance the
    // rule says proceed; a caller that dropped the phantom in anyway gets
    // 5.1 m/s² of braking out of a driver whose comfortable figure is 2.
    const v = 20
    const line = 1000
    const d = stoppingDistance(v, p) * 0.6

    expect(canClearBeforeStopping({ speed: v, distance: d }, p)).toBe(true)

    const forced = new Lane(20000)
    forced.setObstacle(line)
    forced.add(line - d, v)
    expect(worstDeceleration(forced, 60)).toBeGreaterThan(2 * p.comfortableDeceleration)

    // Proceeding instead, it never brakes at all — the phantom is simply not
    // there, and there is no other braking path in the model to trigger.
    const proceeding = new Lane(20000)
    proceeding.add(line - d, v)
    expect(worstDeceleration(proceeding, 60)).toBe(0)
  })

  it('stops comfortably from the far edge of the zone', () => {
    // The calibration claim, and the reason the threshold is this expression
    // and not another: a vehicle told to stop from exactly the threshold
    // distance brakes at 2.12 m/s² against a comfortable 2.0. Move the
    // threshold in and that number climbs without bound.
    const v = 20
    const line = 1000
    const d = stoppingDistance(v, p)

    expect(canClearBeforeStopping({ speed: v, distance: d }, p)).toBe(false)

    const lane = new Lane(20000)
    lane.setObstacle(line)
    lane.add(line - d, v)
    const worst = worstDeceleration(lane, 60)

    expect(worst).toBeGreaterThan(0.5 * p.comfortableDeceleration)
    expect(worst).toBeLessThan(p.comfortableDeceleration * 1.15)
    expect(lane.speedOf(0)).toBe(0)
    expect(lane.positionOf(0)).toBeCloseTo(line - p.minimumGap, 3)
  })
})

/**
 * The two halves that do not compose, pinned as characterised behaviour.
 *
 * `canClearBeforeStopping` answers per vehicle; `Lane.setObstacle` acts on the
 * whole lane. Put a leader inside the dilemma zone and a follower outside it
 * and there is no call that is right for both — which is why `setObstacle`
 * still has no caller anywhere in the codebase, and why this is written down
 * rather than worked around at some call site.
 *
 * These tests assert the WRONG behaviour on purpose, in both directions. They
 * are the marker for the later per-vehicle stopping work: when a signal system
 * lands, exactly these are the expectations that have to change, and a version
 * of them that merely said "TODO" in a comment would not.
 */
describe('the per-vehicle/whole-lane mismatch', () => {
  const line = 1000
  const v = 20

  /** Inside the dilemma zone: the rule says proceed. */
  const leaderDistance = 72
  /** Outside it: the rule says stop. */
  const followerDistance = 192

  /** A lane with the leader and the follower on it at their desired speed. */
  const twoVehicles = (): Lane => {
    const lane = new Lane(20000)
    lane.add(line - leaderDistance, v)
    lane.add(line - followerDistance, v)
    return lane
  }

  it('sets up one vehicle that should proceed and one that should stop', () => {
    // The fixture is the claim. `stoppingDistance(20, p)` is 120m, so 72m is
    // inside the zone and 192m is outside it, and no single stop line can be
    // right for both.
    expect(stoppingDistance(v, p)).toBeCloseTo(120, 9)
    expect(canClearBeforeStopping({ speed: v, distance: leaderDistance }, p)).toBe(true)
    expect(canClearBeforeStopping({ speed: v, distance: followerDistance }, p)).toBe(false)
  })

  it('emergency-brakes the vehicle the rule says should proceed', () => {
    // WRONG, and pinned: 5.09 m/s² out of a driver whose comfortable figure is
    // 2.0. `setObstacle` cannot exempt the one vehicle that is committed.
    const lane = twoVehicles()
    lane.setObstacle(line)

    // Read off the model directly rather than through a step, so the number in
    // the two docstrings is the acceleration itself, not a finite difference.
    const phantomGap = line + VEHICLE_LENGTH - (line - leaderDistance) - VEHICLE_LENGTH
    const leaderAcceleration = idmAcceleration(
      { speed: v, gap: phantomGap, leaderSpeed: 0 },
      p,
    )
    expect(leaderAcceleration).toBeCloseTo(-5.089, 3)
    expect(-leaderAcceleration).toBeGreaterThan(2.5 * p.comfortableDeceleration)

    // And it is not a one-frame artefact of the first step: the lane really
    // does brake this hard.
    expect(worstDeceleration(lane, 30)).toBeGreaterThan(2.5 * p.comfortableDeceleration)
  })

  it('lets the vehicle the rule says should stop cross the line at speed', () => {
    // WRONG in the other direction, and the only other call available. The
    // follower is 192m short of a line it has the room to stop at, and clearing
    // the line is the only way to spare the leader — so the follower is never
    // told anything.
    const lane = twoVehicles()
    lane.setObstacle(undefined)
    run(lane, 30)

    // Index 1 is the follower; ordering is by descending position.
    expect(lane.count).toBe(2)
    expect(lane.positionOf(1)).toBeGreaterThan(line)
    expect(lane.speedOf(1)).toBeGreaterThan(v)
  })

  it('has no third call, at any position at all', () => {
    // The completeness claim, and the reason this is a design gap rather than a
    // tuning one. `setObstacle` takes one position or nothing, so the only
    // escape from the two calls above would be to move the line somewhere else.
    //
    // Nowhere works, and the two conditions are exactly complementary:
    //
    // - The ONLY way a line spares the leader is to be behind it. A line ahead
    //   of it brakes it whatever `canClearBeforeStopping` thinks; the rule's
    //   verdict has no effect on `Lane.step`, which is the whole problem.
    // - The follower stops only for a line at least its own stopping distance
    //   ahead — 120m from 808, which is 928, which is precisely where the
    //   leader is.
    //
    // The two sets touch and do not overlap. Sweeping at 10cm resolution over
    // 800m of lane finds no position in both.
    let both = 0
    for (let at = line - 400; at <= line + 400; at += 0.1) {
      // The phantom exists only for vehicles short of it — see `Lane.step`.
      const leaderSpared = at < line - leaderDistance
      const followerStopped = !canClearBeforeStopping(
        { speed: v, distance: at - (line - followerDistance) }, p,
      )
      if (leaderSpared && followerStopped) both++
    }
    expect(both).toBe(0)

    // And the touching point is not a loophole: a line exactly on the leader is
    // a phantom inside the leader, which brakes it harder still.
    expect(idmAcceleration({ speed: v, gap: 0, leaderSpeed: 0 }, p)).toBeLessThan(-5.089)
  })
})
