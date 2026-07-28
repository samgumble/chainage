# Network Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make drawn roads actually get built, stop the terrain and stray structures from burying the road surface, and grade-separate roads that cross rather than building them through each other.

**Architecture:** Every defect this plan fixes lives in `src/debug/roadScene.ts`, the one file in the project with no unit tests — the same pattern found on all five previous branches. The fix is therefore not to patch that file but to move its arithmetic into pure, renderer-free modules under `src/terrain/` and `src/mesh/`, leaving the scene as assembly. Two independently-derived station ranges (excavation's per-station fill test, and `structureSpans`' span list with its abutment extension) are unified so earthwork and structures cover exactly complementary stations.

**Tech Stack:** TypeScript `strict: true` with `noUncheckedIndexedAccess: true`, vitest 4, three.js `^0.185.1`.

## Global Constraints

- **No three.js** may be imported into `src/geometry/`, `src/terrain/`, `src/network/`, `src/mesh/`, `src/tool/`, or `src/traffic/`. Adding such an import is a defect regardless of whether it compiles.
- **Dependency direction:** `geometry/` imports nothing outside itself. `terrain/` imports `geometry/` only. `network/` imports `geometry/`, `terrain/groundProfile`, and its own `roadClass`. `mesh/` imports `geometry/`, `terrain/`, `network/`. `tool/` imports `geometry/`, `terrain/`, `network/`, `mesh/`. `render/` imports `mesh/`, `tool/`, `network/`, `traffic/` and three.js. `debug/` may import anything. **`terrain/` may not import `mesh/`** — where a terrain module needs pavement thickness, the caller passes it as a number.
- **Report rather than approximate.** When a computation cannot produce a correct answer, surface it through a named channel (the existing ones are `continuityBreaks`, `truncatedStations`, `infeasibleJunctions`, `elevationMismatches`, `tightCrossings`, `infeasibleRoads`) rather than substituting a plausible number. Never silently clamp, fudge, or fall back.
- **Vec2 helpers are `sub`, not `subtract`.** `TerrainSampler` exposes `sample(x, y)`, **not** `heightAt`.
- Every task ends with `npx vitest run` fully green and `npx tsc --noEmit` clean. State the actual counts in your report.
- Do **not** start or stop the dev server. A previous agent did and left the user with a blank page.

## Measured Baseline

These numbers were measured against the running demo scene on `main` at `27474ed`. Tasks reference them; do not re-derive them, but do re-measure after your change where a step says to.

- 3 grid nodes at the junction wanted a non-zero cut and hold 0: `(890,1280)` wanted `+0.09`, `(910,1280)` wanted `−1.66`, `(890,1290)` wanted `+1.16`.
- Along the east arm, terrain stands above the wearing-course crown from s≈3 to s≈17, peaking at **+1.11 m** at s=10.
- 58 grid nodes have a >5 m elevation discontinuity to an orthogonal neighbour, clustered at x≈1160–1180 and x≈1330 (the two bridge ends) and x≈1500–1650.
- Road 1 has one span, stations **273 → 423**, `maxHeight` 17.57 m. Its excavation-skipped stations are **280 → 420**.
- Retaining wall panels currently built: road 0 s=192→532 (340 m), road 1 s=272→424 (152 m, 7 m tall, flanking the whole bridge), road 1 s=480→588, road 2 s=220→256.
- Class radii: gravel 43.4 m, rural 252.0 m, arterial 335.7 m, highway 560.4 m. Default camera framing ≈300 m of ground.

---

### Task 1: Road class picker for the draw tool

The draw tool is hardcoded to `'rural'`, whose 252 m minimum radius cannot be satisfied by points clicked within a ≈300 m camera frame, so `buildPolylineAlignment` rejects the entire polyline and no road is ever added. This is why the player sees roads "not connecting" — they were never built. The code already anticipates this fix in a comment at the construction site.

**Do not** make the radius shrink to fit. `DrawTool.cornerRadius` is deliberately the class's AASHTO minimum; degrading it would build curves below the class's legal design speed and destroy the guarantee the whole geometry layer exists to provide.

**Files:**
- Modify: `src/debug/roadScene.ts` (the `new DrawTool(network, 'rural')` site and the key handler)
- Test: `src/tool/drawTool.test.ts`

**Interfaces:**
- Consumes: `ROAD_CLASS_ORDER` and `ROAD_CLASSES` from `src/network/roadClass.ts`; `DrawTool` from `src/tool/drawTool.ts`.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Write the failing test**

`DrawTool` already takes a class in its constructor, so the tool itself needs no change — but pin the behaviour that makes the picker worth having, because it is the actual bug:

