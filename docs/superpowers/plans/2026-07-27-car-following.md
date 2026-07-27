# Car Following Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cars that drive down a road, follow each other, stop for obstacles, and produce a phantom jam.

**Architecture:** The Intelligent Driver Model gives one acceleration per vehicle per step; ballistic integration turns that into motion. Vehicles live in per-lane struct-of-arrays sorted so a vehicle's leader is the previous index. Stopping — for a red light, a stop sign, an unaccepted gap — is not a separate mechanism: a phantom stationary vehicle is inserted at the stop line and ordinary car-following brakes for it. One code path.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), vitest 4, three.js for the debug view. No new dependencies.

## Global Constraints

- **Dependency direction:** `geometry/` imports nothing outside itself. `terrain/` imports `geometry/`. `network/` imports `geometry/`, `terrain/groundProfile` and its own `roadClass`. `mesh/` imports `geometry/`, `terrain/` and `network/`. `tool/` imports `geometry/`, `terrain/`, `network/` and `mesh/`. **`traffic/` imports `geometry/` and `network/`.** `render/` imports `mesh/`, `tool/`, `network/`, `traffic/` and three.js. `debug/` may import anything.
- **`src/geometry/`, `src/terrain/`, `src/network/`, `src/mesh/`, `src/tool/` and `src/traffic/` must NOT import three.js.** Nor may `src/render/cameraRig.ts`, `sunlight.ts`, `materials.ts` or `tiltShift.ts`.
- Coordinates `(x, y)` in metres with `y` north; `z` positive up. **Speeds are metres per second throughout the simulation**; km/h appears only in road-class design figures and in player-facing text.
- **Report rather than approximate.**
- **TypeScript** `strict: true`, `noUncheckedIndexedAccess: true`. No `any`. No non-null assertion on a value that could genuinely be absent.
- **Tests must discriminate.** Four branches running, every defect that survived review was a test that passed against its own property deleted. For each behavioural test, remove the code it covers and confirm it fails. That check is part of the task.
- Tests colocate with source as `<name>.test.ts`. Run the suite with `npm test`, types with `npx tsc --noEmit`. Both clean at every commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/traffic/idm.ts` (create) | One vehicle's acceleration, given its state and its leader's |
| `src/traffic/lane.ts` (create) | Per-lane vehicle storage and the ballistic step |
| `src/traffic/obstacle.ts` (create) | Turning a stop line into a phantom vehicle, and the dilemma-zone rule |
| `src/debug/roadScene.ts` (modify) | Cars visible on the demo network |

---

### Task 1: The Intelligent Driver Model

One function, one formula, and a great deal riding on it. Spec §4.3:

```
dv/dt   = a · [ 1 − (v/v₀)^δ − (s*(v,Δv) / s)² ]
s*(v,Δv) = s₀ + max(0, v·T + v·Δv / (2√(a·b)))
```

where `s` is the bumper-to-bumper gap, `Δv = v − v_lead`, `δ = 4`, `s₀ = 2m`, and `b` is comfortable braking.

**Files:**
- Create: `src/traffic/idm.ts`
- Create: `src/traffic/idm.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `idmAcceleration(state: IdmState, params: IdmParams): number`, the two types, and `HIGHWAY_PARAMS` / `TOWN_PARAMS`.

- [ ] **Step 1: Write the failing tests**

