# Diorama Look Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it look like an architectural model on a table — shallow depth of field, believable light, materials that read as real surfaces.

**Architecture:** Spec §6 asks for three things, and each has a core of arithmetic that can be got wrong invisibly: where the sun is and what colour it is, how rough and how dark each surface is, and how much a pixel blurs given its depth. Those three go in pure modules with tests. The renderer configuration, the shadow map and the post-processing chain are glue in the scene, verified by looking at it.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), vitest 4, three.js 0.185. Post-processing uses three's own `EffectComposer`, which ships inside the `three` package — no new dependency.

## Global Constraints

- **Dependency direction:** `geometry/` imports nothing outside itself. `terrain/` imports `geometry/`. `network/` imports `geometry/`, `terrain/groundProfile` and its own `roadClass`. `mesh/` imports `geometry/`, `terrain/` and `network/`. `tool/` imports `geometry/`, `terrain/`, `network/` and `mesh/`. `render/` imports `mesh/`, `tool/`, `network/` and three.js. `debug/` may import anything.
- **`src/geometry/`, `src/terrain/`, `src/network/`, `src/mesh/` and `src/tool/` must NOT import three.js.** In `render/`, the three new modules in this plan must also not import it — they produce plain numbers and strings, which is what makes them testable without a renderer. `src/render/cameraRig.ts` already follows this rule.
- Coordinates `(x, y)` in metres with `y` north; `z` positive up. Handedness conversion to three.js `(x, z, −y)` happens only where three.js objects are constructed.
- **Report rather than approximate.**
- **TypeScript** `strict: true`, `noUncheckedIndexedAccess: true`. No `any`. No non-null assertion on a value that could genuinely be absent.
- **Tests must discriminate.** Three branches running, every defect that survived review was a test that passed against its own property deleted. For each behavioural test, remove the code it covers and confirm it fails. That check is part of the task.
- Tests colocate with source as `<name>.test.ts`. Run the suite with `npm test`, types with `npx tsc --noEmit`. Both clean at every commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/render/sunlight.ts` (create) | Where the sun is, what colour, how bright, at a time of day |
| `src/render/materials.ts` (create) | Roughness, colour and metalness for every surface the world draws |
| `src/render/tiltShift.ts` (create) | How much a pixel blurs given its depth, and the shader that does it |
| `src/debug/roadScene.ts` (modify) | Shadows, tone mapping, the post chain, and the framing that makes it a miniature |

---

### Task 1: Where the sun is

"Believable light" is mostly one thing: a sun low enough to cast long shadows and warm enough to look like a time of day rather than a lamp. Both come from the same arithmetic, and both are easy to get subtly wrong in a way nobody notices until the scene looks like a product render.

**Files:**
- Create: `src/render/sunlight.ts`
- Create: `src/render/sunlight.test.ts`

**Interfaces:**
- Consumes: nothing. This file must not import three.js.
- Produces: `sunAt(hourOfDay: number): Sunlight`, the `Sunlight` type, and `SUNRISE_HOUR`, `SUNSET_HOUR`, `MAX_SUN_ELEVATION`.

The sun rises in the east, crosses to the south at midday, and sets in the west — northern hemisphere, which is the convention the terrain generator already implies. In this project's coordinates that is `+x` at sunrise, `−y` at noon, `−x` at sunset.

- [ ] **Step 1: Write the failing tests**

Create `src/render/sunlight.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  MAX_SUN_ELEVATION,
  SUNRISE_HOUR,
  SUNSET_HOUR,
  sunAt,
} from './sunlight'

const NOON = (SUNRISE_HOUR + SUNSET_HOUR) / 2

const channels = (colour: number) => ({
  r: (colour >> 16) & 0xff,
  g: (colour >> 8) & 0xff,
  b: colour & 0xff,
})

