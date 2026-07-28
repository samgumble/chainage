import type { Alignment } from '../geometry/alignment'
import type { RoadId } from '../network/graph'
import { ROAD_CLASSES, type RoadClassName } from '../network/roadClass'
import { HIGHWAY_PARAMS, TOWN_PARAMS, type IdmParams } from './idm'
import { Lane, MAX_TIMESTEP, VEHICLE_LENGTH } from './lane'

/**
 * Kilometres per hour to metres per second.
 *
 * The one place km/h meets the simulation. Road classes state a
 * `designSpeedKph` because that is how a design speed is written down;
 * everything below `driverParamsFor` is in metres per second and stays that
 * way. A second conversion anywhere else is a second chance to write 3.6 the
 * wrong way up, which is a factor of thirteen — traffic either crawling or
 * teleporting, and in neither case obviously a units bug.
 */
export const metresPerSecond = (kph: number): number => kph / 3.6

/**
 * Car-following parameters for a road class.
 *
 * The preset picks the *character* of the driving and the class picks the
 * speed. A highway and an arterial get `HIGHWAY_PARAMS` — generous
 * acceleration, a long 1.5s headway, the calm platoon of a designed road. A
 * rural road and a gravel track get `TOWN_PARAMS`, which is twitchier in the
 * precise sense that matters here: half the acceleration and two thirds the
 * headway, which is the combination `idm.ts` names as the one that grows
 * stop-and-go waves instead of damping them.
 *
 * `desiredSpeed` always comes from the class's own `designSpeedKph` rather
 * than from the preset, so it is 40 km/h on gravel and 110 on a highway.
 * Taking the preset's own `desiredSpeed` instead would give every non-highway
 * road 50 km/h and every highway road 100, and the "a highway's traffic is
 * visibly faster than a gravel track's" check would be passing on a coincidence
 * of the presets rather than on the classes.
 */
export const driverParamsFor = (className: RoadClassName): IdmParams => {
  const base = className === 'highway' || className === 'arterial'
    ? HIGHWAY_PARAMS
    : TOWN_PARAMS
  return { ...base, desiredSpeed: metresPerSecond(ROAD_CLASSES[className].designSpeedKph) }
}

/**
 * The bumper-to-bumper gap a vehicle entering at `speed` wants behind the
 * traffic already there, metres.
 *
 * The IDM's own desired gap at zero closing speed: `s0 + v·T`. Not a number
 * picked to look safe — using the model's own equilibrium means a vehicle
 * spawned exactly at this gap is in equilibrium with its leader and neither
 * brakes nor accelerates on its first step, so the queue at the start of a
 * lane is the same queue the model would have produced if the vehicle had
 * driven in from further back.
 */
export const spawnGap = (speed: number, params: IdmParams): number =>
  params.minimumGap + speed * params.headwayTime

/**
 * Whether a lane has room at position 0 for a vehicle entering at `speed`.
 *
 * `rearmostPosition` is the position of the vehicle furthest *back* in the
 * lane — the last index, since `Lane` sorts by descending position — or
 * `undefined` for an empty lane.
 *
 * This is the check that keeps a jammed lane from deadlocking. Spawning on
 * schedule regardless would stack vehicles on top of a stopped queue at
 * position 0; the IDM's interaction term divides by the gap, so a stack at
 * zero separation produces enormous braking on everything behind it and the
 * lane never discharges. A lane that is full simply does not accept another
 * vehicle until one leaves, which is what a road at capacity does.
 */
export const hasSpawnRoom = (
  rearmostPosition: number | undefined,
  speed: number,
  params: IdmParams,
): boolean => {
  if (rearmostPosition === undefined) return true
  return rearmostPosition - VEHICLE_LENGTH >= spawnGap(speed, params)
}