Create `src/traffic/idm.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  HIGHWAY_PARAMS,
  type IdmParams,
  TOWN_PARAMS,
  idmAcceleration,
} from './idm'

const p: IdmParams = {
  maxAcceleration: 1.5,
  comfortableDeceleration: 2.0,
  desiredSpeed: 30,
  minimumGap: 2,
  headwayTime: 1.5,
}

/** No leader at all: the road ahead is clear. */
const free = (speed: number) => ({ speed, gap: Infinity, leaderSpeed: Infinity })

describe('idmAcceleration', () => {
  it('accelerates from rest on an empty road at very nearly the maximum', () => {
    const a = idmAcceleration(free(0), p)
    expect(a).toBeCloseTo(p.maxAcceleration, 9)
  })

  it('neither accelerates nor brakes at the desired speed on an empty road', () => {
    expect(idmAcceleration(free(p.desiredSpeed), p)).toBeCloseTo(0, 9)
  })

  it('brakes when above the desired speed on an empty road', () => {
    expect(idmAcceleration(free(p.desiredSpeed * 1.2), p)).toBeLessThan(0)
  })

  it('falls off as the fourth power approaching the desired speed', () => {
    // delta = 4: at 90% of desired, the free term retains 1 - 0.9^4 = 0.3439.
    const a = idmAcceleration(free(p.desiredSpeed * 0.9), p)
    expect(a).toBeCloseTo(p.maxAcceleration * (1 - 0.9 ** 4), 9)
  })

  it('brakes hard when far too close to a stopped leader', () => {
    const a = idmAcceleration({ speed: 20, gap: 3, leaderSpeed: 0 }, p)
    expect(a).toBeLessThan(-p.comfortableDeceleration)
  })

  it('sits at zero acceleration at the equilibrium gap behind a same-speed leader', () => {
    // At steady state with dv = 0, s* = s0 + v*T, and the interaction term
    // cancels the free term exactly when s = s* / sqrt(1 - (v/v0)^4).
    const v = 20
    const sStar = p.minimumGap + v * p.headwayTime
    const equilibriumGap = sStar / Math.sqrt(1 - (v / p.desiredSpeed) ** 4)

    const a = idmAcceleration({ speed: v, gap: equilibriumGap, leaderSpeed: v }, p)
    expect(a).toBeCloseTo(0, 9)
  })

  it('closes a gap larger than equilibrium and opens one smaller', () => {
    const v = 20
    const sStar = p.minimumGap + v * p.headwayTime
    const equilibrium = sStar / Math.sqrt(1 - (v / p.desiredSpeed) ** 4)

    expect(idmAcceleration({ speed: v, gap: equilibrium * 1.5, leaderSpeed: v }, p))
      .toBeGreaterThan(0)
    expect(idmAcceleration({ speed: v, gap: equilibrium * 0.7, leaderSpeed: v }, p))
      .toBeLessThan(0)
  })

  it('brakes for a leader that is slower even when the gap is comfortable', () => {
    // The closing-speed term is what makes this negative; without it a
    // generous gap would read as free road right up until the collision.
    const a = idmAcceleration({ speed: 30, gap: 60, leaderSpeed: 5 }, p)
    expect(a).toBeLessThan(0)
  })

  it('ignores a leader that is pulling away', () => {
    // Approaching term must not reward a widening gap: max(0, ...) clamps it.
    const closing = idmAcceleration({ speed: 20, gap: 40, leaderSpeed: 20 }, p)
    const opening = idmAcceleration({ speed: 20, gap: 40, leaderSpeed: 40 }, p)
    expect(opening).toBeGreaterThan(closing)
    // But not unboundedly: it can never exceed the free-road acceleration.
    expect(opening).toBeLessThanOrEqual(idmAcceleration(free(20), p) + 1e-9)
  })

  it('never returns a non-finite number, however extreme the input', () => {
    const cases = [
      { speed: 0, gap: 0, leaderSpeed: 0 },
      { speed: 40, gap: 0, leaderSpeed: 0 },
      { speed: 0, gap: Infinity, leaderSpeed: Infinity },
      { speed: 40, gap: 1e-9, leaderSpeed: 0 },
    ]
    for (const c of cases) {
      expect(Number.isFinite(idmAcceleration(c, p))).toBe(true)
    }
  })

  it('gives the town preset twitchier parameters than the highway preset', () => {
    // Spec 4.3: low a and low T produce dramatic phantom jams; high values
    // produce calm flow. The presets exist to make that a design knob.
    expect(TOWN_PARAMS.maxAcceleration).toBeLessThan(HIGHWAY_PARAMS.maxAcceleration)
    expect(TOWN_PARAMS.headwayTime).toBeLessThan(HIGHWAY_PARAMS.headwayTime)
  })

  it('rejects parameters that would divide by zero', () => {
    expect(() => idmAcceleration(free(10), { ...p, desiredSpeed: 0 })).toThrow(RangeError)
    expect(() => idmAcceleration(free(10), { ...p, maxAcceleration: 0 })).toThrow(RangeError)
    expect(() => idmAcceleration(free(10), { ...p, comfortableDeceleration: 0 }))
      .toThrow(RangeError)
  })
})
```

