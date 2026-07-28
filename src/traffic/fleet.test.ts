import { describe, it, expect } from 'vitest'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import { ROAD_CLASSES } from '../network/roadClass'
import { HIGHWAY_PARAMS, TOWN_PARAMS } from './idm'
import { MAX_TIMESTEP, VEHICLE_LENGTH } from './lane'
import {
  FIXED_STEP,
  Fleet,
  MAX_STEPS_PER_FRAME,
  SPAWN_INTERVAL,
  STEPS_PER_SPAWN,
  driverParamsFor,
  hasSpawnRoom,
  metresPerSecond,
  planFixedSteps,
  spawnGap,
  type DrivableRoad,
} from './fleet'

const straight = (length: number, heading = 0): Alignment =>
  new Alignment([new Line(vec2(0, 0), heading, length)])

const road = (id: number, length: number, className: DrivableRoad['className']): DrivableRoad => ({
  id,
  alignment: straight(length),
  className,
})

describe('metresPerSecond', () => {
  it('divides by 3.6', () => {
    expect(metresPerSecond(36)).toBeCloseTo(10, 12)
    expect(metresPerSecond(3.6)).toBeCloseTo(1, 12)
    expect(metresPerSecond(0)).toBe(0)
  })

  it('makes 100 km/h slower than 100 m/s, not faster', () => {
    // Pins the direction of the conversion. A multiply instead of a divide
    // gives 360, which is still "a number of metres per second".
    expect(metresPerSecond(100)).toBeLessThan(100)
    expect(metresPerSecond(100)).toBeCloseTo(27.7777777, 6)
  })
})

describe('driverParamsFor', () => {
  it('takes desiredSpeed from the class, not from the preset', () => {
    // The whole point: `HIGHWAY_PARAMS.desiredSpeed` is 100 km/h and
    // `TOWN_PARAMS.desiredSpeed` is 50, and neither is any road class's own
    // design speed. If the preset's speed leaked through, gravel and rural
    // would be identical at 50 km/h and arterial and highway identical at 100.
    for (const name of ['gravel', 'rural', 'arterial', 'highway'] as const) {
      expect(driverParamsFor(name).desiredSpeed).toBeCloseTo(
        ROAD_CLASSES[name].designSpeedKph / 3.6,
        12,
      )
    }
  })

  it('gives every class a distinct desired speed', () => {
    const speeds = (['gravel', 'rural', 'arterial', 'highway'] as const).map(
      (n) => driverParamsFor(n).desiredSpeed,
    )
    expect(new Set(speeds).size).toBe(4)
    // Ascending with the class ladder: a highway's traffic must be visibly
    // faster than a gravel track's, which is one of the on-screen checks.
    expect(speeds).toEqual([...speeds].sort((a, b) => a - b))
  })

  it('gives fast classes the calm preset and lesser classes the twitchy one', () => {
    expect(driverParamsFor('highway').maxAcceleration).toBe(HIGHWAY_PARAMS.maxAcceleration)
    expect(driverParamsFor('arterial').headwayTime).toBe(HIGHWAY_PARAMS.headwayTime)
    expect(driverParamsFor('rural').maxAcceleration).toBe(TOWN_PARAMS.maxAcceleration)
    expect(driverParamsFor('gravel').headwayTime).toBe(TOWN_PARAMS.headwayTime)

    // "Twitchier" is not decoration — it is the lower acceleration and shorter
    // headway `idm.ts` names as the wave-growing combination.
    expect(driverParamsFor('gravel').maxAcceleration).toBeLessThan(
      driverParamsFor('highway').maxAcceleration,
    )
    expect(driverParamsFor('gravel').headwayTime).toBeLessThan(
      driverParamsFor('highway').headwayTime,
    )
  })
})

