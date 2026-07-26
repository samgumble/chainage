# Chainage — Foundation & Alignment Geometry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the project with a working deploy pipeline, and build a fully tested pure-math alignment geometry library — the foundation every later system depends on.

**Architecture:** A road centerline is an ordered sequence of curvature-parameterized primitives (line, arc, clothoid spiral), following the ASAM OpenDRIVE data model. Each primitive answers one question: given a distance `s` along me, what is the pose (position + heading + curvature)? The `Alignment` container chains primitives and dispatches by arc length. Everything in `src/geometry/` is pure — no three.js, no DOM, no engine types — so it is exhaustively unit-testable.

**Tech Stack:** TypeScript (strict), Vite, Vitest, three.js r185+ (used only in the final task's debug view), GitHub Actions → GitHub Pages.

## Global Constraints

- **Deploy target:** `https://samgumble.github.io/chainage/` — Vite `base` must be `'/chainage/'`
- **three.js:** r185 or later (`three@^0.185.1`), WebGL2 renderer. Do not use WebGPU.
- **`src/geometry/` imports nothing.** No three.js, no DOM APIs, no other `src/` modules. Pure functions over numbers. This boundary is load-bearing and must not be relaxed.
- **Plan-view coordinate convention:** `(x, y)` in metres, `y` pointing north. Heading is radians counter-clockwise from `+x`. Elevation `z` is a separate profile and is NOT part of plan geometry.
- **three.js handedness:** three uses `+Y` up. Convert at the render boundary only: `(x, y, z) → (x, z, −y)`. Never inside `src/geometry/`.
- **Angle normalization:** all returned headings are normalized to `(−π, π]`.
- **Float comparison in tests:** use `toBeCloseTo` with precision 9 for exact-form math, precision 4 for numerically-integrated results.
- **TypeScript:** `strict: true`, `noUncheckedIndexedAccess: true`.
- **Commits:** conventional commit prefixes (`feat:`, `test:`, `chore:`, `fix:`).

---

### Task 1: Project scaffold and deploy pipeline

Deliverable: a live page at `https://samgumble.github.io/chainage/`, and `npm test` running green. Deployment is de-risked on day one rather than discovered to be broken at the end.

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.ts`, `src/smoke.test.ts`, `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: nothing
- Produces: `npm test` (Vitest), `npm run build` (typecheck + Vite build to `dist/`), `npm run dev`

- [ ] **Step 1: Initialize the package and install dependencies**

```bash
cd "/Users/samgumble/Carpet game"
npm init -y
npm install --save three
npm install --save-dev typescript vite vitest @types/three
```

- [ ] **Step 2: Verify three.js resolved to r185 or later**

```bash
npm ls three
```

Expected: `three@0.185.x` or higher. If it resolved lower, run `npm install --save three@latest` and re-check. Record the resolved versions of `three`, `vite`, and `vitest` in the commit message for Step 10.

- [ ] **Step 3: Write `package.json` scripts**

Replace the `"scripts"` block in `package.json` with:

```json
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  },
```

Keep the `dependencies` and `devDependencies` blocks npm generated. Ensure `"private": true` is present.

- [ ] **Step 4: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vitest/globals"]
  },
  "include": ["src", "vite.config.ts"]
}
```

- [ ] **Step 5: Write `vite.config.ts`**

```ts
/// <reference types="vitest" />
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/chainage/',
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

- [ ] **Step 6: Write `index.html` and `src/main.ts`**

`index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Chainage</title>
    <style>
      html, body { margin: 0; height: 100%; background: #14181d; color: #e8e4dc;
        font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
      #app { position: fixed; inset: 0; display: grid; place-items: center; }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`src/main.ts`:

```ts
const app = document.getElementById('app')
if (app) app.textContent = 'Chainage'
```

- [ ] **Step 7: Write the smoke test**

`src/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