The equilibrium-gap test is the one that pins the formula rather than its shape. Every other assertion here is a sign or an inequality, which a wrong-but-plausible formula can satisfy; that one is an exact algebraic consequence of the model, and only the real thing passes it.

The gap-of-zero cases matter because they will happen: a vehicle spawned on top of another, or a phantom obstacle inserted exactly where a car already is. The formula divides by `s`, and a `NaN` there propagates silently into a position and then into a vertex buffer.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/traffic/idm.test.ts`

Expected: FAIL — cannot resolve `./idm`.

- [ ] **Step 3: Implement**

Create `src/traffic/idm.ts`:

```ts
export type IdmState = {
  /** Metres per second. */
  readonly speed: number
  /** Bumper-to-bumper gap to the leader, metres. `Infinity` for open road. */
  readonly gap: number
  /** Leader's speed, metres per second. `Infinity` for open road. */
  readonly leaderSpeed: number
}

export type IdmParams = {
  /** `a`, metres per second squared. */
  readonly maxAcceleration: number
  /** `b`, metres per second squared. Positive. */
  readonly comfortableDeceleration: number
  /** `v0`, metres per second. */
  readonly desiredSpeed: number
  /** `s0`, metres. The gap kept when stopped. */
  readonly minimumGap: number
  /** `T`, seconds. */
  readonly headwayTime: number
}

/**
 * Free-road exponent.
 *
 * Four, per the spec. It controls how sharply acceleration tapers approaching
 * the desired speed: at 90% of `v0` a vehicle still has 34% of its
 * acceleration left, where a linear taper would leave 10%.
 */
const DELTA = 4

/**
 * Smallest gap the interaction term is evaluated at, metres.
 *
 * The term divides by the gap, so a vehicle exactly on top of another — a
 * spawn overlap, or a phantom obstacle inserted where a car already is —
 * would produce `Infinity` and then `NaN` in the position update, which is
 * silent and lands in a vertex buffer. Clamping instead yields a very large
 * braking deceleration, which is the physically sensible answer.
 */
const MIN_GAP_FOR_INTERACTION = 1e-3

/**
 * One vehicle's acceleration under the Intelligent Driver Model.
 *
 * Two terms. The free-road term accelerates toward `desiredSpeed` and vanishes
 * on reaching it. The interaction term brakes for the leader, and is built
 * from a *desired* gap that grows with both speed and closing speed — which is
 * what makes a driver brake for a much slower leader while the gap is still
 * generous, rather than waiting until it is small.
 *
 * The `max(0, …)` on the desired gap is load-bearing: without it a leader
 * pulling away would produce a negative desired gap and the term would reward
 * the driver for the leader's departure, accelerating harder than an open road
 * would.
 */