describe('spawnGap', () => {
  it('is the IDM equilibrium gap at zero closing speed', () => {
    const params = driverParamsFor('rural')
    expect(spawnGap(20, params)).toBeCloseTo(params.minimumGap + 20 * params.headwayTime, 12)
  })

  it('grows with speed', () => {
    const params = driverParamsFor('rural')
    expect(spawnGap(30, params)).toBeGreaterThan(spawnGap(10, params))
  })

  it('is the stopped gap at rest', () => {
    const params = driverParamsFor('rural')
    expect(spawnGap(0, params)).toBe(params.minimumGap)
  })
})

describe('hasSpawnRoom', () => {
  const params = driverParamsFor('rural')
  const speed = 20
  /** The rearmost position at which a newcomer at position 0 is exactly at its
   * desired gap: gap = rearmost - 0 - VEHICLE_LENGTH. */
  const threshold = spawnGap(speed, params) + VEHICLE_LENGTH

  it('always has room in an empty lane', () => {
    expect(hasSpawnRoom(undefined, speed, params)).toBe(true)
  })

  it('accepts exactly the desired gap', () => {
    expect(hasSpawnRoom(threshold, speed, params)).toBe(true)
  })

  it('refuses a hair under the desired gap', () => {
    expect(hasSpawnRoom(threshold - 1e-9, speed, params)).toBe(false)
  })

  it('refuses a stopped queue sitting on the entry point', () => {
    // The deadlock case. Without this check a jammed lane accepts a vehicle at
    // position 0 on top of one already there, the IDM's interaction term
    // divides by a gap of zero, and the lane never discharges.
    expect(hasSpawnRoom(0, speed, params)).toBe(false)
    expect(hasSpawnRoom(VEHICLE_LENGTH, speed, params)).toBe(false)
  })

  it('counts the vehicle length, not just the gap', () => {
    // A bumper-to-bumper measure that forgot `VEHICLE_LENGTH` would accept
    // this, and spawn a car overlapping the one ahead by a whole car.
    expect(hasSpawnRoom(spawnGap(speed, params), speed, params)).toBe(false)
  })
})

describe('planFixedSteps', () => {
  it('runs nothing and carries everything below one step', () => {
    expect(planFixedSteps(0.1)).toEqual({ steps: 0, carry: 0.1, dropped: 0 })
  })

  it('runs one step and carries the remainder', () => {
    const plan = planFixedSteps(0.3)
    expect(plan.steps).toBe(1)
    expect(plan.carry).toBeCloseTo(0.05, 12)
    expect(plan.dropped).toBe(0)
  })

  it('runs exactly one step at exactly one step of time', () => {
    expect(planFixedSteps(FIXED_STEP)).toEqual({ steps: 1, carry: 0, dropped: 0 })
  })

  it('never asks for a step larger than the lane will accept', () => {
    expect(FIXED_STEP).toBeLessThanOrEqual(MAX_TIMESTEP)
  })

  it('conserves time whenever the cap is not hit', () => {
    for (const elapsed of [0.001, 0.016, 0.0694, 0.25, 0.7, 1.9, 2]) {
      const plan = planFixedSteps(elapsed)
      expect(plan.steps * FIXED_STEP + plan.carry + plan.dropped).toBeCloseTo(elapsed, 12)
      expect(plan.dropped).toBe(0)
      expect(plan.carry).toBeLessThan(FIXED_STEP)
    }
  })

  it('caps a long stall and drops the backlog rather than carrying it', () => {
    const plan = planFixedSteps(30)
    expect(plan.steps).toBe(MAX_STEPS_PER_FRAME)
    // Carrying 28 seconds forward would demand another capped call next frame,
    // and the next, for as long as the tab stayed open — the spiral the cap
    // exists to prevent.
    expect(plan.carry).toBe(0)
    expect(plan.dropped).toBeCloseTo(30 - MAX_STEPS_PER_FRAME * FIXED_STEP, 12)
  })

  it('caps at the boundary, one step past the cap', () => {
    const justOver = (MAX_STEPS_PER_FRAME + 1) * FIXED_STEP
    expect(planFixedSteps(justOver).steps).toBe(MAX_STEPS_PER_FRAME)
    expect(planFixedSteps(justOver).carry).toBe(0)
    // Exactly at the cap is not over it: the backlog is spent, not dropped.
    expect(planFixedSteps(MAX_STEPS_PER_FRAME * FIXED_STEP)).toEqual({
      steps: MAX_STEPS_PER_FRAME,
      carry: 0,
      dropped: 0,
    })
  })

  it('ignores a zero or negative delta', () => {
    expect(planFixedSteps(0).steps).toBe(0)
    expect(planFixedSteps(-1).steps).toBe(0)
  })

  it('takes the same total steps however the time is chopped up', () => {
    const total = (frameSeconds: number, frames: number): number => {
      let accumulated = 0
      let steps = 0
      for (let i = 0; i < frames; i++) {
        accumulated += frameSeconds
        const plan = planFixedSteps(accumulated)
        accumulated = plan.carry
        steps += plan.steps
      }
      return steps
    }
    // One second of real time, in exact binary fractions so the comparison is
    // about the accumulator and not about float noise.
    expect(total(1 / 64, 64)).toBe(4)
    expect(total(1 / 16, 16)).toBe(4)
    expect(total(0.25, 4)).toBe(4)
  })
})

