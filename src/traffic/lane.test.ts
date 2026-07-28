import { describe, expect, it } from 'vitest'
import { type IdmParams, idmAcceleration } from './idm'
import { Lane, MAX_TIMESTEP, VEHICLE_LENGTH } from './lane'

const p: IdmParams = {
  maxAcceleration: 1.5,
  comfortableDeceleration: 2.0,
  desiredSpeed: 30,
  minimumGap: 2,
  headwayTime: 1.5,
}

/** Run a lane for a while at a fixed step. */
const run = (lane: Lane, seconds: number, dt = 0.2): void => {
  for (let t = 0; t < seconds; t += dt) lane.step(dt, p)
}

/**
 * Centre-to-centre spacing at which a platoon cruising at `v` is in IDM
 * equilibrium: the speed at which the free-road term and the interaction term
 * cancel, so every vehicle's acceleration is zero.
 *
 * Note there is no such spacing at `desiredSpeed` — the free term is zero
 * there and the equation only balances at an infinite gap. That is why a lane
 * whose lead vehicle has open road never settles: it climbs to `desiredSpeed`
 * and the platoon behind it stretches forever.
 */
const equilibriumSpacing = (v: number, q: IdmParams): number =>
  (q.minimumGap + v * q.headwayTime) / Math.sqrt(1 - (v / q.desiredSpeed) ** 4) +
  VEHICLE_LENGTH

