# Chainage — Layered Road Mesh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an alignment and a design profile into a road you can see — a layered mesh whose subgrade, base course and wearing course are separately addressable and each drawable to an arbitrary station, so a road can be rendered mid-construction.

**Architecture:** `src/mesh/` is pure geometry generation producing **plain typed arrays**, not engine objects, so it is headlessly testable like `geometry/` and `terrain/`. A thin `src/render/` adapter wraps those arrays into three.js `BufferGeometry`. The chain: road class → cross-section profile → layer stack → swept ribbon → typed arrays → BufferGeometry.

**Tech Stack:** TypeScript (strict), Vitest, three.js r185 (only in `src/render/` and the debug view).

## Global Constraints

- **Dependency direction, one way only:** `geometry/` imports nothing. `terrain/` imports `geometry/`. `mesh/` imports `geometry/` and `terrain/`. `render/` imports `mesh/` and three.js. `debug/` may import anything. Nothing ever imports upward.
- **`src/mesh/` must not import three.js.** It produces plain `Float32Array` / `Uint32Array` attribute data. This is a deliberate deviation from the design spec, which named `BufferGeometry` as the output of `mesh/`; splitting the adapter into `render/` keeps mesh generation unit-testable without a WebGL context, and mesh generation is the project's highest-risk component.
- **Coordinates:** `(x, y)` in metres, `y` north — the plan-view plane. **`z` is elevation in metres, positive up.**
- **three.js handedness:** three uses `+Y` up. Convert **only** at the `render/` boundary: `(x, y, z) → (x, z, −y)`. Never inside `mesh/`.
- **Grades are dimensionless rise-over-run fractions.** 7% is `0.07`. Crossfall likewise: 2.5% is `0.025`.
- **Side slopes are horizontal-to-vertical ratios** — `2` means 2H:1V.
- **Layer thicknesses are metres**, not millimetres. A 40mm wearing course is `0.04`.
- **TypeScript:** `strict: true`, `noUncheckedIndexedAccess: true`.
- **Float comparison in tests:** `toBeCloseTo` precision 9 for exact-form math, precision 4 for swept or sampled results.
- **Commits:** conventional commit prefixes.

## Existing interfaces this plan builds on

All merged and passing 180 tests.

```ts
// src/geometry/vec2.ts
type Vec2 = { readonly x: number; readonly y: number }
const vec2: (x: number, y: number) => Vec2
const add, sub, scale: (a: Vec2, b: Vec2 | number) => Vec2
const normalize: (a: Vec2) => Vec2
const fromAngle: (radians: number) => Vec2
const angleOf: (a: Vec2) => number
const distance: (a: Vec2, b: Vec2) => number
const normalizeAngle: (radians: number) => number
const clamp: (s: number, length: number) => number

// src/geometry/primitives.ts
type Pose = { readonly position: Vec2; readonly heading: number; readonly curvature: number }
interface Primitive { readonly length: number; poseAt(s: number): Pose }
class Line  implements Primitive { constructor(start: Vec2, heading: number, length: number) }
class Arc   implements Primitive { constructor(start: Vec2, heading: number, length: number, curvature: number) }

// src/geometry/spiral.ts
class Spiral implements Primitive {
  constructor(start: Vec2, heading: number, length: number, startCurvature: number, endCurvature: number)
}

// src/geometry/alignment.ts
class Alignment {
  constructor(primitives: readonly Primitive[])
  readonly primitives: readonly Primitive[]
  readonly length: number
  get isEmpty(): boolean
  poseAt(s: number): Pose
  sample(spacing: number): Pose[]
}

// src/terrain/heightmap.ts
type TerrainSampler = { sample(x: number, y: number): number }
class Heightmap implements TerrainSampler { /* ... */ }

// src/terrain/groundProfile.ts
type ProfilePoint = { readonly s: number; readonly z: number }
const sampleGroundProfile: (a: Alignment, t: TerrainSampler, spacing: number) => ProfilePoint[]

// src/terrain/gradeSolver.ts
type GradeConstraints = {
  readonly maxGrade: number; readonly maxCutDepth: number; readonly maxFillHeight: number
  readonly fixedStart?: number; readonly fixedEnd?: number
}
type GradeSolution =
  | { readonly feasible: true;  readonly profile: ProfilePoint[] }
  | { readonly feasible: false; readonly failedAtStation: number }
const solveGradeProfile: (g: readonly ProfilePoint[], c: GradeConstraints) => GradeSolution
```

---

### Task 1: Pose carries its station

Carried forward from plan 1's final review. `Pose` has no `s`, so every consumer that needs a station recomputes it from a sample index. The mesh layer needs both the alignment-wide station and the primitive-local one — lane widths are polynomials in local `ds`, arc-length UVs are global.

**Files:**
- Modify: `src/geometry/primitives.ts`, `src/geometry/spiral.ts`, `src/geometry/alignment.ts`
- Modify: `src/geometry/primitives.test.ts`, `src/geometry/spiral.test.ts`, `src/geometry/alignment.test.ts`

**Interfaces:**
- Consumes: existing `Pose`, `Primitive`, `Alignment`
- Produces:
  - `Pose` gains `readonly s: number`
  - **A `Primitive` reports its own local station; an `Alignment` reports the alignment-wide station.** `line.poseAt(10).s === 10` always. `alignment.poseAt(150).s === 150` even when 150 falls 20m into the third primitive.
  - `Alignment.primitiveAt(s: number): { readonly index: number; readonly localS: number }` — which primitive owns a station and how far into it. Throws `RangeError` on an empty alignment; clamps `s` like `poseAt`.

- [ ] **Step 1: Write the failing tests**

Append to `src/geometry/primitives.test.ts`:

```ts
describe('Pose station', () => {
  it('reports the local station on a Line', () => {
    const line = new Line(vec2(10, 20), 0, 100)
    expect(line.poseAt(0).s).toBeCloseTo(0, 9)
    expect(line.poseAt(42).s).toBeCloseTo(42, 9)
    expect(line.poseAt(100).s).toBeCloseTo(100, 9)
  })

  it('reports the clamped station, not the requested one', () => {
    const line = new Line(vec2(0, 0), 0, 10)
    expect(line.poseAt(999).s).toBeCloseTo(10, 9)
    expect(line.poseAt(-5).s).toBeCloseTo(0, 9)
  })

  it('reports the local station on an Arc', () => {
    const arc = new Arc(vec2(0, 0), 0, 100, 1 / 200)
    expect(arc.poseAt(30).s).toBeCloseTo(30, 9)
  })
})
```

Append to `src/geometry/spiral.test.ts`:

```ts
describe('Spiral station', () => {
  it('reports the local station', () => {
    const spiral = new Spiral(vec2(0, 0), 0, 100, 0, 1 / 50)
    expect(spiral.poseAt(0).s).toBeCloseTo(0, 9)
    expect(spiral.poseAt(60).s).toBeCloseTo(60, 9)
  })

  it('reports the clamped station', () => {
    const spiral = new Spiral(vec2(0, 0), 0, 50, 0, 1 / 100)
    expect(spiral.poseAt(999).s).toBeCloseTo(50, 9)
  })
})
```

Append to `src/geometry/alignment.test.ts`:

```ts
describe('Alignment station reporting', () => {
  it('reports the alignment-wide station, not the primitive-local one', () => {
    const a = new Alignment([
      new Line(vec2(0, 0), 0, 50),
      new Line(vec2(50, 0), 0, 50),
    ])
    // 70 is 20m into the second primitive; the alignment must still say 70.
    expect(a.poseAt(70).s).toBeCloseTo(70, 9)
    expect(a.poseAt(0).s).toBeCloseTo(0, 9)
    expect(a.poseAt(100).s).toBeCloseTo(100, 9)
  })

  it('reports the clamped station', () => {
    const a = new Alignment([new Line(vec2(0, 0), 0, 50)])
    expect(a.poseAt(999).s).toBeCloseTo(50, 9)
    expect(a.poseAt(-10).s).toBeCloseTo(0, 9)
  })

  it('carries the station through sample()', () => {
    const a = new Alignment([new Line(vec2(0, 0), 0, 100)])
    const poses = a.sample(25)
    expect(poses.map((p) => p.s)).toEqual([0, 25, 50, 75, 100])
  })
})

describe('Alignment.primitiveAt', () => {
  const twoLines = () => new Alignment([
    new Line(vec2(0, 0), 0, 50),
    new Line(vec2(50, 0), 0, 30),
  ])

  it('identifies the owning primitive and the local station', () => {
    const a = twoLines()
    expect(a.primitiveAt(20)).toEqual({ index: 0, localS: 20 })
    expect(a.primitiveAt(60)).toEqual({ index: 1, localS: 10 })
  })

  it('assigns a boundary station to the later primitive', () => {
    const a = twoLines()
    expect(a.primitiveAt(50)).toEqual({ index: 1, localS: 0 })
  })

  it('clamps beyond either end', () => {
    const a = twoLines()
    expect(a.primitiveAt(-5)).toEqual({ index: 0, localS: 0 })
    expect(a.primitiveAt(999)).toEqual({ index: 1, localS: 30 })
  })

  it('agrees with poseAt', () => {
    const a = twoLines()
    const { index, localS } = a.primitiveAt(65)
    const direct = a.poseAt(65)
    const viaPrimitive = a.primitives[index]!.poseAt(localS)
    expect(viaPrimitive.position.x).toBeCloseTo(direct.position.x, 9)
    expect(viaPrimitive.position.y).toBeCloseTo(direct.position.y, 9)
  })

  it('throws on an empty alignment', () => {
    expect(() => new Alignment([]).primitiveAt(0)).toThrow(RangeError)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/geometry/
```

Expected: FAIL — `s` is not a property of `Pose`, and `primitiveAt` is not a function.

- [ ] **Step 3: Add `s` to `Pose` and to each primitive**

In `src/geometry/primitives.ts`, extend the type:

```ts
export type Pose = {
  /**
   * Distance along whoever produced this pose.
   *
   * A `Primitive` reports its own local station, so `line.poseAt(10).s` is 10.
   * An `Alignment` reports the alignment-wide station, so a pose 20m into the
   * third primitive reports its total distance from the alignment start, not
   * 20. Use `Alignment.primitiveAt` when you need both.
   *
   * Always the CLAMPED station, never the requested one.
   */
  readonly s: number
  readonly position: Vec2
  readonly heading: number
  readonly curvature: number
}
```

In `Line.poseAt`, add `s: t` to the returned object. In `Arc.poseAt`, add `s: t`. In `src/geometry/spiral.ts`'s `Spiral.poseAt`, add `s: t`. In every case `t` is the already-clamped local station.

- [ ] **Step 4: Rewrite the station on the way out of `Alignment`**

In `src/geometry/alignment.ts`, replace `poseAt` and add `primitiveAt`:

```ts
  /** Which primitive owns a station, and how far into it. */
  primitiveAt(s: number): { readonly index: number; readonly localS: number } {
    if (this.isEmpty) {
      throw new RangeError('cannot locate a station on an empty alignment')
    }
    const t = clampNumber(s, 0, this.length)

    // Last primitive whose start is at or below t. Ties go to the later one,
    // matching poseAt's existing convention.
    let index = 0
    for (let i = this.primitives.length - 1; i >= 0; i--) {
      if (t >= this.starts[i]!) {
        index = i
        break
      }
    }
    return { index, localS: t - this.starts[index]! }
  }

  poseAt(s: number): Pose {
    const { index, localS } = this.primitiveAt(s)
    const pose = this.primitives[index]!.poseAt(localS)
    // The primitive reported its local station; the alignment reports its own.
    return { ...pose, s: this.starts[index]! + pose.s }
  }
```

Add at the bottom of the file if not already present:

```ts
const clampNumber = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS. The suite grows by 13 to 193.

- [ ] **Step 6: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors. If a consumer constructs a `Pose` literal it will now fail to compile — fix it by supplying `s` rather than by loosening the type.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: carry station on Pose and locate primitives by station"
```

---

### Task 2: Alignment validates continuity

Carried forward from plan 1's final review. The end-to-end invariant exists only as a comment; the constructor accepts any array. The design spec calls C¹ continuity across joints "the single most important structural decision", and the drawing tool will produce joint mismatches at volume. Catching them at construction beats discovering them as a kinked mesh.

**Files:**
- Modify: `src/geometry/alignment.ts`, `src/geometry/alignment.test.ts`

**Interfaces:**
- Consumes: `Pose`, `Primitive`, `Alignment` from Task 1
- Produces:
  - `type ContinuityBreak = { readonly index: number; readonly positionGap: number; readonly headingGap: number }`
  - `checkContinuity(primitives: readonly Primitive[]): ContinuityBreak[]` — every joint whose gap exceeds tolerance, empty when the chain is sound
  - `Alignment.continuityBreaks: ContinuityBreak[]` — computed once at construction
  - `Alignment.isContinuous: boolean`
  - Tolerances: `POSITION_TOLERANCE = 1e-3` metres (a millimetre), `HEADING_TOLERANCE = 1e-4` radians (about 0.006°)
  - The constructor does **not** throw. A break is reported, not fatal — a half-built alignment mid-drag is a normal transient state, and throwing would make the tool unusable.

- [ ] **Step 1: Write the failing tests**

Append to `src/geometry/alignment.test.ts`:

```ts
describe('Alignment continuity', () => {
  it('reports no breaks for a sound chain', () => {
    const a = new Alignment([
      new Line(vec2(0, 0), 0, 50),
      new Line(vec2(50, 0), 0, 50),
    ])
    expect(a.continuityBreaks).toEqual([])
    expect(a.isContinuous).toBe(true)
  })

  it('reports no breaks for a line meeting an arc tangentially', () => {
    const a = new Alignment([
      new Line(vec2(0, 0), 0, 50),
      new Arc(vec2(50, 0), 0, 100, 1 / 200),
    ])
    expect(a.isContinuous).toBe(true)
  })

  it('detects a position gap', () => {
    const a = new Alignment([
      new Line(vec2(0, 0), 0, 50),
      new Line(vec2(51, 0), 0, 50),   // starts 1m past where the first ends
    ])
    expect(a.isContinuous).toBe(false)
    expect(a.continuityBreaks).toHaveLength(1)
    expect(a.continuityBreaks[0]!.index).toBe(1)
    expect(a.continuityBreaks[0]!.positionGap).toBeCloseTo(1, 6)
  })

  it('detects a heading kink even when positions match', () => {
    const a = new Alignment([
      new Line(vec2(0, 0), 0, 50),
      new Line(vec2(50, 0), 0.3, 50),   // same point, 0.3 rad kink
    ])
    expect(a.isContinuous).toBe(false)
    expect(a.continuityBreaks[0]!.headingGap).toBeCloseTo(0.3, 6)
    expect(a.continuityBreaks[0]!.positionGap).toBeCloseTo(0, 6)
  })

  it('tolerates a sub-millimetre position gap', () => {
    const a = new Alignment([
      new Line(vec2(0, 0), 0, 50),
      new Line(vec2(50.0001, 0), 0, 50),
    ])
    expect(a.isContinuous).toBe(true)
  })

  it('measures the heading gap across the PI wraparound', () => {
    // Both headings point very nearly west; naive subtraction would give ~2*PI.
    const a = new Alignment([
      new Line(vec2(0, 0), Math.PI - 1e-6, 50),
      new Line(new Line(vec2(0, 0), Math.PI - 1e-6, 50).poseAt(50).position, -Math.PI + 1e-6, 50),
    ])
    expect(a.isContinuous).toBe(true)
  })

  it('reports every break in a chain with several', () => {
    const a = new Alignment([
      new Line(vec2(0, 0), 0, 10),
      new Line(vec2(11, 0), 0, 10),
      new Line(vec2(30, 0), 0, 10),
    ])
    expect(a.continuityBreaks).toHaveLength(2)
    expect(a.continuityBreaks.map((b) => b.index)).toEqual([1, 2])
  })

  it('treats an empty or single-primitive alignment as continuous', () => {
    expect(new Alignment([]).isContinuous).toBe(true)
    expect(new Alignment([new Line(vec2(0, 0), 0, 10)]).isContinuous).toBe(true)
  })

  it('exposes checkContinuity independently of the class', () => {
    const breaks = checkContinuity([
      new Line(vec2(0, 0), 0, 50),
      new Line(vec2(55, 0), 0, 50),
    ])
    expect(breaks).toHaveLength(1)
    expect(breaks[0]!.positionGap).toBeCloseTo(5, 6)
  })
})
```

Add `checkContinuity` to that file's import from `./alignment`, and `Arc` to its import from `./primitives`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/geometry/alignment.test.ts
```

Expected: FAIL — `checkContinuity` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `src/geometry/alignment.ts`, above the class:

```ts
import { distance, normalizeAngle } from './vec2'

export type ContinuityBreak = {
  /** Index of the primitive that starts where the previous one should have ended. */
  readonly index: number
  /** Distance between the previous primitive's end and this one's start, metres. */
  readonly positionGap: number
  /** Absolute heading difference across the joint, radians. */
  readonly headingGap: number
}

/** A millimetre. Below this, a joint is closed as far as anyone can tell. */
const POSITION_TOLERANCE = 1e-3
/** About 0.006 degrees. Below this, a kink is invisible at any road scale. */
const HEADING_TOLERANCE = 1e-4

/**
 * Find every joint where the chain fails to meet.
 *
 * A sound alignment is continuous in position and heading at each joint —
 * curvature may step (a straight meeting an arc is a legitimate curvature
 * discontinuity), but a gap or a kink is a defect. Heading is compared through
 * `normalizeAngle` so a joint straddling the +/-PI boundary reads as closed
 * rather than as a full turn.
 */
export const checkContinuity = (
  primitives: readonly Primitive[],
): ContinuityBreak[] => {
  const breaks: ContinuityBreak[] = []

  for (let i = 1; i < primitives.length; i++) {
    const previous = primitives[i - 1]!
    const current = primitives[i]!

    const end = previous.poseAt(previous.length)
    const start = current.poseAt(0)

    const positionGap = distance(end.position, start.position)
    const headingGap = Math.abs(normalizeAngle(start.heading - end.heading))

    if (positionGap > POSITION_TOLERANCE || headingGap > HEADING_TOLERANCE) {
      breaks.push({ index: i, positionGap, headingGap })
    }
  }

  return breaks
}
```

Inside the class, add after the `length` assignment in the constructor:

```ts
    this.continuityBreaks = checkContinuity(primitives)
```

and declare it alongside the other readonly fields:

```ts
  /**
   * Joints that fail to meet. Empty for a sound alignment.
   *
   * Construction does not throw on a break. A half-built alignment mid-drag is
   * a normal transient state, and throwing would make the drawing tool
   * unusable — the tool inspects this and shows the player where the problem
   * is instead.
   */
  readonly continuityBreaks: ContinuityBreak[]