describe('Fleet.sync', () => {
  it('builds one lane per road', () => {
    const fleet = new Fleet()
    fleet.sync([road(0, 500, 'rural'), road(1, 300, 'gravel')])
    expect(fleet.laneCount).toBe(2)
    expect(fleet.laneFor(0)?.length).toBe(500)
    expect(fleet.laneFor(1)?.length).toBe(300)
  })

  it('keeps a surviving road’s traffic across a rebuild', () => {
    const fleet = new Fleet()
    const roads = [road(0, 500, 'rural'), road(1, 300, 'gravel')]
    fleet.sync(roads)
    fleet.advance(20)
    const before = fleet.laneFor(0)?.count ?? 0
    expect(before).toBeGreaterThan(0)

    // A second road committed elsewhere in the network must not teleport this
    // road's cars back to its start.
    fleet.sync([...roads, road(2, 400, 'rural')])
    expect(fleet.laneFor(0)?.count).toBe(before)
  })

  it('drops the lane of a road that no longer exists', () => {
    const fleet = new Fleet()
    fleet.sync([road(0, 500, 'rural'), road(1, 300, 'gravel')])
    fleet.advance(20)
    fleet.sync([road(0, 500, 'rural')])
    expect(fleet.laneCount).toBe(1)
    expect(fleet.laneFor(1)).toBeUndefined()
  })

  it('rebuilds a lane whose road changed class under the same id', () => {
    // `RoadNetwork.setRoadClass` mutates in place and keeps the id, so a lane
    // matched on id alone would keep driving a gravel track at 110 km/h.
    const fleet = new Fleet()
    fleet.sync([road(0, 500, 'gravel')])
    fleet.advance(20)
    expect(fleet.laneFor(0)?.count).toBeGreaterThan(0)

    fleet.sync([road(0, 500, 'highway')])
    expect(fleet.laneFor(0)?.count).toBe(0)
  })

  it('rebuilds a lane whose road changed length under the same id', () => {
    const fleet = new Fleet()
    fleet.sync([road(0, 500, 'rural')])
    fleet.advance(20)
    fleet.sync([road(0, 900, 'rural')])
    expect(fleet.laneFor(0)?.length).toBe(900)
    expect(fleet.laneFor(0)?.count).toBe(0)
  })

  it('refuses to build a lane for a zero-length road', () => {
    const fleet = new Fleet()
    fleet.sync([{ id: 0, alignment: new Alignment([]), className: 'rural' }])
    expect(fleet.laneCount).toBe(0)
  })
})