export const idmAcceleration = (state: IdmState, params: IdmParams): number => {
  const { maxAcceleration: a, comfortableDeceleration: b } = params
  const { desiredSpeed: v0, minimumGap: s0, headwayTime: T } = params

  if (!(v0 > 0)) throw new RangeError('desiredSpeed must be positive')
  if (!(a > 0)) throw new RangeError('maxAcceleration must be positive')
  if (!(b > 0)) throw new RangeError('comfortableDeceleration must be positive')

  const v = state.speed
  const freeTerm = 1 - (v / v0) ** DELTA

  if (!Number.isFinite(state.gap)) return a * freeTerm

  const closingSpeed = v - state.leaderSpeed
  const desiredGap =
    s0 + Math.max(0, v * T + (v * closingSpeed) / (2 * Math.sqrt(a * b)))

  const gap = Math.max(state.gap, MIN_GAP_FOR_INTERACTION)
  const interactionTerm = (desiredGap / gap) ** 2

  return a * (freeTerm - interactionTerm)
}

/**
 * Presets. Spec 4.3 calls stability a design knob rather than a correctness
 * constraint: low `a` and low `T` produce the dramatic stop-and-go waves that
 * make traffic readable, high values produce calm flow.
 */
export const HIGHWAY_PARAMS: IdmParams = {
  maxAcceleration: 2.0,
  comfortableDeceleration: 2.0,
  desiredSpeed: 100 / 3.6,
  minimumGap: 2,
  headwayTime: 1.5,
}