```ts
import { describe, it, expect } from 'vitest'
import { DrawTool } from './drawTool'
import { RoadNetwork } from '../network/graph'

describe('DrawTool corner radius by class', () => {
  // The defect this guards: a class whose minimum radius exceeds the
  // distance a player can click within the camera frame rejects every
  // road. Gravel must be drawable at diorama scale; rural must not
  // silently become drawable by having its radius quietly reduced.
  it('accepts a 90-degree corner with 60m legs on gravel', () => {
    const tool = new DrawTool(new RoadNetwork(), 'gravel')
    tool.place({ x: 0, y: 0 })
    tool.place({ x: 60, y: 0 })
    tool.place({ x: 60, y: 60 })
    const result = tool.commit()
    expect(result.ok).toBe(true)
  })

  it('rejects the same corner on rural rather than shrinking the radius', () => {
    const tool = new DrawTool(new RoadNetwork(), 'rural')
    tool.place({ x: 0, y: 0 })
    tool.place({ x: 60, y: 0 })
    tool.place({ x: 60, y: 60 })
    const result = tool.commit()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.reason).toBe('curves-overlap')
  })

  it('gives each class the radius its design speed requires', () => {
    expect(new DrawTool(new RoadNetwork(), 'gravel').cornerRadius).toBeCloseTo(43.4, 0)
    expect(new DrawTool(new RoadNetwork(), 'rural').cornerRadius).toBeCloseTo(252.0, 0)
  })
})
```

- [ ] **Step 2: Run it**

`npx vitest run src/tool/drawTool.test.ts`

These may already pass — that is fine and expected. They exist so that Step 3's scene change cannot be "fixed" later by weakening the geometry. If any fails, stop and report: the failure is a real defect in `minimumRadiusForSpeed` or `buildPolylineAlignment`, not in this task.

- [ ] **Step 3: Make the scene's draw class selectable, defaulting to gravel**

In `src/debug/roadScene.ts`, replace the hardcoded construction (currently `const tool = new DrawTool(network, 'rural')`, around line 867, together with its now-obsolete comment) with a mutable current class and a rebuild on change. `DrawTool` computes `cornerRadius` in its constructor, so changing class means constructing a new tool; carry nothing over — a half-drawn gravel road is not a valid half-drawn highway.

```ts
// Gravel by default: its 43m minimum radius is the only class drawable
// within the ~300m the camera frames, so any other default rejects the
// player's first road outright. Faster classes are drawn zoomed out,
// which is honest — a 252m-radius rural road genuinely is a larger
// object than a farm track.
let drawClassIndex = ROAD_CLASS_ORDER.indexOf('gravel')
let tool = new DrawTool(network, ROAD_CLASS_ORDER[drawClassIndex]!)

const setDrawClass = (index: number): void => {
  const wrapped = (index + ROAD_CLASS_ORDER.length) % ROAD_CLASS_ORDER.length
  if (wrapped === drawClassIndex) return
  // A gesture in progress belongs to the class it was started in; the
  // corner radius that validated its points no longer applies.
  tool.cancel()
  drawClassIndex = wrapped
  tool = new DrawTool(network, ROAD_CLASS_ORDER[wrapped]!)
  setMessage(`Draw — ${ROAD_CLASS_ORDER[wrapped]!} (radius ${tool.cornerRadius.toFixed(0)}m)`, 'info')
}
```

Bind `1`–`4` to `setDrawClass(0..3)` in the existing keydown handler, alongside whatever keys are already bound. Every later reference to `tool` in the file must read the current binding — if any closure captured the old `const tool`, it will silently keep drawing the old class; check each one.

Import `ROAD_CLASS_ORDER` from `../network/roadClass`.

- [ ] **Step 4: Verify the class actually changes what gets built**

Run `npx vitest run` and `npx tsc --noEmit`. Then, by reading only (do not start the dev server), confirm every use of `tool` in `roadScene.ts` reads the live binding rather than a captured copy, and list them in your report with line numbers.

- [ ] **Step 5: Commit**

```bash
git add src/debug/roadScene.ts src/tool/drawTool.test.ts
git commit -m "fix: draw tool defaults to gravel and offers a class picker"
```

---

### Task 2: Pure corridor excavation with nearest-centreline arbitration

`excavateCorridor` snaps each transverse sample to the nearest grid node and writes last-write-wins. Beyond `maxBatterWidth`, `designSurfaceAtOffset` returns natural ground, so the delta is exactly `0` — and `TerrainEditLayer.setDelta` **deletes** zero deltas. A second road's "nothing to do out here" sample therefore erases a first road's real cut. Measured: 3 wiped nodes at the junction, leaving terrain up to 1.11 m above the road crown.

The arbitration rule is **nearest centreline wins**: a node lying inside two corridors belongs to the road whose formation is closer to it. That is the physically correct answer and, unlike last-write-wins, it does not depend on the order roads were created in.

`TerrainEditLayer` is left alone. Its job is deformation, and "delta zero means no deformation" is honest. "Is this node inside a road corridor" is a *corridor* question and belongs in the new module.

**Files:**
- Create: `src/terrain/excavation.ts`
- Test: `src/terrain/excavation.test.ts`
- Modify: `src/debug/roadScene.ts` (replace the body of `excavateCorridor` with a call)