/**
 * Seconds between vehicles entering one lane.
 *
 * Chosen by measurement against the demo network's own two road lengths, not
 * by eye, because it is the single knob that decides whether the on-screen
 * result is car-following or a procession. Steady state after 400 simulated
 * seconds, minimum and maximum speed across the lane:
 *
 *   interval   rural 750m (v0 = 22.2)     gravel 300m (v0 = 11.1)
 *   3.00s      12 cars, 21.3–22.1 m/s      10 cars, 10.5–10.9 m/s
 *   2.00s      18 cars, 19.7–21.1          18 cars,  7.2– 9.2
 *   1.75s      23 cars, 18.3–21.2          19 cars,  7.2– 9.7
 *   1.50s      32 cars, 14.4–20.6          19 cars,  7.2– 9.7
 *
 * At three seconds the vehicles never come within three desired gaps of each
 * other and every one of them sits at its desired speed: the model is running,
 * and nothing it does is visible. 1.75s is the first entry where the main
 * arms show a real spread — three metres per second between the fastest and
 * slowest car, cars visibly closing on a leader and opening up again — while
 * still being governed by this interval rather than by the spawn gate. By
 * 1.5s the arms are entry-saturated (1.5, 1.2 and 1.0 all produce the identical
 * 32-car lane, because `hasSpawnRoom` and not this constant is what limits
 * them), and the number stops meaning anything.
 *
 * The gravel branch is gate-limited at every interval below 3s, which is why
 * it is the congested one: a 40 km/h track at this demand is over capacity and
 * runs at two thirds of its design speed. That contrast — the main road
 * flowing, the narrow branch not — is the demo doing its job.
 *
 * A multiple of `FIXED_STEP`, deliberately: the spawn check runs once per
 * fixed step, so any interval quantises up to the next multiple of 0.25s
 * anyway. Anything in (1.75, 2.0] behaves identically to 2.0, which is exactly
 * why three rows of the sweep above were indistinguishable before it was
 * pinned to a grid point.
 */
export const SPAWN_INTERVAL = 1.75

/**
 * The simulation's own timestep, seconds.
 *
 * Exactly `MAX_TIMESTEP`, deliberately: it is the largest step the ballistic
 * integration is stable at, so it is the fewest steps a given span of real
 * time can be simulated in. Anything smaller costs steps for no accuracy
 * anyone can see at 4.5m vehicle scale.
 */
export const FIXED_STEP = MAX_TIMESTEP

/**
 * The most fixed steps one call to `advance` will run.
 *
 * Eight steps is two seconds of simulation. The cap is what stops a stall
 * from spiralling: a browser that hands back a frame delta of thirty seconds
 * (a backgrounded tab, a long mesh rebuild) would otherwise ask for 120
 * steps, which takes longer than a frame, which grows the next delta, which
 * asks for more steps. The backlog is *dropped* rather than carried — see
 * `planFixedSteps` — so the simulation runs slow for one frame instead of
 * never catching up at all.
 */
export const MAX_STEPS_PER_FRAME = 8

/**
 * Fixed steps in one spawn interval — the number of distinct spawn *phases* a
 * lane can have.
 *
 * `SPAWN_INTERVAL` is a multiple of `FIXED_STEP` by construction (see its
 * docstring), so this is exact: seven steps of 0.25s make 1.75s. A lane that
 * spawns on step `n` spawns again on `n + 7` and on no step in between, so two
 * lanes whose phases differ by anything from 1 to 6 never spawn on the same
 * step, and two lanes whose phases are equal spawn together on every step for
 * as long as both stay spawn-limited.
 *
 * Derived rather than written down because it is only ever "how many steps fit
 * in an interval": changing either constant changes it, and a hardcoded 7
 * would go quietly wrong instead.
 */
export const STEPS_PER_SPAWN = Math.round(SPAWN_INTERVAL / FIXED_STEP)

export type StepPlan = {
  /** Whole fixed steps to run now. */
  readonly steps: number
  /** Time to carry into the next call, less than one step. */
  readonly carry: number
  /** Time thrown away because the cap was hit. Zero in the normal case. */
  readonly dropped: number
}

/**
 * Turn accumulated real time into whole fixed steps.
 *
 * The frame rate is not the simulation rate. A frame delivers whatever it
 * delivers — 6.9ms at 144fps, 33ms at 30fps, seconds after a stall — and
 * passing that straight to `Lane.step` would both throw (above `MAX_TIMESTEP`)
 * and, below it, make the trajectory a function of the display's refresh rate.
 * Accumulating instead and running whole `FIXED_STEP`s means 30fps and 144fps
 * simulate the identical sequence of states, just observed at different moments.
 *
 * The remainder is carried, not dropped, so time is conserved in the normal
 * case: a run of 6.9ms frames spends four frames accumulating and steps on the
 * fifth. Only when the cap bites is anything discarded, and then all of it is,
 * because a carry that is itself larger than a step would immediately demand
 * another capped call and the debt would never clear.
 */