describe('Fleet.advance', () => {
  it('puts a vehicle on a new road on the first step', () => {
    const fleet = new Fleet()
    fleet.sync([road(0, 500, 'rural')])
    fleet.advance(FIXED_STEP)
    expect(fleet.vehicleCount).toBe(1)
  })

  it('does nothing at all below one step of accumulated time', () => {
    const fleet = new Fleet()
    fleet.sync([road(0, 500, 'rural')])
    fleet.advance(0.01)
    expect(fleet.vehicleCount).toBe(0)
    expect(fleet.simulatedSeconds).toBe(0)
  })

  it('simulates the same states at 144fps as at 30fps', () => {
    // The property the fixed step exists for, at rates a display actually runs
    // at. 1/30 and 1/144 are not binary fractions and neither divides 0.25, so
    // the two accumulators land on different remainders every frame — which is
    // the whole difficulty, and exactly what the version of this test being
    // replaced arranged not to have: 1/64 and 1/16 are both exact binary
    // fractions landing on precisely four steps per second, so the claim
    // "identical" was true of any implementation that stepped at all.
    //
    // At real rates the claim is not "identical" but "at most one step apart,
    // and the difference does not accumulate": both rates run whole
    // `FIXED_STEP`s of the same sequence, and whichever is momentarily ahead is
    // ahead by less than one step and stays that way.
    /** The fleet's state keyed by how many fixed steps it has run. */
    const run = (frameSeconds: number, seconds: number): Map<number, number[]> => {
      const fleet = new Fleet()
      fleet.sync([road(0, 500, 'rural'), road(1, 300, 'gravel')])
      const states = new Map<number, number[]>()
      for (let i = 0; i < Math.round(seconds / frameSeconds); i++) {
        fleet.advance(frameSeconds)
        const steps = Math.round(fleet.simulatedSeconds / FIXED_STEP)
        if (states.has(steps)) continue
        const snapshot: number[] = []
        fleet.forEachVehicle((roadId, station) => snapshot.push(roadId, station))
        states.set(steps, snapshot)
      }
      return states
    }

    const stepsRun = (states: Map<number, number[]>): number => Math.max(...states.keys())

    const fast = run(1 / 144, 300)
    const slow = run(1 / 30, 300)

    expect(stepsRun(fast)).toBeGreaterThan(1000)
    expect(Math.abs(stepsRun(fast) - stepsRun(slow))).toBeLessThanOrEqual(1)

    // Not merely the same number of steps: the same states. Every step the
    // slower rate reached, the faster one reached with an identical fleet.
    for (const [steps, state] of slow) expect(fast.get(steps)).toEqual(state)

    // And the one-step lag does not accumulate. Ten times as long, still one
    // step — 0.25s behind after 3000 simulated seconds.
    const longFast = run(1 / 144, 3000)
    const longSlow = run(1 / 30, 3000)
    expect(stepsRun(longFast) - stepsRun(longSlow)).toBe(1)
  })

  it('survives a frame delta far larger than the lane will accept', () => {
    // A backgrounded tab hands back seconds. `Lane.step` throws above 0.25s,
    // so anything that forwarded this raw would take the scene down.
    const fleet = new Fleet()
    fleet.sync([road(0, 500, 'rural')])
    expect(() => fleet.advance(30)).not.toThrow()
    expect(fleet.simulatedSeconds).toBeCloseTo(MAX_STEPS_PER_FRAME * FIXED_STEP, 12)
  })

  it('reports the time it dropped rather than losing it silently', () => {
    // `planFixedSteps` has always computed `dropped`; `advance` used to
    // destructure only `steps` and `carry` and throw it away, so 28.25 seconds
    // could vanish with no signal at any layer. The dropping is right — see
    // `MAX_STEPS_PER_FRAME` — but a policy that discards time silently is
    // indistinguishable from a bug that does.
    const fleet = new Fleet()
    fleet.sync([road(0, 500, 'rural')])

    // Ten seconds of ordinary 60fps running. Nothing is ever capped.
    for (let i = 0; i < 600; i++) fleet.advance(1 / 60)
    expect(fleet.droppedSeconds).toBe(0)
    const beforeStall = fleet.simulatedSeconds

    fleet.advance(30)
    // Eight steps run, so two seconds simulated out of the thirty asked for.
    // 28.25 rather than 28.00 because six hundred additions of 1/60 do not sum
    // to exactly ten: the fleet is carrying most of a step when the stall
    // arrives, and a capped call drops the carry along with everything else.
    expect(fleet.simulatedSeconds - beforeStall).toBeCloseTo(MAX_STEPS_PER_FRAME * FIXED_STEP, 12)
    expect(fleet.droppedSeconds).toBeCloseTo(28.25, 9)

    // The accounting identity, which is the point of the channel: everything
    // handed to `advance` is either simulated, dropped, or waiting as carry —
    // and a capped call carries nothing, so after one the sum is exact.
    expect(fleet.simulatedSeconds + fleet.droppedSeconds).toBeCloseTo(40, 9)
  })

  it('accumulates dropped time across repeated stalls', () => {
    const fleet = new Fleet()
    fleet.sync([road(0, 500, 'rural')])
    fleet.advance(30)
    const once = fleet.droppedSeconds
    fleet.advance(30)
    expect(once).toBeGreaterThan(0)
    expect(fleet.droppedSeconds).toBeCloseTo(2 * once, 9)
  })

  it('ignores a non-finite or negative delta', () => {
    const fleet = new Fleet()
    fleet.sync([road(0, 500, 'rural')])
    fleet.advance(Number.NaN)
    fleet.advance(-5)
    expect(fleet.simulatedSeconds).toBe(0)
  })

  it('never lets two vehicles overlap, however long it runs', () => {
    // The composite check: spawning, following and retirement all have to hold
    // together. A spawn-room check that let a vehicle in on top of a queue
    // shows up here as a negative gap.
    const fleet = new Fleet()
    fleet.sync([road(0, 260, 'gravel'), road(1, 750, 'rural')])

    let worstGap = Infinity
    for (let i = 0; i < 4000; i++) {
      fleet.advance(1 / 60)
      const byRoad = new Map<number, number[]>()
      fleet.forEachVehicle((roadId, station) => {
        const list = byRoad.get(roadId) ?? []
        list.push(station)
        byRoad.set(roadId, list)
      })
      for (const stations of byRoad.values()) {
        for (let j = 1; j < stations.length; j++) {
          const gap = stations[j - 1]! - stations[j]! - VEHICLE_LENGTH
          if (gap < worstGap) worstGap = gap
        }
      }
    }
    expect(worstGap).toBeGreaterThanOrEqual(0)
  })

  it('retires vehicles at the end rather than growing without bound', () => {
    const fleet = new Fleet()
    fleet.sync([road(0, 300, 'gravel')])

    // Two samples, both well past the fill-up transient, ten times apart in
    // elapsed time. A lane that never retired would keep taking vehicles until
    // it jammed solid and then hold that count; a lane that retires settles at
    // transit time over spawn interval and stays there.
    for (let i = 0; i < 200 * 60; i++) fleet.advance(1 / 60)
    const settled = fleet.vehicleCount
    for (let i = 0; i < 2000 * 60; i++) fleet.advance(1 / 60)

    expect(settled).toBeGreaterThan(0)
    expect(fleet.vehicleCount).toBeGreaterThanOrEqual(settled - 1)
    expect(fleet.vehicleCount).toBeLessThanOrEqual(settled + 1)

    // The direct property. Without `removeBeyondEnd` a vehicle drives past the
    // end of its road and keeps going — off the end of the alignment and into
    // empty air, since `poseAt` clamps and every later vehicle piles up behind
    // a leader that is no longer on the road.
    let beyond = 0
    let furthest = 0
    fleet.forEachVehicle((_roadId, station) => {
      if (station >= 300) beyond++
      if (station > furthest) furthest = station
    })
    expect(beyond).toBe(0)
    expect(furthest).toBeGreaterThan(200)
  })

  it('resumes at the ordinary rate after a blocked lane clears, not in a burst', () => {
    // `stepOnce` holds `sinceSpawn` at the threshold while the lane has no
    // room. Letting it keep counting instead cannot stack vehicles — at most
    // one enters per fixed step and `hasSpawnRoom` gates each — but it banks
    // the blocked time and then spends it at one car every 0.25s, seven times
    // the intended rate, until the debt clears.
    //
    // A short jammed lane is the natural way to bank a large backlog: a 60m
    // gravel road fills, blocks its own entry for most of a run, and the whole
    // backlog is then spent at once when the block goes away.
    const fleet = new Fleet()
    fleet.sync([road(0, 60, 'gravel')])
    for (let i = 0; i < 120 * 60; i++) fleet.advance(1 / 60)
    expect(fleet.vehicleCount).toBeGreaterThan(2)

    // Clear the road completely: a longer lane under the same id is rebuilt
    // empty by `sync`, which is exactly the "the block went away" moment.
    fleet.sync([road(0, 5000, 'gravel')])
    const seconds = 20
    for (let i = 0; i < seconds * 60; i++) fleet.advance(1 / 60)

    // At the ordinary interval that is 11 or 12 cars. Spending a banked
    // backlog would put one on every fixed step — up to 80.
    expect(fleet.vehicleCount).toBeLessThanOrEqual(Math.ceil(seconds / SPAWN_INTERVAL) + 1)
    expect(fleet.vehicleCount).toBeGreaterThanOrEqual(Math.floor(seconds / SPAWN_INTERVAL) - 1)
  })

  it('holds a blocked lane at the threshold rather than banking the wait', () => {
    // The mechanism directly. A lane held at the threshold spawns on the very
    // next step it has room for and then waits a full interval; a lane that
    // banked its wait spawns on every step until the debt clears.
    const fleet = new Fleet()
    // Just long enough to hold a couple of cars and no more, so the entry gate
    // shuts almost immediately and stays shut.
    fleet.sync([road(0, 40, 'gravel')])
    for (let i = 0; i < 300 * 60; i++) fleet.advance(1 / 60)
    expect(fleet.simulatedSeconds).toBeGreaterThan(200)

    // 300 seconds of blockage is 171 banked intervals, or 1200 fixed steps of
    // debt. Release the lane and run four steps: at most one car can enter.
    fleet.sync([road(0, 4000, 'gravel')])
    const before = fleet.vehicleCount
    for (let n = 0; n < 4; n++) fleet.advance(FIXED_STEP)
    expect(fleet.vehicleCount - before).toBeLessThanOrEqual(1)
  })

  it('does not spawn every lane in lockstep', () => {
    // Seeding every lane at `SPAWN_INTERVAL` — which is what this did — put
    // every road in the network on the same spawn step and, because they all
    // share one interval, kept them there for as long as they ran: the demo's
    // two rural arms produced byte-identical spawn events for ten minutes.
    // Two arms of the same class and length are the case no single-lane test
    // can see.
    const fleet = new Fleet()
    fleet.sync([road(0, 750, 'rural'), road(1, 750, 'rural'), road(2, 300, 'gravel')])

    /** For each lane, the step numbers on which its count went up. */
    const spawnSteps = new Map<number, number[]>()
    let previous = new Map<number, number>()
    for (let step = 1; step <= 400; step++) {
      fleet.advance(FIXED_STEP)
      const counts = new Map<number, number>()
      fleet.forEachVehicle((roadId) => counts.set(roadId, (counts.get(roadId) ?? 0) + 1))
      for (const id of [0, 1, 2]) {
        if ((counts.get(id) ?? 0) > (previous.get(id) ?? 0)) {
          spawnSteps.set(id, [...(spawnSteps.get(id) ?? []), step])
        }
      }
      previous = counts
    }

    // Only the first hundred steps: nothing has reached the end of a 300m road
    // by then, so a step that both spawns and retires cannot hide a spawn.
    const early = (id: number): number[] =>
      (spawnSteps.get(id) ?? []).filter((s) => s <= 100)

    expect(early(0).length).toBeGreaterThan(10)
    // The two rural arms are identical in every other respect, so if their
    // spawn events differ it is this and nothing else.
    expect(early(1)).not.toEqual(early(0))
    expect(early(2)).not.toEqual(early(0))

    // Not merely different — disjoint. Lanes phased by whole fixed steps within
    // one interval never share a spawn step at all.
    expect(early(0).filter((s) => early(1).includes(s))).toEqual([])
  })

  it('still puts a car on a new road inside one spawn interval', () => {
    // The property the un-staggered seed was protecting: a road the player has
    // just drawn does not sit empty. The last phase waits `STEPS_PER_SPAWN`
    // steps, which is exactly one interval; every other phase is sooner.
    for (let id = 0; id < 3 * STEPS_PER_SPAWN; id++) {
      const fleet = new Fleet()
      fleet.sync([road(id, 500, 'rural')])
      for (let n = 0; n < STEPS_PER_SPAWN; n++) fleet.advance(FIXED_STEP)
      expect(fleet.vehicleCount).toBeGreaterThanOrEqual(1)
    }
  })

  it('gives the lanes every distinct phase before repeating one', () => {
    // `STEPS_PER_SPAWN` roads, and no two of them enter their first vehicle on
    // the same step. The next one does — there are only this many phases —
    // which is the honest limit of a scheme with no global lane registry.
    const firstSpawnStep = (id: number): number => {
      const fleet = new Fleet()
      fleet.sync([road(id, 5000, 'rural')])
      for (let step = 1; step <= 2 * STEPS_PER_SPAWN; step++) {
        fleet.advance(FIXED_STEP)
        if (fleet.vehicleCount > 0) return step
      }
      return -1
    }

    const steps = Array.from({ length: STEPS_PER_SPAWN }, (_, id) => firstSpawnStep(id))
    expect(new Set(steps).size).toBe(STEPS_PER_SPAWN)
    expect(Math.min(...steps)).toBe(1)
    expect(Math.max(...steps)).toBe(STEPS_PER_SPAWN)
    expect(firstSpawnStep(STEPS_PER_SPAWN)).toBe(steps[0])
  })

  it('derives the number of spawn phases from the two constants', () => {
    expect(STEPS_PER_SPAWN).toBe(SPAWN_INTERVAL / FIXED_STEP)
    expect(Number.isInteger(STEPS_PER_SPAWN)).toBe(true)
  })

  it('has a spawn interval that lands on a step boundary', () => {
    // The spawn check runs once per fixed step, so an interval that is not a
    // multiple of one quantises up to the next and the constant no longer says
    // what actually happens — the reason three rows of the sweep in
    // `SPAWN_INTERVAL`'s docstring were indistinguishable.
    expect(SPAWN_INTERVAL / FIXED_STEP).toBe(Math.round(SPAWN_INTERVAL / FIXED_STEP))
  })

  it('spawns no faster than the interval', () => {
    const fleet = new Fleet()
    // Long enough that nothing retires within the window measured.
    fleet.sync([road(0, 5000, 'rural')])
    const seconds = 30
    for (let i = 0; i < seconds * 60; i++) fleet.advance(1 / 60)
    expect(fleet.vehicleCount).toBeLessThanOrEqual(Math.ceil(seconds / SPAWN_INTERVAL) + 1)
    expect(fleet.vehicleCount).toBeGreaterThanOrEqual(Math.floor(seconds / SPAWN_INTERVAL) - 1)
  })

  it('drives a highway’s traffic further than a gravel track’s in the same time', () => {
    const fleet = new Fleet()
    fleet.sync([road(0, 5000, 'gravel'), road(1, 5000, 'highway')])
    for (let i = 0; i < 60 * 30; i++) fleet.advance(1 / 60)

    const lead = new Map<number, number>()
    fleet.forEachVehicle((roadId, station) => {
      lead.set(roadId, Math.max(lead.get(roadId) ?? 0, station))
    })
    expect(lead.get(1)!).toBeGreaterThan(lead.get(0)! * 2)
  })
})