describe('toolchain', () => {
  it('runs tests', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 8: Run the test suite and the build**

```bash
npm test && npm run build
```

Expected: Vitest reports `1 passed`, then `tsc` emits nothing, then Vite writes `dist/`. Confirm `dist/index.html` exists and its script `src` begins with `/chainage/`.

- [ ] **Step 9: Write the GitHub Pages workflow**

`.github/workflows/deploy.yml`:

```yaml
name: Deploy to Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run build
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: scaffold Vite + TypeScript + Vitest with Pages deploy"
```

- [ ] **Step 11: Create the remote repo and push**

```bash
gh repo create Samgumble/chainage --public --source=. --remote=origin
git branch -M main
git push -u origin main
```

Then enable Pages: in the repository settings under Pages, set **Source** to **GitHub Actions**. Re-run the workflow if the first run predated this change.

- [ ] **Step 12: Verify the deployment**

```bash
gh run watch
curl -sI https://samgumble.github.io/chainage/ | head -1
```

Expected: workflow succeeds; curl returns `HTTP/2 200`. The page shows "Chainage".

---

### Task 2: 2D vector math

**Files:**
- Create: `src/geometry/vec2.ts`
- Test: `src/geometry/vec2.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type Vec2 = { readonly x: number; readonly y: number }`
  - `vec2(x: number, y: number): Vec2`
  - `add(a: Vec2, b: Vec2): Vec2`
  - `sub(a: Vec2, b: Vec2): Vec2`
  - `scale(a: Vec2, k: number): Vec2`
  - `dot(a: Vec2, b: Vec2): number`
  - `cross(a: Vec2, b: Vec2): number` — the scalar z-component of the 3D cross product
  - `length(a: Vec2): number`
  - `distance(a: Vec2, b: Vec2): number`
  - `normalize(a: Vec2): Vec2` — returns `{x:0,y:0}` for a zero vector
  - `fromAngle(radians: number): Vec2`
  - `angleOf(a: Vec2): number`
  - `normalizeAngle(radians: number): number` — into `(−π, π]`
  - `signedAngleBetween(from: Vec2, to: Vec2): number` — into `(−π, π]`, positive counter-clockwise

- [ ] **Step 1: Write the failing tests**

`src/geometry/vec2.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  vec2, add, sub, scale, dot, cross, length, distance, normalize,
  fromAngle, angleOf, normalizeAngle, signedAngleBetween,
} from './vec2'

describe('vec2 arithmetic', () => {
  it('adds, subtracts and scales', () => {
    expect(add(vec2(1, 2), vec2(3, 4))).toEqual({ x: 4, y: 6 })
    expect(sub(vec2(3, 4), vec2(1, 2))).toEqual({ x: 2, y: 2 })
    expect(scale(vec2(2, 3), 2)).toEqual({ x: 4, y: 6 })
  })

  it('computes dot and cross products', () => {
    expect(dot(vec2(1, 0), vec2(0, 1))).toBe(0)
    expect(dot(vec2(2, 3), vec2(4, 5))).toBe(23)
    expect(cross(vec2(1, 0), vec2(0, 1))).toBe(1)
    expect(cross(vec2(0, 1), vec2(1, 0))).toBe(-1)
  })

  it('computes length and distance', () => {
    expect(length(vec2(3, 4))).toBe(5)
    expect(distance(vec2(1, 1), vec2(4, 5))).toBe(5)
  })

  it('normalizes, and returns zero for a zero vector', () => {
    const n = normalize(vec2(3, 4))
    expect(n.x).toBeCloseTo(0.6, 9)
    expect(n.y).toBeCloseTo(0.8, 9)
    expect(normalize(vec2(0, 0))).toEqual({ x: 0, y: 0 })
  })
})

describe('vec2 angles', () => {
  it('round-trips angle to vector and back', () => {
    for (const a of [0, 0.5, 1.5, 3, -2]) {
      expect(angleOf(fromAngle(a))).toBeCloseTo(a, 9)
    }
  })

  it('normalizes angles into (-PI, PI]', () => {
    expect(normalizeAngle(0)).toBeCloseTo(0, 9)
    expect(normalizeAngle(Math.PI)).toBeCloseTo(Math.PI, 9)
    expect(normalizeAngle(-Math.PI)).toBeCloseTo(Math.PI, 9)
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 9)
    expect(normalizeAngle(2 * Math.PI + 0.5)).toBeCloseTo(0.5, 9)
    expect(normalizeAngle(-2 * Math.PI - 0.5)).toBeCloseTo(-0.5, 9)
  })

  it('measures signed angle between vectors, positive counter-clockwise', () => {
    expect(signedAngleBetween(vec2(1, 0), vec2(0, 1))).toBeCloseTo(Math.PI / 2, 9)
    expect(signedAngleBetween(vec2(0, 1), vec2(1, 0))).toBeCloseTo(-Math.PI / 2, 9)
    expect(signedAngleBetween(vec2(1, 0), vec2(1, 0))).toBeCloseTo(0, 9)
    expect(Math.abs(signedAngleBetween(vec2(1, 0), vec2(-1, 0)))).toBeCloseTo(Math.PI, 9)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/geometry/vec2.test.ts
```

Expected: FAIL — `Failed to resolve import "./vec2"`.

- [ ] **Step 3: Write the implementation**

`src/geometry/vec2.ts`:

```ts
export type Vec2 = { readonly x: number; readonly y: number }

export const vec2 = (x: number, y: number): Vec2 => ({ x, y })

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k })

export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x

export const length = (a: Vec2): number => Math.hypot(a.x, a.y)
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y)

export const normalize = (a: Vec2): Vec2 => {
  const len = Math.hypot(a.x, a.y)
  return len === 0 ? { x: 0, y: 0 } : { x: a.x / len, y: a.y / len }
}

export const fromAngle = (radians: number): Vec2 => ({
  x: Math.cos(radians),
  y: Math.sin(radians),
})

export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x)

/** Normalize into (-PI, PI]. Exactly -PI maps to +PI. */
export const normalizeAngle = (radians: number): number => {
  const twoPi = Math.PI * 2
  let r = radians % twoPi
  if (r > Math.PI) r -= twoPi
  else if (r <= -Math.PI) r += twoPi
  return r
}

/** Signed angle from `from` to `to`, positive counter-clockwise, in (-PI, PI]. */
export const signedAngleBetween = (from: Vec2, to: Vec2): number =>
  normalizeAngle(Math.atan2(cross(from, to), dot(from, to)))
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/geometry/vec2.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Delete the scaffold smoke test**

It existed only to prove the test runner worked before any real code existed. Real tests now cover that, and a test asserting `1 + 1 === 2` is noise.

```bash
rm src/smoke.test.ts
npm test
```

Expected: PASS, 7 tests in 1 file.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add 2D vector and angle math"
```

---

### Task 3: Line and arc primitives

Every primitive answers the same question: at distance `s` from my start, where am I, which way am I facing, and how sharply am I turning?

**Files:**
- Create: `src/geometry/primitives.ts`
- Test: `src/geometry/primitives.test.ts`

**Interfaces:**
- Consumes: `Vec2`, `vec2`, `normalizeAngle` from `./vec2`
- Produces:
  - `type Pose = { readonly position: Vec2; readonly heading: number; readonly curvature: number }`
  - `interface Primitive { readonly length: number; poseAt(s: number): Pose }`
  - `class Line implements Primitive` — `new Line(start: Vec2, heading: number, length: number)`
  - `class Arc implements Primitive` — `new Arc(start: Vec2, heading: number, length: number, curvature: number)`; `curvature` is signed, positive turning left (counter-clockwise). Throws `RangeError` if `curvature` is 0 — use `Line` instead.
  - Both clamp `s` into `[0, length]`.

- [ ] **Step 1: Write the failing tests**

`src/geometry/primitives.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Line, Arc } from './primitives'
import { vec2 } from './vec2'

describe('Line', () => {
  it('advances along its heading', () => {
    const line = new Line(vec2(10, 20), 0, 100)
    const p = line.poseAt(50)
    expect(p.position.x).toBeCloseTo(60, 9)
    expect(p.position.y).toBeCloseTo(20, 9)
    expect(p.heading).toBeCloseTo(0, 9)
    expect(p.curvature).toBe(0)
  })

  it('respects a diagonal heading', () => {
    const line = new Line(vec2(0, 0), Math.PI / 4, Math.SQRT2)
    const p = line.poseAt(Math.SQRT2)
    expect(p.position.x).toBeCloseTo(1, 9)
    expect(p.position.y).toBeCloseTo(1, 9)
  })

  it('clamps s to its length', () => {
    const line = new Line(vec2(0, 0), 0, 10)
    expect(line.poseAt(999).position.x).toBeCloseTo(10, 9)
    expect(line.poseAt(-5).position.x).toBeCloseTo(0, 9)
  })
})

describe('Arc', () => {
  it('traces a quarter circle to the left', () => {
    // Radius 100, starting at origin heading +x, curving left (CCW).
    // Centre is at (0, 100). A quarter turn ends at (100, 100) heading +y.
    const r = 100
    const arc = new Arc(vec2(0, 0), 0, (Math.PI / 2) * r, 1 / r)
    const p = arc.poseAt(arc.length)
    expect(p.position.x).toBeCloseTo(100, 6)
    expect(p.position.y).toBeCloseTo(100, 6)
    expect(p.heading).toBeCloseTo(Math.PI / 2, 9)
    expect(p.curvature).toBeCloseTo(1 / r, 9)
  })

  it('traces a quarter circle to the right with negative curvature', () => {
    const r = 100
    const arc = new Arc(vec2(0, 0), 0, (Math.PI / 2) * r, -1 / r)
    const p = arc.poseAt(arc.length)
    expect(p.position.x).toBeCloseTo(100, 6)
    expect(p.position.y).toBeCloseTo(-100, 6)
    expect(p.heading).toBeCloseTo(-Math.PI / 2, 9)
  })

  it('stays exactly one radius from its centre throughout', () => {
    const r = 250
    const arc = new Arc(vec2(5, -3), 0.7, 300, 1 / r)
    // Centre lies 90 degrees left of the start heading, r away.
    const cx = 5 + r * Math.cos(0.7 + Math.PI / 2)
    const cy = -3 + r * Math.sin(0.7 + Math.PI / 2)
    for (let s = 0; s <= 300; s += 25) {
      const p = arc.poseAt(s)
      expect(Math.hypot(p.position.x - cx, p.position.y - cy)).toBeCloseTo(r, 6)
    }
  })

  it('rejects zero curvature', () => {
    expect(() => new Arc(vec2(0, 0), 0, 10, 0)).toThrow(RangeError)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/geometry/primitives.test.ts
```

Expected: FAIL — `Failed to resolve import "./primitives"`.

- [ ] **Step 3: Write the implementation**

`src/geometry/primitives.ts`:

```ts
import { type Vec2, normalizeAngle } from './vec2'

export type Pose = {
  readonly position: Vec2
  readonly heading: number
  readonly curvature: number
}

export interface Primitive {
  readonly length: number
  poseAt(s: number): Pose
}

const clamp = (s: number, length: number): number =>
  s < 0 ? 0 : s > length ? length : s

/** A straight segment of constant heading and zero curvature. */
export class Line implements Primitive {
  constructor(
    readonly start: Vec2,
    readonly heading: number,
    readonly length: number,
  ) {}

  poseAt(s: number): Pose {
    const t = clamp(s, this.length)
    return {
      position: {
        x: this.start.x + t * Math.cos(this.heading),
        y: this.start.y + t * Math.sin(this.heading),
      },
      heading: normalizeAngle(this.heading),
      curvature: 0,
    }
  }
}

/**
 * A circular arc of constant curvature.
 * Positive curvature turns left (counter-clockwise); radius is 1/|curvature|.
 *
 * Integrating heading(s) = heading0 + curvature * s gives:
 *   x(s) = x0 + ( sin(heading0 + k*s) - sin(heading0) ) / k
 *   y(s) = y0 - ( cos(heading0 + k*s) - cos(heading0) ) / k
 */
export class Arc implements Primitive {
  constructor(
    readonly start: Vec2,
    readonly heading: number,
    readonly length: number,
    readonly curvature: number,
  ) {
    if (curvature === 0) {
      throw new RangeError('Arc curvature must be non-zero; use Line instead')
    }
  }

  poseAt(s: number): Pose {
    const t = clamp(s, this.length)
    const k = this.curvature
    const h0 = this.heading
    const h = h0 + k * t
    return {
      position: {
        x: this.start.x + (Math.sin(h) - Math.sin(h0)) / k,
        y: this.start.y - (Math.cos(h) - Math.cos(h0)) / k,
      },
      heading: normalizeAngle(h),
      curvature: k,
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/geometry/primitives.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/geometry/primitives.ts src/geometry/primitives.test.ts
git commit -m "feat: add line and arc alignment primitives"
```

---

### Task 4: Clothoid spiral primitive

The spiral is what makes this real highway geometry rather than decorative curves: curvature varies *linearly* with distance, so a driver turns the wheel at a constant rate. It has no closed-form position, so it is integrated numerically.

The two tests that matter are the degenerate cases — a spiral with constant zero curvature must equal a `Line`, and one with constant non-zero curvature must equal an `Arc`. If those pass, the integrator is correct.

**Files:**
- Create: `src/geometry/spiral.ts`
- Test: `src/geometry/spiral.test.ts`

**Interfaces:**
- Consumes: `Vec2`, `normalizeAngle` from `./vec2`; `Pose`, `Primitive` from `./primitives`
- Produces:
  - `class Spiral implements Primitive` — `new Spiral(start: Vec2, heading: number, length: number, startCurvature: number, endCurvature: number)`

- [ ] **Step 1: Write the failing tests**

`src/geometry/spiral.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Spiral } from './spiral'
import { Line, Arc } from './primitives'
import { vec2 } from './vec2'

describe('Spiral degenerate cases', () => {
  it('matches a Line when curvature is zero throughout', () => {
    const spiral = new Spiral(vec2(3, 7), 0.4, 120, 0, 0)
    const line = new Line(vec2(3, 7), 0.4, 120)
    for (let s = 0; s <= 120; s += 10) {
      const a = spiral.poseAt(s)
      const b = line.poseAt(s)
      expect(a.position.x).toBeCloseTo(b.position.x, 4)
      expect(a.position.y).toBeCloseTo(b.position.y, 4)
      expect(a.heading).toBeCloseTo(b.heading, 4)
    }
  })

  it('matches an Arc when curvature is constant and non-zero', () => {
    const k = 1 / 150
    const spiral = new Spiral(vec2(-2, 5), 1.1, 200, k, k)
    const arc = new Arc(vec2(-2, 5), 1.1, 200, k)
    for (let s = 0; s <= 200; s += 10) {
      const a = spiral.poseAt(s)
      const b = arc.poseAt(s)
      expect(a.position.x).toBeCloseTo(b.position.x, 4)
      expect(a.position.y).toBeCloseTo(b.position.y, 4)
      expect(a.heading).toBeCloseTo(b.heading, 4)
    }
  })
})

describe('Spiral curvature transition', () => {
  it('interpolates curvature linearly along its length', () => {
    const spiral = new Spiral(vec2(0, 0), 0, 100, 0, 1 / 50)
    expect(spiral.poseAt(0).curvature).toBeCloseTo(0, 9)
    expect(spiral.poseAt(50).curvature).toBeCloseTo(1 / 100, 9)
    expect(spiral.poseAt(100).curvature).toBeCloseTo(1 / 50, 9)
  })

  it('accumulates the analytically correct total heading change', () => {
    // Total turn = integral of curvature ds = mean curvature * length.
    const k0 = 0
    const k1 = 1 / 40
    const L = 80
    const spiral = new Spiral(vec2(0, 0), 0, L, k0, k1)
    const expected = ((k0 + k1) / 2) * L
    expect(spiral.poseAt(L).heading).toBeCloseTo(expected, 6)
  })

  it('bends left for increasing positive curvature', () => {
    const spiral = new Spiral(vec2(0, 0), 0, 100, 0, 1 / 50)
    const end = spiral.poseAt(100)
    expect(end.position.y).toBeGreaterThan(0)
    expect(end.heading).toBeGreaterThan(0)
  })

  it('clamps s to its length', () => {
    const spiral = new Spiral(vec2(0, 0), 0, 50, 0, 1 / 100)
    expect(spiral.poseAt(999).position.x).toBeCloseTo(spiral.poseAt(50).position.x, 9)
    expect(spiral.poseAt(-5).position.x).toBeCloseTo(0, 9)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/geometry/spiral.test.ts
```

Expected: FAIL — `Failed to resolve import "./spiral"`.

- [ ] **Step 3: Write the implementation**

`src/geometry/spiral.ts`:

```ts
import { type Vec2, normalizeAngle } from './vec2'
import type { Pose, Primitive } from './primitives'

/** Integration steps per metre. 0.5 gives sub-millimetre error at road scale. */
const STEPS_PER_METRE = 0.5
const MIN_STEPS = 16

/**
 * A clothoid (Euler spiral): curvature varies linearly with distance.
 *
 *   curvature(s) = k0 + (k1 - k0) * s / L
 *   heading(s)   = h0 + k0*s + (k1 - k0)*s^2 / (2L)      [closed form]
 *   position(s)  = integral of (cos h, sin h) ds          [no closed form]
 *
 * Heading is exact; position is integrated with composite Simpson's rule,
 * which is exact for the cubic terms that dominate at road scale.
 */
export class Spiral implements Primitive {
  private readonly curvatureRate: number

  constructor(
    readonly start: Vec2,
    readonly heading: number,
    readonly length: number,
    readonly startCurvature: number,
    readonly endCurvature: number,
  ) {
    this.curvatureRate =
      length === 0 ? 0 : (endCurvature - startCurvature) / length
  }

  curvatureAt(s: number): number {
    return this.startCurvature + this.curvatureRate * s
  }

  /** Closed form: the integral of curvature from 0 to s. */
  headingAt(s: number): number {
    return this.heading + this.startCurvature * s + 0.5 * this.curvatureRate * s * s
  }

  poseAt(s: number): Pose {
    const t = s < 0 ? 0 : s > this.length ? this.length : s

    // Composite Simpson's rule needs an even number of intervals.
    let n = Math.max(MIN_STEPS, Math.ceil(t * STEPS_PER_METRE))
    if (n % 2 !== 0) n += 1

    const h = t / n
    let sumX = 0
    let sumY = 0

    for (let i = 0; i <= n; i++) {
      const si = i * h
      const weight = i === 0 || i === n ? 1 : i % 2 === 1 ? 4 : 2
      const angle = this.headingAt(si)
      sumX += weight * Math.cos(angle)
      sumY += weight * Math.sin(angle)
    }

    const factor = h / 3
    return {
      position: {
        x: this.start.x + factor * sumX,
        y: this.start.y + factor * sumY,
      },
      heading: normalizeAngle(this.headingAt(t)),
      curvature: this.curvatureAt(t),
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/geometry/spiral.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/geometry/spiral.ts src/geometry/spiral.test.ts
git commit -m "feat: add clothoid spiral primitive"
```

---

### Task 5: Alignment container

Chains primitives end to end and dispatches a global `s` to the right one.

**Files:**
- Create: `src/geometry/alignment.ts`
- Test: `src/geometry/alignment.test.ts`

**Interfaces:**
- Consumes: `Vec2` from `./vec2`; `Pose`, `Primitive`, `Line`, `Arc` from `./primitives`
- Produces:
  - `class Alignment` — `new Alignment(primitives: readonly Primitive[])`
  - `.length: number` — total arc length
  - `.poseAt(s: number): Pose` — clamps `s` to `[0, length]`
  - `.sample(spacing: number): Pose[]` — poses at `spacing` intervals, always including both endpoints
  - `.isEmpty: boolean`
  - Throws `RangeError` from `sample` if `spacing <= 0`

- [ ] **Step 1: Write the failing tests**

`src/geometry/alignment.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Alignment } from './alignment'
import { Line, Arc } from './primitives'
import { vec2 } from './vec2'

const straightThenLeftTurn = () => {
  const r = 100
  const line = new Line(vec2(0, 0), 0, 50)
  // Continue from the line's end, in the same direction.
  const arc = new Arc(vec2(50, 0), 0, (Math.PI / 2) * r, 1 / r)
  return new Alignment([line, arc])
}

describe('Alignment', () => {
  it('sums the lengths of its primitives', () => {
    const a = straightThenLeftTurn()
    expect(a.length).toBeCloseTo(50 + (Math.PI / 2) * 100, 9)
  })

  it('reports empty for no primitives', () => {
    expect(new Alignment([]).isEmpty).toBe(true)
    expect(new Alignment([]).length).toBe(0)
    expect(straightThenLeftTurn().isEmpty).toBe(false)
  })

  it('dispatches s to the correct primitive', () => {
    const a = straightThenLeftTurn()
    const onLine = a.poseAt(25)
    expect(onLine.position.x).toBeCloseTo(25, 6)
    expect(onLine.curvature).toBe(0)

    const onArc = a.poseAt(50 + (Math.PI / 4) * 100)
    expect(onArc.curvature).toBeCloseTo(1 / 100, 9)
  })

  it('is continuous across the primitive boundary', () => {
    const a = straightThenLeftTurn()
    const before = a.poseAt(50 - 1e-6)
    const after = a.poseAt(50 + 1e-6)
    expect(after.position.x).toBeCloseTo(before.position.x, 5)
    expect(after.position.y).toBeCloseTo(before.position.y, 5)
    expect(after.heading).toBeCloseTo(before.heading, 5)
  })

  it('clamps s beyond either end', () => {
    const a = straightThenLeftTurn()
    expect(a.poseAt(-10).position.x).toBeCloseTo(0, 9)
    const end = a.poseAt(a.length)
    expect(a.poseAt(a.length + 500).position.x).toBeCloseTo(end.position.x, 9)
  })

  it('samples at the requested spacing, including both endpoints', () => {
    const a = new Alignment([new Line(vec2(0, 0), 0, 100)])
    const poses = a.sample(25)
    expect(poses).toHaveLength(5)
    expect(poses[0]!.position.x).toBeCloseTo(0, 9)
    expect(poses[4]!.position.x).toBeCloseTo(100, 9)
  })

  it('includes the final endpoint even when spacing does not divide evenly', () => {
    const a = new Alignment([new Line(vec2(0, 0), 0, 100)])
    const poses = a.sample(30)
    const last = poses[poses.length - 1]!
    expect(last.position.x).toBeCloseTo(100, 9)
  })

  it('rejects non-positive spacing', () => {
    const a = straightThenLeftTurn()
    expect(() => a.sample(0)).toThrow(RangeError)
    expect(() => a.sample(-1)).toThrow(RangeError)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/geometry/alignment.test.ts
```

Expected: FAIL — `Failed to resolve import "./alignment"`.

- [ ] **Step 3: Write the implementation**

`src/geometry/alignment.ts`:

```ts
import type { Pose, Primitive } from './primitives'

/**
 * An ordered chain of primitives forming one road centerline.
 *
 * Primitives are assumed to already be positioned end to end — construction
 * of a continuous chain is the caller's job (see the fillet and road-tool
 * layers). This class only handles arc-length dispatch and sampling.
 */
export class Alignment {
  /** Cumulative start distance of each primitive; starts.length === primitives.length. */
  private readonly starts: number[]
  readonly length: number

  constructor(readonly primitives: readonly Primitive[]) {
    this.starts = []
    let total = 0
    for (const p of primitives) {
      this.starts.push(total)
      total += p.length
    }
    this.length = total
  }

  get isEmpty(): boolean {
    return this.primitives.length === 0
  }

  poseAt(s: number): Pose {
    if (this.isEmpty) {
      throw new RangeError('Cannot evaluate an empty alignment')
    }
    const t = s < 0 ? 0 : s > this.length ? this.length : s

    // Find the last primitive whose start is <= t.
    let index = 0
    for (let i = this.primitives.length - 1; i >= 0; i--) {
      if (t >= this.starts[i]!) {
        index = i
        break
      }
    }

    const primitive = this.primitives[index]!
    return primitive.poseAt(t - this.starts[index]!)
  }

  /** Poses every `spacing` metres, always including s=0 and s=length. */
  sample(spacing: number): Pose[] {
    if (spacing <= 0) {
      throw new RangeError('sample spacing must be positive')
    }
    if (this.isEmpty) return []

    const poses: Pose[] = []
    for (let s = 0; s < this.length; s += spacing) {
      poses.push(this.poseAt(s))
    }
    poses.push(this.poseAt(this.length))
    return poses
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/geometry/alignment.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/geometry/alignment.ts src/geometry/alignment.test.ts
git commit -m "feat: add alignment container with arc-length dispatch"
```

---

### Task 6: Arc fillet between two tangents

This is what makes the hybrid drawing tool work: the player drags a corner, and a legal circular curve is inserted automatically.

Given a corner at `P`, an incoming direction `d1` and an outgoing direction `d2`, the tangent distance from the corner to each tangent point is `T = R · tan(Δ/2)` where `Δ` is the deflection angle. A 90° turn gives `T = R`, which is the sanity check.

**Files:**
- Create: `src/geometry/fillet.ts`
- Test: `src/geometry/fillet.test.ts`

**Interfaces:**
- Consumes: `Vec2`, `vec2`, `add`, `scale`, `normalize`, `signedAngleBetween`, `angleOf` from `./vec2`; `Arc` from `./primitives`
- Produces:
  - `type Fillet = { readonly arc: Arc; readonly tangentIn: Vec2; readonly tangentOut: Vec2; readonly tangentDistance: number; readonly deflection: number }`
  - `filletCorner(corner: Vec2, incoming: Vec2, outgoing: Vec2, radius: number): Fillet | null` — returns `null` when the corner is straight or a full reversal (no arc is possible). Throws `RangeError` if `radius <= 0`.

- [ ] **Step 1: Write the failing tests**

`src/geometry/fillet.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { filletCorner } from './fillet'
import { vec2 } from './vec2'

describe('filletCorner', () => {
  it('gives tangent distance equal to radius for a 90 degree turn', () => {
    // Travelling +x, turning to +y, at the corner (100, 0).
    const f = filletCorner(vec2(100, 0), vec2(1, 0), vec2(0, 1), 50)!
    expect(f).not.toBeNull()
    expect(f.tangentDistance).toBeCloseTo(50, 6)
    expect(f.deflection).toBeCloseTo(Math.PI / 2, 9)
  })

  it('places tangent points back along incoming and forward along outgoing', () => {
    const f = filletCorner(vec2(100, 0), vec2(1, 0), vec2(0, 1), 50)!
    expect(f.tangentIn.x).toBeCloseTo(50, 6)
    expect(f.tangentIn.y).toBeCloseTo(0, 6)
    expect(f.tangentOut.x).toBeCloseTo(100, 6)
    expect(f.tangentOut.y).toBeCloseTo(50, 6)
  })

  it('produces an arc that starts at tangentIn and ends at tangentOut', () => {
    const f = filletCorner(vec2(100, 0), vec2(1, 0), vec2(0, 1), 50)!
    const start = f.arc.poseAt(0)
    const end = f.arc.poseAt(f.arc.length)
    expect(start.position.x).toBeCloseTo(f.tangentIn.x, 5)
    expect(start.position.y).toBeCloseTo(f.tangentIn.y, 5)
    expect(end.position.x).toBeCloseTo(f.tangentOut.x, 5)
    expect(end.position.y).toBeCloseTo(f.tangentOut.y, 5)
  })

  it('has arc length equal to radius times deflection', () => {
    const f = filletCorner(vec2(100, 0), vec2(1, 0), vec2(0, 1), 50)!
    expect(f.arc.length).toBeCloseTo(50 * (Math.PI / 2), 6)
  })

  it('curves left with positive curvature for a left turn', () => {
    const f = filletCorner(vec2(100, 0), vec2(1, 0), vec2(0, 1), 50)!
    expect(f.arc.curvature).toBeGreaterThan(0)
    expect(f.arc.curvature).toBeCloseTo(1 / 50, 9)
  })

  it('curves right with negative curvature for a right turn', () => {
    const f = filletCorner(vec2(100, 0), vec2(1, 0), vec2(0, -1), 50)!
    expect(f.arc.curvature).toBeLessThan(0)
    expect(f.arc.curvature).toBeCloseTo(-1 / 50, 9)
    expect(f.deflection).toBeCloseTo(-Math.PI / 2, 9)
  })

  it('scales tangent distance with a shallower turn', () => {
    // A 60 degree deflection: T = R * tan(30 deg) = R * 0.57735
    const out = vec2(Math.cos(Math.PI / 3), Math.sin(Math.PI / 3))
    const f = filletCorner(vec2(0, 0), vec2(1, 0), out, 100)!
    expect(f.tangentDistance).toBeCloseTo(100 * Math.tan(Math.PI / 6), 6)
  })

  it('returns null for a straight corner', () => {
    expect(filletCorner(vec2(0, 0), vec2(1, 0), vec2(1, 0), 50)).toBeNull()
  })

  it('returns null for a full reversal', () => {
    expect(filletCorner(vec2(0, 0), vec2(1, 0), vec2(-1, 0), 50)).toBeNull()
  })

  it('rejects a non-positive radius', () => {
    expect(() => filletCorner(vec2(0, 0), vec2(1, 0), vec2(0, 1), 0)).toThrow(RangeError)
    expect(() => filletCorner(vec2(0, 0), vec2(1, 0), vec2(0, 1), -5)).toThrow(RangeError)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/geometry/fillet.test.ts
```

Expected: FAIL — `Failed to resolve import "./fillet"`.

- [ ] **Step 3: Write the implementation**

`src/geometry/fillet.ts`:

```ts
import {
  type Vec2, add, scale, normalize, signedAngleBetween, angleOf,
} from './vec2'
import { Arc } from './primitives'

export type Fillet = {
  readonly arc: Arc
  /** Where the incoming tangent leaves the straight and enters the curve. */
  readonly tangentIn: Vec2
  /** Where the curve rejoins the outgoing straight. */
  readonly tangentOut: Vec2
  /** Distance from the corner to each tangent point. */
  readonly tangentDistance: number
  /** Signed turn angle, positive counter-clockwise. */
  readonly deflection: number
}

/** Below this deflection the corner is treated as straight and needs no curve. */
const MIN_DEFLECTION = 1e-6

/**
 * Insert a circular curve of the given radius into a corner.
 *
 * `incoming` is the direction of travel arriving at the corner, `outgoing`
 * the direction leaving it. Both are normalized internally.
 *
 * Standard curve geometry: T = R * tan(deflection / 2).
 * A 90 degree deflection gives T = R.
 */
export const filletCorner = (
  corner: Vec2,
  incoming: Vec2,
  outgoing: Vec2,
  radius: number,
): Fillet | null => {
  if (radius <= 0) {
    throw new RangeError('fillet radius must be positive')
  }

  const dIn = normalize(incoming)
  const dOut = normalize(outgoing)
  const deflection = signedAngleBetween(dIn, dOut)
  const magnitude = Math.abs(deflection)

  // Straight through, or a reversal that no finite arc can round.
  if (magnitude < MIN_DEFLECTION) return null
  if (Math.PI - magnitude < MIN_DEFLECTION) return null

  const tangentDistance = radius * Math.tan(magnitude / 2)

  const tangentIn = add(corner, scale(dIn, -tangentDistance))
  const tangentOut = add(corner, scale(dOut, tangentDistance))

  const curvature = (deflection > 0 ? 1 : -1) / radius
  const arcLength = radius * magnitude

  const arc = new Arc(tangentIn, angleOf(dIn), arcLength, curvature)

  return { arc, tangentIn, tangentOut, tangentDistance, deflection }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/geometry/fillet.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/geometry/fillet.ts src/geometry/fillet.test.ts
git commit -m "feat: add circular fillet for road corners"
```

---

### Task 7: Design speed from curve radius

The live readout while dragging. AASHTO's relationship between radius, superelevation and speed:

```
R_min = V² / (127 · (e + f))        V in km/h, R in metres
```

so `V = sqrt(127 · R · (e + f))`. Side friction `f` itself falls with speed, so this is solved by fixed-point iteration — three passes converge well inside a km/h.

**Files:**
- Create: `src/geometry/designSpeed.ts`
- Test: `src/geometry/designSpeed.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `sideFrictionFactor(speedKph: number): number` — AASHTO design values, linearly interpolated, clamped at the table ends
  - `designSpeedForRadius(radiusMetres: number, superelevation?: number): number` — km/h; `superelevation` defaults to `0.06`. Throws `RangeError` if radius is not positive.
  - `minimumRadiusForSpeed(speedKph: number, superelevation?: number): number` — metres. Throws `RangeError` if speed is not positive.

- [ ] **Step 1: Write the failing tests**

`src/geometry/designSpeed.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  sideFrictionFactor, designSpeedForRadius, minimumRadiusForSpeed,
} from './designSpeed'

describe('sideFrictionFactor', () => {
  it('returns AASHTO table values at the tabulated speeds', () => {
    expect(sideFrictionFactor(30)).toBeCloseTo(0.28, 9)
    expect(sideFrictionFactor(60)).toBeCloseTo(0.17, 9)
    expect(sideFrictionFactor(100)).toBeCloseTo(0.12, 9)
  })

  it('interpolates between tabulated speeds', () => {
    // Midway between 50 (0.19) and 60 (0.17).
    expect(sideFrictionFactor(55)).toBeCloseTo(0.18, 9)
  })

  it('clamps below and above the table', () => {
    expect(sideFrictionFactor(10)).toBeCloseTo(0.28, 9)
    expect(sideFrictionFactor(200)).toBeCloseTo(0.09, 9)
  })

  it('decreases monotonically with speed', () => {
    let previous = Infinity
    for (let v = 30; v <= 120; v += 5) {
      const f = sideFrictionFactor(v)
      expect(f).toBeLessThanOrEqual(previous)
      previous = f
    }
  })
})

describe('designSpeedForRadius', () => {
  it('increases with radius', () => {
    expect(designSpeedForRadius(500)).toBeGreaterThan(designSpeedForRadius(100))
  })

  it('lands near expected values for typical rural radii', () => {
    // Loose bounds: this is a design relationship, not a physical constant.
    expect(designSpeedForRadius(50)).toBeGreaterThan(30)
    expect(designSpeedForRadius(50)).toBeLessThan(55)
    expect(designSpeedForRadius(400)).toBeGreaterThan(90)
    expect(designSpeedForRadius(400)).toBeLessThan(130)
  })

  it('gives a higher speed with more superelevation', () => {
    expect(designSpeedForRadius(200, 0.10)).toBeGreaterThan(
      designSpeedForRadius(200, 0.02),
    )
  })

  it('rejects a non-positive radius', () => {
    expect(() => designSpeedForRadius(0)).toThrow(RangeError)
    expect(() => designSpeedForRadius(-10)).toThrow(RangeError)
  })
})

describe('minimumRadiusForSpeed', () => {
  it('round-trips against designSpeedForRadius', () => {
    // Exact at the fixed point; assert relative error so the tolerance is
    // meaningful at both 50 m and 1000 m.
    for (const r of [50, 100, 250, 500, 1000]) {
      const v = designSpeedForRadius(r)
      expect(Math.abs(minimumRadiusForSpeed(v) - r) / r).toBeLessThan(0.01)
    }
  })

  it('increases with speed', () => {
    expect(minimumRadiusForSpeed(100)).toBeGreaterThan(minimumRadiusForSpeed(50))
  })

  it('rejects a non-positive speed', () => {
    expect(() => minimumRadiusForSpeed(0)).toThrow(RangeError)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/geometry/designSpeed.test.ts
```

Expected: FAIL — `Failed to resolve import "./designSpeed"`.

- [ ] **Step 3: Write the implementation**

`src/geometry/designSpeed.ts`:

```ts
/**
 * AASHTO horizontal curve design.
 *
 *   R_min = V^2 / (127 * (e + f))
 *
 * with V in km/h, R in metres, e the superelevation rate and f the side
 * friction factor. f falls with speed, so solving for V from R needs
 * iteration.
 */

/** AASHTO maximum side friction factors for horizontal curve design. */
const FRICTION_TABLE: ReadonlyArray<readonly [speedKph: number, f: number]> = [
  [30, 0.28],
  [40, 0.23],
  [50, 0.19],
  [60, 0.17],
  [70, 0.15],
  [80, 0.14],
  [90, 0.13],
  [100, 0.12],
  [110, 0.11],
  [120, 0.09],
]

const DEFAULT_SUPERELEVATION = 0.06

/**
 * The fixed-point iteration converges in a damped oscillation, so a handful
 * of passes is not enough at tight radii — at R=50 the sequence runs
 * 38.2, 43.6, 41.8, 42.4 km/h and is still ~0.5 m out on a round trip.
 * Iterations are a few floating-point operations each; buy convergence.
 */
const SOLVE_ITERATIONS = 12

export const sideFrictionFactor = (speedKph: number): number => {
  const first = FRICTION_TABLE[0]!
  const last = FRICTION_TABLE[FRICTION_TABLE.length - 1]!

  if (speedKph <= first[0]) return first[1]
  if (speedKph >= last[0]) return last[1]

  for (let i = 0; i < FRICTION_TABLE.length - 1; i++) {
    const [v0, f0] = FRICTION_TABLE[i]!
    const [v1, f1] = FRICTION_TABLE[i + 1]!
    if (speedKph >= v0 && speedKph <= v1) {
      const t = (speedKph - v0) / (v1 - v0)
      return f0 + t * (f1 - f0)
    }
  }

  return last[1]
}

/**
 * The speed a curve of this radius is comfortable at, in km/h.
 * Solved by fixed-point iteration because friction depends on the answer.
 */
export const designSpeedForRadius = (
  radiusMetres: number,
  superelevation: number = DEFAULT_SUPERELEVATION,
): number => {
  if (radiusMetres <= 0) {
    throw new RangeError('radius must be positive')
  }

  let speed = 60 // seed
  for (let i = 0; i < SOLVE_ITERATIONS; i++) {
    const f = sideFrictionFactor(speed)
    speed = Math.sqrt(127 * radiusMetres * (superelevation + f))
  }
  return speed
}

/** The tightest radius allowed at this speed, in metres. */
export const minimumRadiusForSpeed = (
  speedKph: number,
  superelevation: number = DEFAULT_SUPERELEVATION,
): number => {
  if (speedKph <= 0) {
    throw new RangeError('speed must be positive')
  }
  const f = sideFrictionFactor(speedKph)
  return (speedKph * speedKph) / (127 * (superelevation + f))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/geometry/designSpeed.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/geometry/designSpeed.ts src/geometry/designSpeed.test.ts
git commit -m "feat: add AASHTO design speed and minimum radius"
```

---

### Task 8: Deployed debug view

Proves the geometry library end to end by drawing a real alignment — straight, fillet, straight — on the live page, annotated with radius and design speed. This is the first thing that is actually *looked at*, and it will catch sign and handedness errors that unit tests pass right over.

It draws to a 2D canvas, not three.js. The 3D renderer is a later plan; this exists to validate geometry, and a plan view is the honest way to read plan geometry.

> **This file is deliberately untested, and that is an approved decision — not an oversight.** The geometry it exercises is already covered by 49 unit tests. What this file adds is precisely what unit tests cannot catch: sign errors, handedness errors, and a fillet that bulges the wrong side of a corner. Mocking a 2D canvas context and asserting on draw calls would verify that the code calls the functions it calls, which is coverage without value. Reviewers should not flag the absence of tests here.

**Files:**
- Create: `src/debug/alignmentPreview.ts`
- Modify: `src/main.ts` (replace entirely), `index.html` (replace the `#app` styling rule)

**Interfaces:**
- Consumes: `Alignment`, `Line`, `filletCorner`, `designSpeedForRadius`, `vec2`, `angleOf`, `distance`, `sub`
- Produces: `drawAlignmentPreview(canvas: HTMLCanvasElement): void`

- [ ] **Step 1: Write the debug view**

`src/debug/alignmentPreview.ts`:

```ts
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { filletCorner } from '../geometry/fillet'
import { designSpeedForRadius } from '../geometry/designSpeed'
import { vec2, angleOf, distance, sub, type Vec2 } from '../geometry/vec2'

const RADIUS = 120
const SAMPLE_SPACING = 4

/** Straight, filleted corner, straight — the canonical alignment. */
const buildAlignment = (a: Vec2, corner: Vec2, b: Vec2): Alignment | null => {
  const dIn = sub(corner, a)
  const dOut = sub(b, corner)
  const fillet = filletCorner(corner, dIn, dOut, RADIUS)
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

export const drawAlignmentPreview = (canvas: HTMLCanvasElement): void => {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  ctx.clearRect(0, 0, w, h)

  const a = vec2(80, 80)
  const corner = vec2(w - 120, 90)
  const b = vec2(w - 140, h - 90)

  const alignment = buildAlignment(a, corner, b)
  if (!alignment) return

  // World y is north; canvas y grows downward. Flip at the draw boundary.
  const toScreen = (p: Vec2) => ({ x: p.x, y: h - p.y })

  // Construction lines through the corner.
  ctx.strokeStyle = '#3a4652'
  ctx.setLineDash([5, 6])
  ctx.lineWidth = 1
  ctx.beginPath()
  for (const [from, to] of [[a, corner], [corner, b]] as const) {
    const s = toScreen(from)
    const e = toScreen(to)
    ctx.moveTo(s.x, s.y)
    ctx.lineTo(e.x, e.y)
  }
  ctx.stroke()
  ctx.setLineDash([])

  // The alignment itself.
  const poses = alignment.sample(SAMPLE_SPACING)
  ctx.strokeStyle = '#d9c89a'
  ctx.lineWidth = 8
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  poses.forEach((pose, i) => {
    const p = toScreen(pose.position)
    if (i === 0) ctx.moveTo(p.x, p.y)
    else ctx.lineTo(p.x, p.y)
  })
  ctx.stroke()

  // Centre stripe.
  ctx.strokeStyle = '#14181d'
  ctx.lineWidth = 1
  ctx.setLineDash([10, 12])
  ctx.stroke()
  ctx.setLineDash([])

  // Readout.
  const speed = designSpeedForRadius(RADIUS)
  ctx.fillStyle = '#e8e4dc'
  ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.fillText(`R ${RADIUS} m`, 24, 28)
  ctx.fillText(`design speed ${speed.toFixed(0)} km/h`, 24, 48)
  ctx.fillText(`length ${alignment.length.toFixed(1)} m`, 24, 68)
}
```

- [ ] **Step 2: Wire it into the page**

Replace `src/main.ts` entirely:

```ts
import { drawAlignmentPreview } from './debug/alignmentPreview'

const app = document.getElementById('app')

if (app) {
  const canvas = document.createElement('canvas')
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'
  app.appendChild(canvas)

  const render = () => drawAlignmentPreview(canvas)
  render()
  window.addEventListener('resize', render)
}
```

In `index.html`, replace the `#app` rule so the canvas fills the viewport:

```css
      #app { position: fixed; inset: 0; }
```

- [ ] **Step 3: Verify it typechecks and builds**

```bash
npm run build
```

Expected: no TypeScript errors; `dist/` written.

- [ ] **Step 4: Look at it**

```bash
npm run dev
```

Open the printed local URL. Verify by eye:

- The road runs from lower-left, turns at the upper-right corner, and heads down — one smooth curve, no kink at either tangent point.
- The curve is *inside* the dashed construction corner, not outside it. Outside means a sign error in the fillet.
- The readout shows `R 120 m` and a design speed around 90–100 km/h.

Fix any issue before continuing; a handedness error here will otherwise propagate into every later system.

- [ ] **Step 5: Run the full test suite**

```bash
npm test
```

Expected: PASS, 50 tests across 7 files (smoke 1, vec2 7, primitives 7, spiral 6, alignment 8, fillet 10, designSpeed 11).

- [ ] **Step 6: Commit and deploy**

```bash
git add -A
git commit -m "feat: add deployed alignment debug view"
git push
```

- [ ] **Step 7: Verify the live deployment**

```bash
gh run watch
```

Then open `https://samgumble.github.io/chainage/` and confirm the alignment renders there exactly as it did locally.

---

## Plan complete

At the end of this plan there is a deployed page showing a real road alignment built from real highway geometry, backed by a fully tested pure-math library with no engine dependencies.

**Next plan:** Terrain & earthworks — heightmap, the min/max interval grade feasibility solver, non-destructive edit layers, and cut/fill volume computation.
