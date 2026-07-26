# Chainage — Terrain & Earthworks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give roads a vertical dimension — sample terrain under an alignment, solve a feasible vertical profile that respects maximum grade, compute the earthwork corridor and its cut and fill volumes, and deform terrain non-destructively.

**Architecture:** `src/terrain/` is pure logic over numbers, depending only on `src/geometry/`. The chain is linear: heightmap → ground profile along an alignment → grade-feasible design profile → corridor cross-sections → cut and fill volumes → non-destructive edit layer. Each link is independently testable with no rendering.

**Tech Stack:** TypeScript (strict), Vitest. No three.js in this plan.

## Global Constraints

- **`src/terrain/` may import from `src/geometry/` only.** No three.js, no DOM APIs, no other `src/` directories. The dependency direction is one-way and must not be inverted.
- **Coordinates:** `(x, y)` in metres, `y` north — the plan-view plane. **`z` is elevation in metres, positive up.** Elevation is a separate profile and is never part of plan geometry.
- **Grades** are expressed as a **dimensionless rise-over-run fraction**, not a percentage. A 7% grade is `0.07`. Convert only at the display boundary.
- **Side slopes** are expressed as **horizontal-to-vertical ratio** (`2` means 2H:1V, the civil convention). Steeper slopes have smaller numbers.
- **Volumes** are in cubic metres, **areas** in square metres, computed as *bank measure* (in-place, no swell factor).
- **TypeScript:** `strict: true`, `noUncheckedIndexedAccess: true`.
- **Float comparison in tests:** `toBeCloseTo` precision 9 for exact-form math, precision 4 for numerically-integrated or sampled results.
- **Commits:** conventional commit prefixes.

## Existing interfaces this plan builds on

From `src/geometry/`, complete and merged:

```ts
// vec2.ts
type Vec2 = { readonly x: number; readonly y: number }
const vec2: (x: number, y: number) => Vec2
const add:  (a: Vec2, b: Vec2) => Vec2
const sub:  (a: Vec2, b: Vec2) => Vec2
const scale: (a: Vec2, k: number) => Vec2
const fromAngle: (radians: number) => Vec2
const normalizeAngle: (radians: number) => number

// primitives.ts
type Pose = { readonly position: Vec2; readonly heading: number; readonly curvature: number }
interface Primitive { readonly length: number; poseAt(s: number): Pose }
const clamp: (s: number, length: number) => number   // exported during final cleanup
class Line implements Primitive { constructor(start: Vec2, heading: number, length: number) }
class Arc  implements Primitive { constructor(start: Vec2, heading: number, length: number, curvature: number) }

// spiral.ts
class Spiral implements Primitive {
  constructor(start: Vec2, heading: number, length: number, startCurvature: number, endCurvature: number)
}

// alignment.ts
class Alignment {
  constructor(primitives: readonly Primitive[])
  readonly length: number
  get isEmpty(): boolean
  poseAt(s: number): Pose      // clamps s into [0, length]
  sample(spacing: number): Pose[]   // includes both endpoints
}
```

**Known limitation to work around:** `Pose` does not carry its own station `s`. Where a task needs station alongside pose, compute it from the sample index rather than expecting it on the pose. Adding `s` to `Pose` is scheduled as the first task of the mesh plan.

---

### Task 1: Heightmap

A regular grid of elevations with bilinear sampling between grid points.

**Files:**
- Create: `src/terrain/heightmap.ts`
- Test: `src/terrain/heightmap.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `class Heightmap`
    - `constructor(originX: number, originY: number, cellSize: number, cols: number, rows: number, elevations: Float32Array)` — throws `RangeError` if `cellSize <= 0`, if `cols < 2` or `rows < 2`, or if `elevations.length !== cols * rows`
    - `readonly originX, originY, cellSize, cols, rows: number`
    - `get width(): number` — `(cols - 1) * cellSize`
    - `get height(): number` — `(rows - 1) * cellSize`
    - `elevationAtIndex(col: number, row: number): number` — throws `RangeError` if out of range
    - `sample(x: number, y: number): number` — bilinear; clamps to the grid edge outside bounds
    - `static flat(originX, originY, cellSize, cols, rows, elevation): Heightmap`

- [ ] **Step 1: Write the failing tests**

`src/terrain/heightmap.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Heightmap } from './heightmap'

/** 3x3 grid, 10m cells, origin at (0,0). Elevation ramps with x only: 0, 10, 20. */
const rampX = () => {
  const e = new Float32Array([
    0, 10, 20,
    0, 10, 20,
    0, 10, 20,
  ])
  return new Heightmap(0, 0, 10, 3, 3, e)
}

describe('Heightmap construction', () => {
  it('reports its extent', () => {
    const h = rampX()
    expect(h.width).toBe(20)
    expect(h.height).toBe(20)
  })

  it('reads grid values by index', () => {
    const h = rampX()
    expect(h.elevationAtIndex(0, 0)).toBe(0)
    expect(h.elevationAtIndex(1, 0)).toBe(10)
    expect(h.elevationAtIndex(2, 2)).toBe(20)
  })

  it('rejects invalid dimensions', () => {
    const e = new Float32Array(9)
    expect(() => new Heightmap(0, 0, 0, 3, 3, e)).toThrow(RangeError)
    expect(() => new Heightmap(0, 0, 10, 1, 3, e)).toThrow(RangeError)
    expect(() => new Heightmap(0, 0, 10, 3, 3, new Float32Array(8))).toThrow(RangeError)
  })

  it('rejects out-of-range indices', () => {
    const h = rampX()
    expect(() => h.elevationAtIndex(-1, 0)).toThrow(RangeError)
    expect(() => h.elevationAtIndex(3, 0)).toThrow(RangeError)
    expect(() => h.elevationAtIndex(0, 3)).toThrow(RangeError)
  })

  it('builds a flat heightmap', () => {
    const h = Heightmap.flat(0, 0, 5, 4, 4, 42)
    expect(h.sample(7, 7)).toBeCloseTo(42, 9)
  })
})