**Interfaces:**
- Consumes: `Alignment` (`geometry/alignment`), `fromAngle` (`geometry/vec2`), `ProfilePoint` + `designElevationAtStation` (`terrain/groundProfile`), `CorridorTemplate` + `designSurfaceAtOffset` (`terrain/corridor`), `TerrainEditLayer` (`terrain/editLayer`), `Heightmap` (`terrain/heightmap`).
- Produces, consumed by Tasks 3 and 6:
  - `class CorridorExcavation` with `offer(col, row, targetZ, offset)`, `has(col, row): boolean`, `targetAt(col, row): number | undefined`, `nodeCount: number`, `applyTo(layer: TerrainEditLayer): void`
  - `sweepCorridor(params: SweepParams): void` — walks stations and offers samples into a `CorridorExcavation`
  - `type SweepParams`

- [ ] **Step 1: Write the failing tests**

Create `src/terrain/excavation.test.ts`. The fourth test is the one that reproduces the measured defect; the others exist so a wrong arbitration rule cannot pass it by accident.

```ts
import { describe, it, expect } from 'vitest'
import { CorridorExcavation } from './excavation'
import { Heightmap } from './heightmap'
import { TerrainEditLayer } from './editLayer'

const flatGround = (elevation: number): Heightmap => {
  const cols = 8, rows = 8
  const elevations = new Float32Array(cols * rows).fill(elevation)
  return new Heightmap(0, 0, 10, cols, rows, elevations)
}

describe('CorridorExcavation arbitration', () => {
  it('records a single offer', () => {
    const x = new CorridorExcavation(8, 8)
    x.offer(2, 3, 95, 4)
    expect(x.has(2, 3)).toBe(true)
    expect(x.targetAt(2, 3)).toBe(95)
    expect(x.nodeCount).toBe(1)
  })

  it('lets a nearer offer replace a farther one', () => {
    const x = new CorridorExcavation(8, 8)
    x.offer(2, 3, 95, 12)
    x.offer(2, 3, 91, 4)
    expect(x.targetAt(2, 3)).toBe(91)
  })

  // THE DEFECT. Last-write-wins made this fail: road B's far-offset
  // sample, which wanted natural ground, overwrote road A's deep cut.
  it('does not let a farther offer replace a nearer one', () => {
    const x = new CorridorExcavation(8, 8)
    x.offer(2, 3, 91, 4)
    x.offer(2, 3, 95, 12)
    expect(x.targetAt(2, 3)).toBe(91)
  })

  // The same defect in the exact shape measured at the junction: the
  // far sample's target EQUALS natural ground, so under the old code it
  // produced delta 0 and setDelta deleted the entry outright.
  it('does not let a farther no-change offer erase a nearer cut', () => {
    const x = new CorridorExcavation(8, 8)
    x.offer(2, 3, 98.34, 3)    // road A cuts 1.66m below ground at 100
    x.offer(2, 3, 100, 27)     // road B: beyond its batter, natural ground
    expect(x.targetAt(2, 3)).toBe(98.34)
  })

  it('keeps the first of two offers at an equal offset', () => {
    const x = new CorridorExcavation(8, 8)
    x.offer(2, 3, 91, 7)
    x.offer(2, 3, 95, 7)
    expect(x.targetAt(2, 3)).toBe(91)
  })

  // A node whose corridor target happens to equal natural ground is
  // still IN the corridor. roadScene colours cut nodes brown by asking
  // this, not by asking whether the delta is non-zero.
  it('reports a node as present even when its target equals ground', () => {
    const x = new CorridorExcavation(8, 8)
    x.offer(2, 3, 100, 27)
    expect(x.has(2, 3)).toBe(true)
    expect(x.targetAt(2, 3)).toBe(100)
  })

  it('ignores offers outside the grid rather than throwing', () => {
    const x = new CorridorExcavation(8, 8)
    x.offer(-1, 3, 95, 4)
    x.offer(2, 99, 95, 4)
    expect(x.nodeCount).toBe(0)
  })

  it('applies the resolved target as a delta from base ground', () => {
    const x = new CorridorExcavation(8, 8)
    x.offer(2, 3, 98.34, 3)
    const layer = new TerrainEditLayer(flatGround(100))
    x.applyTo(layer)
    expect(layer.deltaAt(2, 3)).toBeCloseTo(-1.66, 6)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

`npx vitest run src/terrain/excavation.test.ts`
Expected: FAIL — `Cannot find module './excavation'`.

- [ ] **Step 3: Implement `CorridorExcavation`**

Create `src/terrain/excavation.ts`:

```ts
import type { Alignment } from '../geometry/alignment'
import { fromAngle } from '../geometry/vec2'
import { type ProfilePoint, designElevationAtStation } from './groundProfile'
import { type CorridorTemplate, designSurfaceAtOffset } from './corridor'
import type { TerrainEditLayer } from './editLayer'
import type { Heightmap } from './heightmap'