export const TOWN_PARAMS: IdmParams = {
  maxAcceleration: 1.0,
  comfortableDeceleration: 1.5,
  desiredSpeed: 50 / 3.6,
  minimumGap: 2,
  headwayTime: 1.0,
}
```

- [ ] **Step 4: Run the tests, then confirm they discriminate**

Run: `npx vitest run src/traffic/idm.test.ts`

Then, reverting each: drop the `max(0, …)` clamp and confirm the pulling-away test fails; change `DELTA` to 1 and confirm the fourth-power test fails; drop the closing-speed term from `desiredGap` and confirm the slower-leader test fails; remove the `MIN_GAP_FOR_INTERACTION` clamp and confirm the finiteness test fails. Record all four.

- [ ] **Step 5: Run everything, check types and commit**

```bash
git add src/traffic/idm.ts src/traffic/idm.test.ts
git commit -m "feat: intelligent driver model acceleration"
```

---

### Task 2: A lane of vehicles, stepped

Storage and motion. Spec §4.3: per-lane arrays sorted by position, leader is the previous index, ballistic integration with `dt ≤ 0.25s`.

Ballistic rather than Euler is not a detail. Euler updates position with the *new* speed, which lets a braking vehicle's position jump backwards and makes stop-and-go traffic visibly jitter. Ballistic uses the average of old and new speed over the step, and handles the vehicle reaching zero speed mid-step.

**Files:**
- Create: `src/traffic/lane.ts`
- Create: `src/traffic/lane.test.ts`

**Interfaces:**
- Consumes: `idmAcceleration`, `IdmParams` from `src/traffic/idm`.
- Produces: `class Lane` with `length`, `count`, `positionOf(i)`, `speedOf(i)`, `add(position, speed)`, `step(dt, params)`, `removeBeyondEnd()`, and `MAX_TIMESTEP`.

Vehicles are stored **sorted by descending position**, so index 0 is furthest along the lane and vehicle `i`'s leader is `i − 1`. Vehicle 0 has no leader.

- [ ] **Step 1: Write the failing tests**

Create `src/traffic/lane.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { type IdmParams, idmAcceleration } from './idm'
import { Lane, MAX_TIMESTEP } from './lane'

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

  it('accelerates a lone vehicle toward the desired speed and no further', () => {
    const lane = new Lane(100000)
    lane.add(0, 0)
    run(lane, 200)

    expect(lane.speedOf(0)).toBeGreaterThan(p.desiredSpeed * 0.99)
    expect(lane.speedOf(0)).toBeLessThanOrEqual(p.desiredSpeed + 1e-6)
  })

  it('never lets a vehicle travel backwards or reach a negative speed', () => {
    const lane = new Lane(1000)
    lane.add(50, 0)     // stopped leader
    lane.add(20, 25)    // fast follower, far too close

    let previous = lane.positionOf(1)
    for (let t = 0; t < 30; t += 0.2) {
      lane.step(0.2, p)
      expect(lane.speedOf(1)).toBeGreaterThanOrEqual(0)
      expect(lane.positionOf(1)).toBeGreaterThanOrEqual(previous - 1e-9)
      previous = lane.positionOf(1)
    }
  })

  it('does not let a follower pass through its leader', () => {
    const lane = new Lane(2000)
    lane.add(200, 0)
    lane.add(150, 30)

    run(lane, 60)

    expect(lane.positionOf(1)).toBeLessThan(lane.positionOf(0))
  })

  it('settles a following vehicle at a steady gap behind a steady leader', () => {
    const lane = new Lane(100000)
    lane.add(1000, 20)
    lane.add(900, 20)

    run(lane, 300)

    const gapNow = lane.positionOf(0) - lane.positionOf(1)
    lane.step(0.2, p)
    const gapNext = lane.positionOf(0) - lane.positionOf(1)

    expect(Math.abs(gapNext - gapNow)).toBeLessThan(1e-3)
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
    const lane = new Lane(1000)
    lane.add(30, 0)
    lane.add(29, 1)   // 1 m behind a stopped car, crawling: must brake to a halt

    run(lane, 20)

    expect(lane.speedOf(1)).toBeCloseTo(0, 6)
    expect(lane.positionOf(1)).toBeLessThan(lane.positionOf(0))
  })

  it('rejects a timestep beyond the stable maximum', () => {
    const lane = new Lane(1000)
    lane.add(0, 0)
    expect(() => lane.step(MAX_TIMESTEP + 0.01, p)).toThrow(RangeError)
    expect(() => lane.step(0, p)).toThrow(RangeError)
    expect(() => lane.step(-0.1, p)).toThrow(RangeError)
  })

  it('removes vehicles that reach the end of the lane', () => {
    const lane = new Lane(100)
    lane.add(99, 20)
    lane.add(10, 20)

    run(lane, 5)
    lane.removeBeyondEnd()

    expect(lane.count).toBe(1)
    expect(lane.positionOf(0)).toBeLessThan(100)
  })

  it('produces a phantom jam: a perturbation travels backwards through a platoon', () => {
    // Spec 4.3 calls this the most readable traffic phenomenon there is, and
    // the reason microscopic simulation was chosen at all. A dense platoon at
    // equilibrium, one vehicle briefly braking, and the disturbance must reach
    // vehicles *behind* it while the road ahead stays clear.
    const twitchy: IdmParams = { ...p, maxAcceleration: 1.0, headwayTime: 1.0 }
    const lane = new Lane(100000)

    const v = 20
    const gap = 25
    const n = 30
    for (let i = 0; i < n; i++) lane.add(5000 - i * gap, v)

    // Let it settle, then brake the leader hard for a moment.
    for (let t = 0; t < 60; t += 0.2) lane.step(0.2, twitchy)
    const settled = Array.from({ length: n }, (_, i) => lane.speedOf(i))

    lane.brake(0, 12)
    for (let t = 0; t < 8; t += 0.2) lane.step(0.2, twitchy)

    // A vehicle well back in the platoon must have slowed measurably...
    const disturbedIndex = 8
    expect(lane.speedOf(disturbedIndex)).toBeLessThan(settled[disturbedIndex]! - 0.5)

    // ...while one much further back has not yet noticed. That asymmetry is
    // the wave travelling backwards; without it this is just "everyone slowed".
    const untouchedIndex = n - 1
    expect(lane.speedOf(untouchedIndex)).toBeGreaterThan(settled[untouchedIndex]! - 0.5)
  })
})
```

The phantom-jam test earns its length. It is the one test here that checks an *emergent* property rather than a formula, and its second assertion is what makes it meaningful: any model where a leader's braking is broadcast to everyone would pass the first assertion alone.

The ballistic test pins the integration exactly, using the one case where ballistic and Euler differ by a clean factor of two.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/traffic/lane.test.ts`