describe('Heightmap sampling', () => {
  it('returns exact values at grid points', () => {
    const h = rampX()
    expect(h.sample(0, 0)).toBeCloseTo(0, 9)
    expect(h.sample(10, 0)).toBeCloseTo(10, 9)
    expect(h.sample(20, 20)).toBeCloseTo(20, 9)
  })

  it('interpolates linearly between grid points', () => {
    const h = rampX()
    expect(h.sample(5, 0)).toBeCloseTo(5, 9)
    expect(h.sample(15, 12)).toBeCloseTo(15, 9)
  })

  it('interpolates bilinearly in both axes', () => {
    // Corner values 0,10 / 20,30 over one 10m cell.
    const e = new Float32Array([0, 10, 20, 30])
    const h = new Heightmap(0, 0, 10, 2, 2, e)
    expect(h.sample(5, 5)).toBeCloseTo(15, 9)
    expect(h.sample(0, 10)).toBeCloseTo(20, 9)
    expect(h.sample(10, 10)).toBeCloseTo(30, 9)
  })

  it('respects a non-zero origin', () => {
    const e = new Float32Array([0, 10, 20, 30])
    const h = new Heightmap(100, 200, 10, 2, 2, e)
    expect(h.sample(100, 200)).toBeCloseTo(0, 9)
    expect(h.sample(105, 205)).toBeCloseTo(15, 9)
  })

  it('clamps to the edge outside its bounds', () => {
    const h = rampX()
    expect(h.sample(-50, 0)).toBeCloseTo(0, 9)
    expect(h.sample(999, 0)).toBeCloseTo(20, 9)
    expect(h.sample(10, -999)).toBeCloseTo(10, 9)
    expect(h.sample(10, 999)).toBeCloseTo(10, 9)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/terrain/heightmap.test.ts
```

Expected: FAIL — `Failed to resolve import "./heightmap"`.

- [ ] **Step 3: Write the implementation**

`src/terrain/heightmap.ts`:

```ts
/**
 * A regular grid of ground elevations.
 *
 * Grid point (col, row) sits at world position
 *   (originX + col * cellSize, originY + row * cellSize)
 * and `elevations` is row-major: index = row * cols + col.
 *
 * Sampling between grid points is bilinear. Sampling outside the grid clamps
 * to the nearest edge rather than throwing, so an alignment that strays past
 * the map still yields a usable ground profile.
 */
export class Heightmap {
  constructor(
    readonly originX: number,
    readonly originY: number,
    readonly cellSize: number,
    readonly cols: number,
    readonly rows: number,
    readonly elevations: Float32Array,
  ) {
    if (cellSize <= 0) {
      throw new RangeError('cellSize must be positive')
    }
    if (cols < 2 || rows < 2) {
      throw new RangeError('heightmap must be at least 2x2')
    }
    if (elevations.length !== cols * rows) {
      throw new RangeError(
        `elevations length ${elevations.length} does not match ${cols}x${rows}`,
      )
    }
  }

  get width(): number {
    return (this.cols - 1) * this.cellSize
  }

  get height(): number {
    return (this.rows - 1) * this.cellSize
  }

  elevationAtIndex(col: number, row: number): number {
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) {
      throw new RangeError(`grid index (${col}, ${row}) out of range`)
    }
    return this.elevations[row * this.cols + col]!
  }

  sample(x: number, y: number): number {
    // Continuous grid coordinates, clamped so we never index outside.
    const gx = clampNumber((x - this.originX) / this.cellSize, 0, this.cols - 1)
    const gy = clampNumber((y - this.originY) / this.cellSize, 0, this.rows - 1)

    const col0 = Math.min(Math.floor(gx), this.cols - 2)
    const row0 = Math.min(Math.floor(gy), this.rows - 2)
    const tx = gx - col0
    const ty = gy - row0

    const z00 = this.elevationAtIndex(col0, row0)
    const z10 = this.elevationAtIndex(col0 + 1, row0)
    const z01 = this.elevationAtIndex(col0, row0 + 1)
    const z11 = this.elevationAtIndex(col0 + 1, row0 + 1)

    const bottom = z00 + (z10 - z00) * tx
    const top = z01 + (z11 - z01) * tx
    return bottom + (top - bottom) * ty
  }

  static flat(
    originX: number,
    originY: number,
    cellSize: number,
    cols: number,
    rows: number,
    elevation: number,
  ): Heightmap {
    const e = new Float32Array(cols * rows)
    e.fill(elevation)
    return new Heightmap(originX, originY, cellSize, cols, rows, e)
  }
}

const clampNumber = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/terrain/heightmap.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/terrain/heightmap.ts src/terrain/heightmap.test.ts
git commit -m "feat: add heightmap with bilinear sampling"
```

---

### Task 2: Procedural valley terrain

A deterministic generator producing the one valley M1 needs. Deterministic because a seeded, repeatable terrain is testable; random terrain is not.

**Files:**
- Create: `src/terrain/generate.ts`
- Test: `src/terrain/generate.test.ts`

**Interfaces:**
- Consumes: `Heightmap` from `./heightmap`
- Produces:
  - `type ValleyOptions = { cols: number; rows: number; cellSize: number; floorElevation: number; ridgeHeight: number; valleyHalfWidth: number; seed: number }`
  - `generateValley(options: ValleyOptions): Heightmap` — throws `RangeError` if `valleyHalfWidth <= 0`

- [ ] **Step 1: Write the failing tests**

`src/terrain/generate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { generateValley, type ValleyOptions } from './generate'

const opts = (over: Partial<ValleyOptions> = {}): ValleyOptions => ({
  cols: 65,
  rows: 65,
  cellSize: 20,
  floorElevation: 100,
  ridgeHeight: 60,
  valleyHalfWidth: 250,
  seed: 1,
  ...over,
})

describe('generateValley', () => {
  it('produces a heightmap of the requested size', () => {
    const h = generateValley(opts())
    expect(h.cols).toBe(65)
    expect(h.rows).toBe(65)
    expect(h.cellSize).toBe(20)
  })

  it('is deterministic for a given seed', () => {
    const a = generateValley(opts())
    const b = generateValley(opts())
    expect(Array.from(a.elevations)).toEqual(Array.from(b.elevations))
  })

  it('differs between seeds', () => {
    const a = generateValley(opts({ seed: 1 }))
    const b = generateValley(opts({ seed: 2 }))
    expect(Array.from(a.elevations)).not.toEqual(Array.from(b.elevations))
  })

  it('is lowest along the valley axis and rises toward the sides', () => {
    const h = generateValley(opts())
    const midY = h.originY + h.height / 2
    const onAxis = h.sample(h.originX + h.width / 2, midY)
    const offAxis = h.sample(h.originX + h.width / 2, midY + 500)
    expect(offAxis).toBeGreaterThan(onAxis)
  })

  it('runs the valley floor roughly along the x axis', () => {
    const h = generateValley(opts())
    const midY = h.originY + h.height / 2
    const a = h.sample(h.originX + h.width * 0.25, midY)
    const b = h.sample(h.originX + h.width * 0.75, midY)
    // Both near the floor, and neither near ridge height.
    expect(Math.abs(a - b)).toBeLessThan(40)
    expect(a).toBeLessThan(100 + 60)
    expect(b).toBeLessThan(100 + 60)
  })

  it('stays within the floor-to-ridge band plus roughness', () => {
    const h = generateValley(opts())
    for (const z of h.elevations) {
      expect(z).toBeGreaterThan(100 - 30)
      expect(z).toBeLessThan(100 + 60 + 30)
    }
  })

  it('rejects a non-positive valley width', () => {
    expect(() => generateValley(opts({ valleyHalfWidth: 0 }))).toThrow(RangeError)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/terrain/generate.test.ts
```

Expected: FAIL — `Failed to resolve import "./generate"`.

- [ ] **Step 3: Write the implementation**

`src/terrain/generate.ts`:

```ts
import { Heightmap } from './heightmap'

export type ValleyOptions = {
  cols: number
  rows: number
  cellSize: number
  /** Elevation of the valley floor, metres. */
  floorElevation: number
  /** How far the ridges rise above the floor, metres. */
  ridgeHeight: number
  /** Distance from the valley axis to the ridge crest, metres. */
  valleyHalfWidth: number
  seed: number
}

/**
 * A deterministic river valley running roughly west to east.
 *
 * Cross-section is a smoothstep from floor to ridge over `valleyHalfWidth`,
 * so the sides ease out at both the floor and the crest rather than meeting
 * at a crease. The axis meanders gently along x, and layered value noise adds
 * roughness without breaking the overall form.
 *
 * Deterministic by design: a seeded, repeatable terrain can be asserted
 * against in tests. Random terrain cannot.
 */
export const generateValley = (options: ValleyOptions): Heightmap => {
  const {
    cols, rows, cellSize, floorElevation, ridgeHeight, valleyHalfWidth, seed,
  } = options

  if (valleyHalfWidth <= 0) {
    throw new RangeError('valleyHalfWidth must be positive')
  }

  const elevations = new Float32Array(cols * rows)
  const worldWidth = (cols - 1) * cellSize
  const worldHeight = (rows - 1) * cellSize
  const axisY = worldHeight / 2

  for (let row = 0; row < rows; row++) {
    const y = row * cellSize
    for (let col = 0; col < cols; col++) {
      const x = col * cellSize

      // The valley axis meanders gently rather than running dead straight.
      const meander =
        Math.sin((x / worldWidth) * Math.PI * 2) * valleyHalfWidth * 0.35 +
        Math.sin((x / worldWidth) * Math.PI * 5 + seed) * valleyHalfWidth * 0.12

      const distanceFromAxis = Math.abs(y - (axisY + meander))
      const t = smoothstep(0, valleyHalfWidth, distanceFromAxis)

      const roughness =
        valueNoise(x * 0.004, y * 0.004, seed) * 14 +
        valueNoise(x * 0.017, y * 0.017, seed + 101) * 5

      elevations[row * cols + col] =
        floorElevation + t * ridgeHeight + roughness
    }
  }

  return new Heightmap(0, 0, cellSize, cols, rows, elevations)
}

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Deterministic hash to [-1, 1]. No Math.random anywhere. */
const hash2 = (ix: number, iy: number, seed: number): number => {
  let h = ix * 374761393 + iy * 668265263 + seed * 1274126177
  h = (h ^ (h >> 13)) * 1274126177
  h = h ^ (h >> 16)
  return ((h & 0x7fffffff) / 0x7fffffff) * 2 - 1
}

/** Smoothed value noise on a unit lattice. */
const valueNoise = (x: number, y: number, seed: number): number => {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy

  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)

  const n00 = hash2(ix, iy, seed)
  const n10 = hash2(ix + 1, iy, seed)
  const n01 = hash2(ix, iy + 1, seed)
  const n11 = hash2(ix + 1, iy + 1, seed)

  const bottom = n00 + (n10 - n00) * ux
  const top = n01 + (n11 - n01) * ux
  return bottom + (top - bottom) * uy
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/terrain/generate.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/terrain/generate.ts src/terrain/generate.test.ts
git commit -m "feat: add deterministic valley terrain generator"
```

---

### Task 3: Ground profile along an alignment

Walk an alignment and record the natural ground elevation beneath it. This is the input to the grade solver.

**Files:**
- Create: `src/terrain/groundProfile.ts`
- Test: `src/terrain/groundProfile.test.ts`

**Interfaces:**
- Consumes: `Alignment` from `../geometry/alignment`; `Heightmap` from `./heightmap`
- Produces:
  - `type ProfilePoint = { readonly s: number; readonly z: number }`
  - `sampleGroundProfile(alignment: Alignment, terrain: Heightmap, spacing: number): ProfilePoint[]` — throws `RangeError` if `spacing <= 0`; returns `[]` for an empty alignment. Stations are exact multiples of `spacing` plus a final point at `alignment.length`.

- [ ] **Step 1: Write the failing tests**

`src/terrain/groundProfile.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { sampleGroundProfile } from './groundProfile'
import { Heightmap } from './heightmap'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'

/** Ground rises 1m per 1m of x: 0 at x=0, 100 at x=100. */
const rampX = () => {
  const cols = 11
  const rows = 3
  const e = new Float32Array(cols * rows)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      e[row * cols + col] = col * 10
    }
  }
  return new Heightmap(0, 0, 10, cols, rows, e)
}

const straightAlongX = (length: number) =>
  new Alignment([new Line(vec2(0, 10), 0, length)])

describe('sampleGroundProfile', () => {
  it('samples at the requested spacing including both endpoints', () => {
    const p = sampleGroundProfile(straightAlongX(100), rampX(), 25)
    expect(p).toHaveLength(5)
    expect(p[0]!.s).toBeCloseTo(0, 9)
    expect(p[4]!.s).toBeCloseTo(100, 9)
  })

  it('records ground elevation beneath the alignment', () => {
    const p = sampleGroundProfile(straightAlongX(100), rampX(), 25)
    expect(p[0]!.z).toBeCloseTo(0, 4)
    expect(p[1]!.z).toBeCloseTo(25, 4)
    expect(p[4]!.z).toBeCloseTo(100, 4)
  })

  it('always includes the final station even when spacing does not divide evenly', () => {
    const p = sampleGroundProfile(straightAlongX(100), rampX(), 30)
    expect(p[p.length - 1]!.s).toBeCloseTo(100, 9)
    expect(p[p.length - 1]!.z).toBeCloseTo(100, 4)
  })

  it('produces stations that increase monotonically', () => {
    const p = sampleGroundProfile(straightAlongX(100), rampX(), 30)
    for (let i = 1; i < p.length; i++) {
      expect(p[i]!.s).toBeGreaterThan(p[i - 1]!.s)
    }
  })

  it('returns an empty array for an empty alignment', () => {
    expect(sampleGroundProfile(new Alignment([]), rampX(), 10)).toEqual([])
  })

  it('rejects non-positive spacing', () => {
    expect(() => sampleGroundProfile(straightAlongX(100), rampX(), 0)).toThrow(RangeError)
    expect(() => sampleGroundProfile(straightAlongX(100), rampX(), -5)).toThrow(RangeError)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/terrain/groundProfile.test.ts
```

Expected: FAIL — `Failed to resolve import "./groundProfile"`.

- [ ] **Step 3: Write the implementation**

`src/terrain/groundProfile.ts`:

```ts
import type { Alignment } from '../geometry/alignment'
import type { Heightmap } from './heightmap'

/** Natural ground elevation at a station along an alignment. */
export type ProfilePoint = {
  /** Distance along the alignment, metres. */
  readonly s: number
  /** Elevation, metres. */
  readonly z: number
}

/**
 * Walk an alignment and record the ground beneath it.
 *
 * Stations are computed as `i * spacing` rather than accumulated, so they are
 * exact and cannot drift over a long alignment. The final station is always
 * the alignment's full length; if that coincides with the last stepped
 * station it is not duplicated.
 */
export const sampleGroundProfile = (
  alignment: Alignment,
  terrain: Heightmap,
  spacing: number,
): ProfilePoint[] => {
  if (spacing <= 0) {
    throw new RangeError('spacing must be positive')
  }
  if (alignment.isEmpty) return []

  const points: ProfilePoint[] = []
  const steps = Math.floor(alignment.length / spacing)

  for (let i = 0; i <= steps; i++) {
    const s = i * spacing
    const p = alignment.poseAt(s).position
    points.push({ s, z: terrain.sample(p.x, p.y) })
  }

  const last = points[points.length - 1]
  if (!last || last.s < alignment.length) {
    const p = alignment.poseAt(alignment.length).position
    points.push({ s: alignment.length, z: terrain.sample(p.x, p.y) })
  }

  return points
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/terrain/groundProfile.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/terrain/groundProfile.ts src/terrain/groundProfile.test.ts
git commit -m "feat: add ground profile sampling along an alignment"
```

---

### Task 4: Grade feasibility solver

The centrepiece. Given the ground beneath a road and a maximum grade, produce a design profile that respects the grade limit and hugs the ground as closely as it can — or report that no such profile exists.

**Read this before implementing.** The algorithm is interval propagation followed by greedy selection, and both halves are necessary.

Each station gets an allowed elevation interval `[min, max]`, initially the ground elevation plus or minus the permitted cut and fill. Two passes tighten those intervals so that neighbours are mutually reachable within the grade limit:

```
forward,  i = 1 .. n-1,  d = s[i] - s[i-1]:
    min[i] = max(min[i], min[i-1] - d*G)
    max[i] = min(max[i], max[i-1] + d*G)

backward, i = n-2 .. 0,  d = s[i+1] - s[i]:
    min[i] = max(min[i], min[i+1] - d*G)
    max[i] = min(max[i], max[i+1] + d*G)
```

**Two passes suffice — do not loop.** The constraints form a path graph (each station constrains only its immediate neighbours), and one pass in each direction achieves arc consistency on a path. Raising `min[i]` during the backward pass cannot invalidate the forward result for `min[i+1]`, because the new value minus `d*G` is strictly lower than the value that already satisfied it.

If any interval is empty (`min[i] > max[i]`) the alignment is **infeasible** at that grade.

**The selection step is not optional.** Non-empty intervals guarantee *a* solution exists; they do not make the obvious per-station choice valid. Picking each station independently as "whatever is closest to the ground within its interval" can violate the grade limit between two stations — for instance two adjacent intervals of `[0, 10]` with `d*G = 1` are perfectly consistent, yet choosing 0 and then 10 is a 10m step across a 1m allowance. So select in a forward sweep, narrowing each station by the running window from the station just chosen:

```
z[0] = clamp(ground[0], min[0], max[0])
for i = 1 .. n-1,  d = s[i] - s[i-1]:
    lo = max(min[i], z[i-1] - d*G)
    hi = min(max[i], z[i-1] + d*G)
    z[i] = clamp(ground[i], lo, hi)
```

`lo <= hi` always holds after propagation, so this sweep cannot fail.

**Files:**
- Create: `src/terrain/gradeSolver.ts`
- Test: `src/terrain/gradeSolver.test.ts`

**Interfaces:**
- Consumes: `ProfilePoint` from `./groundProfile`
- Produces:
  - `type GradeConstraints = { maxGrade: number; maxCutDepth: number; maxFillHeight: number; fixedStart?: number; fixedEnd?: number }`
  - `type GradeSolution = { readonly feasible: true; readonly profile: ProfilePoint[] } | { readonly feasible: false; readonly failedAtStation: number }`
  - `solveGradeProfile(ground: readonly ProfilePoint[], constraints: GradeConstraints): GradeSolution` — throws `RangeError` if `maxGrade <= 0`, or if `maxCutDepth` or `maxFillHeight` is negative

- [ ] **Step 1: Write the failing tests**

`src/terrain/gradeSolver.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { solveGradeProfile, type GradeConstraints } from './gradeSolver'
import type { ProfilePoint } from './groundProfile'

const constraints = (over: Partial<GradeConstraints> = {}): GradeConstraints => ({
  maxGrade: 0.07,
  maxCutDepth: 10,
  maxFillHeight: 10,
  ...over,
})

/** Ground points every 25m from a list of elevations. */
const ground = (elevations: number[]): ProfilePoint[] =>
  elevations.map((z, i) => ({ s: i * 25, z }))

const gradesOf = (p: readonly ProfilePoint[]): number[] => {
  const g: number[] = []
  for (let i = 1; i < p.length; i++) {
    g.push((p[i]!.z - p[i - 1]!.z) / (p[i]!.s - p[i - 1]!.s))
  }
  return g
}

describe('solveGradeProfile — feasible cases', () => {
  it('follows flat ground exactly', () => {
    const r = solveGradeProfile(ground([100, 100, 100, 100]), constraints())
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    for (const p of r.profile) expect(p.z).toBeCloseTo(100, 9)
  })

  it('follows gentle ground exactly when within the grade limit', () => {
    // 1m rise per 25m = 4% grade, under the 7% limit.
    const r = solveGradeProfile(ground([100, 101, 102, 103]), constraints())
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    expect(r.profile.map((p) => p.z)).toEqual([100, 101, 102, 103])
  })

  it('never exceeds the maximum grade on steep ground', () => {
    // 5m rise per 25m = 20% ground grade, far over the limit.
    const r = solveGradeProfile(ground([100, 105, 110, 115, 120]), constraints())
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    for (const g of gradesOf(r.profile)) {
      expect(Math.abs(g)).toBeLessThanOrEqual(0.07 + 1e-9)
    }
  })

  it('smooths a single sharp bump rather than following it', () => {
    const r = solveGradeProfile(ground([100, 100, 108, 100, 100]), constraints())
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    // The peak must be cut down; 8m over 25m is 32%.
    expect(r.profile[2]!.z).toBeLessThan(108)
    for (const g of gradesOf(r.profile)) {
      expect(Math.abs(g)).toBeLessThanOrEqual(0.07 + 1e-9)
    }
  })

  it('stays within the permitted cut and fill envelope', () => {
    // Ground rises 5m per 25m station — a 20% grade against a 7% limit — so
    // the solver must deviate substantially and the envelope genuinely binds.
    // A 10m allowance is the smallest that keeps this feasible: the solution
    // lands exactly on the cut limit at the final station. With 6m the bands
    // collapse to min 114 > max 113 there and the alignment is infeasible.
    const gp = ground([100, 105, 110, 115, 120])
    const allowance = 10
    const r = solveGradeProfile(
      gp,
      constraints({ maxCutDepth: allowance, maxFillHeight: allowance }),
    )
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    r.profile.forEach((p, i) => {
      expect(p.z).toBeGreaterThanOrEqual(gp[i]!.z - allowance - 1e-9)
      expect(p.z).toBeLessThanOrEqual(gp[i]!.z + allowance + 1e-9)
    })
    // The last station sits exactly at the cut limit, so this is not a
    // vacuous pass — a solver that ignored the envelope would overshoot it.
    const last = r.profile[r.profile.length - 1]!
    expect(last.z).toBeCloseTo(gp[gp.length - 1]!.z - allowance, 6)
  })

  it('honours fixed start and end elevations', () => {
    const r = solveGradeProfile(
      ground([100, 100, 100, 100, 100]),
      constraints({ fixedStart: 98, fixedEnd: 102 }),
    )
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    expect(r.profile[0]!.z).toBeCloseTo(98, 9)
    expect(r.profile[4]!.z).toBeCloseTo(102, 9)
  })

  it('handles a single point', () => {
    const r = solveGradeProfile(ground([100]), constraints())
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    expect(r.profile).toHaveLength(1)
    expect(r.profile[0]!.z).toBeCloseTo(100, 9)
  })

  it('preserves the input stations exactly', () => {
    const gp = ground([100, 105, 110])
    const r = solveGradeProfile(gp, constraints())
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    expect(r.profile.map((p) => p.s)).toEqual(gp.map((p) => p.s))
  })
})

describe('solveGradeProfile — infeasible cases', () => {
  it('reports infeasible when fixed ends demand too steep a grade', () => {
    // 20m rise over 50m = 40%, with only 7% allowed.
    const r = solveGradeProfile(
      ground([100, 100, 100]),
      constraints({ fixedStart: 100, fixedEnd: 120, maxCutDepth: 0, maxFillHeight: 0 }),
    )
    expect(r.feasible).toBe(false)
  })

  it('reports infeasible when a cliff exceeds the cut and fill envelope', () => {
    // 40m step with only 2m of cut and fill available either side.
    const r = solveGradeProfile(
      ground([100, 100, 140, 140]),
      constraints({ maxCutDepth: 2, maxFillHeight: 2 }),
    )
    expect(r.feasible).toBe(false)
  })

  it('names the station where feasibility failed', () => {
    const r = solveGradeProfile(
      ground([100, 100, 140, 140]),
      constraints({ maxCutDepth: 2, maxFillHeight: 2 }),
    )
    expect(r.feasible).toBe(false)
    if (r.feasible) return
    expect(typeof r.failedAtStation).toBe('number')
    expect(r.failedAtStation).toBeGreaterThanOrEqual(0)
  })
})

describe('solveGradeProfile — argument validation', () => {
  it('returns an empty feasible profile for empty input', () => {
    const r = solveGradeProfile([], constraints())
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    expect(r.profile).toEqual([])
  })

  it('rejects a non-positive maximum grade', () => {
    expect(() => solveGradeProfile(ground([100]), constraints({ maxGrade: 0 }))).toThrow(RangeError)
  })

  it('rejects negative cut or fill allowances', () => {
    expect(() => solveGradeProfile(ground([100]), constraints({ maxCutDepth: -1 }))).toThrow(RangeError)
    expect(() => solveGradeProfile(ground([100]), constraints({ maxFillHeight: -1 }))).toThrow(RangeError)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/terrain/gradeSolver.test.ts
```

Expected: FAIL — `Failed to resolve import "./gradeSolver"`.

- [ ] **Step 3: Write the implementation**

`src/terrain/gradeSolver.ts`:

```ts
import type { ProfilePoint } from './groundProfile'

export type GradeConstraints = {
  /** Maximum absolute grade as a rise-over-run fraction. 7% is 0.07. */
  maxGrade: number
  /** How far below natural ground the road may be cut, metres. */
  maxCutDepth: number
  /** How far above natural ground the road may be filled, metres. */
  maxFillHeight: number
  /** Elevation the profile must start at, if tied to existing road. */
  fixedStart?: number
  /** Elevation the profile must end at, if tied to existing road. */
  fixedEnd?: number
}

export type GradeSolution =
  | { readonly feasible: true; readonly profile: ProfilePoint[] }
  | { readonly feasible: false; readonly failedAtStation: number }

/** Interval comparisons tolerate this much floating-point slack. */
const EPSILON = 1e-9

/**
 * Find a vertical alignment that respects the maximum grade and stays as
 * close to natural ground as possible — or report that none exists.
 *
 * Two phases, both required:
 *
 * 1. Interval propagation. Each station starts with the elevation band its
 *    cut and fill allowance permits, then one forward and one backward pass
 *    tighten those bands so neighbours are mutually reachable within the
 *    grade limit. Two passes are sufficient and no loop is needed: the
 *    constraints form a path graph, and one pass each way achieves arc
 *    consistency on a path. An empty band means the alignment is infeasible.
 *
 * 2. Greedy forward selection. Non-empty bands prove a solution exists but do
 *    not make the obvious per-station choice valid — two adjacent bands of
 *    [0, 10] with a 1m grade allowance are perfectly consistent, yet picking
 *    0 then 10 is a 10m step. So each station is additionally narrowed by the
 *    reachable window from the station just chosen. After propagation that
 *    window is never empty, so the sweep cannot fail.
 *
 * Returning the corrected profile rather than merely rejecting is the point:
 * the player gets a workable vertical alignment instead of an error.
 */
export const solveGradeProfile = (
  ground: readonly ProfilePoint[],
  constraints: GradeConstraints,
): GradeSolution => {
  const { maxGrade, maxCutDepth, maxFillHeight, fixedStart, fixedEnd } = constraints

  if (maxGrade <= 0) {
    throw new RangeError('maxGrade must be positive')
  }
  if (maxCutDepth < 0 || maxFillHeight < 0) {
    throw new RangeError('cut and fill allowances must not be negative')
  }

  const n = ground.length
  if (n === 0) return { feasible: true, profile: [] }

  // --- Initial bands from the cut and fill envelope ---
  const min = new Float64Array(n)
  const max = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const g = ground[i]!.z
    min[i] = g - maxCutDepth
    max[i] = g + maxFillHeight
  }

  if (fixedStart !== undefined) {
    min[0] = fixedStart
    max[0] = fixedStart
  }
  if (fixedEnd !== undefined) {
    min[n - 1] = fixedEnd
    max[n - 1] = fixedEnd
  }

  // --- Phase 1: interval propagation, one pass each way ---
  for (let i = 1; i < n; i++) {
    const d = ground[i]!.s - ground[i - 1]!.s
    const reach = d * maxGrade
    min[i] = Math.max(min[i]!, min[i - 1]! - reach)
    max[i] = Math.min(max[i]!, max[i - 1]! + reach)
  }

  for (let i = n - 2; i >= 0; i--) {
    const d = ground[i + 1]!.s - ground[i]!.s
    const reach = d * maxGrade
    min[i] = Math.max(min[i]!, min[i + 1]! - reach)
    max[i] = Math.min(max[i]!, max[i + 1]! + reach)
  }

  for (let i = 0; i < n; i++) {
    if (min[i]! > max[i]! + EPSILON) {
      return { feasible: false, failedAtStation: ground[i]!.s }
    }
  }

  // --- Phase 2: greedy forward selection, hugging natural ground ---
  const profile: ProfilePoint[] = []

  let previous = clampNumber(ground[0]!.z, min[0]!, max[0]!)
  profile.push({ s: ground[0]!.s, z: previous })

  for (let i = 1; i < n; i++) {
    const d = ground[i]!.s - ground[i - 1]!.s
    const reach = d * maxGrade
    const lo = Math.max(min[i]!, previous - reach)
    const hi = Math.min(max[i]!, previous + reach)
    previous = clampNumber(ground[i]!.z, lo, hi)
    profile.push({ s: ground[i]!.s, z: previous })
  }

  return { feasible: true, profile }
}

const clampNumber = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/terrain/gradeSolver.test.ts
```

Expected: PASS, 14 tests.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/terrain/gradeSolver.ts src/terrain/gradeSolver.test.ts
git commit -m "feat: add grade feasibility solver with interval propagation"
```

---

### Task 5: Corridor cross-section

At any station, what elevation does the earthworks design surface sit at, a given distance left or right of the centreline? The road is flat across its formation, then side slopes run out until they meet natural ground — the *daylight* point.

**Files:**
- Create: `src/terrain/corridor.ts`
- Test: `src/terrain/corridor.test.ts`

**Retaining walls are part of this task.** A retaining wall is what you build when there is not enough room to run a batter out to natural ground — a constrained corridor, a property boundary, a watercourse. It is a cross-section variant, not a structure added afterwards, which is why it belongs here rather than in the mesh plan.

The template gains an optional `maxBatterWidth`. When the batter needed to reach natural ground would exceed it, the batter is truncated at that width and a vertical retaining wall makes up the remaining height. The maths:

```
depth              = |groundZ − designZ|
naturalBatterWidth = depth × slope
if maxBatterWidth is undefined or naturalBatterWidth ≤ maxBatterWidth:
    no wall, height 0
else:
    wall stands at offset (formationHalfWidth + maxBatterWidth)
    wall height = depth − maxBatterWidth / slope
```

Two sanity checks worth holding onto: `maxBatterWidth = 0` gives a wall of the full depth, and `maxBatterWidth = naturalBatterWidth` gives a wall of exactly zero. Both fall out of the formula.

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type CorridorTemplate = { formationHalfWidth: number; cutSlope: number; fillSlope: number; maxBatterWidth?: number }` — slopes are horizontal-to-vertical ratios; `2` means 2H:1V. `maxBatterWidth` is in metres; omitted means batters may run out as far as they need.
  - `designElevationAt(offset: number, designZ: number, groundZ: number, template: CorridorTemplate): number` — elevation of the design surface at transverse `offset` metres from the centreline. Throws `RangeError` if `formationHalfWidth < 0`, either slope is `<= 0`, or `maxBatterWidth` is present and negative.
  - `isDaylighted(offset: number, designZ: number, groundZ: number, template: CorridorTemplate): boolean` — true once the side slope has met or passed natural ground at this offset
  - `retainingWall(designZ: number, groundZ: number, template: CorridorTemplate): { readonly offset: number; readonly height: number } | null` — where the wall stands and how tall it is, or `null` when no wall is needed. `offset` is the distance from the centreline, always positive; a wall exists symmetrically on both sides.

- [ ] **Step 1: Write the failing tests**

`src/terrain/corridor.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { designElevationAt, isDaylighted, retainingWall, type CorridorTemplate } from './corridor'

const template = (over: Partial<CorridorTemplate> = {}): CorridorTemplate => ({
  formationHalfWidth: 5,
  cutSlope: 2,   // 2H:1V
  fillSlope: 3,  // 3H:1V
  ...over,
})

describe('designElevationAt — formation', () => {
  it('is flat across the formation width', () => {
    const t = template()
    for (const offset of [-5, -2.5, 0, 2.5, 5]) {
      expect(designElevationAt(offset, 100, 95, t)).toBeCloseTo(100, 9)
    }
  })

  it('is flat regardless of whether the section is in cut or fill', () => {
    const t = template()
    expect(designElevationAt(0, 100, 90, t)).toBeCloseTo(100, 9)
    expect(designElevationAt(0, 100, 110, t)).toBeCloseTo(100, 9)
  })
})

describe('designElevationAt — cut sections', () => {
  it('rises away from the road when ground is above the design line', () => {
    // Ground 10m above design: this is a cut, so the batter climbs outward.
    const t = template()
    // 3m beyond the formation edge at 2H:1V rises 1.5m.
    expect(designElevationAt(8, 100, 110, t)).toBeCloseTo(101.5, 9)
  })

  it('stops rising once it reaches natural ground', () => {
    const t = template()
    // Ground only 2m up; at 2H:1V that daylights 4m beyond the edge.
    expect(designElevationAt(9, 100, 102, t)).toBeCloseTo(102, 9)
    expect(designElevationAt(50, 100, 102, t)).toBeCloseTo(102, 9)
  })

  it('is symmetric left and right', () => {
    const t = template()
    expect(designElevationAt(-8, 100, 110, t)).toBeCloseTo(
      designElevationAt(8, 100, 110, t), 9,
    )
  })
})

describe('designElevationAt — fill sections', () => {
  it('falls away from the road when ground is below the design line', () => {
    const t = template()
    // 3m beyond the edge at 3H:1V drops 1m.
    expect(designElevationAt(8, 100, 90, t)).toBeCloseTo(99, 9)
  })

  it('stops falling once it reaches natural ground', () => {
    const t = template()
    // Ground 1m down; at 3H:1V that daylights 3m beyond the edge.
    expect(designElevationAt(8.5, 100, 99, t)).toBeCloseTo(99, 9)
    expect(designElevationAt(50, 100, 99, t)).toBeCloseTo(99, 9)
  })

  it('uses the fill slope, not the cut slope', () => {
    const t = template({ cutSlope: 2, fillSlope: 4 })
    // 4m beyond the edge at 4H:1V drops exactly 1m.
    expect(designElevationAt(9, 100, 80, t)).toBeCloseTo(99, 9)
  })
})

describe('isDaylighted', () => {
  it('is false within the formation', () => {
    expect(isDaylighted(0, 100, 110, template())).toBe(false)
  })

  it('is false on the batter before it meets ground', () => {
    expect(isDaylighted(6, 100, 110, template())).toBe(false)
  })

  it('is true once the batter has met ground', () => {
    expect(isDaylighted(50, 100, 102, template())).toBe(true)
  })

  it('is true immediately when design and ground coincide', () => {
    expect(isDaylighted(6, 100, 100, template())).toBe(true)
  })
})

describe('retaining walls', () => {
  it('needs no wall when the batter has room to daylight', () => {
    // 2m cut at 2H:1V needs 4m of batter; 10m is available.
    expect(retainingWall(100, 102, template({ maxBatterWidth: 10 }))).toBeNull()
  })

  it('needs no wall when maxBatterWidth is not set', () => {
    expect(retainingWall(100, 130, template())).toBeNull()
  })

  it('stands the wall at the end of the permitted batter', () => {
    // 5m cut at 2H:1V wants 10m of batter, but only 4m is available.
    const wall = retainingWall(100, 105, template({ maxBatterWidth: 4 }))!
    expect(wall).not.toBeNull()
    expect(wall.offset).toBeCloseTo(9, 9)   // formationHalfWidth 5 + 4
  })

  it('makes up exactly the height the batter could not', () => {
    // depth 5, batter covers 4/2 = 2m of it, so the wall is 3m.
    const wall = retainingWall(100, 105, template({ maxBatterWidth: 4 }))!
    expect(wall.height).toBeCloseTo(3, 9)
  })

  it('gives a full-depth wall when no batter is allowed at all', () => {
    const wall = retainingWall(100, 105, template({ maxBatterWidth: 0 }))!
    expect(wall.height).toBeCloseTo(5, 9)
    expect(wall.offset).toBeCloseTo(5, 9)
  })

  it('gives exactly zero height when the allowance equals what is needed', () => {
    // 3m fill at 3H:1V needs exactly 9m of batter.
    expect(retainingWall(100, 97, template({ maxBatterWidth: 9 }))).toBeNull()
  })

  it('uses the fill slope on fill sections', () => {
    // 4m fill at 3H:1V wants 12m; only 6m allowed, so batter covers 2m.
    const wall = retainingWall(100, 96, template({ maxBatterWidth: 6 }))!
    expect(wall.height).toBeCloseTo(2, 9)
  })

  it('needs no wall where design sits on natural ground', () => {
    expect(retainingWall(100, 100, template({ maxBatterWidth: 0 }))).toBeNull()
  })

  it('truncates the design surface at the wall', () => {
    const t = template({ maxBatterWidth: 4 })
    // Inside the permitted batter the surface still climbs.
    expect(designElevationAt(7, 100, 105, t)).toBeCloseTo(101, 9)
    // Beyond the wall there is no earthwork — the surface is natural ground.
    expect(designElevationAt(12, 100, 105, t)).toBeCloseTo(105, 9)
  })
})

describe('designElevationAt — validation', () => {
  it('rejects an invalid template', () => {
    expect(() => designElevationAt(0, 100, 95, template({ formationHalfWidth: -1 }))).toThrow(RangeError)
    expect(() => designElevationAt(0, 100, 95, template({ cutSlope: 0 }))).toThrow(RangeError)
    expect(() => designElevationAt(0, 100, 95, template({ fillSlope: -2 }))).toThrow(RangeError)
    expect(() => designElevationAt(0, 100, 95, template({ maxBatterWidth: -1 }))).toThrow(RangeError)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/terrain/corridor.test.ts
```

Expected: FAIL — `Failed to resolve import "./corridor"`.

- [ ] **Step 3: Write the implementation**

`src/terrain/corridor.ts`:

```ts
/**
 * The transverse shape of the earthworks at a station.
 *
 * Slopes are horizontal-to-vertical ratios, the civil convention: a value of
 * 2 means 2H:1V, so the batter runs out 2m horizontally for every 1m of
 * height. Steeper slopes have smaller numbers. Cut batters are conventionally
 * steeper than fill batters, since undisturbed ground stands better than
 * placed material.
 */
export type CorridorTemplate = {
  /** Half the formation width — carriageway plus shoulders — in metres. */
  formationHalfWidth: number
  /** Cut batter, horizontal-to-vertical. */
  cutSlope: number
  /** Fill batter, horizontal-to-vertical. */
  fillSlope: number
  /**
   * How far a batter may run out from the formation edge before a retaining
   * wall takes over, metres. Omitted means batters may run as far as needed.
   */
  maxBatterWidth?: number
}

const validate = (t: CorridorTemplate): void => {
  if (t.formationHalfWidth < 0) {
    throw new RangeError('formationHalfWidth must not be negative')
  }
  if (t.cutSlope <= 0 || t.fillSlope <= 0) {
    throw new RangeError('slopes must be positive')
  }
  if (t.maxBatterWidth !== undefined && t.maxBatterWidth < 0) {
    throw new RangeError('maxBatterWidth must not be negative')
  }
}

/** Which batter applies here — cut above the design line, fill below. */
const slopeFor = (designZ: number, groundZ: number, t: CorridorTemplate): number =>
  groundZ > designZ ? t.cutSlope : t.fillSlope

/**
 * Where a retaining wall stands and how tall it is, or null if none is needed.
 *
 * A wall is what you build when there is not enough room to run a batter out
 * to natural ground — a constrained corridor, a property boundary, a
 * watercourse. The batter is truncated at `maxBatterWidth` and a vertical
 * wall makes up whatever height it could not.
 *
 * `offset` is distance from the centreline and is always positive; the wall
 * exists symmetrically on both sides.
 */
export const retainingWall = (
  designZ: number,
  groundZ: number,
  template: CorridorTemplate,
): { readonly offset: number; readonly height: number } | null => {
  validate(template)

  const { maxBatterWidth } = template
  if (maxBatterWidth === undefined) return null

  const depth = Math.abs(groundZ - designZ)
  if (depth === 0) return null

  const slope = slopeFor(designZ, groundZ, template)
  const naturalBatterWidth = depth * slope
  if (naturalBatterWidth <= maxBatterWidth) return null

  return {
    offset: template.formationHalfWidth + maxBatterWidth,
    height: depth - maxBatterWidth / slope,
  }
}

/**
 * Elevation of the earthworks design surface at a transverse offset.
 *
 * Within the formation the surface is flat at the design elevation. Beyond
 * it, the batter runs toward natural ground and stops the moment it gets
 * there — the daylight point. Past that the design surface simply is natural
 * ground, so cut and fill areas integrate to zero out there.
 */
export const designElevationAt = (
  offset: number,
  designZ: number,
  groundZ: number,
  template: CorridorTemplate,
): number => {
  validate(template)

  const beyondFormation = Math.abs(offset) - template.formationHalfWidth
  if (beyondFormation <= 0) return designZ

  // Past a retaining wall there is no earthwork at all — the wall holds the
  // ground back and the surface beyond it is simply natural ground.
  if (
    template.maxBatterWidth !== undefined &&
    beyondFormation > template.maxBatterWidth
  ) {
    return groundZ
  }

  if (groundZ > designZ) {
    // Cut: the batter climbs outward toward the higher ground.
    const rise = beyondFormation / template.cutSlope
    return Math.min(designZ + rise, groundZ)
  }

  if (groundZ < designZ) {
    // Fill: the batter descends outward toward the lower ground.
    const drop = beyondFormation / template.fillSlope
    return Math.max(designZ - drop, groundZ)
  }

  return designZ
}

/** Has the batter met natural ground at this offset? */
export const isDaylighted = (
  offset: number,
  designZ: number,
  groundZ: number,
  template: CorridorTemplate,
): boolean => {
  validate(template)

  if (Math.abs(offset) <= template.formationHalfWidth) return false
  return designElevationAt(offset, designZ, groundZ, template) === groundZ
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/terrain/corridor.test.ts
```

Expected: PASS, 22 tests.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/terrain/corridor.ts src/terrain/corridor.test.ts
git commit -m "feat: add corridor cross-section with batters and retaining walls"
```

---

### Task 6: Cut and fill volumes

The average end-area method: compute cut and fill *areas* at each station, then the volume between two stations is the mean of their areas times the distance. This is how earthwork quantities are actually taken off, and it is what drives both construction cost and construction duration.

**Files:**
- Create: `src/terrain/volumes.ts`
- Test: `src/terrain/volumes.test.ts`

**Interfaces:**
- Consumes: `Alignment` from `../geometry/alignment`; `Heightmap` from `./heightmap`; `ProfilePoint` from `./groundProfile`; `CorridorTemplate`, `designElevationAt` from `./corridor`
- Produces:
  - `type StationAreas = { readonly s: number; readonly cutArea: number; readonly fillArea: number; readonly truncated: boolean }` — `truncated` is true when the section reached the safety cap without daylighting, so its areas are an under-estimate
  - `type EarthworkQuantities = { readonly stations: StationAreas[]; readonly cutVolume: number; readonly fillVolume: number; readonly netVolume: number; readonly truncatedStations: number }` — `netVolume` is `cutVolume - fillVolume`; positive means surplus to dispose of, negative means material must be imported. A non-zero `truncatedStations` means the quantities are an under-estimate.

> **The integration bound must be found by marching, not predicted.** An earlier draft of this task derived a fixed half-width from the depth at the centreline. That silently under-reports on cross-sloped ground: where the ground rises away from the centreline, the uphill batter daylights well beyond a bound computed from the centre, and the loop stops without ever checking whether daylight was reached. Since the game's terrain is a valley, cross-slope is the normal case, not an edge case. March outward on each side independently until the design surface has equalled natural ground for four consecutive samples, cap at `MAX_SECTION_HALF_WIDTH = 500` metres, and report `truncated` when the cap is hit — so an under-estimate is visible rather than silent.
  - `crossSectionAreas(alignment: Alignment, terrain: Heightmap, station: ProfilePoint, template: CorridorTemplate, transverseStep?: number): StationAreas` — `transverseStep` defaults to `0.5` metres
  - `computeEarthworks(alignment: Alignment, terrain: Heightmap, design: readonly ProfilePoint[], template: CorridorTemplate, transverseStep?: number): EarthworkQuantities`

- [ ] **Step 1: Write the failing tests**

`src/terrain/volumes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { crossSectionAreas, computeEarthworks } from './volumes'
import { Heightmap } from './heightmap'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import type { CorridorTemplate } from './corridor'
import type { ProfilePoint } from './groundProfile'

const template: CorridorTemplate = {
  formationHalfWidth: 5,
  cutSlope: 2,
  fillSlope: 2,
}

/** Flat ground at a given elevation, large enough to hold the corridor. */
const flatGround = (z: number) => Heightmap.flat(-500, -500, 50, 41, 41, z)

/** A straight road along +x through the origin. */
const road = (length: number) => new Alignment([new Line(vec2(0, 0), 0, length)])

describe('crossSectionAreas', () => {
  it('is zero in both directions when the design sits on the ground', () => {
    const a = crossSectionAreas(road(100), flatGround(100), { s: 50, z: 100 }, template)
    expect(a.cutArea).toBeCloseTo(0, 4)
    expect(a.fillArea).toBeCloseTo(0, 4)
  })

  it('reports cut when the design is below the ground', () => {
    const a = crossSectionAreas(road(100), flatGround(100), { s: 50, z: 98 }, template)
    expect(a.cutArea).toBeGreaterThan(0)
    expect(a.fillArea).toBeCloseTo(0, 4)
  })

  it('reports fill when the design is above the ground', () => {
    const a = crossSectionAreas(road(100), flatGround(100), { s: 50, z: 102 }, template)
    expect(a.fillArea).toBeGreaterThan(0)
    expect(a.cutArea).toBeCloseTo(0, 4)
  })

  it('matches the analytic area of a trapezoidal cut', () => {
    // Depth d=2, formation width 10, side slopes 2H:1V on flat ground.
    // Trapezoid area = d * (width + slope * d) = 2 * (10 + 2*2) = 28 m^2.
    // Tolerance is relative: midpoint integration is exact on the linear
    // batters, and the only residual error is at the two kinks.
    const a = crossSectionAreas(road(100), flatGround(100), { s: 50, z: 98 }, template)
    expect(Math.abs(a.cutArea - 28) / 28).toBeLessThan(0.01)
  })

  it('matches the analytic area of a trapezoidal fill', () => {
    // Same geometry inverted: 3 * (10 + 2*3) = 48 m^2.
    const a = crossSectionAreas(road(100), flatGround(100), { s: 50, z: 103 }, template)
    expect(Math.abs(a.fillArea - 48) / 48).toBeLessThan(0.01)
  })

  it('scales with depth faster than linearly, because the batters widen', () => {
    const shallow = crossSectionAreas(road(100), flatGround(100), { s: 50, z: 99 }, template)
    const deep = crossSectionAreas(road(100), flatGround(100), { s: 50, z: 98 }, template)
    expect(deep.cutArea).toBeGreaterThan(shallow.cutArea * 2)
  })

  it('reports the station it was given', () => {
    const a = crossSectionAreas(road(100), flatGround(100), { s: 37, z: 98 }, template)
    expect(a.s).toBe(37)
  })
})

describe('computeEarthworks', () => {
  it('returns zero quantities for an empty design', () => {
    const q = computeEarthworks(road(100), flatGround(100), [], template)
    expect(q.cutVolume).toBe(0)
    expect(q.fillVolume).toBe(0)
    expect(q.netVolume).toBe(0)
    expect(q.stations).toEqual([])
  })

  it('computes volume by average end area', () => {
    // Constant 2m cut over 100m: area 28 m^2 throughout, so 2800 m^3.
    // Relative tolerance, because the per-station area error compounds over
    // the length — an absolute tolerance here would be a false precision.
    const design: ProfilePoint[] = [
      { s: 0, z: 98 }, { s: 50, z: 98 }, { s: 100, z: 98 },
    ]
    const q = computeEarthworks(road(100), flatGround(100), design, template)
    expect(Math.abs(q.cutVolume - 2800) / 2800).toBeLessThan(0.01)
    expect(q.fillVolume).toBeCloseTo(0, 4)
  })

  it('reports net volume as cut minus fill', () => {
    const design: ProfilePoint[] = [
      { s: 0, z: 98 }, { s: 100, z: 98 },
    ]
    const q = computeEarthworks(road(100), flatGround(100), design, template)
    expect(q.netVolume).toBeCloseTo(q.cutVolume - q.fillVolume, 6)
    expect(q.netVolume).toBeGreaterThan(0)
  })

  it('reports a negative net volume when fill dominates', () => {
    const design: ProfilePoint[] = [
      { s: 0, z: 103 }, { s: 100, z: 103 },
    ]
    const q = computeEarthworks(road(100), flatGround(100), design, template)
    expect(q.netVolume).toBeLessThan(0)
  })

  it('balances to near zero when equal cut and fill offset each other', () => {
    // 2m cut over the first half, 2m fill over the second, same geometry.
    const design: ProfilePoint[] = [
      { s: 0, z: 98 }, { s: 50, z: 98 },
      { s: 50.0001, z: 102 }, { s: 100, z: 102 },
    ]
    const q = computeEarthworks(road(100), flatGround(100), design, template)
    expect(Math.abs(q.netVolume)).toBeLessThan(q.cutVolume * 0.05)
  })

  it('returns one area entry per design station', () => {
    const design: ProfilePoint[] = [
      { s: 0, z: 99 }, { s: 25, z: 99 }, { s: 50, z: 99 },
    ]
    const q = computeEarthworks(road(100), flatGround(100), design, template)
    expect(q.stations).toHaveLength(3)
    expect(q.stations.map((a) => a.s)).toEqual([0, 25, 50])
  })

  it('handles a single station with zero volume', () => {
    const q = computeEarthworks(road(100), flatGround(100), [{ s: 0, z: 98 }], template)
    expect(q.stations).toHaveLength(1)
    expect(q.cutVolume).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/terrain/volumes.test.ts
```

Expected: FAIL — `Failed to resolve import "./volumes"`.

- [ ] **Step 3: Write the implementation**

`src/terrain/volumes.ts`:

```ts
import type { Alignment } from '../geometry/alignment'
import { fromAngle, add, scale } from '../geometry/vec2'
import type { Heightmap } from './heightmap'
import type { ProfilePoint } from './groundProfile'
import { designElevationAt, type CorridorTemplate } from './corridor'

export type StationAreas = {
  readonly s: number
  /** Cross-sectional area of material to be excavated, m^2. */
  readonly cutArea: number
  /** Cross-sectional area of material to be placed, m^2. */
  readonly fillArea: number
}

export type EarthworkQuantities = {
  readonly stations: StationAreas[]
  readonly cutVolume: number
  readonly fillVolume: number
  /** cut − fill. Positive is surplus to dispose of; negative must be imported. */
  readonly netVolume: number
}

const DEFAULT_TRANSVERSE_STEP = 0.5

/**
 * How far either side of the centreline to integrate.
 *
 * The batter must have daylighted well before this, or the section is
 * truncated and the area under-reported. Generous, since sampling a few extra
 * metres of zero costs almost nothing.
 */
const maxHalfWidth = (template: CorridorTemplate, depth: number): number =>
  template.formationHalfWidth +
  Math.max(template.cutSlope, template.fillSlope) * Math.abs(depth) +
  10

/**
 * Cut and fill areas at one station, by transverse numerical integration.
 *
 * Steps across the section perpendicular to the alignment, sampling natural
 * ground and the design surface at each offset and accumulating the signed
 * difference. Past the daylight point the two coincide and contribute
 * nothing, so the integration bound only has to be generous, not exact.
 */
export const crossSectionAreas = (
  alignment: Alignment,
  terrain: Heightmap,
  station: ProfilePoint,
  template: CorridorTemplate,
  transverseStep: number = DEFAULT_TRANSVERSE_STEP,
): StationAreas => {
  if (transverseStep <= 0) {
    throw new RangeError('transverseStep must be positive')
  }

  const pose = alignment.poseAt(station.s)
  // Perpendicular to the direction of travel, pointing left.
  const normal = fromAngle(pose.heading + Math.PI / 2)

  const centreGround = terrain.sample(pose.position.x, pose.position.y)
  const half = maxHalfWidth(template, station.z - centreGround)

  let cutArea = 0
  let fillArea = 0

  // Midpoint rule, not left-Riemann. The batters are linear ramps, and the
  // midpoint rule integrates a linear function exactly while a left sum
  // overestimates it by step/2 x slope on every side — about 1 m^2 of error
  // on a 2m cut, which is far too much when this figure drives both cost and
  // construction duration. Residual error comes only from the two kinks
  // (formation edge and daylight point) and is on the order of 0.01 m^2.
  const steps = Math.ceil((2 * half) / transverseStep)
  for (let i = 0; i < steps; i++) {
    const offset = -half + (i + 0.5) * transverseStep
    const p = add(pose.position, scale(normal, offset))
    const groundZ = terrain.sample(p.x, p.y)
    const surfaceZ = designElevationAt(offset, station.z, groundZ, template)

    const difference = groundZ - surfaceZ
    if (difference > 0) cutArea += difference * transverseStep
    else fillArea += -difference * transverseStep
  }

  return { s: station.s, cutArea, fillArea }
}

/**
 * Earthwork quantities for a whole road, by the average end-area method.
 *
 * Volume between two stations is the mean of their cross-sectional areas
 * times the distance between them. This is how quantities are actually taken
 * off a set of drawings, and it feeds both construction cost and — via
 * productivity rates — how long the road takes to build.
 */
export const computeEarthworks = (
  alignment: Alignment,
  terrain: Heightmap,
  design: readonly ProfilePoint[],
  template: CorridorTemplate,
  transverseStep: number = DEFAULT_TRANSVERSE_STEP,
): EarthworkQuantities => {
  if (design.length === 0) {
    return { stations: [], cutVolume: 0, fillVolume: 0, netVolume: 0 }
  }

  const stations = design.map((station) =>
    crossSectionAreas(alignment, terrain, station, template, transverseStep),
  )

  let cutVolume = 0
  let fillVolume = 0

  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1]!
    const b = stations[i]!
    const distance = b.s - a.s
    cutVolume += ((a.cutArea + b.cutArea) / 2) * distance
    fillVolume += ((a.fillArea + b.fillArea) / 2) * distance
  }

  return {
    stations,
    cutVolume,
    fillVolume,
    netVolume: cutVolume - fillVolume,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/terrain/volumes.test.ts
```

Expected: PASS, 14 tests.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/terrain/volumes.ts src/terrain/volumes.test.ts
git commit -m "feat: add cut and fill volumes by average end area"
```

---

### Task 7: Non-destructive edit layer

Terrain deformation lives in a layer over the base heightmap, never in the base itself. That is what makes earthworks undoable — the failing that draws the loudest complaints about Cities: Skylines 2, where terrain edits cannot be reversed.

**Files:**
- Create: `src/terrain/editLayer.ts`
- Test: `src/terrain/editLayer.test.ts`

**Interfaces:**
- Consumes: `Heightmap` from `./heightmap`
- Produces:
  - `class TerrainEditLayer`
    - `constructor(base: Heightmap)`
    - `readonly base: Heightmap`
    - `get editCount(): number`
    - `setDelta(col: number, row: number, delta: number): void` — throws `RangeError` if out of range
    - `deltaAt(col: number, row: number): number` — `0` where untouched
    - `clear(): void`
    - `sample(x: number, y: number): number` — base plus deltas, bilinear, edge-clamped
    - `flatten(): Heightmap` — a new `Heightmap` with edits baked in; the layer is unchanged

- [ ] **Step 1: Write the failing tests**

`src/terrain/editLayer.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { TerrainEditLayer } from './editLayer'
import { Heightmap } from './heightmap'

const base = () => Heightmap.flat(0, 0, 10, 3, 3, 100)

describe('TerrainEditLayer', () => {
  it('starts empty and samples the base unchanged', () => {
    const layer = new TerrainEditLayer(base())
    expect(layer.editCount).toBe(0)
    expect(layer.sample(15, 15)).toBeCloseTo(100, 9)
  })

  it('applies a delta at a grid point', () => {
    const layer = new TerrainEditLayer(base())
    layer.setDelta(1, 1, -5)
    expect(layer.deltaAt(1, 1)).toBe(-5)
    expect(layer.sample(10, 10)).toBeCloseTo(95, 9)
  })

  it('reports zero delta where untouched', () => {
    const layer = new TerrainEditLayer(base())
    layer.setDelta(1, 1, -5)
    expect(layer.deltaAt(0, 0)).toBe(0)
    expect(layer.sample(0, 0)).toBeCloseTo(100, 9)
  })

  it('interpolates deltas bilinearly between grid points', () => {
    const layer = new TerrainEditLayer(base())
    layer.setDelta(0, 0, -10)
    // Halfway between the edited corner and its untouched neighbour.
    expect(layer.sample(5, 0)).toBeCloseTo(95, 9)
  })

  it('overwrites rather than accumulating on repeated set', () => {
    const layer = new TerrainEditLayer(base())
    layer.setDelta(1, 1, -5)
    layer.setDelta(1, 1, -8)
    expect(layer.deltaAt(1, 1)).toBe(-8)
    expect(layer.editCount).toBe(1)
  })

  it('counts only distinct edited points', () => {
    const layer = new TerrainEditLayer(base())
    layer.setDelta(0, 0, 1)
    layer.setDelta(1, 0, 2)
    layer.setDelta(0, 0, 3)
    expect(layer.editCount).toBe(2)
  })

  it('restores the base exactly when cleared — the undo guarantee', () => {
    const layer = new TerrainEditLayer(base())
    layer.setDelta(1, 1, -20)
    layer.setDelta(2, 2, 15)
    layer.clear()
    expect(layer.editCount).toBe(0)
    expect(layer.sample(10, 10)).toBeCloseTo(100, 9)
    expect(layer.sample(20, 20)).toBeCloseTo(100, 9)
  })

  it('never mutates the base heightmap', () => {
    const b = base()
    const before = Array.from(b.elevations)
    const layer = new TerrainEditLayer(b)
    layer.setDelta(1, 1, -50)
    expect(Array.from(b.elevations)).toEqual(before)
  })

  it('rejects out-of-range grid indices', () => {
    const layer = new TerrainEditLayer(base())
    expect(() => layer.setDelta(-1, 0, 1)).toThrow(RangeError)
    expect(() => layer.setDelta(3, 0, 1)).toThrow(RangeError)
    expect(() => layer.deltaAt(0, 3)).toThrow(RangeError)
  })

  it('bakes edits into a new heightmap on flatten', () => {
    const layer = new TerrainEditLayer(base())
    layer.setDelta(1, 1, -5)
    const flat = layer.flatten()
    expect(flat.elevationAtIndex(1, 1)).toBeCloseTo(95, 4)
    expect(flat.elevationAtIndex(0, 0)).toBeCloseTo(100, 4)
  })

  it('leaves the layer usable after flatten', () => {
    const layer = new TerrainEditLayer(base())
    layer.setDelta(1, 1, -5)
    layer.flatten()
    expect(layer.editCount).toBe(1)
    expect(layer.sample(10, 10)).toBeCloseTo(95, 9)
  })

  it('clamps outside its bounds like the base does', () => {
    const layer = new TerrainEditLayer(base())
    layer.setDelta(0, 0, -10)
    expect(layer.sample(-999, -999)).toBeCloseTo(90, 9)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/terrain/editLayer.test.ts
```

Expected: FAIL — `Failed to resolve import "./editLayer"`.

- [ ] **Step 3: Write the implementation**

`src/terrain/editLayer.ts`:

```ts
import { Heightmap } from './heightmap'

/**
 * Terrain deformation held separately from the ground it deforms.
 *
 * Edits are sparse elevation deltas keyed by grid index; the base heightmap
 * is never touched. Undo is therefore exact and free — dropping the delta
 * restores the original ground bit for bit, with no accumulated drift from
 * applying and reversing an operation.
 *
 * This is the direct answer to the most-complained-about flaw in Cities:
 * Skylines 2, where terrain edits are destructive and cannot be undone.
 */
export class TerrainEditLayer {
  /** Sparse deltas, keyed by `row * cols + col`. */
  private readonly deltas = new Map<number, number>()

  constructor(readonly base: Heightmap) {}

  get editCount(): number {
    return this.deltas.size
  }

  private indexOf(col: number, row: number): number {
    if (col < 0 || col >= this.base.cols || row < 0 || row >= this.base.rows) {
      throw new RangeError(`grid index (${col}, ${row}) out of range`)
    }
    return row * this.base.cols + col
  }

  setDelta(col: number, row: number, delta: number): void {
    this.deltas.set(this.indexOf(col, row), delta)
  }

  deltaAt(col: number, row: number): number {
    return this.deltas.get(this.indexOf(col, row)) ?? 0
  }

  clear(): void {
    this.deltas.clear()
  }

  /**
   * Base elevation plus deformation, bilinearly interpolated.
   *
   * Mirrors `Heightmap.sample` exactly, including edge clamping, so an edited
   * terrain behaves identically to an unedited one everywhere.
   */
  sample(x: number, y: number): number {
    const baseZ = this.base.sample(x, y)
    if (this.deltas.size === 0) return baseZ

    const { originX, originY, cellSize, cols, rows } = this.base

    const gx = clampNumber((x - originX) / cellSize, 0, cols - 1)
    const gy = clampNumber((y - originY) / cellSize, 0, rows - 1)

    const col0 = Math.min(Math.floor(gx), cols - 2)
    const row0 = Math.min(Math.floor(gy), rows - 2)
    const tx = gx - col0
    const ty = gy - row0

    const d00 = this.deltaAt(col0, row0)
    const d10 = this.deltaAt(col0 + 1, row0)
    const d01 = this.deltaAt(col0, row0 + 1)
    const d11 = this.deltaAt(col0 + 1, row0 + 1)

    const bottom = d00 + (d10 - d00) * tx
    const top = d01 + (d11 - d01) * tx

    return baseZ + bottom + (top - bottom) * ty
  }

  /** A new heightmap with the edits baked in. This layer is left untouched. */
  flatten(): Heightmap {
    const { originX, originY, cellSize, cols, rows } = this.base
    const elevations = new Float32Array(cols * rows)

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        elevations[row * cols + col] =
          this.base.elevationAtIndex(col, row) + this.deltaAt(col, row)
      }
    }

    return new Heightmap(originX, originY, cellSize, cols, rows, elevations)
  }
}

const clampNumber = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/terrain/editLayer.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/terrain/editLayer.ts src/terrain/editLayer.test.ts
git commit -m "feat: add non-destructive terrain edit layer"
```

---

### Task 8: Deployed long-section debug view

Replace the plan-view debug page with a long-section: natural ground against the design line, cut hatched one way and fill the other, with the grade and the earthwork quantities called out. This is the classic civil engineering drawing, and it is the fastest way to see whether the whole chain is behaving.

Like the alignment preview it replaces, **this file is deliberately untested** — it exists to catch the class of error that unit tests pass over, which requires a human looking at it.

**Files:**
- Create: `src/debug/longSectionPreview.ts`
- Modify: `src/main.ts` (replace entirely)
- Delete: `src/debug/alignmentPreview.ts`

**Interfaces:**
- Consumes: everything built in Tasks 1–7, plus `Alignment`, `Line`, `Arc`, `filletCorner`, `vec2`, `angleOf`, `sub`, `distance` from `src/geometry/`
- Produces: `drawLongSection(canvas: HTMLCanvasElement): void`

- [ ] **Step 1: Write the debug view**

`src/debug/longSectionPreview.ts`:

```ts
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { filletCorner } from '../geometry/fillet'
import { vec2, angleOf, sub, distance, type Vec2 } from '../geometry/vec2'
import { generateValley } from '../terrain/generate'
import { sampleGroundProfile } from '../terrain/groundProfile'
import { solveGradeProfile } from '../terrain/gradeSolver'
import { computeEarthworks } from '../terrain/volumes'
import type { CorridorTemplate } from '../terrain/corridor'

const SAMPLE_SPACING = 10
const MAX_GRADE = 0.07
const CURVE_RADIUS = 400

// Cut and fill allowances, metres. Chosen by measuring candidate routes across
// this terrain rather than guessed: 12/10 is the tightest envelope under which
// the route below is feasible, and it yields a near-balanced design.
const MAX_CUT_DEPTH = 12
const MAX_FILL_HEIGHT = 10

const TEMPLATE: CorridorTemplate = {
  formationHalfWidth: 5,
  cutSlope: 2,
  fillSlope: 3,
}

/** Straight, filleted corner, straight — across the valley. */
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

export const drawLongSection = (canvas: HTMLCanvasElement): void => {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const terrain = generateValley({
    cols: 129, rows: 129, cellSize: 20,
    floorElevation: 100, ridgeHeight: 70, valleyHalfWidth: 400, seed: 7,
  })

  // A road running the length of the valley, crossing the meandering axis
  // twice. Route chosen by measurement, not by eye: a road climbing the ridge
  // flank is genuinely infeasible here — the smoothstep gives that flank a 26%
  // gradient against a 7% limit — and routes that merely survive it move around
  // 250 m3 per metre, which is mountain-pass earthmoving, not a valley road.
  // This one is feasible at the tightest envelope and comes out nearly
  // balanced, which is what a designer actually aims for.
  const alignment = buildAlignment(
    vec2(200, 1300), vec2(1400, 1200), vec2(2400, 1340),
  )
  if (!alignment) return

  const ground = sampleGroundProfile(alignment, terrain, SAMPLE_SPACING)
  if (ground.length < 2) return

  const solution = solveGradeProfile(ground, {
    maxGrade: MAX_GRADE,
    maxCutDepth: MAX_CUT_DEPTH,
    maxFillHeight: MAX_FILL_HEIGHT,
  })

  const pad = { left: 70, right: 30, top: 60, bottom: 50 }
  const plotW = w - pad.left - pad.right
  const plotH = h - pad.top - pad.bottom

  const design = solution.feasible ? solution.profile : []
  const allZ = [...ground.map((p) => p.z), ...design.map((p) => p.z)]
  const minZ = Math.min(...allZ) - 5
  const maxZ = Math.max(...allZ) + 5
  const totalS = ground[ground.length - 1]!.s

  const sx = (s: number) => pad.left + (s / totalS) * plotW
  const sy = (z: number) => pad.top + plotH - ((z - minZ) / (maxZ - minZ)) * plotH

  const pathThrough = (points: readonly { s: number; z: number }[]) => {
    ctx.beginPath()
    points.forEach((p, i) => {
      const x = sx(p.s)
      const y = sy(p.z)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
  }

  // Elevation grid.
  ctx.strokeStyle = '#232a33'
  ctx.fillStyle = '#5d6b7a'
  ctx.lineWidth = 1
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
  const zStep = 10
  for (let z = Math.ceil(minZ / zStep) * zStep; z < maxZ; z += zStep) {
    const y = sy(z)
    ctx.beginPath()
    ctx.moveTo(pad.left, y)
    ctx.lineTo(pad.left + plotW, y)
    ctx.stroke()
    ctx.fillText(`${z.toFixed(0)}m`, 20, y + 4)
  }

  if (design.length === ground.length) {
    // Cut and fill bands between the two lines, coloured by which dominates.
    for (let i = 1; i < ground.length; i++) {
      const g0 = ground[i - 1]!
      const g1 = ground[i]!
      const d0 = design[i - 1]!
      const d1 = design[i]!
      const isCut = (g0.z + g1.z) / 2 > (d0.z + d1.z) / 2

      ctx.beginPath()
      ctx.moveTo(sx(g0.s), sy(g0.z))
      ctx.lineTo(sx(g1.s), sy(g1.z))
      ctx.lineTo(sx(d1.s), sy(d1.z))
      ctx.lineTo(sx(d0.s), sy(d0.z))
      ctx.closePath()
      ctx.fillStyle = isCut ? 'rgba(216, 122, 84, 0.35)' : 'rgba(108, 160, 132, 0.35)'
      ctx.fill()
    }
  }

  // Natural ground.
  pathThrough(ground)
  ctx.strokeStyle = '#7d6b58'
  ctx.lineWidth = 2
  ctx.stroke()

  // Design line.
  if (design.length > 0) {
    pathThrough(design)
    ctx.strokeStyle = '#d9c89a'
    ctx.lineWidth = 3
    ctx.stroke()
  }

  // Readout.
  ctx.fillStyle = '#e8e4dc'
  ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace'

  if (!solution.feasible) {
    ctx.fillStyle = '#d87a54'
    ctx.fillText(
      `INFEASIBLE at station ${solution.failedAtStation.toFixed(0)}m ` +
      `— cannot hold ${(MAX_GRADE * 100).toFixed(0)}% grade`,
      pad.left, 30,
    )
    return
  }

  const quantities = computeEarthworks(alignment, terrain, design, TEMPLATE)

  let steepest = 0
  for (let i = 1; i < design.length; i++) {
    const g = Math.abs(
      (design[i]!.z - design[i - 1]!.z) / (design[i]!.s - design[i - 1]!.s),
    )
    if (g > steepest) steepest = g
  }

  ctx.fillText(
    `length ${totalS.toFixed(0)}m   ` +
    `max grade ${(steepest * 100).toFixed(2)}% (limit ${(MAX_GRADE * 100).toFixed(0)}%)`,
    pad.left, 26,
  )
  ctx.fillText(
    `cut ${Math.round(quantities.cutVolume).toLocaleString()} m³   ` +
    `fill ${Math.round(quantities.fillVolume).toLocaleString()} m³   ` +
    `net ${quantities.netVolume >= 0 ? '+' : ''}${Math.round(quantities.netVolume).toLocaleString()} m³` +
    `${quantities.netVolume >= 0 ? ' surplus' : ' import'}`,
    pad.left, 46,
  )

  // A truncated section reached the integration safety cap without daylighting,
  // so its quantities are an under-estimate. Say so rather than presenting the
  // number as fact — a silent under-report is the exact failure this flag exists
  // to prevent, and it would otherwise flow straight into cost and duration.
  if (quantities.truncatedStations > 0) {
    ctx.fillStyle = '#d87a54'
    ctx.fillText(
      `⚠ ${quantities.truncatedStations} of ${quantities.stations.length} sections truncated ` +
      `— quantities are an under-estimate`,
      pad.left, 66,
    )
  }

  ctx.fillStyle = '#5d6b7a'
  ctx.fillText('natural ground ——   design line ——   cut ▨   fill ▨', pad.left, h - 18)
}
```

- [ ] **Step 2: Wire it into the page and remove the old view**

Replace `src/main.ts` entirely:

```ts
import { drawLongSection } from './debug/longSectionPreview'

const app = document.getElementById('app')

if (app) {
  const canvas = document.createElement('canvas')
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'
  app.appendChild(canvas)

  const render = () => drawLongSection(canvas)
  render()
  window.addEventListener('resize', render)
}
```

Then remove the superseded view:

```bash
rm src/debug/alignmentPreview.ts
```

- [ ] **Step 3: Verify the typecheck and build**

```bash
npm run build
```

Expected: no TypeScript errors. If `tsc` reports `alignmentPreview.ts` is still referenced, the `main.ts` replacement was incomplete.

- [ ] **Step 4: Run the full test suite**

```bash
npm test
```

Expected: PASS, 159 tests across 13 files — the 69 from plan 1, plus 15 heightmap, 7 generate, 6 groundProfile, 14 gradeSolver, 22 corridor, 14 volumes, 12 editLayer.

- [ ] **Step 5: Commit and push**

```bash
git add -A
git commit -m "feat: add long-section debug view with cut and fill"
git push
```

- [ ] **Step 6: Hand off for visual inspection**

Do not attempt the visual check yourself. Report that the build is deployed and ready to look at, and note anything you noticed that might affect it.

What the reviewer will check:

- The design line stays visibly gentler than the ground wherever the ground is steep — that is the grade solver working.
- Reported max grade is at or just under 7%, never above.
- Cut bands appear where the design line runs *below* ground, fill bands where it runs *above*. Reversed colouring means the sign convention is inverted somewhere in the chain.
- Cut and fill volumes are plausible for a road of this length — thousands to tens of thousands of cubic metres, not tens or millions.
- The design line does not float implausibly far from the ground; the cut and fill allowances should keep it within about 15m.

---

## Plan complete

At the end of this plan, roads have a vertical dimension: terrain can be sampled, a grade-legal profile solved, earthwork quantities taken off, and terrain deformed reversibly. The deployed page shows a real long-section with cut and fill.

### Deliberately not in this plan

**Bridges and overpasses.** Both generate geometry — deck, piers at intervals, abutments — so they belong in plan 3 with road ribbons and junction polygons. An overpass additionally needs the road network graph, because it has to know what it is crossing and at what clearance; that graph does not exist until plan 3 either.

This plan supplies exactly the trigger condition they need. The height of the design line above natural ground is available at every station from `solveGradeProfile`, and it is what decides between an embankment and a structure: below a threshold you fill, above it the fill becomes uneconomic and absurd-looking and you build a bridge instead.

**Retaining walls are NOT deferred** — they are in Task 5. A wall is a cross-section variant chosen when there is no room for a batter, not a structure added on top of finished earthworks, so it belongs with the corridor. Task 5 returns where the wall stands and how tall it is; plan 3 turns that into geometry.

**Applying the corridor to the edit layer.** `TerrainEditLayer` is built and fully tested here, but nothing in this plan writes earthwork deformation into it. Wiring the corridor through to actual terrain deformation belongs with the interactive tool in plan 4, where an edit becomes something the player commits and can undo. Building the layer now — rather than when it is first needed — is deliberate: it is the piece that makes undo possible, and it is cheaper to get right in isolation than under pressure from the tool.

**Next plan:** Layered road mesh and junctions. Its first task adds station `s` to `Pose` and a continuity check to `Alignment`, both carried forward from plan 1's final review. Road meshes must be layer-aware from the outset — subgrade, base and wearing course separately addressable and drawable to an arbitrary station — so that construction can render a road mid-build.