/**
 * Which road corridor owns each terrain grid node, and what elevation it
 * wants there.
 *
 * Corridors overlap — at every junction, and anywhere two roads run close.
 * A node inside two of them cannot have two elevations, so one must win.
 * The rule is **nearest centreline**: the node belongs to the road whose
 * formation is closer to it.
 *
 * The rule this replaced was last-write-wins, which had two failure modes
 * that compounded. Beyond its `maxBatterWidth` a corridor's design surface
 * is natural ground, so a road sweeping past a node it does not actually
 * touch still wrote to it — and wrote a zero delta, which
 * `TerrainEditLayer.setDelta` deletes. A second road therefore erased a
 * first road's cut simply by passing nearby, and the road it belonged to
 * was left buried under a metre of unexcavated ground. Nearest-centreline
 * fixes both: the far sample loses, and it loses regardless of which road
 * was created first, so the result no longer depends on insertion order.
 *
 * Presence is tracked separately from elevation. A node whose corridor
 * target equals natural ground is still inside the corridor — callers that
 * ask "is this node in a road corridor" (the terrain colour rule does) must
 * ask `has`, never `deltaAt(...) !== 0`.
 */
export class CorridorExcavation {
  /** Keyed by `row * cols + col`, matching `TerrainEditLayer`. */
  private readonly chosen = new Map<number, { targetZ: number; offset: number }>()

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    if (!Number.isInteger(cols) || cols <= 0) {
      throw new RangeError('cols must be a positive integer')
    }
    if (!Number.isInteger(rows) || rows <= 0) {
      throw new RangeError('rows must be a positive integer')
    }
  }

  get nodeCount(): number {
    return this.chosen.size
  }

  /**
   * Propose an elevation for a node, from a sample `offset` metres from its
   * road's centreline.
   *
   * Out-of-grid nodes are dropped rather than throwing: a corridor sweep
   * legitimately runs off the edge of the terrain, and that is not an error
   * at the call site. Ties keep the earlier offer, so a given set of offers
   * always resolves the same way.
   */
  offer(col: number, row: number, targetZ: number, offset: number): void {
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return

    const distance = Math.abs(offset)
    const index = row * this.cols + col
    const existing = this.chosen.get(index)
    if (existing && existing.offset <= distance) return

    this.chosen.set(index, { targetZ, offset: distance })
  }

  /** Whether any corridor claimed this node. */
  has(col: number, row: number): boolean {
    return this.chosen.has(row * this.cols + col)
  }

  /** The winning target elevation, or `undefined` if no corridor claimed it. */
  targetAt(col: number, row: number): number | undefined {
    return this.chosen.get(row * this.cols + col)?.targetZ
  }

  /**
   * Write every resolved node into an edit layer as a delta from base ground.
   *
   * The layer's base heightmap supplies the ground each delta is measured
   * from, so this cannot be called against a layer built over different
   * terrain than the sweep sampled.
   */
  applyTo(layer: TerrainEditLayer): void {
    if (layer.base.cols !== this.cols || layer.base.rows !== this.rows) {
      throw new RangeError(
        `edit layer is ${layer.base.cols}x${layer.base.rows}, excavation is ${this.cols}x${this.rows}`,
      )
    }
    for (const [index, { targetZ }] of this.chosen) {
      const col = index % this.cols
      const row = (index - col) / this.cols
      layer.setDelta(col, row, targetZ - layer.base.elevationAtIndex(col, row))
    }
  }
}
```

- [ ] **Step 4: Run the tests**

`npx vitest run src/terrain/excavation.test.ts`
Expected: PASS, 8/8.

- [ ] **Step 5: Prove the tests discriminate**

Change `if (existing && existing.offset <= distance) return` to `if (false) return` — i.e. restore last-write-wins — and re-run. The "does not let a farther offer replace a nearer one" and "does not let a farther no-change offer erase a nearer cut" tests must both fail. Then change `<=` to `<` and confirm the tie test fails. **Revert both mutations.** Report exactly which tests failed for each; if either mutation survives, the test is not testing what it claims and you must fix the test before proceeding.

- [ ] **Step 6: Add the station sweep**

Append to `src/terrain/excavation.ts`. Note `pavementDepth` arrives as a number — `terrain/` must not import `mesh/crossSection`.

```ts
export type SweepParams = {
  readonly alignment: Alignment
  readonly profile: readonly ProfilePoint[]
  readonly terrain: Heightmap
  readonly template: CorridorTemplate
  /** Full pavement stack thickness plus any z-fight margin, metres. */
  readonly pavementDepth: number
  /** Steepest batter slope as run-over-rise; sizes the swept half-width. */
  readonly maxSlope: number
  /** Extra half-width swept beyond the computed batter, metres. */
  readonly margin: number
  /** Station spacing along the alignment, metres. */
  readonly stationSpacing: number
  /** Transverse sample spacing, metres. */
  readonly transverseSpacing: number
  /**
   * Station ranges carried on a structure, which this sweep must not touch.
   *
   * These come from `structureSpans`, so earthwork stops exactly where the
   * abutment stands rather than where a per-station fill test happens to
   * trip. The two used to be derived independently and disagreed by several
   * stations, which left an unsupported notch past the deck and a bare
   * terrain cliff at each bridge end.
   */
  readonly structureRanges: readonly { readonly fromStation: number; readonly toStation: number }[]
}