Expected: FAIL — cannot resolve `./lane`.

- [ ] **Step 3: Implement**

Create `src/traffic/lane.ts`. The shape:

```ts
import { type IdmParams, idmAcceleration } from './idm'

/**
 * Largest stable timestep, seconds.
 *
 * Spec 4.3. Beyond this the car-following response lags far enough behind the
 * closing speed that vehicles overshoot into each other and the model becomes
 * unstable — which reads as cars visibly interpenetrating, not as a subtle
 * numerical error.
 */
export const MAX_TIMESTEP = 0.25

/** Bumper-to-bumper vehicle length, metres. */
export const VEHICLE_LENGTH = 4.5

export class Lane {
  constructor(readonly length: number)
  get count(): number
  positionOf(index: number): number
  speedOf(index: number): number
  /** Insert, keeping descending-position order. */
  add(position: number, speed: number): void
  /** Force a vehicle's speed. For tests and, later, for events. */
  brake(index: number, speed: number): void
  step(dt: number, params: IdmParams): void
  /** Drop vehicles past the end of the lane. */
  removeBeyondEnd(): void
}
```

Requirements the tests enforce, and which the implementation must honour:

- **Storage is struct-of-arrays** — parallel `Float64Array`s for position and speed, not an array of objects. Spec §4.3 measures ~20–23ns per vehicle per substep this way. Grow by reallocating at a larger capacity rather than per-insert.
- **Sorted by descending position**, so vehicle `i`'s leader is `i − 1` and vehicle 0 has open road. Insertion keeps the order.
- **Gap is bumper to bumper**: `position[i-1] − position[i] − VEHICLE_LENGTH`, and it can legitimately be small. Do not clamp it here — `idmAcceleration` owns that.
- **Accelerations for the whole lane are computed before any position is written.** Stepping in place would let vehicle `i` react to vehicle `i−1`'s already-updated state, which quietly changes the model into something with an implicit half-step of lookahead — and makes the phantom jam weaker or absent, because information propagates upstream instantly rather than one vehicle per step. This is the single easiest way to get this file wrong.
- **Ballistic integration**: over a step, `position += v·dt + 0.5·a·dt²` and `speed += a·dt`. When the new speed would be negative the vehicle stops within the step: it travels `v²/(2·|a|)` and ends at zero speed.
- **`step` throws `RangeError`** for `dt` outside `(0, MAX_TIMESTEP]`.

- [ ] **Step 4: Run the tests, then confirm they discriminate**

Run: `npx vitest run src/traffic/lane.test.ts`

Then, reverting each: step vehicles in place instead of computing all accelerations first, and confirm the phantom-jam test's second assertion fails; use Euler position updates and confirm the ballistic test fails; remove the stop-within-the-step handling and confirm the no-negative-speed test fails. Record all three, and say what the phantom-jam test reported in the in-place case — if it still passes, the test is not discriminating and needs strengthening before this task is done.

- [ ] **Step 5: Run everything, check types and commit**

```bash
git add src/traffic/lane.ts src/traffic/lane.test.ts
git commit -m "feat: a lane of vehicles, stepped ballistically"
```

---

### Task 3: Stopping, as one mechanism

Spec §4.3 is unusually prescriptive here, and the reason is worth restating: red lights, stop signs and unaccepted gaps all insert a **phantom stationary vehicle** at the stop line, and ordinary car-following brakes for it. No separate approach controller, no state machine, no discontinuity when the light changes. One code path.

The dilemma zone is the part that cannot be skipped: a vehicle too close to stop comfortably when a light turns yellow must be allowed to proceed, or it emergency-brakes.