```

And a getter:

```ts
  get isContinuous(): boolean {
    return this.continuityBreaks.length === 0
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS. The suite grows by 9 to 202.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: report continuity breaks at alignment joints"
```

---

### Task 3: Structure allowance in the grade solver

Carried forward from plan 2's final review, and a prerequisite for bridges ever existing. The solver bounds every design elevation to `[ground − maxCutDepth, ground + maxFillHeight]`, so a design line standing high above natural ground — precisely the bridge trigger — cannot be produced. Asked for one, the solver returns infeasible. A ravine that should resolve to a bridge reads as an impossible alignment.

The fix is a second, larger vertical allowance. Below `maxFillHeight` the gap is closed with earth; between `maxFillHeight` and `maxStructureHeight` it is a structure; beyond that it is genuinely infeasible.

**Files:**
- Modify: `src/terrain/gradeSolver.ts`, `src/terrain/gradeSolver.test.ts`

**Interfaces:**
- Consumes: `ProfilePoint` from `./groundProfile`
- Produces:
  - `GradeConstraints` gains `readonly maxStructureHeight?: number` — when set, the fill side of the band widens to this. Defaults to `maxFillHeight` (no structures).
  - `type StationSupport = 'earthwork' | 'structure'`
  - `classifySupport(ground: readonly ProfilePoint[], design: readonly ProfilePoint[], maxFillHeight: number): StationSupport[]` — one entry per station: `structure` where the design line stands more than `maxFillHeight` above natural ground, `earthwork` otherwise
  - Throws `RangeError` if `maxStructureHeight` is present and less than `maxFillHeight`

- [ ] **Step 1: Write the failing tests**

Append to `src/terrain/gradeSolver.test.ts`:

```ts
describe('structure allowance', () => {
  it('is infeasible across a ravine without one', () => {
    // A 40m ravine with 10m of fill available.
    const gp = ground([100, 100, 60, 100, 100])
    const r = solveGradeProfile(gp, constraints({ maxCutDepth: 10, maxFillHeight: 10 }))
    expect(r.feasible).toBe(false)
  })

  it('becomes feasible with a structure allowance', () => {
    const gp = ground([100, 100, 60, 100, 100])
    const r = solveGradeProfile(
      gp,
      constraints({ maxCutDepth: 10, maxFillHeight: 10, maxStructureHeight: 45 }),
    )
    expect(r.feasible).toBe(true)
  })

  it('carries the design line across the ravine rather than dropping into it', () => {
    const gp = ground([100, 100, 60, 100, 100])
    const r = solveGradeProfile(
      gp,
      constraints({ maxCutDepth: 10, maxFillHeight: 10, maxStructureHeight: 45 }),
    )
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    // The station over the ravine floor stays far above it.
    expect(r.profile[2]!.z).toBeGreaterThan(90)
  })

  it('still respects the cut side, which a structure does not help', () => {
    const gp = ground([100, 100, 100])
    const r = solveGradeProfile(
      gp,
      constraints({ maxCutDepth: 3, maxFillHeight: 3, maxStructureHeight: 50 }),
    )
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    for (const p of r.profile) expect(p.z).toBeGreaterThanOrEqual(97 - 1e-9)
  })

  it('rejects a structure allowance below the fill allowance', () => {
    expect(() =>
      solveGradeProfile(ground([100]), constraints({ maxFillHeight: 10, maxStructureHeight: 5 })),
    ).toThrow(RangeError)
  })

  it('behaves identically when the structure allowance equals the fill allowance', () => {
    const gp = ground([100, 105, 110, 115, 120])
    const withOut = solveGradeProfile(gp, constraints({ maxCutDepth: 10, maxFillHeight: 10 }))
    const withEqual = solveGradeProfile(
      gp,
      constraints({ maxCutDepth: 10, maxFillHeight: 10, maxStructureHeight: 10 }),
    )
    expect(withOut.feasible).toBe(true)
    expect(withEqual.feasible).toBe(true)
    if (!withOut.feasible || !withEqual.feasible) return
    expect(withEqual.profile.map((p) => p.z)).toEqual(withOut.profile.map((p) => p.z))
  })
})

describe('classifySupport', () => {
  it('marks stations standing above the fill allowance as structure', () => {
    const gp = ground([100, 100, 60, 100, 100])
    const design = ground([100, 100, 100, 100, 100])
    expect(classifySupport(gp, design, 10)).toEqual([
      'earthwork', 'earthwork', 'structure', 'earthwork', 'earthwork',
    ])
  })

  it('marks everything earthwork when the design hugs the ground', () => {
    const gp = ground([100, 101, 102])
    expect(classifySupport(gp, gp, 10)).toEqual(['earthwork', 'earthwork', 'earthwork'])
  })

  it('marks cut as earthwork however deep', () => {
    const gp = ground([100, 100, 100])
    const design = ground([80, 80, 80])
    expect(classifySupport(gp, design, 10)).toEqual(['earthwork', 'earthwork', 'earthwork'])
  })

  it('treats exactly the fill allowance as earthwork', () => {
    const gp = ground([100])
    const design = ground([110])
    expect(classifySupport(gp, design, 10)).toEqual(['earthwork'])
  })

  it('rejects mismatched lengths', () => {
    expect(() => classifySupport(ground([100, 100]), ground([100]), 10)).toThrow(RangeError)
  })
})
```

Extend that file's import from `./gradeSolver` to include `classifySupport`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/terrain/gradeSolver.test.ts
```

Expected: FAIL — `classifySupport` is not exported and `maxStructureHeight` is not accepted.

- [ ] **Step 3: Write the implementation**

In `src/terrain/gradeSolver.ts`, extend the constraints type:

```ts
export type GradeConstraints = {
  /** Maximum absolute grade as a rise-over-run fraction. 7% is 0.07. */
  readonly maxGrade: number
  /** How far below natural ground the road may be cut, metres. */
  readonly maxCutDepth: number
  /** How far above natural ground the road may be carried on fill, metres. */
  readonly maxFillHeight: number
  /**
   * How far above natural ground the road may be carried on a STRUCTURE,
   * metres. Must be at least `maxFillHeight`; defaults to it, meaning no
   * structures are permitted.
   *
   * Without this the solver can never produce a design line standing high
   * above the ground, so a ravine that ought to become a bridge reads as an
   * impossible alignment instead. Below `maxFillHeight` the gap is closed with
   * earth; between the two it is a structure; beyond it, genuinely infeasible.
   * The cut side is unaffected — a bridge does not help you get through a hill.
   */
  readonly maxStructureHeight?: number
  readonly fixedStart?: number
  readonly fixedEnd?: number
}

/** How a station is held up. */
export type StationSupport = 'earthwork' | 'structure'
```

In `solveGradeProfile`, after the existing validation, add:

```ts
  const maxAbove = maxStructureHeight ?? maxFillHeight
  if (maxAbove < maxFillHeight) {
    throw new RangeError('maxStructureHeight must not be less than maxFillHeight')
  }
```

destructuring `maxStructureHeight` alongside the others, and change the initial band's upper bound from `g + maxFillHeight` to `g + maxAbove`.

Then add at the end of the file:

```ts
/**
 * Which stations are carried on earth and which need a structure.
 *
 * A station standing more than the fill allowance above natural ground is a
 * structure — beyond that height an embankment stops being economic and
 * starts looking absurd. Depth of cut is irrelevant: a bridge does not help
 * you get through a hill.
 */
export const classifySupport = (
  ground: readonly ProfilePoint[],
  design: readonly ProfilePoint[],
  maxFillHeight: number,
): StationSupport[] => {
  if (ground.length !== design.length) {
    throw new RangeError('ground and design profiles must have the same length')
  }
  return design.map((d, i) =>
    d.z - ground[i]!.z > maxFillHeight ? 'structure' : 'earthwork',
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS. The suite grows by 11 to 213.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add structure allowance so bridges become reachable"
```

---

### Task 4: Road classes

The four classes from the design spec, each carrying the numbers everything downstream reads: how wide it is, how fast it is, what it costs, and how thick its pavement is.

**Files:**
- Create: `src/mesh/roadClass.ts`
- Test: `src/mesh/roadClass.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type RoadClassName = 'gravel' | 'rural' | 'arterial' | 'highway'`
  - `type LayerName = 'subgrade' | 'base' | 'wearing'`
  - `type RoadClass = { readonly name: RoadClassName; readonly laneCount: number; readonly laneWidth: number; readonly shoulderWidth: number; readonly crossfall: number; readonly designSpeedKph: number; readonly layers: readonly { readonly name: LayerName; readonly thickness: number; readonly widthExtension: number }[] }`
  - `ROAD_CLASSES: Readonly<Record<RoadClassName, RoadClass>>`
  - `carriagewayHalfWidth(rc: RoadClass): number` — half the sealed width, excluding shoulders
  - `formationHalfWidth(rc: RoadClass): number` — half the full width including shoulders
  - `totalPavementThickness(rc: RoadClass): number`

- [ ] **Step 1: Write the failing tests**

`src/mesh/roadClass.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  ROAD_CLASSES, carriagewayHalfWidth, formationHalfWidth, totalPavementThickness,
  type RoadClassName,
} from './roadClass'

const ALL: RoadClassName[] = ['gravel', 'rural', 'arterial', 'highway']

describe('ROAD_CLASSES', () => {
  it('defines every class', () => {
    for (const name of ALL) expect(ROAD_CLASSES[name].name).toBe(name)
  })

  it('gets wider and faster up the hierarchy', () => {
    let width = 0
    let speed = 0
    for (const name of ALL) {
      const rc = ROAD_CLASSES[name]
      expect(formationHalfWidth(rc)).toBeGreaterThan(width)
      expect(rc.designSpeedKph).toBeGreaterThan(speed)
      width = formationHalfWidth(rc)
      speed = rc.designSpeedKph
    }
  })

  it('gives every class a positive lane width and lane count', () => {
    for (const name of ALL) {
      expect(ROAD_CLASSES[name].laneWidth).toBeGreaterThan(0)
      expect(ROAD_CLASSES[name].laneCount).toBeGreaterThanOrEqual(1)
    }
  })

  it('uses a crossfall that sheds water without being felt', () => {
    for (const name of ALL) {
      expect(ROAD_CLASSES[name].crossfall).toBeGreaterThanOrEqual(0.02)
      expect(ROAD_CLASSES[name].crossfall).toBeLessThanOrEqual(0.05)
    }
  })
})

describe('layers', () => {
  it('orders layers bottom-up: subgrade, base, wearing', () => {
    for (const name of ALL) {
      expect(ROAD_CLASSES[name].layers.map((l) => l.name)).toEqual([
        'subgrade', 'base', 'wearing',
      ])
    }
  })

  it('gives every layer a positive thickness', () => {
    for (const name of ALL) {
      for (const layer of ROAD_CLASSES[name].layers) {
        expect(layer.thickness).toBeGreaterThan(0)
      }
    }
  })

  it('makes lower layers wider than upper ones', () => {
    for (const name of ALL) {
      const ext = ROAD_CLASSES[name].layers.map((l) => l.widthExtension)
      expect(ext[0]!).toBeGreaterThan(ext[1]!)
      expect(ext[1]!).toBeGreaterThan(ext[2]!)
      expect(ext[2]!).toBe(0)
    }
  })

  it('builds thicker pavement for heavier classes', () => {
    expect(totalPavementThickness(ROAD_CLASSES.highway))
      .toBeGreaterThan(totalPavementThickness(ROAD_CLASSES.gravel))
  })

  it('keeps total pavement within a realistic band', () => {
    for (const name of ALL) {
      const t = totalPavementThickness(ROAD_CLASSES[name])
      expect(t).toBeGreaterThan(0.15)
      expect(t).toBeLessThan(1.2)
    }
  })
})

describe('width helpers', () => {
  it('computes carriageway half width from lanes', () => {
    const rc = ROAD_CLASSES.rural
    expect(carriagewayHalfWidth(rc)).toBeCloseTo((rc.laneCount * rc.laneWidth) / 2, 9)
  })

  it('adds shoulders for formation half width', () => {
    const rc = ROAD_CLASSES.rural
    expect(formationHalfWidth(rc)).toBeCloseTo(
      carriagewayHalfWidth(rc) + rc.shoulderWidth, 9,
    )
  })

  it('gives a divided highway more lanes than a rural road', () => {
    expect(ROAD_CLASSES.highway.laneCount).toBeGreaterThan(ROAD_CLASSES.rural.laneCount)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/mesh/roadClass.test.ts
```

Expected: FAIL — `Failed to resolve import "./roadClass"`.

- [ ] **Step 3: Write the implementation**

`src/mesh/roadClass.ts`:

```ts
export type RoadClassName = 'gravel' | 'rural' | 'arterial' | 'highway'

/** Pavement layers, named bottom-up. */
export type LayerName = 'subgrade' | 'base' | 'wearing'

export type PavementLayer = {
  readonly name: LayerName
  /** Vertical thickness, metres. A 40mm wearing course is 0.04. */
  readonly thickness: number
  /**
   * How far this layer extends beyond the formation edge on each side, metres.
   *
   * Lower layers are built wider than upper ones — the base course has to
   * support the seal right to its edge, so it cannot stop in the same place.
   * The wearing course defines the formation edge and so extends by zero.
   */
  readonly widthExtension: number
}

export type RoadClass = {
  readonly name: RoadClassName
  readonly laneCount: number
  /** Width of one lane, metres. */
  readonly laneWidth: number
  /** Width of the shoulder on each side, metres. */
  readonly shoulderWidth: number
  /** Cross slope from crown to edge, as a fraction. 2.5% is 0.025. */
  readonly crossfall: number
  readonly designSpeedKph: number
  /** Bottom-up: subgrade, base, wearing. */
  readonly layers: readonly PavementLayer[]
}

/**
 * The four classes, with figures in the range real road standards use.
 *
 * Crossfall exists to shed water: too little and the surface ponds, too much
 * and a driver feels the camber. Every class sits in the usual 2.5–3% band.
 */
export const ROAD_CLASSES: Readonly<Record<RoadClassName, RoadClass>> = {
  gravel: {
    name: 'gravel',
    laneCount: 1,
    laneWidth: 3.5,
    shoulderWidth: 0.5,
    crossfall: 0.03,
    designSpeedKph: 40,
    layers: [
      { name: 'subgrade', thickness: 0.20, widthExtension: 0.4 },
      { name: 'base', thickness: 0.15, widthExtension: 0.2 },
      { name: 'wearing', thickness: 0.05, widthExtension: 0 },
    ],
  },
  rural: {
    name: 'rural',
    laneCount: 2,
    laneWidth: 3.5,
    shoulderWidth: 1.5,
    crossfall: 0.025,
    designSpeedKph: 80,
    layers: [
      { name: 'subgrade', thickness: 0.25, widthExtension: 0.6 },
      { name: 'base', thickness: 0.20, widthExtension: 0.3 },
      { name: 'wearing', thickness: 0.05, widthExtension: 0 },
    ],
  },
  arterial: {
    name: 'arterial',
    laneCount: 4,
    laneWidth: 3.5,
    shoulderWidth: 2.0,
    crossfall: 0.025,
    designSpeedKph: 90,
    layers: [
      { name: 'subgrade', thickness: 0.30, widthExtension: 0.8 },
      { name: 'base', thickness: 0.25, widthExtension: 0.4 },
      { name: 'wearing', thickness: 0.06, widthExtension: 0 },
    ],
  },
  highway: {
    name: 'highway',
    laneCount: 6,
    laneWidth: 3.7,
    shoulderWidth: 3.0,
    crossfall: 0.025,
    designSpeedKph: 110,
    layers: [
      { name: 'subgrade', thickness: 0.35, widthExtension: 1.0 },
      { name: 'base', thickness: 0.30, widthExtension: 0.5 },
      { name: 'wearing', thickness: 0.08, widthExtension: 0 },
    ],
  },
}

/** Half the sealed width, excluding shoulders. */
export const carriagewayHalfWidth = (rc: RoadClass): number =>
  (rc.laneCount * rc.laneWidth) / 2

/** Half the full built width, including shoulders. */
export const formationHalfWidth = (rc: RoadClass): number =>
  carriagewayHalfWidth(rc) + rc.shoulderWidth

export const totalPavementThickness = (rc: RoadClass): number =>
  rc.layers.reduce((sum, l) => sum + l.thickness, 0)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/mesh/roadClass.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/mesh/roadClass.ts src/mesh/roadClass.test.ts
git commit -m "feat: add road classes with pavement layer stacks"
```

---

### Task 5: Cross-section profile

The transverse shape of one pavement layer at a station: a list of points across the road, each an offset from the centreline and a height relative to the design elevation. Sweeping this along an alignment is what makes a ribbon.

**Files:**
- Create: `src/mesh/crossSection.ts`
- Test: `src/mesh/crossSection.test.ts`

**Interfaces:**
- Consumes: `RoadClass`, `LayerName`, `PavementLayer`, `formationHalfWidth`, `totalPavementThickness` from `./roadClass`
- Produces:
  - `type SectionPoint = { readonly offset: number; readonly dz: number }` — `offset` is metres from the centreline, negative left; `dz` is metres relative to the design elevation, which is the **top of the wearing course at the crown**
  - `layerTopProfile(rc: RoadClass, layer: LayerName): SectionPoint[]` — the top surface of one layer, left edge to right edge, offsets strictly increasing
  - `layerDepthBelowSurface(rc: RoadClass, layer: LayerName): number` — how far the top of a layer sits below the design elevation
  - Throws `RangeError` for a layer name the class does not have

- [ ] **Step 1: Write the failing tests**

`src/mesh/crossSection.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { layerTopProfile, layerDepthBelowSurface } from './crossSection'
import { ROAD_CLASSES, formationHalfWidth } from './roadClass'

const rural = ROAD_CLASSES.rural

describe('layerDepthBelowSurface', () => {
  it('puts the wearing course top at the design elevation', () => {
    expect(layerDepthBelowSurface(rural, 'wearing')).toBeCloseTo(0, 9)
  })

  it('puts the base top one wearing-course thickness down', () => {
    const wearing = rural.layers.find((l) => l.name === 'wearing')!
    expect(layerDepthBelowSurface(rural, 'base')).toBeCloseTo(wearing.thickness, 9)
  })

  it('puts the subgrade top below wearing plus base', () => {
    const wearing = rural.layers.find((l) => l.name === 'wearing')!
    const base = rural.layers.find((l) => l.name === 'base')!
    expect(layerDepthBelowSurface(rural, 'subgrade'))
      .toBeCloseTo(wearing.thickness + base.thickness, 9)
  })

  it('rejects an unknown layer', () => {
    // @ts-expect-error deliberately invalid layer name
    expect(() => layerDepthBelowSurface(rural, 'ballast')).toThrow(RangeError)
  })
})

describe('layerTopProfile', () => {
  it('is symmetric about the centreline', () => {
    const p = layerTopProfile(rural, 'wearing')
    const first = p[0]!
    const last = p[p.length - 1]!
    expect(first.offset).toBeCloseTo(-last.offset, 9)
    expect(first.dz).toBeCloseTo(last.dz, 9)
  })

  it('has strictly increasing offsets', () => {
    for (const name of ['subgrade', 'base', 'wearing'] as const) {
      const p = layerTopProfile(rural, name)
      for (let i = 1; i < p.length; i++) {
        expect(p[i]!.offset).toBeGreaterThan(p[i - 1]!.offset)
      }
    }
  })

  it('peaks at the crown and falls to the edges', () => {
    const p = layerTopProfile(rural, 'wearing')
    const crown = p.find((q) => Math.abs(q.offset) < 1e-9)!
    expect(crown.dz).toBeCloseTo(0, 9)
    for (const q of p) {
      if (Math.abs(q.offset) > 1e-9) expect(q.dz).toBeLessThan(crown.dz)
    }
  })

  it('applies the class crossfall from crown to formation edge', () => {
    const p = layerTopProfile(rural, 'wearing')
    const half = formationHalfWidth(rural)
    const edge = p[p.length - 1]!
    expect(edge.offset).toBeCloseTo(half, 9)
    expect(edge.dz).toBeCloseTo(-half * rural.crossfall, 9)
  })

  it('places a lower layer entirely below an upper one at the same offset', () => {
    const wearing = layerTopProfile(rural, 'wearing')
    const base = layerTopProfile(rural, 'base')
    const crownW = wearing.find((q) => Math.abs(q.offset) < 1e-9)!
    const crownB = base.find((q) => Math.abs(q.offset) < 1e-9)!
    expect(crownB.dz).toBeLessThan(crownW.dz)
  })

  it('makes lower layers wider', () => {
    const wearingHalf = layerTopProfile(rural, 'wearing').slice(-1)[0]!.offset
    const baseHalf = layerTopProfile(rural, 'base').slice(-1)[0]!.offset
    const subHalf = layerTopProfile(rural, 'subgrade').slice(-1)[0]!.offset
    expect(baseHalf).toBeGreaterThan(wearingHalf)
    expect(subHalf).toBeGreaterThan(baseHalf)
  })

  it('gives every class a usable profile', () => {
    for (const name of ['gravel', 'rural', 'arterial', 'highway'] as const) {
      const p = layerTopProfile(ROAD_CLASSES[name], 'wearing')
      expect(p.length).toBeGreaterThanOrEqual(3)
      expect(p.every((q) => Number.isFinite(q.offset) && Number.isFinite(q.dz))).toBe(true)
    }
  })

  it('includes a point at every lane boundary', () => {
    // A 2-lane road has boundaries at -3.5, 0, +3.5 plus the shoulder edges.
    const p = layerTopProfile(rural, 'wearing')
    for (const offset of [-3.5, 0, 3.5]) {
      expect(p.some((q) => Math.abs(q.offset - offset) < 1e-9)).toBe(true)
    }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/mesh/crossSection.test.ts
```

Expected: FAIL — `Failed to resolve import "./crossSection"`.

- [ ] **Step 3: Write the implementation**

`src/mesh/crossSection.ts`:

```ts
import {
  type RoadClass, type LayerName,
  carriagewayHalfWidth, formationHalfWidth,
} from './roadClass'

/**
 * One point across the road.
 *
 * `offset` is metres from the centreline, negative to the left of the
 * direction of travel. `dz` is metres relative to the **design elevation**,
 * which is defined as the top of the wearing course at the crown — so the
 * wearing course crown has `dz` of exactly zero and everything else is below.
 */
export type SectionPoint = {
  readonly offset: number
  readonly dz: number
}

const layerOf = (rc: RoadClass, layer: LayerName) => {
  const found = rc.layers.find((l) => l.name === layer)
  if (!found) {
    throw new RangeError(`road class ${rc.name} has no layer named ${layer}`)
  }
  return found
}

/** How far the top of a layer sits below the design elevation. */
export const layerDepthBelowSurface = (rc: RoadClass, layer: LayerName): number => {
  layerOf(rc, layer) // validates
  let depth = 0
  // Layers are ordered bottom-up, so walk down from the top.
  for (let i = rc.layers.length - 1; i >= 0; i--) {
    const l = rc.layers[i]!
    if (l.name === layer) return depth
    depth += l.thickness
  }
  return depth
}

/**
 * The top surface of one layer, left edge to right edge.
 *
 * Points land at the crown, every lane boundary, the carriageway edge and the
 * layer's own outer edge, so the swept mesh has vertices exactly where lane
 * markings and the shoulder change need them.
 *
 * The whole profile drops by the class crossfall away from the crown, and the
 * whole layer sits at its own depth below the design elevation.
 */
export const layerTopProfile = (rc: RoadClass, layer: LayerName): SectionPoint[] => {
  const spec = layerOf(rc, layer)
  const depth = layerDepthBelowSurface(rc, layer)

  const carriageway = carriagewayHalfWidth(rc)
  const formation = formationHalfWidth(rc)
  const outer = formation + spec.widthExtension

  // Unique offsets on the right half, ascending; mirrored for the left.
  const rightOffsets = new Set<number>([0])
  for (let i = 1; i <= rc.laneCount / 2; i++) {
    rightOffsets.add(Math.min(i * rc.laneWidth, carriageway))
  }
  rightOffsets.add(carriageway)
  rightOffsets.add(outer)

  const right = [...rightOffsets].sort((a, b) => a - b)

  const pointAt = (offset: number): SectionPoint => ({
    offset,
    dz: -depth - Math.abs(offset) * rc.crossfall,
  })

  const left = right.filter((o) => o > 0).reverse().map((o) => pointAt(-o))
  return [...left, ...right.map(pointAt)]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/mesh/crossSection.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/mesh/crossSection.ts src/mesh/crossSection.test.ts
git commit -m "feat: add layered cross-section profiles with crossfall"
```

---

### Task 6: Swept ribbon mesh

Sweep a cross-section along an alignment, following the design profile vertically, and emit plain vertex and index arrays. The station range is a parameter — that is what lets a road render half-built.

**Files:**
- Create: `src/mesh/ribbon.ts`
- Test: `src/mesh/ribbon.test.ts`

**Interfaces:**
- Consumes: `Alignment` from `../geometry/alignment`; `fromAngle`, `add`, `scale` from `../geometry/vec2`; `ProfilePoint` from `../terrain/groundProfile`; `SectionPoint` from `./crossSection`
- Produces:
  - `type MeshData = { readonly positions: Float32Array; readonly normals: Float32Array; readonly uvs: Float32Array; readonly indices: Uint32Array; readonly vertexCount: number; readonly triangleCount: number }`
  - `type RibbonOptions = { readonly spacing?: number; readonly startStation?: number; readonly endStation?: number; readonly uvTileLength?: number }` — `spacing` defaults to 4 metres, `startStation` to 0, `endStation` to the alignment length, `uvTileLength` to 10 metres
  - `sweepRibbon(alignment: Alignment, design: readonly ProfilePoint[], section: readonly SectionPoint[], options?: RibbonOptions): MeshData`
  - Throws `RangeError` if the section has fewer than 2 points, if `spacing <= 0`, or if `endStation < startStation`
  - Returns an empty `MeshData` (all arrays length 0) when the requested range is degenerate — a zero-length road under construction is normal, not an error

- [ ] **Step 1: Write the failing tests**

`src/mesh/ribbon.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { sweepRibbon } from './ribbon'
import { Alignment } from '../geometry/alignment'
import { Line, Arc } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import type { ProfilePoint } from '../terrain/groundProfile'
import type { SectionPoint } from './crossSection'

/** A flat 10m-wide section: three points, no crossfall. */
const flatSection: SectionPoint[] = [
  { offset: -5, dz: 0 },
  { offset: 0, dz: 0 },
  { offset: 5, dz: 0 },
]

const straight = (length: number) => new Alignment([new Line(vec2(0, 0), 0, length)])

/** A level design profile at a constant elevation. */
const level = (length: number, z: number, step = 10): ProfilePoint[] => {
  const points: ProfilePoint[] = []
  for (let s = 0; s < length; s += step) points.push({ s, z })
  points.push({ s: length, z })
  return points
}

describe('sweepRibbon geometry', () => {
  it('emits one vertex per section point per station', () => {
    const m = sweepRibbon(straight(100), level(100, 50), flatSection, { spacing: 25 })
    // 25m spacing over 100m gives 5 stations; 3 section points each.
    expect(m.vertexCount).toBe(15)
    expect(m.positions).toHaveLength(45)
  })

  it('emits two triangles per quad', () => {
    const m = sweepRibbon(straight(100), level(100, 50), flatSection, { spacing: 25 })
    // 4 spans x 2 section gaps x 2 triangles.
    expect(m.triangleCount).toBe(16)
    expect(m.indices).toHaveLength(48)
  })

  it('places vertices at the design elevation plus the section dz', () => {
    const m = sweepRibbon(straight(100), level(100, 50), flatSection, { spacing: 50 })
    // First vertex is the left edge at station 0: x=0, y=+5 (left of +x heading), z=50.
    expect(m.positions[0]).toBeCloseTo(0, 4)
    expect(m.positions[1]).toBeCloseTo(5, 4)
    expect(m.positions[2]).toBeCloseTo(50, 4)
  })

  it('offsets transversely, perpendicular to the alignment', () => {
    const m = sweepRibbon(straight(100), level(100, 50), flatSection, { spacing: 100 })
    // Station 0 with a +x heading: left is +y, right is -y.
    expect(m.positions[1]).toBeCloseTo(5, 4)    // left edge
    expect(m.positions[7]).toBeCloseTo(-5, 4)   // right edge
  })

  it('applies section dz relative to the design elevation', () => {
    const sloped: SectionPoint[] = [
      { offset: -5, dz: -0.125 },
      { offset: 0, dz: 0 },
      { offset: 5, dz: -0.125 },
    ]
    const m = sweepRibbon(straight(100), level(100, 50), sloped, { spacing: 100 })
    expect(m.positions[2]).toBeCloseTo(49.875, 4)   // left edge is lower
    expect(m.positions[5]).toBeCloseTo(50, 4)       // crown is at design
  })

  it('follows a rising design profile', () => {
    const rising: ProfilePoint[] = [{ s: 0, z: 100 }, { s: 100, z: 110 }]
    const m = sweepRibbon(straight(100), rising, flatSection, { spacing: 50 })
    // Crown vertices are index 1, 4, 7 -> z at components 5, 14, 23.
    expect(m.positions[5]).toBeCloseTo(100, 4)
    expect(m.positions[14]).toBeCloseTo(105, 4)
    expect(m.positions[23]).toBeCloseTo(110, 4)
  })

  it('produces upward-facing normals on a level road', () => {
    const m = sweepRibbon(straight(100), level(100, 50), flatSection, { spacing: 50 })
    for (let i = 0; i < m.vertexCount; i++) {
      expect(m.normals[i * 3 + 2]).toBeGreaterThan(0.99)
    }
  })

  it('produces unit-length normals', () => {
    const curve = new Alignment([new Arc(vec2(0, 0), 0, 200, 1 / 150)])
    const m = sweepRibbon(curve, level(200, 50), flatSection, { spacing: 10 })
    for (let i = 0; i < m.vertexCount; i++) {
      const len = Math.hypot(
        m.normals[i * 3]!, m.normals[i * 3 + 1]!, m.normals[i * 3 + 2]!,
      )
      expect(len).toBeCloseTo(1, 4)
    }
  })
})

describe('sweepRibbon station range', () => {
  it('builds only the requested range', () => {
    const full = sweepRibbon(straight(100), level(100, 50), flatSection, { spacing: 25 })
    const half = sweepRibbon(straight(100), level(100, 50), flatSection, {
      spacing: 25, endStation: 50,
    })
    expect(half.vertexCount).toBeLessThan(full.vertexCount)
  })

  it('starts the range where asked', () => {
    const m = sweepRibbon(straight(100), level(100, 50), flatSection, {
      spacing: 50, startStation: 50,
    })
    // First crown vertex sits at x=50, not x=0.
    expect(m.positions[3]).toBeCloseTo(50, 4)
  })

  it('always includes the final station of the range', () => {
    const m = sweepRibbon(straight(100), level(100, 50), flatSection, {
      spacing: 30, endStation: 100,
    })
    const lastCrownX = m.positions[(m.vertexCount - 2) * 3]!
    expect(lastCrownX).toBeCloseTo(100, 4)
  })

  it('returns an empty mesh for a zero-length range', () => {
    const m = sweepRibbon(straight(100), level(100, 50), flatSection, {
      startStation: 40, endStation: 40,
    })
    expect(m.vertexCount).toBe(0)
    expect(m.triangleCount).toBe(0)
    expect(m.positions).toHaveLength(0)
    expect(m.indices).toHaveLength(0)
  })

  it('clamps a range beyond the alignment', () => {
    const m = sweepRibbon(straight(100), level(100, 50), flatSection, {
      spacing: 50, endStation: 999,
    })
    const lastCrownX = m.positions[(m.vertexCount - 2) * 3]!
    expect(lastCrownX).toBeCloseTo(100, 4)
  })
})

describe('sweepRibbon validation', () => {
  it('rejects a section with fewer than two points', () => {
    expect(() => sweepRibbon(straight(100), level(100, 50), [{ offset: 0, dz: 0 }]))
      .toThrow(RangeError)
  })

  it('rejects non-positive spacing', () => {
    expect(() => sweepRibbon(straight(100), level(100, 50), flatSection, { spacing: 0 }))
      .toThrow(RangeError)
  })

  it('rejects an inverted station range', () => {
    expect(() => sweepRibbon(straight(100), level(100, 50), flatSection, {
      startStation: 80, endStation: 20,
    })).toThrow(RangeError)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/mesh/ribbon.test.ts
```

Expected: FAIL — `Failed to resolve import "./ribbon"`.

- [ ] **Step 3: Write the implementation**

`src/mesh/ribbon.ts`:

```ts
import type { Alignment } from '../geometry/alignment'
import { fromAngle, add, scale } from '../geometry/vec2'
import type { ProfilePoint } from '../terrain/groundProfile'
import type { SectionPoint } from './crossSection'

/**
 * Renderer-agnostic mesh attributes.
 *
 * Plain typed arrays rather than a three.js BufferGeometry, so mesh generation
 * stays unit-testable without a WebGL context. `src/render/` wraps these.
 */
export type MeshData = {
  /** xyz per vertex. */
  readonly positions: Float32Array
  /** xyz per vertex, unit length. */
  readonly normals: Float32Array
  /** uv per vertex. */
  readonly uvs: Float32Array
  readonly indices: Uint32Array
  readonly vertexCount: number
  readonly triangleCount: number
}

export type RibbonOptions = {
  /** Longitudinal sample spacing, metres. Default 4. */
  readonly spacing?: number
  /** Where to start building, metres along the alignment. Default 0. */
  readonly startStation?: number
  /** Where to stop. Default the alignment length. This is what renders a road mid-construction. */
  readonly endStation?: number
  /** Metres of road per V tile, so markings repeat at real-world scale. Default 10. */
  readonly uvTileLength?: number
}

const EMPTY: MeshData = {
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  uvs: new Float32Array(0),
  indices: new Uint32Array(0),
  vertexCount: 0,
  triangleCount: 0,
}

/** Linear interpolation of a design profile at an arbitrary station. */
const designElevationAt = (design: readonly ProfilePoint[], s: number): number => {
  if (design.length === 0) return 0
  const first = design[0]!
  const last = design[design.length - 1]!
  if (s <= first.s) return first.z
  if (s >= last.s) return last.z

  for (let i = 1; i < design.length; i++) {
    const a = design[i - 1]!
    const b = design[i]!
    if (s <= b.s) {
      const span = b.s - a.s
      const t = span === 0 ? 0 : (s - a.s) / span
      return a.z + (b.z - a.z) * t
    }
  }
  return last.z
}

/**
 * Sweep a cross-section along an alignment into a triangle mesh.
 *
 * Stations are computed as `start + i * spacing` rather than accumulated, so
 * they cannot drift, and the final station of the range is always included.
 * V coordinates run on **arc length**, not vertex index, so lane markings
 * keep their real-world spacing through a curve instead of stretching.
 */
export const sweepRibbon = (
  alignment: Alignment,
  design: readonly ProfilePoint[],
  section: readonly SectionPoint[],
  options: RibbonOptions = {},
): MeshData => {
  const {
    spacing = 4,
    startStation = 0,
    endStation = alignment.length,
    uvTileLength = 10,
  } = options

  if (section.length < 2) {
    throw new RangeError('a cross-section needs at least two points')
  }
  if (spacing <= 0) {
    throw new RangeError('spacing must be positive')
  }
  if (endStation < startStation) {
    throw new RangeError('endStation must not be less than startStation')
  }
  if (uvTileLength <= 0) {
    throw new RangeError('uvTileLength must be positive')
  }
  if (alignment.isEmpty) return EMPTY

  const from = Math.max(0, Math.min(startStation, alignment.length))
  const to = Math.max(0, Math.min(endStation, alignment.length))
  const span = to - from
  if (span <= 0) return EMPTY

  // Stations across the range, always including the last.
  const stations: number[] = []
  const steps = Math.floor(span / spacing)
  for (let i = 0; i <= steps; i++) stations.push(from + i * spacing)
  const lastStation = stations[stations.length - 1]!
  if (lastStation < to) stations.push(to)
  if (stations.length < 2) return EMPTY

  const across = section.length
  const vertexCount = stations.length * across
  const triangleCount = (stations.length - 1) * (across - 1) * 2

  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  const indices = new Uint32Array(triangleCount * 3)

  const outerOffset = Math.abs(section[across - 1]!.offset)
  const halfWidth = outerOffset === 0 ? 1 : outerOffset

  let v = 0
  for (const s of stations) {
    const pose = alignment.poseAt(s)
    // Left of the direction of travel.
    const normal = fromAngle(pose.heading + Math.PI / 2)
    const designZ = designElevationAt(design, s)

    for (let j = 0; j < across; j++) {
      const point = section[j]!
      // `normal` points LEFT of travel, but SectionPoint.offset is negative to
      // the left (positive-is-right, the CAD convention). So the offset must be
      // negated to land on the correct side. Getting this wrong mirrors the
      // section, which is invisible on a symmetric road and silently swaps
      // lane sides the moment anything is asymmetric.
      const p = add(pose.position, scale(normal, -point.offset))

      positions[v * 3] = p.x
      positions[v * 3 + 1] = p.y
      positions[v * 3 + 2] = designZ + point.dz

      // U runs across the road, V along it by arc length so markings tile
      // at a real-world rate regardless of curvature.
      uvs[v * 2] = (point.offset + halfWidth) / (2 * halfWidth)
      uvs[v * 2 + 1] = s / uvTileLength

      v++
    }
  }

  // Normals from the cross-product of the along and across tangents, computed
  // by finite difference over the neighbouring vertices.
  const nAt = (row: number, col: number) => (row * across + col) * 3
  for (let row = 0; row < stations.length; row++) {
    for (let col = 0; col < across; col++) {
      const rowPrev = Math.max(0, row - 1)
      const rowNext = Math.min(stations.length - 1, row + 1)
      const colPrev = Math.max(0, col - 1)
      const colNext = Math.min(across - 1, col + 1)

      const a = nAt(rowNext, col)
      const b = nAt(rowPrev, col)
      const c = nAt(row, colNext)
      const d = nAt(row, colPrev)

      const alongX = positions[a]! - positions[b]!
      const alongY = positions[a + 1]! - positions[b + 1]!
      const alongZ = positions[a + 2]! - positions[b + 2]!

      const acrossX = positions[c]! - positions[d]!
      const acrossY = positions[c + 1]! - positions[d + 1]!
      const acrossZ = positions[c + 2]! - positions[d + 2]!

      // across x along, which points up for a left-handed transverse axis.
      let nx = acrossY * alongZ - acrossZ * alongY
      let ny = acrossZ * alongX - acrossX * alongZ
      let nz = acrossX * alongY - acrossY * alongX

      const len = Math.hypot(nx, ny, nz)
      if (len > 0) {
        nx /= len
        ny /= len
        nz /= len
      } else {
        nx = 0
        ny = 0
        nz = 1
      }

      const o = nAt(row, col)
      normals[o] = nx
      normals[o + 1] = ny
      normals[o + 2] = nz
    }
  }

  let t = 0
  for (let row = 0; row < stations.length - 1; row++) {
    for (let col = 0; col < across - 1; col++) {
      const topLeft = row * across + col
      const topRight = topLeft + 1
      const bottomLeft = topLeft + across
      const bottomRight = bottomLeft + 1

      indices[t++] = topLeft
      indices[t++] = bottomLeft
      indices[t++] = topRight

      indices[t++] = topRight
      indices[t++] = bottomLeft
      indices[t++] = bottomRight
    }
  }

  return { positions, normals, uvs, indices, vertexCount, triangleCount }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/mesh/ribbon.test.ts
```

Expected: PASS, 16 tests.

If the "upward-facing normals" test fails with negative `z`, the cross-product operand order is reversed — swap `across` and `along` in the three component expressions rather than negating the result, so the reason stays legible.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/mesh/ribbon.ts src/mesh/ribbon.test.ts
git commit -m "feat: sweep cross-sections into layered ribbon meshes"
```

---

### Task 7: Build a road's full layer stack

Assemble the three layers of a road into a set of meshes, each with its own station range, so a road under construction shows subgrade further along than base and base further along than seal.

**Files:**
- Create: `src/mesh/roadMesh.ts`
- Test: `src/mesh/roadMesh.test.ts`

**Interfaces:**
- Consumes: `Alignment`; `ProfilePoint`; `RoadClass`, `LayerName` from `./roadClass`; `layerTopProfile` from `./crossSection`; `sweepRibbon`, `MeshData`, `RibbonOptions` from `./ribbon`
- Produces:
  - `type LayerStations = Readonly<Partial<Record<LayerName, number>>>` — how far each layer has been built, metres. A missing layer means not started.
  - `type RoadMesh = { readonly layers: readonly { readonly name: LayerName; readonly mesh: MeshData }[] }`
  - `buildRoadMesh(alignment, design, roadClass, stations?, options?): RoadMesh` — omit `stations` for a finished road (every layer full length)
  - Layers are returned bottom-up, matching `RoadClass.layers`
  - A layer whose station is `0` or missing yields an empty `MeshData`, not an omitted entry — consumers can rely on all three being present

- [ ] **Step 1: Write the failing tests**

`src/mesh/roadMesh.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildRoadMesh } from './roadMesh'
import { ROAD_CLASSES } from './roadClass'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import type { ProfilePoint } from '../terrain/groundProfile'