/** Walk an alignment and offer every corridor sample into `into`. */
export const sweepCorridor = (params: SweepParams, into: CorridorExcavation): void => {
  const {
    alignment, profile, terrain, template, pavementDepth,
    maxSlope, margin, stationSpacing, transverseSpacing, structureRanges,
  } = params

  if (stationSpacing <= 0) throw new RangeError('stationSpacing must be positive')
  if (transverseSpacing <= 0) throw new RangeError('transverseSpacing must be positive')

  const carried = (s: number): boolean =>
    structureRanges.some((r) => s >= r.fromStation && s <= r.toStation)

  const steps = Math.max(1, Math.ceil(alignment.length / stationSpacing))

  for (let i = 0; i <= steps; i++) {
    const s = Math.min(i * stationSpacing, alignment.length)
    if (carried(s)) continue

    const pose = alignment.poseAt(s)
    const roadZ = designElevationAtStation(profile, s)
    const designZ = roadZ - pavementDepth

    const centreGroundZ = terrain.sample(pose.position.x, pose.position.y)
    const depth = Math.abs(centreGroundZ - designZ)
    const half = template.formationHalfWidth + maxSlope * depth + margin

    const normal = fromAngle(pose.heading + Math.PI / 2)
    const transverseSteps = Math.max(1, Math.ceil(half / transverseSpacing))

    for (let j = -transverseSteps; j <= transverseSteps; j++) {
      const offset = (half * j) / transverseSteps
      const worldX = pose.position.x + normal.x * offset
      const worldY = pose.position.y + normal.y * offset

      const col = Math.round((worldX - terrain.originX) / terrain.cellSize)
      const row = Math.round((worldY - terrain.originY) / terrain.cellSize)
      if (col < 0 || col >= terrain.cols || row < 0 || row >= terrain.rows) continue

      const groundZ = terrain.elevationAtIndex(col, row)
      into.offer(col, row, designSurfaceAtOffset(offset, designZ, groundZ, template), offset)
    }
  }
}
```

- [ ] **Step 7: Test the sweep**

Add to `src/terrain/excavation.test.ts`. Build a straight 100 m alignment over flat ground at 100 m with a design line at 96 m, sweep it, and assert:

```ts
describe('sweepCorridor', () => {
  it('claims nodes along the alignment', () => { /* nodeCount > 0 */ })

  it('skips stations inside a structure range', () => {
    // Sweep once with structureRanges: [], once with the middle third
    // covered. The covered version must claim strictly fewer nodes, and
    // must claim NO node whose nearest station falls inside the range.
  })

  it('claims the station exactly at a structure range boundary as carried', () => {
    // fromStation and toStation are inclusive: the abutment stands there.
  })
})
```

Write these out fully with real coordinates. If you cannot construct a fixture that discriminates, say so in your report rather than writing an assertion that passes vacuously.

- [ ] **Step 8: Rewire `roadScene.excavateCorridor`**

Replace the body of `excavateCorridor` in `src/debug/roadScene.ts` with a `sweepCorridor` call into a shared `CorridorExcavation`, and call `applyTo` once after all roads have been swept. The per-road `layer.setDelta` loop and the `if (roadZ - centreGroundZ > MAX_FILL_HEIGHT) continue` test both go away — the latter is replaced by `structureRanges`, which Task 3 supplies.

Until Task 3 lands, pass `structureRanges: []`. Say so in your report; do not leave it undocumented.

- [ ] **Step 9: Full suite and commit**

```bash
npx vitest run && npx tsc --noEmit
git add src/terrain/excavation.ts src/terrain/excavation.test.ts src/debug/roadScene.ts
git commit -m "fix: corridor excavation arbitrates overlaps by nearest centreline"
```

---

### Task 3: Make excavation and structures agree on station ranges

Excavation skipped stations where fill exceeded `MAX_FILL_HEIGHT` (measured: 280–420 on road 1). The span, including its `ABUTMENT_EXTENSION = 3`, covers 273–423. Everything wrong at the bridges lives in that mismatch: a 6–13 m bare terrain cliff at each end where the sweep stopped short of the abutment (58 measured nodes, rendering as green shards because un-excavated nodes are coloured green), a ~3 m notch of unsupported air past the deck end, and an embankment burying the west abutment (edited ground 113.21 against a deck top of 113.05).

Fixing this means computing spans **before** excavating, then handing them to `sweepCorridor` as `structureRanges`. Earthwork then stops exactly at the abutment face, where a wall stands to cover the step.

**Files:**
- Modify: `src/debug/roadScene.ts`
- Test: `src/terrain/excavation.test.ts` (extend Task 2's structure-range tests)

**Interfaces:**
- Consumes: `structureSpans` from `src/mesh/structures/spans.ts`; `sweepCorridor`'s `structureRanges` from Task 2.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Establish the current ordering**

Read `buildSceneContent` in `src/debug/roadScene.ts` and write down, in your report, the exact current order of: grade solve → excavation → mesh build → `structureSpans`. Spans are currently computed inside the mesh build, downstream of excavation. Restructuring so spans come first is the substance of this task; state the dependency that made it downstream and how you broke it.

- [ ] **Step 2: Write the failing check**

Add to `src/terrain/excavation.test.ts` a test that pins the property the mismatch violated:

```ts
it('leaves every node under a structure range unclaimed', () => {
  // Sweep a 500m alignment with structureRanges [{from: 273, to: 423}].
  // For every claimed node, compute the nearest station on the alignment;
  // assert none falls strictly inside (273, 423).
  //
  // This is the property the old code broke: it stopped earthwork at 280
  // and resumed at 420, so nodes between 273-280 and 420-423 were claimed
  // by earthwork AND covered by an abutment.
})
```

Write it out fully. Run it and confirm it fails if you pass `structureRanges: []`.

- [ ] **Step 3: Reorder the scene**

Compute each road's spans from its solved profile before excavating, and pass them through. Both `structureSpans` and the mesh build must use the **same** span list object — deriving it twice invites them to drift apart again, which is the defect being fixed.

- [ ] **Step 4: Re-measure**

Re-run the discontinuity scan from the Measured Baseline: count grid nodes with a >5 m elevation step to an orthogonal neighbour. Report the new count against the baseline of 58. Report the counts at x≈1160–1180 and x≈1330 specifically. If the count at the bridge ends is not substantially reduced, the fix did not work — say so rather than reporting success.

- [ ] **Step 5: Commit**

```bash
npx vitest run && npx tsc --noEmit
git add -A && git commit -m "fix: earthwork and structures share one station range"
```

---

### Task 4: Retaining wall panels must break at station gaps

`networkMesh.ts:271-278` filters out wall segments inside a span. `buildRetainingWallMesh` (`retainingWallMesh.ts:130-148`) then joins *consecutive surviving* segments with a single quad, regardless of the station gap between them — so it spans the very gap the filter opened. Measured result: a 152 m long, 7 m tall concrete panel down **each side of the 150 m bridge**, plus a 340 m panel on road 0 and a 108 m one on road 1.

**Files:**
- Modify: `src/mesh/structures/retainingWallMesh.ts`
- Test: `src/mesh/structures/retainingWallMesh.test.ts`

**Interfaces:**
- Consumes: the existing wall-segment type in `retainingWallMesh.ts`. **Its station field is named `s`, not `station`**, and segments also carry `side`, `offset`, `topZ`, `bottomZ`. The join loop is `for (let i = 1; i < run.length; i++)` over segments filtered by `side` and sorted by `s`; every consecutive pair becomes one quad with no gap check at all.
- Produces: no signature change. The mesh gains a break; the function signature does not change.

- [ ] **Step 1: Write the failing test**

```ts
it('does not join two segments separated by a station gap', () => {
  // Segments at stations 100, 105, 110 — then 300, 305, 310.
  // Spacing is 5m, so 110 -> 300 is a 190m gap, not an adjacency.
  // The mesh must contain two disconnected panels, not one 210m panel.
  //
  // Assert on geometry, not on a count that a wrong implementation could
  // also produce: no triangle may have two vertices more than one
  // station-spacing apart along the alignment.
})