describe('sunAt', () => {
  it('always returns a unit direction', () => {
    for (let hour = 0; hour < 24; hour += 0.5) {
      const { direction } = sunAt(hour)
      const length = Math.hypot(direction.x, direction.y, direction.z)
      expect(length).toBeCloseTo(1, 9)
    }
  })

  it('puts the sun in the east at sunrise', () => {
    const { direction } = sunAt(SUNRISE_HOUR)
    expect(direction.x).toBeGreaterThan(0.9)
    expect(direction.z).toBeCloseTo(0, 3)
  })

  it('puts the sun in the west at sunset', () => {
    const { direction } = sunAt(SUNSET_HOUR)
    expect(direction.x).toBeLessThan(-0.9)
    expect(direction.z).toBeCloseTo(0, 3)
  })

  it('puts the sun to the south at midday', () => {
    const { direction } = sunAt(NOON)
    // South is -y in this project's coordinates.
    expect(direction.y).toBeLessThan(0)
    expect(Math.abs(direction.x)).toBeLessThan(0.1)
  })

  it('is highest at midday and never higher than the stated maximum', () => {
    const noon = sunAt(NOON).direction.z
    expect(noon).toBeCloseTo(Math.sin(MAX_SUN_ELEVATION), 6)

    for (let hour = SUNRISE_HOUR; hour <= SUNSET_HOUR; hour += 0.25) {
      expect(sunAt(hour).direction.z).toBeLessThanOrEqual(noon + 1e-9)
    }
  })

  it('climbs through the morning and falls through the afternoon', () => {
    const morning = [8, 9, 10, 11].map((h) => sunAt(h).direction.z)
    const afternoon = [13, 14, 15, 16].map((h) => sunAt(h).direction.z)

    for (let i = 1; i < morning.length; i++) {
      expect(morning[i]!).toBeGreaterThan(morning[i - 1]!)
    }
    for (let i = 1; i < afternoon.length; i++) {
      expect(afternoon[i]!).toBeLessThan(afternoon[i - 1]!)
    }
  })

  it('is brightest at midday and dark at night', () => {
    expect(sunAt(NOON).intensity).toBeGreaterThan(sunAt(SUNRISE_HOUR + 1).intensity)
    expect(sunAt(3).intensity).toBe(0)
    expect(sunAt(23).intensity).toBe(0)
  })

  it('is warmer near the horizon than overhead', () => {
    const low = channels(sunAt(SUNRISE_HOUR + 0.2).colour)
    const high = channels(sunAt(NOON).colour)

    // Warmth is red relative to blue, not red alone — a dimmer light has less
    // of every channel, so comparing red against red would prove nothing.
    expect(low.r / low.b).toBeGreaterThan(high.r / high.b)
  })

  it('never emits a channel outside a byte', () => {
    for (let hour = 0; hour < 24; hour += 0.5) {
      const { r, g, b } = channels(sunAt(hour).colour)
      for (const value of [r, g, b]) {
        expect(Number.isInteger(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(255)
      }
    }
  })

  it('treats the hour cyclically rather than throwing', () => {
    expect(sunAt(24 + NOON).direction.z).toBeCloseTo(sunAt(NOON).direction.z, 9)
    expect(sunAt(-24 + NOON).direction.z).toBeCloseTo(sunAt(NOON).direction.z, 9)
  })
})
```

The warmth test compares a *ratio* rather than a channel. A test asserting "more red at dawn" passes for a light that is simply brighter overall, which is the opposite of what dawn looks like.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/render/sunlight.test.ts`

Expected: FAIL — cannot resolve `./sunlight`.

- [ ] **Step 3: Implement**

Create `src/render/sunlight.ts`:

```ts
export type Vec3 = {
  readonly x: number
  readonly y: number
  readonly z: number
}

export type Sunlight = {
  /** Unit vector from the ground toward the sun. */
  readonly direction: Vec3
  /** Packed 0xRRGGBB. */
  readonly colour: number
  /** Zero at night, peaking at midday. */
  readonly intensity: number
}

export const SUNRISE_HOUR = 6
export const SUNSET_HOUR = 18

/**
 * How high the sun climbs at midday, radians.
 *
 * Deliberately not overhead. A sun near the zenith flattens everything: the
 * shadows that make a model read as a model are the long ones, and a scene lit
 * from straight above looks like a product photograph instead.
 */
export const MAX_SUN_ELEVATION = Math.PI / 3

/** Brightness at midday. */
const PEAK_INTENSITY = 4.5

/** Colour at midday and at the horizon, packed 0xRRGGBB. */
const OVERHEAD_COLOUR = { r: 0xff, g: 0xf4, b: 0xe2 }
const HORIZON_COLOUR = { r: 0xff, g: 0xb1, b: 0x6a }

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value)

const mix = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * Where the sun is, what colour and how bright, at an hour of the day.
 *
 * A simple arc rather than an ephemeris: it rises in the east, crosses to the
 * south at midday and sets in the west, which in this project's coordinates is
 * `+x`, then `−y`, then `−x`. Accuracy to the minute would buy nothing — what
 * matters is that the light has a direction a viewer can read as a time of day,
 * and that it is low enough to throw the long shadows a miniature needs.
 */
export const sunAt = (hourOfDay: number): Sunlight => {
  // Wrap rather than reject: a caller animating a clock should not have to
  // remember to take a modulus, and there is no such thing as an invalid hour.
  const hour = ((hourOfDay % 24) + 24) % 24

  const dayLength = SUNSET_HOUR - SUNRISE_HOUR
  // 0 at sunrise, 1 at sunset. Outside the day it leaves [0, 1] and the sun
  // sits below the horizon, which is exactly what the intensity check wants.
  const t = (hour - SUNRISE_HOUR) / dayLength
  const isDay = t >= 0 && t <= 1

  const elevation = MAX_SUN_ELEVATION * Math.sin(Math.PI * t)
  // Azimuth measured from east, sweeping south: 0 at sunrise, −pi at sunset.
  const azimuth = -Math.PI * t

  const horizontal = Math.cos(elevation)
  const direction: Vec3 = {
    x: horizontal * Math.cos(azimuth),
    y: horizontal * Math.sin(azimuth),
    z: Math.sin(elevation),
  }

  if (!isDay) {
    return { direction, colour: (HORIZON_COLOUR.r << 16) | (HORIZON_COLOUR.g << 8) | HORIZON_COLOUR.b, intensity: 0 }
  }

  // Height above the horizon, as a fraction of the day's maximum. Drives both
  // the warmth and the brightness, so a low sun is dim and orange together.
  const height = clamp01(Math.sin(elevation) / Math.sin(MAX_SUN_ELEVATION))

  const r = Math.round(mix(HORIZON_COLOUR.r, OVERHEAD_COLOUR.r, height))
  const g = Math.round(mix(HORIZON_COLOUR.g, OVERHEAD_COLOUR.g, height))
  const b = Math.round(mix(HORIZON_COLOUR.b, OVERHEAD_COLOUR.b, height))

  return {
    direction,
    colour: (r << 16) | (g << 8) | b,
    intensity: PEAK_INTENSITY * height,
  }
}
```

- [ ] **Step 4: Run the tests, then confirm they discriminate**

Run: `npx vitest run src/render/sunlight.test.ts`

Then, reverting each: make the azimuth sweep positive rather than negative and confirm the midday-south test fails; drop the `height` factor from `intensity` and confirm the brightness test fails; return `OVERHEAD_COLOUR` unconditionally and confirm the warmth test fails. Record all three outcomes.

- [ ] **Step 5: Run everything, check types and commit**

```bash
git add src/render/sunlight.ts src/render/sunlight.test.ts
git commit -m "feat: sun direction, colour and brightness from the time of day"
```

---

### Task 2: What each surface is made of

The scene currently picks colours from a small lookup and leaves roughness and metalness at their defaults, so every surface has the same sheen. Asphalt, gravel, concrete and grass do not reflect light the same way, and that difference is most of what makes a render read as physical.

**Files:**
- Create: `src/render/materials.ts`
- Create: `src/render/materials.test.ts`

**Interfaces:**
- Consumes: `LayerName` from `src/network/roadClass` (type-only). Must not import three.js.
- Produces: `SURFACES`, `surfaceFor(name: SurfaceName): Surface`, and the `Surface` and `SurfaceName` types.

- [ ] **Step 1: Write the failing tests**

Create `src/render/materials.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ROAD_CLASSES } from '../network/roadClass'
import { SURFACES, type SurfaceName, surfaceFor } from './materials'

const luminance = (colour: number): number => {
  const r = (colour >> 16) & 0xff
  const g = (colour >> 8) & 0xff
  const b = colour & 0xff
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

describe('SURFACES', () => {
  it('covers every pavement layer the road classes name', () => {
    const layers = new Set(
      Object.values(ROAD_CLASSES).flatMap((rc) => rc.layers.map((l) => l.name)),
    )
    for (const layer of layers) {
      expect(SURFACES).toHaveProperty(layer)
    }
  })

  it('gives every surface a physically sane roughness and metalness', () => {
    for (const [name, surface] of Object.entries(SURFACES)) {
      expect(surface.roughness, name).toBeGreaterThan(0)
      expect(surface.roughness, name).toBeLessThanOrEqual(1)
      expect(surface.metalness, name).toBeGreaterThanOrEqual(0)
      expect(surface.metalness, name).toBeLessThanOrEqual(1)
    }
  })

  it('makes nothing metallic, because none of it is metal', () => {
    for (const [name, surface] of Object.entries(SURFACES)) {
      expect(surface.metalness, name).toBeLessThan(0.2)
    }
  })

  it('keeps every colour inside a byte per channel', () => {
    for (const [name, surface] of Object.entries(SURFACES)) {
      expect(Number.isInteger(surface.colour), name).toBe(true)
      expect(surface.colour, name).toBeGreaterThanOrEqual(0)
      expect(surface.colour, name).toBeLessThanOrEqual(0xffffff)
    }
  })

  it('makes the wearing course darker than the base it sits on', () => {
    // Sealed asphalt against an unsealed granular base: the seal is much darker.
    expect(luminance(SURFACES.wearing.colour)).toBeLessThan(
      luminance(SURFACES.base.colour),
    )
  })

  it('makes the sealed surface smoother than the granular ones', () => {
    expect(SURFACES.wearing.roughness).toBeLessThan(SURFACES.base.roughness)
    expect(SURFACES.wearing.roughness).toBeLessThan(SURFACES.subgrade.roughness)
  })

  it('makes concrete lighter and smoother than asphalt', () => {
    expect(luminance(SURFACES.concrete.colour)).toBeGreaterThan(
      luminance(SURFACES.wearing.colour),
    )
    expect(SURFACES.concrete.roughness).toBeLessThan(SURFACES.base.roughness)
  })

  it('never makes a surface a perfect mirror or perfectly matte', () => {
    // Both extremes read as computer-generated rather than as a real material.
    for (const [name, surface] of Object.entries(SURFACES)) {
      expect(surface.roughness, name).toBeGreaterThan(0.05)
      expect(surface.roughness, name).toBeLessThan(1)
    }
  })
})

describe('surfaceFor', () => {
  it('returns the named surface', () => {
    expect(surfaceFor('wearing')).toBe(SURFACES.wearing)
  })

  it('has an entry for every name in the union', () => {
    const names: SurfaceName[] = [
      'subgrade',
      'base',
      'wearing',
      'concrete',
      'terrain',
      'cutFace',
    ]
    for (const name of names) {
      expect(surfaceFor(name)).toBeDefined()
    }
  })
})
```

"Covers every pavement layer the road classes name" is the test that keeps this in step: adding a layer to `ROAD_CLASSES` without giving it a surface will fail here rather than silently rendering in the fallback grey the scene currently uses.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/render/materials.test.ts`

Expected: FAIL — cannot resolve `./materials`.

- [ ] **Step 3: Implement**

Create `src/render/materials.ts`:

```ts
import type { LayerName } from '../network/roadClass'

/**
 * Every surface the world draws.
 *
 * The pavement layers come from `LayerName` so the two cannot drift; the rest
 * are the surfaces that are not part of a pavement.
 */
export type SurfaceName = LayerName | 'concrete' | 'terrain' | 'cutFace'

export type Surface = {
  /** Base colour, packed 0xRRGGBB. */
  readonly colour: number
  /** 0 is a mirror, 1 is entirely diffuse. */
  readonly roughness: number
  /** Non-metals sit at 0; nothing here is metal. */
  readonly metalness: number
}

/**
 * What each surface is made of.
 *
 * Roughness is doing most of the work. A sealed wearing course reflects the sky
 * along its length and a granular base does not, and that difference is more of
 * what makes a render read as physical than the colours are — which is why the
 * tests assert the *relationships* between these numbers rather than the
 * numbers themselves. The values are free to be tuned; asphalt being smoother
 * and darker than the base it sits on is not.
 */
export const SURFACES: Readonly<Record<SurfaceName, Surface>> = {
  /** Compacted earth: dull, mid-brown, and completely diffuse. */
  subgrade: { colour: 0x6b5a45, roughness: 0.95, metalness: 0 },
  /** Unsealed granular base: paler, still rough. */
  base: { colour: 0x8a8175, roughness: 0.9, metalness: 0 },
  /** Sealed asphalt: dark, and smooth enough to catch the sky. */
  wearing: { colour: 0x33363a, roughness: 0.55, metalness: 0 },
  /** Structural concrete — bridge decks, abutments, retaining walls. */
  concrete: { colour: 0x9d9a93, roughness: 0.7, metalness: 0 },
  /** Undisturbed ground. */
  terrain: { colour: 0x7f8f5e, roughness: 0.95, metalness: 0 },
  /** Freshly cut earth, exposed by excavation: rawer than the ground above it. */
  cutFace: { colour: 0x7a6547, roughness: 0.95, metalness: 0 },
}

export const surfaceFor = (name: SurfaceName): Surface => SURFACES[name]
```

- [ ] **Step 4: Run the tests, then confirm they discriminate**

Run: `npx vitest run src/render/materials.test.ts`

Then, reverting each: give `wearing` a roughness above `base`'s and confirm the smoothness test fails; make `wearing` lighter than `base` and confirm the darkness test fails; remove the `subgrade` entry and confirm the coverage test fails. Record all three outcomes.

- [ ] **Step 5: Run everything, check types and commit**

```bash
git add src/render/materials.ts src/render/materials.test.ts
git commit -m "feat: physically-based surface definitions"
```

---

### Task 3: How much a pixel blurs

Tilt-shift is a lens effect, and the thing that makes it read as *miniature* rather than merely soft is that the blur grows with distance from a narrow focal plane. Get the falloff wrong and it looks like fog; get the focal plane wrong and the thing the player is working on is the blurriest part of the screen.

The arithmetic is small and entirely testable. The shader that applies it is not, so this task keeps them separable: the profile is a function, and the shader source is a string this task also owns — with a test that the two agree about the uniforms they share, which is the one way a shader can silently break without anyone noticing.

**Files:**
- Create: `src/render/tiltShift.ts`
- Create: `src/render/tiltShift.test.ts`

**Interfaces:**
- Consumes: nothing. Must not import three.js — this file produces numbers and a shader source string, and the scene builds the pass from them.
- Produces: `blurFractionAt(depth, focus)`, `TiltShiftFocus`, `TILT_SHIFT_FRAGMENT_SHADER`, `TILT_SHIFT_UNIFORM_NAMES`, `MAX_BLUR_PIXELS`.

- [ ] **Step 1: Write the failing tests**

Create `src/render/tiltShift.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  MAX_BLUR_PIXELS,
  TILT_SHIFT_FRAGMENT_SHADER,
  TILT_SHIFT_UNIFORM_NAMES,
  type TiltShiftFocus,
  blurFractionAt,
} from './tiltShift'

const focus: TiltShiftFocus = { distance: 800, range: 300, falloff: 900 }

describe('blurFractionAt', () => {
  it('is sharp at the focal distance', () => {
    expect(blurFractionAt(800, focus)).toBe(0)
  })

  it('is sharp anywhere inside the focal range', () => {
    expect(blurFractionAt(800 - focus.range / 2, focus)).toBe(0)
    expect(blurFractionAt(800 + focus.range / 2, focus)).toBe(0)
  })

  it('blurs both nearer and further than the focal range', () => {
    expect(blurFractionAt(300, focus)).toBeGreaterThan(0)
    expect(blurFractionAt(1500, focus)).toBeGreaterThan(0)
  })

  it('blurs more the further from focus, in both directions', () => {
    expect(blurFractionAt(200, focus)).toBeGreaterThan(blurFractionAt(400, focus))
    expect(blurFractionAt(2000, focus)).toBeGreaterThan(blurFractionAt(1200, focus))
  })

  it('never exceeds one', () => {
    for (const depth of [0, 1, 500, 800, 5000, 1e6]) {
      expect(blurFractionAt(depth, focus)).toBeLessThanOrEqual(1)
      expect(blurFractionAt(depth, focus)).toBeGreaterThanOrEqual(0)
    }
  })

  it('reaches full blur exactly one falloff beyond the range', () => {
    const edge = 800 + focus.range / 2
    expect(blurFractionAt(edge + focus.falloff, focus)).toBeCloseTo(1, 9)
  })

  it('is symmetric about the focal distance', () => {
    const offset = 500
    expect(blurFractionAt(800 + offset, focus)).toBeCloseTo(
      blurFractionAt(800 - offset, focus),
      9,
    )
  })

  it('treats a zero range as a single sharp plane rather than dividing by zero', () => {
    const knife: TiltShiftFocus = { distance: 500, range: 0, falloff: 100 }
    expect(blurFractionAt(500, knife)).toBe(0)
    expect(Number.isFinite(blurFractionAt(600, knife))).toBe(true)
    expect(blurFractionAt(600, knife)).toBeCloseTo(1, 9)
  })

  it('rejects a non-positive falloff rather than dividing by zero', () => {
    expect(() => blurFractionAt(100, { distance: 500, range: 10, falloff: 0 })).toThrow(
      RangeError,
    )
  })

  it('handles a depth behind the camera without producing a negative blur', () => {
    expect(blurFractionAt(-50, focus)).toBeGreaterThanOrEqual(0)
    expect(blurFractionAt(-50, focus)).toBeLessThanOrEqual(1)
  })
})

describe('TILT_SHIFT_FRAGMENT_SHADER', () => {
  it('declares every uniform the pass will supply', () => {
    for (const name of TILT_SHIFT_UNIFORM_NAMES) {
      expect(TILT_SHIFT_FRAGMENT_SHADER).toMatch(
        new RegExp(`uniform\\s+\\w+\\s+${name}\\s*;`),
      )
    }
  })

  it('names no uniform the pass will not supply', () => {
    const declared = [...TILT_SHIFT_FRAGMENT_SHADER.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map(
      (m) => m[1],
    )
    for (const name of declared) {
      expect(TILT_SHIFT_UNIFORM_NAMES).toContain(name)
    }
  })

  it('writes a fragment colour', () => {
    expect(TILT_SHIFT_FRAGMENT_SHADER).toMatch(/gl_FragColor\s*=/)
  })

  it('reaches the same full-blur bound as the profile', () => {
    expect(TILT_SHIFT_FRAGMENT_SHADER).toContain(String(MAX_BLUR_PIXELS))
  })
})
```

The two uniform tests are the point of the shader half. A renamed uniform is silent — the pass sets a value nobody reads, the shader reads a value nobody sets, and the effect quietly does nothing or turns everything to mush. Checking the declaration list in both directions catches it at test time instead.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/render/tiltShift.test.ts`

Expected: FAIL — cannot resolve `./tiltShift`.

- [ ] **Step 3: Implement**

Create `src/render/tiltShift.ts`. The profile:

```ts
export type TiltShiftFocus = {
  /** Distance from the camera that is perfectly sharp, metres. */
  readonly distance: number
  /** Total depth around that distance which stays sharp, metres. */
  readonly range: number
  /** How far beyond the sharp range blur takes to reach maximum, metres. */
  readonly falloff: number
}

/** Blur radius at full strength, in pixels. */
export const MAX_BLUR_PIXELS = 6

/** Uniforms the pass supplies and the shader reads. Must agree exactly. */
export const TILT_SHIFT_UNIFORM_NAMES = [
  'tDiffuse',
  'tDepth',
  'uFocusDistance',
  'uFocusRange',
  'uFocusFalloff',
  'uNear',
  'uFar',
  'uTexelSize',
] as const

/**
 * How blurred a pixel at a given depth should be, from 0 to 1.
 *
 * Zero inside the sharp band, then rising linearly to full over `falloff`. A
 * linear ramp rather than anything smoother on purpose: the effect that makes
 * a scene read as miniature is a *narrow* sharp band with a quick transition,
 * and a gentle curve reads as haze instead.
 *
 * Symmetric about the focal distance — near and far blur alike, which is what
 * a real shallow depth of field does and what separates the look from fog.
 */
export const blurFractionAt = (depth: number, focus: TiltShiftFocus): number => {
  if (!(focus.falloff > 0)) {
    throw new RangeError('focus falloff must be positive')
  }

  const halfRange = Math.max(0, focus.range) / 2
  const distanceFromBand = Math.abs(depth - focus.distance) - halfRange
  if (distanceFromBand <= 0) return 0

  const fraction = distanceFromBand / focus.falloff
  return fraction > 1 ? 1 : fraction
}
```

Then the shader source, as an exported template string. Write the GLSL yourself; it must:

- Declare exactly the uniforms in `TILT_SHIFT_UNIFORM_NAMES` and no others, with `tDiffuse` and `tDepth` as `sampler2D` and the rest as `float` or `vec2` as appropriate.
- Read the depth buffer, convert it from its non-linear form to a view-space distance in metres using `uNear` and `uFar`, and compute the same blur fraction the TypeScript above does — same sharp band, same linear ramp.
- Blur by sampling `tDiffuse` in a small disc whose radius is `blurFraction * MAX_BLUR_PIXELS` texels, using `uTexelSize`.
- Write to `gl_FragColor`.

Interpolate `MAX_BLUR_PIXELS` into the source rather than hard-coding it twice, so the test asserting the two agree is checking something real.

- [ ] **Step 4: Run the tests, then confirm they discriminate**

Run: `npx vitest run src/render/tiltShift.test.ts`

Then, reverting each: rename one uniform in the shader source only and confirm the first uniform test fails; add a uniform to the shader that is not in the list and confirm the second fails; remove the symmetry by taking `depth - focus.distance` without the absolute value and confirm the symmetry test fails. Record all three.

- [ ] **Step 5: Run everything, check types and commit**

```bash
git add src/render/tiltShift.ts src/render/tiltShift.test.ts
git commit -m "feat: tilt-shift blur profile and shader"
```

---

### Task 4: Make it look like a model

Everything above is numbers and a string. This task makes the scene use them.

This is the only task here with no unit tests, and on the three previous branches that has been where nearly every defect lived. Read `src/debug/roadScene.ts` fully before changing it, and be careful with disposal in particular — the post-processing chain owns render targets, and they are exactly the kind of resource that leaks on resize.

**Files:**
- Modify: `src/debug/roadScene.ts`
- Test: `src/debug/roadScene.test.ts` where a change is testable without a renderer

- [ ] **Step 1: Correct the renderer's colour handling**

Set ACES Filmic tone mapping and an exposure near 1. Confirm `outputColorSpace` is sRGB — three 0.185 defaults it, so check rather than set it blindly, and say in your report what you found.

Without tone mapping, a bright sun clips to flat white and the scene looks like a screenshot of a spreadsheet. This one change does more for the look than anything else in this task.

- [ ] **Step 2: Light it from `sunAt`**

Replace the fixed directional light's colour and intensity with `sunAt(hour)` for a chosen hour — mid-afternoon, around 15, gives long shadows without being sunset-orange. Position the light along the returned `direction`, converting to three.js handedness the same way the rest of the scene does. Do not invent a second conversion.

Keep the hemisphere fill, but reduce it: it currently has to do all the work, and once the sun casts real shadows an over-bright fill flattens them back out.

- [ ] **Step 3: Turn on shadows**

Enable shadow maps on the renderer, soft type. Make the sun cast; make terrain and road meshes receive; make road, structure and terrain meshes cast.

The sun is directional, so its shadow camera is orthographic and **must be sized to the scene** — the default frustum is a couple of units across and will produce either no shadows or a small square of them near the origin. Size it from the terrain's extent.

Shadow acne and peter-panning are the two failure modes; tune bias and normal bias until neither is visible, and say in your report what you settled on.

- [ ] **Step 4: Give every surface its material**

Replace the `LAYER_COLOURS` lookup with `surfaceFor`. Pavement layers use their own names; bridge decks, abutments, piers and retaining walls use `'concrete'`; the terrain uses `'terrain'`; the excavated corridor surface uses `'cutFace'`.

Delete `LAYER_COLOURS` once nothing reads it.

- [ ] **Step 5: Add the tilt-shift pass**

Build an `EffectComposer` with a `RenderPass` and a `ShaderPass` using `TILT_SHIFT_FRAGMENT_SHADER`. Import from `three/examples/jsm/postprocessing/...`; **verify the exact specifier resolves under this project's bundler before building on it**, and say in your report what you used.

The pass needs a depth texture, so the render target must be created with one. Set `uFocusDistance` from the camera rig's `distance` each frame, so what the player is looking at is what is sharp — that is the difference between a diorama and a smeared screenshot.

Render through the composer instead of directly. Resize the composer *and* its render targets on the existing resize path, and dispose them in the teardown.

- [ ] **Step 6: Frame it as a miniature**

The rig currently starts far enough out that roads read as hairlines. Bring the default distance in until a junction fills a useful part of the screen, and lower the default elevation so the view is a raised oblique rather than near-plan — the spec asks for "a comfortable raised angle", and a diorama is looked *across*, not down at.

Reduce the fog, or remove it. Fog and depth of field are two ways of saying distance, and together they read as neither.

- [ ] **Step 7: Extend what can be tested without a renderer**

Add tests to `src/debug/roadScene.test.ts` for anything that became a pure function here — the shadow camera's extent from the terrain, if you write it as one, is the obvious candidate. Do not attempt to test the renderer configuration.

- [ ] **Step 8: Look at it**

Run: `npm run dev` and open **`http://localhost:5173/chainage/`** — the bare root returns a redirect and a blank page.

Confirm each, and report honestly. Some embedded browser panes report `document.hidden` as true, which stalls `requestAnimationFrame` so nothing repaints past the first frame; if you hit that, say so plainly rather than claiming a check you could not make.

1. The scene is in focus at the distance the camera is orbiting, and blurs both nearer and further.
2. Zooming changes what is sharp, rather than the blur staying put.
3. Roads cast shadows onto the terrain, and the shadows are long enough to read as afternoon.
4. There is no shadow acne on the terrain and no gap between a road and its own shadow.
5. The sealed surface looks different from the granular layers under it — not just a different colour.
6. Bridges and retaining walls read as concrete.
7. Nothing is blown out to flat white, and nothing is crushed to black.
8. The default view frames the network as a model rather than as a map.
9. Resizing the window does not break the blur or leave it at the old resolution.

Take a screenshot and include it in your report.

- [ ] **Step 9: Commit**

```bash
git add src/debug/roadScene.ts src/debug/roadScene.test.ts
git commit -m "feat: tilt-shift diorama presentation"
```

---

## Deliberately not in this plan

- **Vegetation, water, and level-of-detail.** §6 defers all three to implementation planning, and each is its own piece of work.
- **A day/night cycle.** `sunAt` takes an hour and the scene passes a constant. Animating it is a one-line change whenever it is wanted.
- **Ambient occlusion, bloom, and screen-space reflections.** The post chain has one pass; adding more is cheap once it exists.
- **Texture maps.** Every surface is a flat colour with a roughness. Normal and roughness maps are the next real step in fidelity and want art, not code.
- **The inspector panel and overlays.** §5's delay-ratio heatmap needs traffic, which does not exist yet.

---

## Self-Review

**Spec coverage.** §6 names four things: shallow depth of field (Task 3 and Task 4 Step 5), believable light (Task 1, Task 4 Steps 2–3), physically-based materials (Task 2, Step 4), and a raised angle the player can drop low from (Step 6 sets the framing; `CameraRig`'s existing elevation clamp already permits a low view, so no new control is needed). The deferred list in §6 — LOD, vegetation, post chain beyond this, water — is deferred here too, explicitly.

**Type consistency.** `Vec3` is declared locally in `sunlight.ts`, matching the existing local declarations in `rayCast.ts` and `cameraRig.ts`. That is now a *third* copy, and the previous branch's review already flagged the pattern as worth watching. I am keeping it rather than promoting a shared type mid-plan, but the next plan that touches any of them should consolidate — three is where deliberate duplication stops being deliberate.

**One thing I could not verify while writing this.** Task 4 Step 5 assumes `three/examples/jsm/postprocessing/EffectComposer.js` resolves under this project's Vite setup, and that a `WebGLRenderTarget` with a depth texture composes with it cleanly in three 0.185. Both are conventional, neither is checked. The implementer must confirm before building on it and report what they found — if the specifier differs, the fix is trivial, but discovering it late would look like a shader bug.