const road = (length: number) => new Alignment([new Line(vec2(0, 0), 0, length)])
const level = (length: number, z: number): ProfilePoint[] => [{ s: 0, z }, { s: length, z }]
const rural = ROAD_CLASSES.rural

describe('buildRoadMesh', () => {
  it('returns all three layers bottom-up', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural)
    expect(m.layers.map((l) => l.name)).toEqual(['subgrade', 'base', 'wearing'])
  })

  it('builds every layer full length when no stations are given', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural, undefined, { spacing: 50 })
    for (const layer of m.layers) {
      expect(layer.mesh.vertexCount).toBeGreaterThan(0)
    }
  })

  it('builds lower layers further along than upper ones', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural,
      { subgrade: 200, base: 120, wearing: 40 }, { spacing: 20 })
    const count = (name: string) =>
      m.layers.find((l) => l.name === name)!.mesh.vertexCount
    expect(count('subgrade')).toBeGreaterThan(count('base'))
    expect(count('base')).toBeGreaterThan(count('wearing'))
  })

  it('yields an empty mesh for a layer not yet started', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural,
      { subgrade: 100 }, { spacing: 20 })
    expect(m.layers.find((l) => l.name === 'subgrade')!.mesh.vertexCount).toBeGreaterThan(0)
    expect(m.layers.find((l) => l.name === 'base')!.mesh.vertexCount).toBe(0)
    expect(m.layers.find((l) => l.name === 'wearing')!.mesh.vertexCount).toBe(0)
  })

  it('still returns all three entries when only one has been built', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural, { subgrade: 100 })
    expect(m.layers).toHaveLength(3)
  })

  it('places lower layers below upper ones in the mesh', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural, undefined, { spacing: 100 })
    const crownZ = (name: string) => {
      const mesh = m.layers.find((l) => l.name === name)!.mesh
      // The crown is the section point at offset 0; find the highest z.
      let highest = -Infinity
      for (let i = 0; i < mesh.vertexCount; i++) {
        const z = mesh.positions[i * 3 + 2]!
        if (z > highest) highest = z
      }
      return highest
    }
    expect(crownZ('wearing')).toBeGreaterThan(crownZ('base'))
    expect(crownZ('base')).toBeGreaterThan(crownZ('subgrade'))
  })

  it('builds wider meshes for lower layers', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural, undefined, { spacing: 100 })
    const widest = (name: string) => {
      const mesh = m.layers.find((l) => l.name === name)!.mesh
      let w = 0
      for (let i = 0; i < mesh.vertexCount; i++) {
        w = Math.max(w, Math.abs(mesh.positions[i * 3 + 1]!))
      }
      return w
    }
    expect(widest('subgrade')).toBeGreaterThan(widest('base'))
    expect(widest('base')).toBeGreaterThan(widest('wearing'))
  })

  it('clamps a station beyond the alignment length', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural,
      { subgrade: 9999, base: 9999, wearing: 9999 }, { spacing: 50 })
    const full = buildRoadMesh(road(200), level(200, 50), rural, undefined, { spacing: 50 })
    expect(m.layers[0]!.mesh.vertexCount).toBe(full.layers[0]!.mesh.vertexCount)
  })

  it('works for every road class', () => {
    for (const name of ['gravel', 'rural', 'arterial', 'highway'] as const) {
      const m = buildRoadMesh(road(200), level(200, 50), ROAD_CLASSES[name])
      expect(m.layers).toHaveLength(3)
      for (const layer of m.layers) expect(layer.mesh.triangleCount).toBeGreaterThan(0)
    }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/mesh/roadMesh.test.ts
```

Expected: FAIL — `Failed to resolve import "./roadMesh"`.

- [ ] **Step 3: Write the implementation**

`src/mesh/roadMesh.ts`:

```ts
import type { Alignment } from '../geometry/alignment'
import type { ProfilePoint } from '../terrain/groundProfile'
import type { RoadClass, LayerName } from './roadClass'
import { layerTopProfile } from './crossSection'
import { sweepRibbon, type MeshData, type RibbonOptions } from './ribbon'

/**
 * How far each pavement layer has been built, metres along the alignment.
 *
 * A missing layer has not been started. These are the construction stations
 * from the construction spec — subgrade runs ahead of base, base ahead of
 * seal — and rendering each layer only to its own station is what makes a
 * road visibly half-built.
 */
export type LayerStations = Readonly<Partial<Record<LayerName, number>>>

export type RoadMesh = {
  /** Bottom-up, matching the road class's own layer order. */
  readonly layers: readonly { readonly name: LayerName; readonly mesh: MeshData }[]
}

/**
 * Build every pavement layer of a road.
 *
 * Omit `stations` for a finished road. All three layers are always present in
 * the result even when a layer has no geometry yet, so a consumer can hold a
 * stable set of meshes and simply see one of them go from empty to populated.
 */
export const buildRoadMesh = (
  alignment: Alignment,
  design: readonly ProfilePoint[],
  roadClass: RoadClass,
  stations?: LayerStations,
  options: RibbonOptions = {},
): RoadMesh => {
  const layers = roadClass.layers.map((spec) => {
    const endStation = stations === undefined
      ? alignment.length
      : stations[spec.name] ?? 0

    const section = layerTopProfile(roadClass, spec.name)
    const mesh = sweepRibbon(alignment, design, section, {
      ...options,
      startStation: 0,
      endStation,
    })

    return { name: spec.name, mesh }
  })

  return { layers }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/mesh/roadMesh.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/mesh/roadMesh.ts src/mesh/roadMesh.test.ts
git commit -m "feat: assemble road layer stacks with per-layer stations"
```

---

### Task 8: three.js adapter and the first 3D view

Wrap `MeshData` into `BufferGeometry` and put a real road on screen, over real terrain, at a partly-built state so the layering is visible.

This is the first task in the project to use three.js, and the first to show the game rather than a diagram.

**Files:**
- Create: `src/render/meshAdapter.ts`, `src/render/terrainMesh.ts`, `src/debug/roadScene.ts`
- Test: `src/render/meshAdapter.test.ts`
- Modify: `src/main.ts` (replace entirely)

**Interfaces:**
- Consumes: `MeshData` from `../mesh/ribbon`; `TerrainSampler`, `Heightmap` from `../terrain/heightmap`
- Produces:
  - `toBufferGeometry(mesh: MeshData): THREE.BufferGeometry` — converts plan coordinates to three's `+Y`-up convention as `(x, y, z) → (x, z, −y)`
  - `terrainGeometry(terrain: Heightmap, step?: number): THREE.BufferGeometry`
  - `drawRoadScene(canvas: HTMLCanvasElement): () => void` — returns a dispose function

**On testing:** `meshAdapter.test.ts` is a real unit test — it asserts the coordinate conversion, which is exactly the sort of thing that is silently wrong forever. `roadScene.ts` and `terrainMesh.ts` are deliberately untested, the same approved decision as the earlier debug views: what they add is a picture, and only a human looking at it can tell whether it is right.

- [ ] **Step 1: Write the failing adapter test**

`src/render/meshAdapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { toBufferGeometry } from './meshAdapter'
import type { MeshData } from '../mesh/ribbon'

const mesh = (): MeshData => ({
  positions: new Float32Array([1, 2, 3, 4, 5, 6]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 0, 1, 1]),
  indices: new Uint32Array([0, 1, 0]),
  vertexCount: 2,
  triangleCount: 1,
})

describe('toBufferGeometry', () => {
  it('maps plan (x, y, z) to three (x, z, -y)', () => {
    const g = toBufferGeometry(mesh())
    const p = g.getAttribute('position').array
    // (1, 2, 3) -> (1, 3, -2)
    expect(p[0]).toBeCloseTo(1, 5)
    expect(p[1]).toBeCloseTo(3, 5)
    expect(p[2]).toBeCloseTo(-2, 5)
    // (4, 5, 6) -> (4, 6, -5)
    expect(p[3]).toBeCloseTo(4, 5)
    expect(p[4]).toBeCloseTo(6, 5)
    expect(p[5]).toBeCloseTo(-5, 5)
  })

  it('applies the same mapping to normals', () => {
    const g = toBufferGeometry(mesh())
    const n = g.getAttribute('normal').array
    // Plan-up (0, 0, 1) becomes three-up (0, 1, 0).
    expect(n[0]).toBeCloseTo(0, 5)
    expect(n[1]).toBeCloseTo(1, 5)
    expect(n[2]).toBeCloseTo(0, 5)
  })

  it('carries uvs through unchanged', () => {
    const g = toBufferGeometry(mesh())
    const uv = g.getAttribute('uv').array
    expect(Array.from(uv)).toEqual([0, 0, 1, 1])
  })

  it('carries indices through unchanged', () => {
    const g = toBufferGeometry(mesh())
    expect(Array.from(g.getIndex()!.array)).toEqual([0, 1, 0])
  })

  it('handles an empty mesh without throwing', () => {
    const empty: MeshData = {
      positions: new Float32Array(0), normals: new Float32Array(0),
      uvs: new Float32Array(0), indices: new Uint32Array(0),
      vertexCount: 0, triangleCount: 0,
    }
    const g = toBufferGeometry(empty)
    expect(g.getAttribute('position').count).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- src/render/meshAdapter.test.ts
```

Expected: FAIL — `Failed to resolve import "./meshAdapter"`.

- [ ] **Step 3: Write the adapter**

`src/render/meshAdapter.ts`:

```ts
import * as THREE from 'three'
import type { MeshData } from '../mesh/ribbon'

/**
 * Wrap renderer-agnostic mesh data as a three.js geometry.
 *
 * This is the single place the handedness conversion happens. The game's plan
 * coordinates are `(x, y)` with `y` north and `z` up; three.js wants `+Y` up.
 * The mapping is `(x, y, z) -> (x, z, -y)`, which preserves winding order and
 * therefore face orientation. Nothing upstream of this file knows three.js
 * exists, and nothing downstream should re-apply the conversion.
 */
export const toBufferGeometry = (mesh: MeshData): THREE.BufferGeometry => {
  const geometry = new THREE.BufferGeometry()

  const positions = new Float32Array(mesh.vertexCount * 3)
  const normals = new Float32Array(mesh.vertexCount * 3)

  for (let i = 0; i < mesh.vertexCount; i++) {
    positions[i * 3] = mesh.positions[i * 3]!
    positions[i * 3 + 1] = mesh.positions[i * 3 + 2]!
    positions[i * 3 + 2] = -mesh.positions[i * 3 + 1]!

    normals[i * 3] = mesh.normals[i * 3]!
    normals[i * 3 + 1] = mesh.normals[i * 3 + 2]!
    normals[i * 3 + 2] = -mesh.normals[i * 3 + 1]!
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(mesh.uvs), 2))
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1))

  return geometry
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- src/render/meshAdapter.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Write the terrain geometry helper**

`src/render/terrainMesh.ts`:

```ts
import * as THREE from 'three'
import type { Heightmap } from '../terrain/heightmap'

/**
 * A three.js geometry for a heightmap.
 *
 * `step` skips grid points to keep the vertex count sane on a large map; a
 * step of 2 samples every other row and column. Deliberately simple — proper
 * terrain LOD belongs with the renderer work, not here.
 */
export const terrainGeometry = (
  terrain: Heightmap,
  step: number = 1,
): THREE.BufferGeometry => {
  if (step < 1 || !Number.isInteger(step)) {
    throw new RangeError('step must be a positive integer')
  }

  const cols = Math.floor((terrain.cols - 1) / step) + 1
  const rows = Math.floor((terrain.rows - 1) / step) + 1

  const positions = new Float32Array(cols * rows * 3)
  const indices: number[] = []

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const gx = terrain.originX + c * step * terrain.cellSize
      const gy = terrain.originY + r * step * terrain.cellSize
      const z = terrain.sample(gx, gy)

      const i = (r * cols + c) * 3
      positions[i] = gx
      positions[i + 1] = z
      positions[i + 2] = -gy
    }
  }

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c
      const b = a + 1
      const d = a + cols
      const e = d + 1
      indices.push(a, d, b, b, d, e)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}
```

- [ ] **Step 6: Write the scene**

`src/debug/roadScene.ts`:

```ts
import * as THREE from 'three'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { filletCorner } from '../geometry/fillet'
import { vec2, angleOf, sub, distance, type Vec2 } from '../geometry/vec2'
import { generateValley } from '../terrain/generate'
import { sampleGroundProfile } from '../terrain/groundProfile'
import { solveGradeProfile } from '../terrain/gradeSolver'
import { ROAD_CLASSES } from '../mesh/roadClass'
import { buildRoadMesh } from '../mesh/roadMesh'
import { toBufferGeometry } from '../render/meshAdapter'
import { terrainGeometry } from '../render/terrainMesh'

const CURVE_RADIUS = 400
const MAX_GRADE = 0.07
const MAX_CUT_DEPTH = 12
const MAX_FILL_HEIGHT = 10

/** Layer colours: dark earth, grey aggregate, near-black asphalt. */
const LAYER_COLOURS: Record<string, number> = {
  subgrade: 0x6b5c48,
  base: 0x8a8a86,
  wearing: 0x2e3033,
}

const buildAlignment = (a: Vec2, corner: Vec2, b: Vec2): Alignment | null => {
  const dIn = sub(corner, a)
  const dOut = sub(b, corner)
  const fillet = filletCorner(corner, dIn, dOut, CURVE_RADIUS)
  if (!fillet) return null
  const inLength = distance(a, fillet.tangentIn)
  const outLength = distance(fillet.tangentOut, b)
  if (inLength <= 0 || outLength <= 0) return null
  return new Alignment([
    new Line(a, angleOf(dIn), inLength),
    fillet.arc,
    new Line(fillet.tangentOut, angleOf(dOut), outLength),
  ])
}

export const drawRoadScene = (canvas: HTMLCanvasElement): (() => void) => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setClearColor(0x14181d)

  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog(0x14181d, 1200, 3200)

  const camera = new THREE.PerspectiveCamera(45, 1, 1, 6000)

  scene.add(new THREE.HemisphereLight(0xbdd7ff, 0x3a3227, 1.1))
  const sun = new THREE.DirectionalLight(0xfff2d8, 2.2)
  sun.position.set(-600, 900, 400)
  scene.add(sun)

  const terrain = generateValley({
    cols: 129, rows: 129, cellSize: 20,
    floorElevation: 100, ridgeHeight: 70, valleyHalfWidth: 400, seed: 7,
  })

  scene.add(new THREE.Mesh(
    terrainGeometry(terrain, 1),
    new THREE.MeshStandardMaterial({ color: 0x5e6b4a, roughness: 0.95, flatShading: false }),
  ))

  const alignment = buildAlignment(vec2(200, 1300), vec2(1400, 1200), vec2(2400, 1340))

  if (alignment) {
    const ground = sampleGroundProfile(alignment, terrain, 10)
    const solution = solveGradeProfile(ground, {
      maxGrade: MAX_GRADE,
      maxCutDepth: MAX_CUT_DEPTH,
      maxFillHeight: MAX_FILL_HEIGHT,
    })

    if (solution.feasible) {
      // Deliberately part-built, so all three layers are visible at once.
      const total = alignment.length
      const road = buildRoadMesh(
        alignment, solution.profile, ROAD_CLASSES.rural,
        { subgrade: total, base: total * 0.72, wearing: total * 0.45 },
        { spacing: 4 },
      )

      for (const layer of road.layers) {
        if (layer.mesh.vertexCount === 0) continue
        scene.add(new THREE.Mesh(
          toBufferGeometry(layer.mesh),
          new THREE.MeshStandardMaterial({
            color: LAYER_COLOURS[layer.name] ?? 0x888888,
            roughness: 0.9,
            side: THREE.DoubleSide,
          }),
        ))
      }
    }
  }

  // Look along the road from above and behind its start.
  camera.position.set(-200, 420, -700)
  camera.lookAt(1300, 110, -1280)

  const resize = () => {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  resize()
  window.addEventListener('resize', resize)

  let frame = 0
  const tick = () => {
    frame = requestAnimationFrame(tick)
    renderer.render(scene, camera)
  }
  tick()

  return () => {
    cancelAnimationFrame(frame)
    window.removeEventListener('resize', resize)
    renderer.dispose()
  }
}
```

- [ ] **Step 7: Wire it into the page**

Replace `src/main.ts` entirely:

```ts
import { drawRoadScene } from './debug/roadScene'

const app = document.getElementById('app')

if (app) {
  const canvas = document.createElement('canvas')
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'
  app.appendChild(canvas)
  drawRoadScene(canvas)
}
```

Leave `src/debug/longSectionPreview.ts` in place — it is still the clearest view of the earthworks chain and a later task may add a switcher.

- [ ] **Step 8: Verify the typecheck and build**

```bash
npm run build
```

Expected: no TypeScript errors. Note the bundle grows substantially — this is the first code to pull in three.js.

- [ ] **Step 9: Run the full test suite**

```bash
npm test
```

Expected: PASS, 267 tests across 18 files — 180 from earlier plans, plus 13 station/primitiveAt, 9 continuity, 11 structure allowance, 12 road class, 12 cross-section, 16 ribbon, 9 road mesh, 5 mesh adapter.

- [ ] **Step 10: Commit and push**

```bash
git add -A
git commit -m "feat: render layered road meshes in 3D over terrain"
git push
```

- [ ] **Step 11: Hand off for visual inspection**

Do not attempt the visual check yourself. Report that it is deployed and ready, and note anything that might affect it.

What the reviewer will check:

- A road is visible lying on the terrain, following the valley, curving at the fillet.
- **Three distinct layers are visible where they end**, stepping down and outward: dark earth subgrade running furthest, grey base course stopping short of it, near-black seal stopping shortest. If they all end together, the per-layer stations are not being applied.
- Lower layers are visibly **wider** as well as lower, so each layer's edge is a visible step rather than a coincident line.
- The road sits *on* the ground rather than floating above it or sunk into it. Floating means the design profile and the mesh disagree about elevation.
- The road is not inside-out or invisible from above — that would mean a winding or normal error in the adapter.

---

## Plan complete

At the end of this plan there is a road on screen: layered, part-built, lying on real terrain, with a vertical alignment that respects grade.

### Deliberately not in this plan

**Junctions.** Where two ribbons meet, both must be trimmed back and a junction polygon generated. It is the highest-risk geometry in the project and deserves its own plan and its own reviewer gate.

**The road network graph.** Nothing yet knows that two roads are connected. Junctions need it, and so do overpasses, which have to know what they cross.

**Bridges, overpasses and retaining walls.** Task 3 delivers the *trigger* — `classifySupport` marks which stations need a structure — but generating deck, piers and abutments is its own plan. Retaining wall position and height already come from `retainingWall()` in the terrain layer, awaiting geometry.

**Materials and lighting.** The scene uses flat `MeshStandardMaterial` colours to make the layering legible. The tilt-shift diorama look, road markings, and the post chain are the next plan.

**Next plan:** Network graph and junctions.