export const planFixedSteps = (
  accumulated: number,
  step: number = FIXED_STEP,
  maxSteps: number = MAX_STEPS_PER_FRAME,
): StepPlan => {
  if (!(step > 0)) throw new RangeError(`step must be positive, got ${step}`)
  if (!Number.isFinite(accumulated) || accumulated <= 0) {
    return { steps: 0, carry: Math.max(0, Number.isFinite(accumulated) ? accumulated : 0), dropped: 0 }
  }

  const wanted = Math.floor(accumulated / step)
  const steps = Math.min(wanted, maxSteps)
  const capped = wanted > maxSteps
  const carry = capped ? 0 : accumulated - steps * step
  return { steps, carry, dropped: accumulated - steps * step - carry }
}

/** The part of a road this needs: its identity, its shape and its class. */
export type DrivableRoad = {
  readonly id: RoadId
  readonly alignment: Alignment
  readonly className: RoadClassName
}

type LaneEntry = {
  readonly lane: Lane
  readonly params: IdmParams
  /** What the lane was built from, so `sync` can tell a rebuild is needed. */
  readonly length: number
  readonly className: RoadClassName
  sinceSpawn: number
}

/**
 * One lane of traffic per road, driven at a fixed timestep.
 *
 * Knows nothing about rendering, three.js, or where a station is in the world
 * — only that a road has a length and a class, and that vehicles move along it.
 * `Lane` owns the two-pass step; this owns the clock, the spawning and the
 * retirement, which are exactly the things `Lane`'s docstring says belong to
 * whoever holds the frame clock rather than to the lane.
 */
export class Fleet {
  private readonly lanes = new Map<RoadId, LaneEntry>()
  private accumulated = 0
  /** Simulated seconds run so far. Real elapsed time minus anything dropped. */
  private elapsedSimulated = 0
  private secondsDropped = 0

  get simulatedSeconds(): number {
    return this.elapsedSimulated
  }

  /**
   * Real seconds handed to `advance` that were never simulated, cumulative.
   *
   * `planFixedSteps` computes this and the dropping policy is deliberate — see
   * `MAX_STEPS_PER_FRAME` — but a policy that discards time silently is
   * indistinguishable from a bug that does. Ten seconds of ordinary running
   * followed by one `advance(30)` loses 28.25 simulated seconds, and without
   * this nothing at any layer says so: `simulatedSeconds` simply reads lower
   * than the wall clock, and no caller has anything to compare it against.
   *
   * Zero for every frame a browser actually delivers. Non-zero means the tab
   * stalled, and `simulatedSeconds + droppedSeconds` is the elapsed real time
   * the fleet was asked for.
   */
  get droppedSeconds(): number {
    return this.secondsDropped
  }

  get laneCount(): number {
    return this.lanes.size
  }

  get vehicleCount(): number {
    let total = 0
    for (const entry of this.lanes.values()) total += entry.lane.count
    return total
  }

