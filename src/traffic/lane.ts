import { type IdmParams, idmAcceleration } from './idm'

/**
 * Largest stable timestep, seconds.
 *
 * Spec 4.3. Beyond this the car-following response lags far enough behind the
 * closing speed that vehicles overshoot into each other and the model becomes
 * unstable — which reads as cars visibly interpenetrating, not as a subtle
 * numerical error.
 *
 * `step` rejects anything larger rather than silently substepping. A lane that
 * quietly took two half-steps for a caller asking for one would produce a
 * different trajectory than the caller's own loop at the same total time, and
 * the difference would only show up as traffic that behaves differently at low
 * frame rates. Substepping is a scheduling decision and belongs to whoever
 * owns the frame clock, not to the lane.
 */
export const MAX_TIMESTEP = 0.25

/**
 * Bumper-to-bumper vehicle length, metres.
 *
 * Positions are the point the vehicle occupies on the lane; the gap the model
 * sees is the centre-to-centre distance *minus* this, so two vehicles at zero
 * gap are touching rather than overlapping by a car.
 */
export const VEHICLE_LENGTH = 4.5

/** Slots allocated up front; growth doubles rather than reallocating per insert. */
const INITIAL_CAPACITY = 16

/**
 * A queue of vehicles on one lane, stepped by the Intelligent Driver Model.
 *
 * Storage is struct-of-arrays — parallel `Float64Array`s rather than an array
 * of objects — because the step is a tight numeric loop over every vehicle in
 * the network, several times a frame.
 *
 * Vehicles are kept sorted by **descending** position, so index 0 is furthest
 * along the lane and vehicle `i`'s leader is `i − 1`. Vehicle 0 has open road.
 * Overtaking within a lane does not exist in this model, so the order is an
 * invariant rather than something re-established each step.
 */
export class Lane {
  private positions = new Float64Array(INITIAL_CAPACITY)
  private speeds = new Float64Array(INITIAL_CAPACITY)
  /** Scratch for the first pass of `step`. Never read outside one step. */
  private accelerations = new Float64Array(INITIAL_CAPACITY)
  private size = 0

  constructor(readonly length: number) {
    if (!(length > 0)) {
      throw new RangeError(`lane length must be positive, got ${length}`)
    }
    if (!Number.isFinite(length)) {
      throw new RangeError('lane length must be finite')
    }
  }

  get count(): number {
    return this.size
  }

  positionOf(index: number): number {
    this.checkIndex(index)
    return this.positions[index]!
  }

  speedOf(index: number): number {
    this.checkIndex(index)
    return this.speeds[index]!
  }

  /**
   * Insert a vehicle, keeping descending-position order.
   *
   * Linear insertion. Vehicles enter at the start of a lane, which is the tail
   * of the array, so the scan is O(1) in the case that actually happens and
   * O(n) only for the deliberate out-of-order inserts a test makes.
   */
  add(position: number, speed: number): void {
    if (!Number.isFinite(position)) {
      throw new RangeError(`vehicle position must be finite, got ${position}`)
    }
    if (!Number.isFinite(speed) || speed < 0) {
      throw new RangeError(`vehicle speed must be finite and non-negative, got ${speed}`)
    }

    this.reserve(this.size + 1)

    let at = this.size
    while (at > 0 && this.positions[at - 1]! < position) at--

    this.positions.copyWithin(at + 1, at, this.size)
    this.speeds.copyWithin(at + 1, at, this.size)
    this.positions[at] = position
    this.speeds[at] = speed
    this.size++
  }

  /** Force a vehicle's speed. For tests and, later, for events. */
  brake(index: number, speed: number): void {
    this.checkIndex(index)
    if (!Number.isFinite(speed) || speed < 0) {
      throw new RangeError(`speed must be finite and non-negative, got ${speed}`)
    }
    this.speeds[index] = speed
  }

  /**
   * Advance every vehicle by `dt` seconds.
   *
   * Two passes, and the separation is the whole model. Every acceleration is
   * computed from the state at the *start* of the step; only then is anything
   * written. Stepping in place would let vehicle `i` react to vehicle `i − 1`'s
   * already-updated state, giving the follower an implicit half-step of
   * lookahead and letting a leader's braking reach the back of a platoon in one
   * step instead of one vehicle per step. That is the difference between a
   * simulation that grows stop-and-go waves and one that merely slows everyone
   * down together.
   */
  step(dt: number, params: IdmParams): void {
    if (!(dt > 0) || dt > MAX_TIMESTEP) {
      throw new RangeError(
        `timestep must be in (0, ${MAX_TIMESTEP}] seconds, got ${dt}`,
      )
    }

    const { positions, speeds, accelerations, size } = this

    // Pass 1: accelerations, all from the current state.
    for (let i = 0; i < size; i++) {
      const leading = i > 0
      accelerations[i] = idmAcceleration(
        {
          speed: speeds[i]!,
          // Bumper to bumper: the leader is the previous index, and a whole
          // vehicle length of it sits between the two positions.
          gap: leading ? positions[i - 1]! - positions[i]! - VEHICLE_LENGTH : Infinity,
          leaderSpeed: leading ? speeds[i - 1]! : Infinity,
        },
        params,
      )
    }

    // Pass 2: ballistic integration.
    for (let i = 0; i < size; i++) {
      const v = speeds[i]!
      const a = accelerations[i]!
      const next = v + a * dt

      if (next < 0) {
        // The vehicle reaches zero partway through the step. It travels only
        // as far as it gets before stopping — v²/(2|a|) — and stays there.
        // Integrating the full step would carry it *backwards*, which reads as
        // a car twitching against the traffic in a queue.
        positions[i] = positions[i]! + (v * v) / (2 * -a)
        speeds[i] = 0
      } else {
        positions[i] = positions[i]! + v * dt + 0.5 * a * dt * dt
        speeds[i] = next
      }
    }
  }

  /**
   * Drop vehicles that have reached the end of the lane.
   *
   * They are a prefix of the array — position is descending — so this is a
   * shift, not a filter. A vehicle exactly at `length` has arrived: the lane
   * covers `[0, length)` and the next one picks it up at 0.
   */
  removeBeyondEnd(): void {
    let gone = 0
    while (gone < this.size && this.positions[gone]! >= this.length) gone++
    if (gone === 0) return

    this.positions.copyWithin(0, gone, this.size)
    this.speeds.copyWithin(0, gone, this.size)
    this.size -= gone
  }

  private checkIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.size) {
      throw new RangeError(
        `vehicle index ${index} out of range for ${this.size} vehicles`,
      )
    }
  }

  private reserve(wanted: number): void {
    if (wanted <= this.positions.length) return

    let capacity = this.positions.length
    while (capacity < wanted) capacity *= 2

    const positions = new Float64Array(capacity)
    const speeds = new Float64Array(capacity)
    positions.set(this.positions)
    speeds.set(this.speeds)
    this.positions = positions
    this.speeds = speeds
    this.accelerations = new Float64Array(capacity)
  }
}