it('still joins genuinely adjacent segments into one panel', () => {
  // Segments at 100, 105, 110 with no gap must remain a single
  // continuous panel — the fix must not shatter every wall into
  // per-segment quads.
})
```

Write both out fully against the real segment type. The second test is what stops the fix from being "never join anything".

- [ ] **Step 2: Run to verify failure**

`npx vitest run src/mesh/structures/retainingWallMesh.test.ts`
Expected: the first test FAILS (one long panel), the second PASSES.

- [ ] **Step 3: Implement the break**

Join consecutive segments only when their stations are adjacent — within a small tolerance of the segment spacing. Derive the expected spacing from the segment list rather than hardcoding it, and document the tolerance's reasoning in a comment the way the rest of this codebase does.

- [ ] **Step 4: Run both tests, then the suite**

- [ ] **Step 5: Prove the test discriminates**

Remove the adjacency check and confirm the first test fails again. **Revert.** Report the result.

- [ ] **Step 6: Commit**

```bash
git add src/mesh/structures/retainingWallMesh.ts src/mesh/structures/retainingWallMesh.test.ts
git commit -m "fix: retaining wall panels break at station gaps"
```

---

### Task 5: Deck clearance from pavement thickness, and abutment below deck

Two independent defects in the same file:

1. `DECK_CLEARANCE = 0.6` (`bridgeMesh.ts:18`) is a constant, but `totalPavementThickness(rural)` is `0.5`. The deck top therefore sits **0.1 m below the pavement underside** — the road floats 10 cm above its own bridge, for the entire span.
2. The abutment top face is placed at `topZ = section.leftBottom.z` at a station shifted by `pierHalfWidth` (`bridgeMesh.ts:131-133`), landing **≈0.07 m** from the deck underside over a 2 × 10 m footprint, same material, both `DoubleSide`. A guaranteed z-fight under each abutment.

**Files:**
- Modify: `src/mesh/structures/bridgeMesh.ts`
- Test: `src/mesh/structures/bridgeMesh.test.ts`

**Interfaces:**
- Consumes: `totalPavementThickness` from `src/mesh/crossSection.ts` (`mesh/` importing `mesh/` is fine).
- Produces: the deck-clearance constant becomes a parameter derived from the road class. State the exact new signature in your report — Task 7 does not depend on it, but the scene does.

- [ ] **Step 1: Write the failing tests**

```ts
it('puts the deck top exactly at the pavement underside for every class', () => {
  // For gravel, rural, arterial, highway: deck top must equal
  // designZ - totalPavementThickness(class), not a constant.
})