describe('Lane', () => {
  it('starts empty', () => {
    expect(new Lane(1000).count).toBe(0)
  })

  it('keeps vehicles ordered by descending position however they are added', () => {
    const lane = new Lane(1000)
    lane.add(100, 0)
    lane.add(500, 0)
    lane.add(300, 0)

    expect([lane.positionOf(0), lane.positionOf(1), lane.positionOf(2)])
      .toEqual([500, 300, 100])
  })

  it('grows past its initial capacity without disturbing the order', () => {
    const lane = new Lane(100000)
    // Added front-to-back, so every insert lands at the tail.
    for (let i = 0; i < 200; i++) lane.add(10000 - i * 30, 0)
    expect(lane.count).toBe(200)
    for (let i = 0; i < 200; i++) expect(lane.positionOf(i)).toBe(10000 - i * 30)

    // And again added back-to-front, so every insert lands at the head.
    const reverse = new Lane(100000)
    for (let i = 199; i >= 0; i--) reverse.add(10000 - i * 30, 0)
    expect(reverse.count).toBe(200)
    for (let i = 0; i < 200; i++) expect(reverse.positionOf(i)).toBe(10000 - i * 30)
  })

  it('accelerates a lone vehicle toward the desired speed and no further', () => {
    const lane = new Lane(100000)
    lane.add(0, 0)
    run(lane, 200)

    expect(lane.speedOf(0)).toBeGreaterThan(p.desiredSpeed * 0.99)
    expect(lane.speedOf(0)).toBeLessThanOrEqual(p.desiredSpeed + 1e-6)
  })

  it('measures the gap bumper to bumper, not centre to centre', () => {
    // The one piece of arithmetic in this file that is wrong by exactly one
    // vehicle length if VEHICLE_LENGTH is dropped, and which every other test
    // would tolerate because it is only a slightly different following
    // distance. Pinned against the model directly.
    const lane = new Lane(100000)
    lane.add(200, 20)
    lane.add(160, 20)

    const centreToCentre = 40
    const bumperToBumper = centreToCentre - VEHICLE_LENGTH
    const expected = idmAcceleration(
      { speed: 20, gap: bumperToBumper, leaderSpeed: 20 },
      p,
    )
    const ifLengthWereIgnored = idmAcceleration(
      { speed: 20, gap: centreToCentre, leaderSpeed: 20 },
      p,
    )
    // The two must be far enough apart that the assertion can tell them apart.
    expect(Math.abs(expected - ifLengthWereIgnored)).toBeGreaterThan(0.1)

    lane.step(0.2, p)
    expect((lane.speedOf(1) - 20) / 0.2).toBeCloseTo(expected, 9)
  })

  it('gives the vehicle at the head of the lane open road, and follows the one ahead', () => {
    // Vehicle 0 has no leader; vehicle i follows i - 1. If the leader were
    // looked up at i + 1 instead, these two accelerations would swap.
    const lane = new Lane(100000)
    lane.add(200, 20)
    lane.add(160, 20)

    const openRoad = idmAcceleration({ speed: 20, gap: Infinity, leaderSpeed: Infinity }, p)
    const following = idmAcceleration(
      { speed: 20, gap: 40 - VEHICLE_LENGTH, leaderSpeed: 20 },
      p,
    )
    expect(following).toBeLessThan(openRoad)

    lane.step(0.2, p)
    expect((lane.speedOf(0) - 20) / 0.2).toBeCloseTo(openRoad, 9)
    expect((lane.speedOf(1) - 20) / 0.2).toBeCloseTo(following, 9)
  })

  it('never lets a vehicle travel backwards or reach a negative speed', () => {
    const lane = new Lane(1000)
    lane.add(50, 0)     // stopped leader
    lane.add(30, 25)    // fast follower, far too close

    let previous = lane.positionOf(1)
    let reachedStandstill = false
    for (let t = 0; t < 30; t += 0.2) {
      lane.step(0.2, p)
      expect(lane.speedOf(1)).toBeGreaterThanOrEqual(0)
      expect(lane.positionOf(1)).toBeGreaterThanOrEqual(previous - 1e-9)
      if (lane.speedOf(1) === 0) reachedStandstill = true
      previous = lane.positionOf(1)
    }

    // Without this the test is vacuous: a fixture that merely slows down never
    // exercises the clamp it exists to check.
    expect(reachedStandstill).toBe(true)
  })

  it('does not let a follower pass through its leader, at any timestep it accepts', () => {
    // Not one scenario but a sweep, because a pass-through is a defect that
    // only appears in a corner of the (gap, speed, dt) space — and the corner
    // that matters most is the largest timestep the lane will accept.
    let worstGap = Infinity

    for (const dt of [0.05, 0.2, MAX_TIMESTEP]) {
      for (let gap = 0.5; gap <= 30; gap += 1.5) {
        for (let speed = 0; speed <= 40; speed += 5) {
          const lane = new Lane(100000)
          lane.add(500, 0)
          lane.add(500 - VEHICLE_LENGTH - gap, speed)

          for (let k = 0; k < 200; k++) {
            lane.step(dt, p)
            const bumperGap = lane.positionOf(0) - lane.positionOf(1) - VEHICLE_LENGTH
            worstGap = Math.min(worstGap, bumperGap)
          }
        }
      }
    }

    expect(worstGap).toBeGreaterThan(0)
  })

  it('settles a following vehicle at a steady gap behind a steady leader', () => {
    // The leader's speed is held: vehicle 0 has open road, and a vehicle on
    // open road climbs to `desiredSpeed`, where the IDM equilibrium gap is
    // infinite. Left free it opens the gap without bound (measured: 100m to
    // 241m over 300s, still widening), so there is no steady gap to settle at.
    const lane = new Lane(100000)
    lane.add(1000, 20)
    lane.add(900, 20)

    const cruise = (): void => {
      lane.brake(0, 20)
      lane.step(0.2, p)
    }
    for (let t = 0; t < 300; t += 0.2) cruise()

    const gapNow = lane.positionOf(0) - lane.positionOf(1)
    cruise()
    const gapNext = lane.positionOf(0) - lane.positionOf(1)

    expect(Math.abs(gapNext - gapNow)).toBeLessThan(1e-3)
    // And it settled at a following distance, not at arm's length or a mile back.
    expect(gapNow).toBeGreaterThan(30)
    expect(gapNow).toBeLessThan(50)
  })

  it('integrates ballistically rather than by Euler', () => {
    // One step from rest at constant acceleration a: ballistic advances
    // 0.5*a*dt^2, Euler advances a*dt^2 — twice as far. At a = 1.5 and
    // dt = 0.2 that is 0.03m against 0.06m.
    const lane = new Lane(1000)
    lane.add(0, 0)
    lane.step(0.2, p)

    expect(lane.positionOf(0)).toBeCloseTo(0.5 * p.maxAcceleration * 0.2 ** 2, 9)
  })

  it('stops a braking vehicle within the step rather than overshooting', () => {
    // A vehicle that would reach zero speed partway through the step must
    // travel only as far as it gets before stopping, not the full step.
    //
    // Pinned in one step against the closed form, because it is the only way
    // to state it exactly: a lane has no permanent obstacle to brake for — a
    // stopped leader has open road and drives away — so a long run cannot hold
    // a vehicle at a standstill to check.
    const lane = new Lane(1000)
    lane.add(30, 0)
    lane.add(24, 1)   // 1.5m of clear road behind a stopped car, crawling

    const a = idmAcceleration(
      { speed: 1, gap: 30 - 24 - VEHICLE_LENGTH, leaderSpeed: 0 },
      p,
    )
    // The premise: this step really would carry the speed below zero.
    expect(1 + a * 0.2).toBeLessThan(0)

    lane.step(0.2, p)

    // It travels v^2 / 2|a| and stops, rather than the v*dt + a*dt^2/2 that
    // integrating the whole step would give — which is *shorter*, because it
    // keeps integrating after the vehicle has already stopped.
    expect(lane.positionOf(1) - 24).toBeCloseTo(1 / (2 * -a), 12)
    expect(lane.speedOf(1)).toBe(0)
    expect(lane.positionOf(1)).toBeLessThan(lane.positionOf(0))
  })

  it('rejects a timestep beyond the stable maximum', () => {
    const lane = new Lane(1000)
    lane.add(0, 0)
    expect(() => lane.step(MAX_TIMESTEP + 0.01, p)).toThrow(RangeError)
    expect(() => lane.step(0, p)).toThrow(RangeError)
    expect(() => lane.step(-0.1, p)).toThrow(RangeError)
    expect(() => lane.step(Number.NaN, p)).toThrow(RangeError)
    expect(() => lane.step(MAX_TIMESTEP, p)).not.toThrow()
  })

  it('rejects an out-of-range vehicle index', () => {
    const lane = new Lane(1000)
    lane.add(0, 0)
    expect(() => lane.positionOf(1)).toThrow(RangeError)
    expect(() => lane.speedOf(-1)).toThrow(RangeError)
    expect(() => lane.brake(3, 0)).toThrow(RangeError)
  })

  it('removes vehicles that reach the end of the lane', () => {
    const lane = new Lane(100)
    lane.add(99, 20)
    lane.add(10, 20)

    run(lane, 3)
    lane.removeBeyondEnd()

    expect(lane.count).toBe(1)
    expect(lane.positionOf(0)).toBeLessThan(100)
  })

  it('removes nothing when every vehicle is still on the lane', () => {
    const lane = new Lane(1000)
    lane.add(500, 0)
    lane.add(400, 0)
    lane.removeBeyondEnd()
    expect(lane.count).toBe(2)
    expect(lane.positionOf(0)).toBe(500)
  })

  it('carries news of a disturbance exactly one vehicle per step', () => {
    // The direct statement of the two-pass rule, and the only exact one. Every
    // acceleration is computed from the state at the *start* of the step, so
    // after one step a vehicle two places back cannot yet have reacted — not
    // "reacted less", but bit-for-bit unchanged.
    //
    // The phantom-jam tests below cannot check this. Measured: stepping in
    // place still produces a travelling, amplifying wave, just ~20% faster
    // (front at vehicle 12 rather than 10 after 10s). Emergence is robust to
    // the mistake; this is not.
    const twitchy: IdmParams = { ...p, maxAcceleration: 1.0, headwayTime: 1.0 }
    const v = 20
    const spacing = equilibriumSpacing(v, twitchy)

    const platoon = (): Lane => {
      const lane = new Lane(100000)
      for (let i = 0; i < 3; i++) lane.add(1000 - i * spacing, v)
      return lane
    }

    const undisturbed = platoon()
    const disturbed = platoon()
    disturbed.brake(0, 12)

    undisturbed.step(0.2, twitchy)
    disturbed.step(0.2, twitchy)

    // Vehicle 1 is behind the braking vehicle and reacts on this very step.
    expect(disturbed.speedOf(1)).not.toBe(undisturbed.speedOf(1))
    // Vehicle 2 is one further back and cannot possibly know yet.
    expect(disturbed.speedOf(2)).toBe(undisturbed.speedOf(2))
    expect(disturbed.positionOf(2)).toBe(undisturbed.positionOf(2))

    // On the next step the news arrives, one vehicle per step exactly.
    undisturbed.step(0.2, twitchy)
    disturbed.step(0.2, twitchy)
    expect(disturbed.speedOf(2)).not.toBe(undisturbed.speedOf(2))
  })

  it('produces a phantom jam: a perturbation travels backwards through a platoon', () => {
    // Spec 4.3 calls this the most readable traffic phenomenon there is, and
    // the reason microscopic simulation was chosen at all. A dense platoon at
    // equilibrium, one vehicle briefly braking, and the disturbance must reach
    // vehicles *behind* it while the road ahead stays clear.
    const twitchy: IdmParams = { ...p, maxAcceleration: 1.0, headwayTime: 1.0 }
    const lane = new Lane(100000)

    const v = 20
    const n = 30
    const spacing = equilibriumSpacing(v, twitchy)   // 29.0589m
    for (let i = 0; i < n; i++) lane.add(50000 - i * spacing, v)

    // Settle with the lead vehicle held at cruise. Without the hold it climbs
    // toward `desiredSpeed` and drags the platoon into a transient that never
    // ends, and `settled` below would be a snapshot of vehicles still
    // accelerating rather than a baseline.
    for (let t = 0; t < 120; t += 0.2) {
      lane.brake(0, v)
      lane.step(0.2, twitchy)
    }
    const settled = Array.from({ length: n }, (_, i) => lane.speedOf(i))
    // Genuinely at rest in the moving frame: every follower within 1e-4 m/s.
    const followers = settled.slice(1)
    expect(Math.max(...followers) - Math.min(...followers)).toBeLessThan(1e-4)

    // Now brake the lead vehicle hard, once, and let go.
    lane.brake(0, 12)
    for (let t = 0; t < 10; t += 0.2) lane.step(0.2, twitchy)

    // A vehicle well back in the platoon must have slowed measurably...
    const disturbedIndex = 8
    expect(lane.speedOf(disturbedIndex)).toBeLessThan(settled[disturbedIndex]! - 0.5)

    // ...while one much further back has not yet noticed. That asymmetry is
    // the wave travelling backwards; without it this is just "everyone slowed".
    const untouchedIndex = n - 1
    expect(lane.speedOf(untouchedIndex)).toBeGreaterThan(settled[untouchedIndex]! - 0.5)

    // And the wave front is a front: a contiguous run of disturbed vehicles at
    // the head, clear road behind it. "Everyone slowed a bit" has no front,
    // and neither does a model that broadcasts the leader's braking.
    const disturbed = settled.map((was, i) => lane.speedOf(i) < was - 0.5)
    const front = disturbed.lastIndexOf(true)
    expect(front).toBeGreaterThanOrEqual(disturbedIndex)
    expect(front).toBeLessThan(untouchedIndex)
    expect(disturbed.slice(front + 1).some(Boolean)).toBe(false)
  })

  it('grows the phantom jam rather than damping it', () => {
    // The wave is not just transported, it amplifies as it moves upstream —
    // that is what makes it a jam rather than a ripple, and it is the property
    // that only survives if every vehicle reacts to the state at the start of
    // the step.
    const twitchy: IdmParams = { ...p, maxAcceleration: 1.0, headwayTime: 1.0 }
    const lane = new Lane(100000)

    const v = 20
    const n = 30
    const spacing = equilibriumSpacing(v, twitchy)
    for (let i = 0; i < n; i++) lane.add(50000 - i * spacing, v)
    for (let t = 0; t < 120; t += 0.2) {
      lane.brake(0, v)
      lane.step(0.2, twitchy)
    }
    const settled = Array.from({ length: n }, (_, i) => lane.speedOf(i))

    lane.brake(0, 12)
    for (let t = 0; t < 10; t += 0.2) lane.step(0.2, twitchy)

    // The lead vehicle has recovered — it has open road — yet the deepest
    // point of the disturbance is now several vehicles back and still severe.
    const drop = settled.map((was, i) => was - lane.speedOf(i))
    const deepest = drop.indexOf(Math.max(...drop))
    expect(deepest).toBeGreaterThan(2)
    expect(drop[0]!).toBeLessThan(1)
    expect(drop[deepest]!).toBeGreaterThan(3)
  })
})