**Files:**
- Create: `src/traffic/obstacle.ts`
- Create: `src/traffic/obstacle.test.ts`
- Modify: `src/traffic/lane.ts`

**Interfaces:**
- Consumes: `IdmParams` from `src/traffic/idm`; `Lane` from `src/traffic/lane`.
- Produces: `canClearBeforeStopping(state, params): boolean` and `Lane.setObstacle(position | undefined)`.

The dilemma rule, from the spec:

```
on yellow: if d_to_line < v²/(2b) + v·t_react  →  proceed
                                    otherwise  →  insert phantom, stop
```

- [ ] **Step 1: Write the failing tests**

Create `src/traffic/obstacle.test.ts` covering:

- A vehicle far from the line stops for it — assert its speed reaches zero and its final position is short of the line by roughly the minimum gap.
- A vehicle already very close at speed is told to proceed rather than stop, and its deceleration never exceeds the comfortable value by more than a small margin.
- The boundary: at exactly `v²/(2b) + v·t_react` the rule's answer flips, and a test either side of it disagrees. Derive the numbers rather than copying them.
- Clearing the obstacle lets a stopped queue move off again, and the vehicle nearest the line moves first.
- An obstacle set *behind* a vehicle does not affect it — only vehicles upstream of the line brake.
- An obstacle at the exact position of a stopped vehicle produces a finite acceleration, not `NaN`.

Write these yourself from the requirements above. Each must fail against the unimplemented module for the right reason before you write the implementation.

- [ ] **Step 2: Implement**

`Lane.setObstacle(position)` records a stop line. During `step`, the vehicle nearest the line from behind treats it as a leader at that position with speed zero — competing with its real leader, whichever is closer. Everything downstream of the line is unaffected.

Because the obstacle is just another leader, no other code changes: the queue that forms behind it, the way it discharges when cleared, and the shockwave that runs back through it are all the existing car-following.

`canClearBeforeStopping` implements the dilemma rule. Use a reaction time of 1.0s and say so in a named constant.

- [ ] **Step 3: Confirm the tests discriminate**

For each behavioural test, remove the code it covers and confirm it fails. Record every outcome.

In particular: make the obstacle apply to *every* vehicle rather than only those upstream of it, and confirm the behind-the-vehicle test fails.

- [ ] **Step 4: Run everything, check types and commit**

```bash
git add src/traffic/obstacle.ts src/traffic/obstacle.test.ts src/traffic/lane.ts
git commit -m "feat: stopping via phantom obstacles, with a dilemma-zone rule"
```

---

### Task 4: Cars on the demo network

Make it visible. One lane per road in the demo scene, vehicles spawned at intervals, stepped each frame, drawn as small boxes placed by sampling the road's alignment at each vehicle's station.

This is the task with no unit tests, and on all four previous branches it is where nearly every defect lived. Read `src/debug/roadScene.ts` fully before changing it.

**Files:**
- Modify: `src/debug/roadScene.ts`
- Test: `src/debug/roadScene.test.ts` where a change is testable without a renderer

- [ ] **Step 1: A lane per road**

For each road, create a `Lane` of its alignment's length. Choose IDM parameters from the road's class — a highway gets `HIGHWAY_PARAMS`, lesser classes something twitchier — and set `desiredSpeed` from the class's own `designSpeedKph`, converted to metres per second. That conversion is the one place km/h meets the simulation; do it once, in a named helper.

- [ ] **Step 2: Spawn and retire**

Spawn a vehicle at position 0 of each lane at intervals, but only when there is room — spawning on top of a stopped queue is how a simulation deadlocks. Retire vehicles at the end of the lane with `removeBeyondEnd`.

Rebuild lanes when the network changes: the scene already has a rebuild path for meshes, and a road that was split or deleted must not leave a lane behind referring to it.

- [ ] **Step 3: Step at a fixed rate**