it('keeps the abutment top clear of the deck underside', () => {
  // The vertical gap must be at least a stated margin. Assert the
  // margin, and put the reasoning for its value in a comment.
})
```

- [ ] **Step 2: Run to verify failure.** Both must fail with the measured numbers (0.6 vs 0.5; ~0.07 m).

- [ ] **Step 3: Implement.** Derive deck clearance from the class's pavement thickness. Lower the abutment top by a documented margin.

- [ ] **Step 4: Run tests and full suite.**

- [ ] **Step 5: Commit**

```bash
git add src/mesh/structures/bridgeMesh.ts src/mesh/structures/bridgeMesh.test.ts
git commit -m "fix: deck sits under the pavement, abutment sits under the deck"
```

---

### Task 6: Coplanar surface protection and shadow bias

`grep -rn "polygonOffset\|renderOrder\|depthWrite\|depthTest" src/` returns **nothing**. No coplanar surface in the scene has any protection. The `wearing` and `base` ribbons are 5 cm apart over an identical footprint; depth resolution at the default 300 m rig distance is ≈5 mm so it holds, but at ≈1000 m it is ≈60 mm and the base punches through.

Separately, `sun.shadow.bias = -0.0002` against an orthographic depth range of 1799 m is ≈**0.36 m of world-space bias**, which suppresses shadows from anything shorter than that outright.

**Files:**
- Modify: `src/debug/roadScene.ts`

**Interfaces:** none. This task changes no module boundary.

- [ ] **Step 1: Apply `polygonOffset` to the pavement stack**

Give the lower pavement layers a positive `polygonOffsetFactor`/`polygonOffsetUnits` so they are pushed away from the camera relative to the wearing course. Do not set `depthWrite: false` — these are opaque surfaces and disabling depth writes on them would break their occlusion of everything behind.

- [ ] **Step 2: Scale the shadow bias to the frustum**

The bias is a normalised depth value; its world-space effect is `bias × (far − near)`. The current frustum is refit every frame by `updateSunShadow`, so a constant bias means a bias that changes meaning as the player zooms. Compute it from the live `far − near` to hold a constant world-space value, and state in a comment what world-space bias you chose and why.

- [ ] **Step 3: Verify by reading**

You cannot verify this without rendering, and you must not start the dev server. Report precisely what you changed and what you expect it to look like; the controller will verify visually.

- [ ] **Step 4: Commit**

```bash
npx vitest run && npx tsc --noEmit
git add src/debug/roadScene.ts
git commit -m "fix: separate coplanar pavement layers and scale shadow bias to the frustum"
```

---

### Task 7: Overpass on crossing, intersection on termination

Crossings are detected and then ignored. `findCrossings` computes the vertical gap between two roads, `networkMesh` collects any below `MIN_OVERPASS_CLEARANCE` into `tightCrossings`, and `roadScene.ts:562` logs them to the console. Nothing raises a road. Two roads that cross at grade are built through each other.

Meanwhile `DrawTool.commit` splits roads only at **placed points** (`drawTool.ts:188` loops over `this.placed`). A road whose alignment crosses another *between* two placed points is invisible to the graph entirely.

The rule to implement:

- **A crossing at a placed point is an intersection.** Split both roads and connect them. This is what `commit` already does; keep it.
- **A crossing between placed points is an overpass.** Do not split. Grade-separate, with the **new road going over**.

The new road always goes over. Raising only the road being drawn means never mutating an existing road's profile, which would otherwise invalidate its structures, its mesh, and any road tied to its endpoints. It is also predictable for the player.

The lift is a **constraint on the grade solve, not a post-process**. `solveGradeProfile` already does interval propagation over per-station elevation bands; a required clearance is a raised floor on one station's band. An overpass unreachable within max grade then comes back through the solver's existing infeasibility path rather than being fudged — which is what "report rather than approximate" requires.

**Files:**
- Modify: `src/terrain/gradeSolver.ts` (add `clearanceFloors` to `GradeConstraints`)
- Create: `src/network/crossingKind.ts`
- Modify: `src/debug/roadScene.ts`
- Test: `src/terrain/gradeSolver.test.ts`, `src/network/crossingKind.test.ts`

**Interfaces:**
- Consumes: `findCrossings`, `MIN_OVERPASS_CLEARANCE` (`network/crossings`); `solveGradeProfile` (`terrain/gradeSolver`).
- Produces: `classifyCrossing(crossing, placedPoints, tolerance) => 'intersection' | 'overpass'`; `GradeConstraints.clearanceFloors?: readonly { station: number; minimumElevation: number }[]`.

- [ ] **Step 1: Write the failing grade-solver tests**

```ts
describe('clearanceFloors', () => {
  it('lifts the profile to the floor at that station', () => {
    // Flat ground at 100, generous cut/fill, a floor of 112 at station 200
    // on a 400m alignment. The solved profile at 200 must be >= 112.
  })

  it('leaves the profile alone where no floor applies', () => {
    // Same solve without floors: station 200 must sit near ground.
  })

  it('reports infeasible when the floor cannot be reached within max grade', () => {
    // A floor 50m up at station 10 with maxGrade 0.07 needs ~714m of run.
    // Must return { feasible: false } with failedAtStation set, NOT a
    // profile that silently exceeds the grade limit.
  })

  it('respects a floor that is already satisfied without raising anything', () => {
    // A floor BELOW where the profile already runs must change nothing.
  })
})
```

Write these out fully with real numbers. The third is the one that matters most: it is where "report rather than approximate" is enforced.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement `clearanceFloors`**

In phase 1 of `solveGradeProfile`, raise the low end of the band at each floored station before the forward and backward propagation passes run. Do not add a separate pass — the existing propagation already handles reachability, and an empty band already means infeasible. Match a floor to its station using the existing `STATION_TOLERANCE`.

Document why this belongs in phase 1 and not as a post-solve lift: a post-solve lift would satisfy the clearance while silently violating the grade limit between stations, which is exactly the class of defect this codebase reports rather than commits.

- [ ] **Step 4: Prove the tests discriminate**

Gut the floor application (make it a no-op) and confirm the first and third tests fail. Then apply the floor *after* propagation instead of before, and confirm the third test fails — a post-solve lift produces a profile that reaches the floor but breaks max grade. **Revert both.** Report both results. If the post-solve mutation survives, the third test is not pinning what it claims.

- [ ] **Step 5: Write and implement `classifyCrossing`**

Create `src/network/crossingKind.ts`. A crossing within `tolerance` of any placed point is an `'intersection'`; otherwise `'overpass'`. Tests must cover: a crossing exactly on a placed point; one a hair inside the tolerance; one a hair outside; and one at a placed point that is also an alignment endpoint.

- [ ] **Step 6: Wire it into the scene**

When solving the new road's profile, pass a clearance floor at each overpass crossing's station:

```
minimumElevation = lowerRoadDesignElevation + MIN_OVERPASS_CLEARANCE + deckThickness
```

An infeasible solve must reach the player through a named channel — add `infeasibleCrossings` alongside the existing report channels and surface it the way `infeasibleRoads` is surfaced. **Do not** fall back to building the crossing at grade.

Replace the `console.warn` at `roadScene.ts:562` — `tightCrossings` should now be empty for any crossing this path handled, so a non-empty `tightCrossings` becomes a real defect signal rather than routine noise. Say in your report what it contains after your change.

- [ ] **Step 7: Full suite and commit**

```bash
npx vitest run && npx tsc --noEmit
git add -A
git commit -m "feat: roads that cross become overpasses, roads that terminate become junctions"
```

---

## Self-Review

**Spec coverage.** Every ranked cause from the diagnosis maps to a task: cause 1 → Task 2; cause 2 → Task 3; cause 3 → Task 4; cause 4 → Task 3; causes 5 and 6 → Task 5; causes 7 and 8 → Task 6. The rejection defect → Task 1. The user's crossing rule → Task 7.

**Known gap, stated rather than hidden.** Task 6 cannot be verified by its implementer, because verifying it requires rendering and implementers are barred from the dev server. The controller must verify it visually before merge. Task 3's Step 4 re-measurement is likewise a count the implementer reports and the controller must sanity-check against the baseline of 58.

**Ordering dependency.** Task 3 depends on Task 2's `structureRanges` parameter existing. Task 2 ships with `structureRanges: []` and Task 3 fills it. No other task pair is ordered; 1, 4, 5, 6 and 7 are independent.

**Deliberately not in scope.** Junction elevation warping (measured spread 0.4575 m at node 0, currently only reported through `elevationMismatches`) is a real defect and is left for its own plan — it needs the junction mesh to warp to a common elevation, which is a larger change than anything here. Structure meshes receiving shadows, and the terrain mesh's downward winding masked by `DoubleSide`, are both cosmetic and noted for later.