  /**
   * Match the set of lanes to the set of roads that can carry traffic.
   *
   * Called after every network mutation. A road that has been deleted, or
   * split into two new ids, or lost its design profile, loses its lane and its
   * vehicles with it — otherwise the scene keeps stepping a lane for a road
   * that is not there any more and drawing cars along an alignment nothing is
   * built on.
   *
   * A road whose id survives keeps its lane and its traffic, so committing a
   * road somewhere else in the network does not teleport every vehicle back to
   * the start of its road. The exception is a road whose length or class has
   * actually changed underneath its id — `RoadNetwork.setRoadClass` does
   * exactly that — where the lane is rebuilt, because its length and its
   * driver parameters are both wrong.
   */
  sync(roads: Iterable<DrivableRoad>): void {
    const seen = new Set<RoadId>()

    for (const road of roads) {
      const length = road.alignment.length
      // A zero-length alignment is not a road anyone can drive on, and `Lane`
      // rejects it outright rather than being handed a degenerate lane.
      if (!(length > 0)) continue

      seen.add(road.id)
      const existing = this.lanes.get(road.id)
      if (existing && existing.length === length && existing.className === road.className) continue

      this.lanes.set(road.id, {
        lane: new Lane(length),
        params: driverParamsFor(road.className),
        length,
        className: road.className,
        // Phased by road id: the lane's first vehicle enters on step
        // `1 + (id mod STEPS_PER_SPAWN)` and every `STEPS_PER_SPAWN`th step
        // after that, so the seed is whatever leaves exactly that many steps
        // to run.
        //
        // Seeding every lane at `SPAWN_INTERVAL` instead — which is what this
        // was — puts every lane's first spawn on step 1 and, since they all
        // share one interval, keeps them together forever: the demo's two
        // rural arms produced byte-identical spawn events for as long as they
        // ran. Phasing by whole steps within one interval makes them
        // independent streams and, because there are exactly
        // `STEPS_PER_SPAWN` distinct phases, gives two differently-phased
        // lanes no shared spawn step at all while both stay spawn-limited.
        //
        // Still prompt, which is what the un-staggered seed was protecting:
        // the last phase waits `STEPS_PER_SPAWN` steps, one whole interval,
        // and every other phase less — so a road the player has just drawn has
        // a car on it inside 1.75s rather than sitting empty.
        sinceSpawn: SPAWN_INTERVAL - FIXED_STEP * (1 + (road.id % STEPS_PER_SPAWN)),
      })
    }

    for (const id of [...this.lanes.keys()]) {
      if (!seen.has(id)) this.lanes.delete(id)
    }
  }

  /**
   * Advance by `elapsed` real seconds.
   *
   * Never passes `elapsed` to `Lane.step`. See `planFixedSteps`.
   */
  advance(elapsed: number): void {
    if (!Number.isFinite(elapsed) || elapsed <= 0) return

    this.accumulated += elapsed
    const plan = planFixedSteps(this.accumulated)
    this.accumulated = plan.carry

    for (let n = 0; n < plan.steps; n++) this.stepOnce(FIXED_STEP)
    this.elapsedSimulated += plan.steps * FIXED_STEP
    this.secondsDropped += plan.dropped
  }

  /** Every vehicle in the fleet, by road and station. No allocation per call. */
  forEachVehicle(visit: (roadId: RoadId, station: number, speed: number) => void): void {
    for (const [roadId, entry] of this.lanes) {
      for (let i = 0; i < entry.lane.count; i++) {
        visit(roadId, entry.lane.positionOf(i), entry.lane.speedOf(i))
      }
    }
  }

  /** The lane on a road, for tests. `undefined` if that road has none. */
  laneFor(roadId: RoadId): Lane | undefined {
    return this.lanes.get(roadId)?.lane
  }

  private stepOnce(dt: number): void {
    for (const entry of this.lanes.values()) {
      entry.lane.step(dt, entry.params)
      // Retire before spawning: a vehicle leaving the far end this step frees
      // nothing at the near end, but doing it in this order keeps the lane's
      // count honest for anything reading it between steps.
      entry.lane.removeBeyondEnd()

      entry.sinceSpawn += dt
      if (entry.sinceSpawn < SPAWN_INTERVAL) continue

      const speed = entry.params.desiredSpeed
      const rearmost = entry.lane.count === 0
        ? undefined
        : entry.lane.positionOf(entry.lane.count - 1)

      if (hasSpawnRoom(rearmost, speed, entry.params)) {
        entry.lane.add(0, speed)
        entry.sinceSpawn = 0
      } else {
        // Held at the threshold rather than allowed to keep counting.
        //
        // Not because letting it count would stack vehicles: `stepOnce` admits
        // at most ONE vehicle per fixed step and `hasSpawnRoom` is checked
        // before each, so a banked backlog could never put two cars in the same
        // place. What it would do is spend that backlog at one car every 0.25s
        // — seven times the intended rate — for as many steps as the lane was
        // blocked. A lane held up for a minute would discharge sixty seconds of
        // demand in nine, as a solid block of cars at the spawn gap, and only
        // then return to the 1.75s interval. Holding at the threshold means a
        // lane that clears resumes at its ordinary rate immediately, which is
        // what a queue at a road's entry actually does.
        entry.sinceSpawn = SPAWN_INTERVAL
      }
    }
  }
}