The frame rate is not the simulation rate. Accumulate elapsed time and run whole fixed steps of at most `MAX_TIMESTEP`, so the simulation behaves identically at 30fps and 144fps. Cap the number of steps per frame so a long stall — a tab in the background, a slow rebuild — cannot produce a spiral of ever-larger catch-up.

- [ ] **Step 4: Draw them**

One `InstancedMesh` of boxes, sized roughly `VEHICLE_LENGTH` by a car's width. Each frame, for each vehicle, sample its road's alignment at its station to get a position and heading, lift it to the design elevation the road was built at, and write the instance matrix. Convert to three.js handedness with the scene's existing helper — do not add a second.

Dispose the instanced mesh and its material in the teardown.

- [ ] **Step 5: Extend what can be tested without a renderer**

Add tests for anything that became a pure function — the km/h conversion, the fixed-step accumulator's step count for a given elapsed time, the spawn-room check.

- [ ] **Step 6: Look at it**

Run: `npm run dev`, open **`http://localhost:5173/chainage/`** — the bare root redirects to a blank page.

Confirm, and report each honestly:

1. Cars appear and drive along the roads.
2. They sit on the road surface, at its elevation, pointing along it — not floating, not sunk, not sideways.
3. They follow each other rather than overlapping.
4. They slow for the vehicle ahead and speed up when it clears.
5. Speed looks plausible against the road class — a highway's traffic is visibly faster than a gravel track's.
6. Drawing a new road gives it traffic too, and deleting one does not leave cars driving through empty air.
7. Frame rate is unaffected at the demo's vehicle count.

Note some embedded browser panes report `document.hidden` as true, which stalls the frame loop; if you hit that, say so plainly rather than claiming a check you could not make.

- [ ] **Step 7: Commit**

```bash
git add src/debug/roadScene.ts src/debug/roadScene.test.ts
git commit -m "feat: traffic on the demo network"
```

---

## Deliberately not in this plan

Each is its own plan, and the spec covers all of them in detail:

- **Lane changing (MOBIL)** and multi-lane roads. One lane per road here.
- **Routing.** Vehicles drive to the end of a road and vanish; they do not choose a path. Weighted A*, segment abstraction, the replan budget and the rerouting-stability stack (5% per tick, hysteresis, speed smoothing) are the next plan.
- **Intersections.** The conflict matrix, gap acceptance, signals and the control-type crossover. Vehicles currently ignore junctions entirely.
- **Demand and town growth.** The gravity model and induced demand.
- **The congestion overlay.** Delay ratio, Viridis, the back-of-queue bars. §5 is emphatic that the metric is delay ratio and not flow over capacity, and that colour is never red-green.
- **Level-of-detail.** Microscopic everywhere for now; the mesoscopic fallback past ~6km view width comes when there is enough traffic to need it.

---

## Self-Review

**Spec coverage.** §4.3 names IDM (Task 1), ballistic integration and the sorted-array layout (Task 2), one-mechanism stopping and the dilemma rule (Task 3), and the phantom jam as the reason for choosing microscopic at all — which Task 2 tests directly rather than taking on trust. The stability presets are Task 1's. LOD is deferred above.

**Type consistency.** `IdmParams` is defined in Task 1 and consumed by name in Tasks 2, 3 and 4. `MAX_TIMESTEP` and `VEHICLE_LENGTH` come from Task 2 and are used in Task 4.

**Two things I could not verify while writing this.** The phantom-jam test's parameters — 30 vehicles at 25m spacing and 20 m/s, braking to 12 m/s for 8 seconds — are a plausible setup for a stop-and-go wave, not a measured one. The implementer must confirm the disturbance actually reaches vehicle 8 and not vehicle 29 in that window, and **tune the fixture until it genuinely does**, reporting what they changed. A phantom-jam test that passes because everything slowed down would be worse than no test at all. And the equilibrium-gap formula in Task 1's test is my own algebra; check it against the implementation's own terms before assuming a failure is the code's fault.
