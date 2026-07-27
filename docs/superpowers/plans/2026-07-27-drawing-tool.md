# Drawing Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw a road by clicking points on the terrain and watch it appear, correctly engineered, in the world.

**Architecture:** The tool is a pure state machine over two pure geometric services — turning a clicked polyline into a continuous alignment, and resolving where a pointer actually means to be. three.js appears only at the edges: a camera rig whose orbit maths is separately testable, and event plumbing. Picking does not raycast the rendered mesh; it marches the ray against the heightfield directly, so the answer does not depend on how finely the terrain happens to be tessellated.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), vitest 4, three.js. No new dependencies.

## Global Constraints

- **Dependency direction:** `geometry/` imports nothing outside itself. `terrain/` imports `geometry/`. `network/` imports `geometry/`, `terrain/groundProfile` and its own `roadClass`. `mesh/` imports `geometry/`, `terrain/` and `network/`. `tool/` imports `geometry/`, `terrain/`, `network/` and `mesh/`. `render/` imports `mesh/`, `tool/` and three.js. `debug/` may import anything.
- **`src/geometry/`, `src/terrain/`, `src/network/`, `src/mesh/` and `src/tool/` must NOT import three.js.** Only `render/` and `debug/` may.
- Coordinates `(x, y)` in metres with `y` north; `z` positive up. Handedness conversion to three.js `(x, z, −y)` happens only in `render/` and the debug scene.
- **Report rather than approximate.** When code cannot satisfy a constraint it reports the fact through a named channel carrying enough detail to act on — not a boolean, not a bare string. Existing channels: `continuityBreaks`, `truncatedStations`, `infeasibleJunctions`, `elevationMismatches`, `tightCrossings`, `ClassChangeRejection`, `UpgradeObstacle`.
- **TypeScript** `strict: true`, `noUncheckedIndexedAccess: true`. No `any`. No non-null assertion on a value that could genuinely be absent.
- `NODE_SNAP_DISTANCE = 0.5` metres is a *topological identity* threshold — two road ends closer than this are the same node. The tool's snap radius is a separate, much larger *usability* threshold. Do not conflate them.
- Tests colocate with source as `<name>.test.ts`. Run the suite with `npm test`, types with `npx tsc --noEmit`. Both clean at every commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/geometry/polyline.ts` (create) | Clicked points → a continuous alignment, with fillet arcs at the corners |
| `src/geometry/fillet.ts` (modify) | Export `MIN_DEFLECTION` so the polyline builder shares one definition of "straight" |
| `src/network/nodeIndex.ts` (modify) | `nearby` accepts a query radius larger than the default |
| `src/network/graph.ts` (modify) | `nodesWithin(position, radius)` for the tool's wider search |
| `src/tool/snap.ts` (create) | Where a pointer position actually means — free ground, an existing node, or a point on a road |
| `src/tool/drawTool.ts` (create) | The state machine: accumulate points, offer a preview, commit or reject |
| `src/terrain/rayCast.ts` (create) | Ray against heightfield, by marching and bisection |
| `src/render/cameraRig.ts` (create) | Orbit state → camera position and target; pure maths |
| `src/debug/roadScene.ts` (modify) | Replace the fixed auto-orbit with the rig, wire pointer events, render the preview, commit |

`polyline.ts` lives in `geometry/` rather than `tool/` because it takes a corner radius as a parameter and knows nothing about roads. `rayCast.ts` lives in `terrain/` because it is a query against a `TerrainSampler`.

---

### Task 1: Clicked points to a continuous alignment

A player clicks a sequence of points. Each interior corner needs a curve of an appropriate radius inserted into it, and the straights between them must be shortened to meet their curves' tangent points. Two things can make that impossible: a corner too sharp to fillet at the given radius, and two adjacent curves whose tangent lengths together exceed the straight between them. Both are reported, with the index of the point at fault.

**Files:**
- Create: `src/geometry/polyline.ts`
- Create: `src/geometry/polyline.test.ts`
- Modify: `src/geometry/fillet.ts`

**Interfaces:**
- Consumes: `Vec2`, `sub`, `distance`, `angleOf`, `signedAngleBetween` from `src/geometry/vec2`; `Line`, `Primitive` from `src/geometry/primitives`; `Alignment` from `src/geometry/alignment`; `filletCorner`, `Fillet`, and the newly exported `MIN_DEFLECTION` from `src/geometry/fillet`.
- Produces: `buildPolylineAlignment(points: readonly Vec2[], radius: number): PolylineResult`, plus the `PolylineResult` and `PolylineRejection` types below.

`filletCorner` returns `null` for two different situations — a corner straight enough to need no curve, and a corner too sharp to fillet at this radius. The builder must not confuse them, so it measures the deflection itself first and only calls `filletCorner` for corners that genuinely turn. That is why `MIN_DEFLECTION` has to be exported rather than duplicated: two thresholds that drift apart would create corners that are "straight" to one and "turning" to the other.

- [ ] **Step 1: Export the shared threshold**

In `src/geometry/fillet.ts`, change the declaration of `MIN_DEFLECTION` to be exported and extend its comment:

```ts
/**
 * Below this deflection the corner is treated as straight and needs no curve.
 *
 * Exported because `buildPolylineAlignment` must distinguish `filletCorner`'s
 * two `null` results — "straight, no curve needed" from "too sharp to fillet"
 * — by measuring the deflection itself before calling. Two thresholds that
 * drifted apart would produce corners that are straight to one and turning to
 * the other.
 */
export const MIN_DEFLECTION = 1e-6
```

- [ ] **Step 2: Write the failing tests**

Create `src/geometry/polyline.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Arc, Line } from './primitives'
import { type Vec2, distance } from './vec2'
import { buildPolylineAlignment } from './polyline'

const at = (x: number, y: number): Vec2 => ({ x, y })

/** The alignment must start at the first point and end at the last. */
const expectEndpoints = (
  result: ReturnType<typeof buildPolylineAlignment>,
  first: Vec2,
  last: Vec2,
) => {
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const a = result.alignment
  expect(distance(a.poseAt(0).position, first)).toBeLessThan(1e-6)
  expect(distance(a.poseAt(a.length).position, last)).toBeLessThan(1e-6)
}

describe('buildPolylineAlignment', () => {
  it('turns two points into a single straight', () => {
    const result = buildPolylineAlignment([at(0, 0), at(100, 0)], 50)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.alignment.primitives).toHaveLength(1)
    expect(result.alignment.primitives[0]).toBeInstanceOf(Line)
    expect(result.alignment.length).toBeCloseTo(100, 9)
  })

  it('inserts an arc at a corner and keeps the chain continuous', () => {
    const points = [at(0, 0), at(200, 0), at(200, 200)]
    const result = buildPolylineAlignment(points, 50)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const { alignment } = result
    expect(alignment.isContinuous).toBe(true)
    expect(alignment.primitives.map((p) => p.constructor.name)).toEqual([
      'Line', 'Arc', 'Line',
    ])
    expectEndpoints(result, points[0]!, points[2]!)
  })

  it('gives the inserted arc the radius it was asked for', () => {
    const result = buildPolylineAlignment([at(0, 0), at(200, 0), at(200, 200)], 50)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const arc = result.alignment.primitives.find((p) => p instanceof Arc)
    expect(arc).toBeInstanceOf(Arc)
    if (!(arc instanceof Arc)) return
    expect(1 / Math.abs(arc.curvature)).toBeCloseTo(50, 6)
  })

  it('shortens the straights to meet the curve, rather than overshooting the corner', () => {
    // A 90-degree corner at (200, 0) with radius 50 gives T = 50, so the first
    // straight runs 0..150 and the second starts 50m past the corner.
    const result = buildPolylineAlignment([at(0, 0), at(200, 0), at(200, 200)], 50)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [first] = result.alignment.primitives
    expect(first).toBeInstanceOf(Line)
    expect(first?.length).toBeCloseTo(150, 6)
  })

  it('emits no curve for a corner that does not turn', () => {
    const result = buildPolylineAlignment([at(0, 0), at(100, 0), at(200, 0)], 50)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.alignment.primitives.every((p) => p instanceof Line)).toBe(true)
    expect(result.alignment.isContinuous).toBe(true)
    expect(result.alignment.length).toBeCloseTo(200, 6)
  })

  it('handles several corners in a row', () => {
    const points = [at(0, 0), at(300, 0), at(300, 300), at(600, 300), at(600, 600)]
    const result = buildPolylineAlignment(points, 40)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.alignment.isContinuous).toBe(true)
    expect(result.alignment.primitives.filter((p) => p instanceof Arc)).toHaveLength(3)
    expectEndpoints(result, points[0]!, points[4]!)
  })

  it('turns both ways', () => {
    // Right then left. Curvature signs must differ.
    const points = [at(0, 0), at(200, 0), at(200, -200), at(400, -200)]
    const result = buildPolylineAlignment(points, 40)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const arcs = result.alignment.primitives.filter((p): p is Arc => p instanceof Arc)
    expect(arcs).toHaveLength(2)
    expect(Math.sign(arcs[0]!.curvature)).not.toBe(Math.sign(arcs[1]!.curvature))
    expect(result.alignment.isContinuous).toBe(true)
  })

  it('ignores a repeated point', () => {
    const result = buildPolylineAlignment(
      [at(0, 0), at(100, 0), at(100, 0), at(200, 0)],
      50,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // A duplicate leaves a zero-length segment with no direction; every angle
    // computed from it would be meaningless, so it must be dropped rather
    // than treated as a corner.
    expect(result.alignment.length).toBeCloseTo(200, 6)
    expect(result.alignment.isContinuous).toBe(true)
  })

  it('rejects fewer than two distinct points', () => {
    expect(buildPolylineAlignment([at(0, 0)], 50)).toEqual({
      ok: false,
      rejection: { reason: 'too-few-points' },
    })
    expect(buildPolylineAlignment([at(0, 0), at(0, 0)], 50)).toEqual({
      ok: false,
      rejection: { reason: 'too-few-points' },
    })
    expect(buildPolylineAlignment([], 50)).toEqual({
      ok: false,
      rejection: { reason: 'too-few-points' },
    })
  })

  it('rejects a hairpin, naming the point at fault', () => {
    // Almost a full reversal: tangent distance diverges.
    const points = [at(0, 0), at(1000, 0), at(0, 1)]
    const result = buildPolylineAlignment(points, 50)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe('corner-too-sharp')
    if (result.rejection.reason !== 'corner-too-sharp') return
    expect(result.rejection.index).toBe(1)
  })

  it('rejects curves that would overlap, and says by how much', () => {
    // Two 90-degree corners 60m apart, each needing T = 50: 100m of tangent
    // into a 60m straight.
    const points = [at(0, 0), at(200, 0), at(200, 60), at(400, 60)]
    const result = buildPolylineAlignment(points, 50)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe('curves-overlap')
    if (result.rejection.reason !== 'curves-overlap') return
    expect(result.rejection.available).toBeCloseTo(60, 6)
    expect(result.rejection.required).toBeCloseTo(100, 6)
    expect(result.rejection.index).toBe(1)
  })

  it('reports the original index of a bad corner even after a duplicate is dropped', () => {
    // The duplicate at index 1 shifts every later point; the reported index
    // must refer to the caller's array, not the cleaned one.
    const points = [at(0, 0), at(0, 0), at(1000, 0), at(0, 1)]
    const result = buildPolylineAlignment(points, 50)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe('corner-too-sharp')
    if (result.rejection.reason !== 'corner-too-sharp') return
    expect(result.rejection.index).toBe(2)
  })

  it('accepts curves that exactly fill the straight between them', () => {
    // Two 90-degree corners 100m apart, each needing T = 50. Exactly zero
    // straight left between them — legal, and must not emit a zero-length
    // primitive.
    const points = [at(0, 0), at(200, 0), at(200, 100), at(400, 100)]
    const result = buildPolylineAlignment(points, 50)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.alignment.isContinuous).toBe(true)
    for (const p of result.alignment.primitives) {
      expect(p.length).toBeGreaterThan(0)
    }
  })

  it('rejects a non-positive radius', () => {
    expect(() => buildPolylineAlignment([at(0, 0), at(100, 0)], 0)).toThrow(RangeError)
    expect(() => buildPolylineAlignment([at(0, 0), at(100, 0)], -5)).toThrow(RangeError)
  })
})
```

Two of these carry most of the weight. "Reports the original index of a bad corner even after a duplicate is dropped" catches a builder that reports positions in its own cleaned array, which would highlight the wrong point on screen. "Accepts curves that exactly fill the straight between them" is the boundary where a naive `>=` check rejects legal geometry, and where a naive assembly emits a zero-length `Line`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/geometry/polyline.test.ts`

Expected: FAIL — cannot resolve `./polyline`.

- [ ] **Step 4: Implement the builder**

Create `src/geometry/polyline.ts`:

```ts
import { Alignment } from './alignment'
import { type Fillet, MIN_DEFLECTION, filletCorner } from './fillet'
import { Line, type Primitive } from './primitives'
import { type Vec2, angleOf, distance, signedAngleBetween, sub } from './vec2'

export type PolylineRejection =
  | { readonly reason: 'too-few-points' }
  | {
      readonly reason: 'corner-too-sharp'
      /** Index into the caller's array of the corner that cannot be filleted. */
      readonly index: number
    }
  | {
      readonly reason: 'curves-overlap'
      /** Index into the caller's array of the point the straight starts from. */
      readonly index: number
      /** Tangent length the two curves need, metres. */
      readonly required: number
      /** Length of the straight they have to share, metres. */
      readonly available: number
    }

export type PolylineResult =
  | { readonly ok: true; readonly alignment: Alignment }
  | { readonly ok: false; readonly rejection: PolylineRejection }

/**
 * Shorter than this and a segment has no usable direction, metres.
 *
 * A millimetre is far below any distance a player can express by clicking and
 * far above the floating-point noise of a projected pointer position.
 */
const MIN_SEGMENT_LENGTH = 1e-3

/** Slack on the overlap comparison so exactly-touching curves are legal. */
const OVERLAP_TOLERANCE = 1e-9

/**
 * Turn a clicked polyline into a continuous alignment.
 *
 * Every corner that genuinely turns gets a curve of the given radius, and the
 * straights are shortened to meet their curves' tangent points. Two things
 * make that impossible, and both are reported against the caller's own point
 * indices so the tool can show the player which click is the problem: a corner
 * too sharp to fillet at this radius, and two adjacent curves whose tangent
 * lengths together exceed the straight between them.
 */
export const buildPolylineAlignment = (
  points: readonly Vec2[],
  radius: number,
): PolylineResult => {
  if (!(radius > 0)) {
    throw new RangeError('corner radius must be positive')
  }

  // Drop points that repeat their predecessor. A zero-length segment has no
  // direction, and every angle derived from it would be meaningless — but the
  // caller's indices must survive, since a rejection names one of their clicks.
  const kept: { point: Vec2; index: number }[] = []
  points.forEach((point, index) => {
    const last = kept[kept.length - 1]
    if (last && distance(last.point, point) < MIN_SEGMENT_LENGTH) return
    kept.push({ point, index })
  })

  if (kept.length < 2) {
    return { ok: false, rejection: { reason: 'too-few-points' } }
  }

  // fillets[k] belongs to vertex k + 1. A null entry is a corner straight
  // enough to need no curve.
  const fillets: (Fillet | null)[] = []
  for (let v = 1; v < kept.length - 1; v++) {
    const corner = kept[v]!.point
    const incoming = sub(corner, kept[v - 1]!.point)
    const outgoing = sub(kept[v + 1]!.point, corner)

    if (Math.abs(signedAngleBetween(incoming, outgoing)) < MIN_DEFLECTION) {
      fillets.push(null)
      continue
    }

    // Only reached for a corner that genuinely turns, so a null here means
    // "too sharp to fillet", never "straight".
    const fillet = filletCorner(corner, incoming, outgoing, radius)
    if (!fillet) {
      return {
        ok: false,
        rejection: { reason: 'corner-too-sharp', index: kept[v]!.index },
      }
    }
    fillets.push(fillet)
  }

  /** The fillet at a vertex, or null at the two ends and at straight corners. */
  const filletAt = (vertex: number): Fillet | null => {
    if (vertex <= 0 || vertex >= kept.length - 1) return null
    return fillets[vertex - 1] ?? null
  }

  // Each straight has to accommodate the tangent length of the curve at both
  // of its ends.
  for (let seg = 0; seg < kept.length - 1; seg++) {
    const from = kept[seg]!
    const to = kept[seg + 1]!
    const available = distance(from.point, to.point)
    const required =
      (filletAt(seg)?.tangentDistance ?? 0) +
      (filletAt(seg + 1)?.tangentDistance ?? 0)

    if (required > available + OVERLAP_TOLERANCE) {
      return {
        ok: false,
        rejection: { reason: 'curves-overlap', index: from.index, required, available },
      }
    }
  }

  const primitives: Primitive[] = []
  let cursor = kept[0]!.point

  for (let seg = 0; seg < kept.length - 1; seg++) {
    const from = kept[seg]!.point
    const to = kept[seg + 1]!.point
    const endFillet = filletAt(seg + 1)

    // The straight runs from wherever the previous curve let go, to wherever
    // the next one takes over.
    const lineEnd = endFillet ? endFillet.tangentIn : to
    const lineLength = distance(cursor, lineEnd)

    // Two curves may exactly meet, leaving no straight at all. That is legal;
    // a zero-length primitive is not.
    if (lineLength > MIN_SEGMENT_LENGTH) {
      primitives.push(new Line(cursor, angleOf(sub(to, from)), lineLength))
    }

    if (endFillet) {
      primitives.push(endFillet.arc)
      cursor = endFillet.tangentOut
    } else {
      cursor = to
    }
  }

  return { ok: true, alignment: new Alignment(primitives) }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/geometry/polyline.test.ts`

Expected: PASS, 14 tests.

- [ ] **Step 6: Run the whole suite, check types and commit**

Run: `npm test` then `npx tsc --noEmit`

```bash
git add src/geometry/polyline.ts src/geometry/polyline.test.ts src/geometry/fillet.ts
git commit -m "feat: build a continuous alignment from clicked points"
```

---

### Task 2: Where the pointer actually means

A pointer position on the terrain is rarely exactly what the player intends. Near an existing node they mean to connect to it; near an existing road they mean to join it, which will need a split. Away from both they mean the bare ground.

The tool's snap radius is a usability threshold measured in metres of world space, and it is deliberately much larger than `NODE_SNAP_DISTANCE`, which is a statement about topological identity. Keeping them separate is why `nodeAt` is left alone: the graph's first-created-wins rule is right for deciding whether two road ends are the same point, and nearest-wins is right for deciding what a player is pointing at.

**Files:**
- Modify: `src/network/nodeIndex.ts`
- Modify: `src/network/graph.ts`
- Create: `src/tool/snap.ts`
- Create: `src/tool/snap.test.ts`
- Test: `src/network/nodeIndex.test.ts`, `src/network/graph.test.ts`

**Interfaces:**
- Consumes: `RoadNetwork`, `NodeId`, `RoadId` from `src/network/graph`; `Vec2`, `distance` from `src/geometry/vec2`.
- Produces:

```ts
export type SnapTarget =
  | { readonly kind: 'free'; readonly position: Vec2 }
  | { readonly kind: 'node'; readonly position: Vec2; readonly nodeId: NodeId }
  | {
      readonly kind: 'road'
      readonly position: Vec2
      readonly roadId: RoadId
      /** Station along that road, metres. */
      readonly station: number
    }

export const resolveSnap: (
  network: RoadNetwork,
  position: Vec2,
  radius: number,
) => SnapTarget
```

Also `NodeIndex.nearby(position: Vec2, radius?: number): number[]` — an optional wider radius — and `RoadNetwork.nodesWithin(position: Vec2, radius: number): NetworkNode[]`.

Nodes win ties against roads: a node *is* a point on a road, and connecting to an existing junction is almost always what a player near one intends.

- [ ] **Step 1: Write the failing tests for the wider index query**

Add to `src/network/nodeIndex.test.ts`:

```ts
describe('NodeIndex.nearby with a wider radius', () => {
  it('finds a node further away than the default radius', () => {
    const index = new NodeIndex(0.5)
    index.insert(1, { x: 0, y: 0 })
    expect(index.nearby({ x: 6, y: 0 })).toEqual([])
    expect(index.nearby({ x: 6, y: 0 }, 10)).toEqual([1])
  })

  it('scans enough cells for a radius spanning several of them', () => {
    const index = new NodeIndex(0.5)
    // Three cells away on both axes; a one-ring scan would miss it.
    index.insert(2, { x: CELL_SIZE * 3, y: CELL_SIZE * 3 })
    const far = Math.hypot(CELL_SIZE * 3, CELL_SIZE * 3) + 1
    expect(index.nearby({ x: 0, y: 0 }, far)).toEqual([2])
  })

  it('still excludes a node outside the given radius', () => {
    const index = new NodeIndex(0.5)
    index.insert(3, { x: 20, y: 0 })
    expect(index.nearby({ x: 0, y: 0 }, 10)).toEqual([])
  })

  it('keeps ascending id order at a wider radius', () => {
    const index = new NodeIndex(0.5)
    index.insert(9, { x: 1, y: 0 })
    index.insert(2, { x: 2, y: 0 })
    expect(index.nearby({ x: 0, y: 0 }, 10)).toEqual([2, 9])
  })
})
```

The second test is the one that matters: a wider radius needs more than the one-ring neighbourhood the default uses, and an implementation that ignores the radius when choosing how many cells to scan passes every other test here.

- [ ] **Step 2: Run to verify failure, then widen the index**

Run: `npx vitest run src/network/nodeIndex.test.ts`

Expected: FAIL — `nearby` ignores its second argument.

In `src/network/nodeIndex.ts`, replace `nearby` and relax the constructor guard's rationale:

```ts
  /**
   * Every indexed id within a radius of a position, ascending.
   *
   * The scan covers as many rings of cells as the radius spans, so a caller
   * may search wider than the index's default radius — the drawing tool's
   * snap distance is metres of usability, not the half-metre at which two
   * road ends are the same node.
   *
   * Ascending order is not cosmetic. Ids are allocated from a counter, so
   * ascending id is creation order, and the graph's documented snapping rule
   * is that the first node created at a location wins. A grid scan visits
   * cells in an order that has nothing to do with creation, so the sort is
   * what keeps the answer identical to the linear scan it replaced.
   */
  nearby(position: Vec2, radius: number = this.radius): number[] {
    const [cx, cy] = NodeIndex.cellOf(position)
    const rings = Math.max(1, Math.ceil(radius / CELL_SIZE))
    const found: number[] = []

    for (let dx = -rings; dx <= rings; dx++) {
      for (let dy = -rings; dy <= rings; dy++) {
        const bucket = this.cells.get(NodeIndex.key(cx + dx, cy + dy))
        if (!bucket) continue
        for (const id of bucket) {
          const p = this.positions.get(id)
          if (p && distance(p, position) <= radius) found.push(id)
        }
      }
    }

    return found.sort((a, b) => a - b)
  }
```

Update the constructor's guard comment, which currently justifies itself by the one-ring scan:

```ts
  constructor(private readonly radius: number) {
    if (radius > CELL_SIZE) {
      throw new RangeError(
        `default search radius ${radius} exceeds cell size ${CELL_SIZE}; the default one-ring scan would miss nodes`,
      )
    }
  }
```

- [ ] **Step 3: Run the index tests**

Run: `npx vitest run src/network/nodeIndex.test.ts`

Expected: PASS, including the four new tests.

- [ ] **Step 4: Write the failing test for `nodesWithin`**

Add to `src/network/graph.test.ts`:

```ts
describe('nodesWithin', () => {
  it('returns every node inside the radius, nearest first', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    net.addRoad(straight(0, 30, 0, 100), 'rural')

    const found = net.nodesWithin({ x: 0, y: 0 }, 50)
    expect(found.map((n) => n.position.y)).toEqual([0, 30])
  })

  it('excludes nodes outside the radius', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    expect(net.nodesWithin({ x: 0, y: 0 }, 10).map((n) => n.position.y)).toEqual([0])
  })

  it('returns an empty array when nothing is near', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    expect(net.nodesWithin({ x: 5000, y: 5000 }, 50)).toEqual([])
  })
})
```

- [ ] **Step 5: Implement `nodesWithin`**

In `src/network/graph.ts`:

```ts
  /**
   * Every node within a radius, nearest first.
   *
   * Distinct from `nodeAt`, which answers a different question: whether a
   * position *is* an existing node, at the half-metre threshold that defines
   * topological identity, resolving ties to the earliest-created node. This
   * answers what is nearby, at whatever radius the caller finds useful, and
   * orders by distance because a caller asking this is choosing between
   * candidates rather than establishing identity.
   */
  nodesWithin(position: Vec2, radius: number): NetworkNode[] {
    return this.index
      .nearby(position, radius)
      .flatMap((id) => {
        const found = this.nodeMap.get(id)
        return found ? [{ ...found, ends: [...found.ends] }] : []
      })
      .sort(
        (a, b) => distance(a.position, position) - distance(b.position, position),
      )
  }
```

- [ ] **Step 6: Write the failing tests for snap resolution**

Create `src/tool/snap.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { RoadNetwork } from '../network/graph'
import { resolveSnap } from './snap'

const straight = (x: number, y: number, heading: number, length: number) =>
  new Alignment([new Line({ x, y }, heading, length)])

describe('resolveSnap', () => {
  it('reports free ground away from everything', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')

    const result = resolveSnap(net, { x: 500, y: 500 }, 20)
    expect(result).toEqual({ kind: 'free', position: { x: 500, y: 500 } })
  })

  it('snaps to a node and reports the node position, not the pointer', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 100), 'rural')
    const startNode = net.road(id).startNode

    const result = resolveSnap(net, { x: 3, y: 4 }, 20)
    expect(result.kind).toBe('node')
    if (result.kind !== 'node') return
    expect(result.nodeId).toBe(startNode)
    expect(result.position).toEqual({ x: 0, y: 0 })
  })

  it('prefers the nearest node when two are in range', () => {
    const net = new RoadNetwork()
    // Node at (0,0) is created first; node at (0,30) is nearer to the query.
    net.addRoad(straight(0, 0, 0, 10), 'rural')
    const second = net.addRoad(straight(0, 30, 0, 10), 'rural')
    const nearer = net.road(second).startNode

    const result = resolveSnap(net, { x: 0, y: 28 }, 50)
    expect(result.kind).toBe('node')
    if (result.kind !== 'node') return
    // Nearest wins here, unlike nodeAt's first-created-wins identity rule.
    expect(result.nodeId).toBe(nearer)
  })

  it('snaps to a road, reporting the station and the point on the centreline', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 200), 'rural')

    const result = resolveSnap(net, { x: 120, y: 6 }, 20)
    expect(result.kind).toBe('road')
    if (result.kind !== 'road') return
    expect(result.roadId).toBe(id)
    expect(result.station).toBeCloseTo(120, 1)
    expect(result.position.x).toBeCloseTo(120, 1)
    expect(result.position.y).toBeCloseTo(0, 6)
  })

  it('prefers a node to a road when both are in range', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 200), 'rural')
    // Near the start node and also right on the road.
    const result = resolveSnap(net, { x: 2, y: 1 }, 20)
    expect(result.kind).toBe('node')
  })

  it('ignores a road outside the radius', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 200), 'rural')
    const result = resolveSnap(net, { x: 100, y: 60 }, 20)
    expect(result.kind).toBe('free')
  })

  it('picks the nearer of two roads', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 200), 'rural')
    const near = net.addRoad(straight(0, 40, 0, 200), 'rural')

    const result = resolveSnap(net, { x: 100, y: 35 }, 20)
    expect(result.kind).toBe('road')
    if (result.kind !== 'road') return
    expect(result.roadId).toBe(near)
  })

  it('returns free ground on an empty network', () => {
    const result = resolveSnap(new RoadNetwork(), { x: 1, y: 2 }, 20)
    expect(result).toEqual({ kind: 'free', position: { x: 1, y: 2 } })
  })
})
```

"Prefers the nearest node when two are in range" is the test that pins the deliberate divergence from `nodeAt`. It is built so the *earlier-created* node is the *further* one, so an implementation that reuses `nodeAt`'s rule fails it.

- [ ] **Step 7: Run to verify failure, then implement**

Run: `npx vitest run src/tool/snap.test.ts`

Expected: FAIL — cannot resolve `./snap`.

Create `src/tool/snap.ts`:

```ts
import { type Vec2, distance } from '../geometry/vec2'
import type { NetworkNode, NodeId, RoadId, RoadNetwork } from '../network/graph'

export type SnapTarget =
  | { readonly kind: 'free'; readonly position: Vec2 }
  | { readonly kind: 'node'; readonly position: Vec2; readonly nodeId: NodeId }
  | {
      readonly kind: 'road'
      readonly position: Vec2
      readonly roadId: RoadId
      /** Station along that road, metres. */
      readonly station: number
    }

/**
 * How finely a road's centreline is walked when measuring pointer distance.
 *
 * Five metres is well inside the tool's snap radius, so a road cannot slip
 * between samples and read as further away than it is. The nearest sample is
 * then refined, so this spacing bounds the search rather than the answer.
 */
const CENTRELINE_SPACING = 5

/** Refinement passes around the nearest sampled station. */
const REFINEMENT_PASSES = 20

/** Nearest station on a road to a position, and how far away it is. */
const nearestStation = (
  network: RoadNetwork,
  roadId: RoadId,
  position: Vec2,
): { station: number; distance: number; position: Vec2 } => {
  const { alignment } = network.road(roadId)

  let best = 0
  let bestDistance = Infinity
  for (const pose of alignment.sample(CENTRELINE_SPACING)) {
    const d = distance(pose.position, position)
    if (d < bestDistance) {
      bestDistance = d
      best = pose.s
    }
  }

  // Golden-section-free bisection: halve the bracket around the best sample
  // repeatedly, keeping whichever side is nearer.
  let low = Math.max(0, best - CENTRELINE_SPACING)
  let high = Math.min(alignment.length, best + CENTRELINE_SPACING)
  for (let i = 0; i < REFINEMENT_PASSES; i++) {
    const mid = (low + high) / 2
    const quarter = (high - low) / 4
    const left = alignment.poseAt(mid - quarter)
    const right = alignment.poseAt(mid + quarter)
    if (distance(left.position, position) < distance(right.position, position)) {
      high = mid
    } else {
      low = mid
    }
  }

  const station = (low + high) / 2
  const pose = alignment.poseAt(station)
  return { station, distance: distance(pose.position, position), position: pose.position }
}

/**
 * What a pointer position means.
 *
 * Nodes beat roads: a node is itself a point on a road, and a player pointing
 * near a junction almost always means to connect to it rather than to split
 * one of its legs a metre away.
 *
 * `radius` is a usability threshold in metres of world space, deliberately far
 * larger than `NODE_SNAP_DISTANCE`. That constant answers whether two road
 * ends *are* the same node; this answers what a player is pointing at. Nodes
 * are ranked nearest-first here, where `nodeAt` resolves ties to the
 * earliest-created node — the right rule for identity, the wrong one for aim.
 */
export const resolveSnap = (
  network: RoadNetwork,
  position: Vec2,
  radius: number,
): SnapTarget => {
  const nodes: NetworkNode[] = network.nodesWithin(position, radius)
  const nearestNode = nodes[0]
  if (nearestNode) {
    return { kind: 'node', position: nearestNode.position, nodeId: nearestNode.id }
  }

  let best: { roadId: RoadId; station: number; position: Vec2; distance: number } | undefined
  for (const road of network.roads) {
    const candidate = nearestStation(network, road.id, position)
    if (candidate.distance <= radius && (!best || candidate.distance < best.distance)) {
      best = { roadId: road.id, ...candidate }
    }
  }

  if (best) {
    return {
      kind: 'road',
      position: best.position,
      roadId: best.roadId,
      station: best.station,
    }
  }

  return { kind: 'free', position }
}
```

- [ ] **Step 8: Run everything, check types and commit**

Run: `npm test` then `npx tsc --noEmit`

```bash
git add src/network/nodeIndex.ts src/network/nodeIndex.test.ts src/network/graph.ts src/network/graph.test.ts src/tool/snap.ts src/tool/snap.test.ts
git commit -m "feat: resolve what a pointer position means against the network"
```

**Known limitation to record, not to fix here:** `resolveSnap` walks every road in the network to find the nearest one. That is linear in road count on every pointer move. The node lookup is indexed; the road lookup is not. Acceptable at the scale this plan reaches — measure before building a segment index.

---

### Task 3: The drawing state machine

The tool accumulates clicked points, offers a preview of what would be built, and commits. It is pure logic over Tasks 1 and 2 — no three.js, no events, no rendering. That is what makes the interesting behaviour testable.

**Files:**
- Create: `src/tool/drawTool.ts`
- Create: `src/tool/drawTool.test.ts`

**Interfaces:**
- Consumes: `buildPolylineAlignment`, `PolylineRejection` from `src/geometry/polyline`; `resolveSnap`, `SnapTarget` from `src/tool/snap`; `RoadNetwork`, `RoadId` from `src/network/graph`; `ROAD_CLASSES`, `RoadClassName` from `src/network/roadClass`; `minimumRadiusForSpeed` from `src/geometry/designSpeed`.
- Produces: `class DrawTool` with `className`, `points`, `preview`, `hover(position)`, `place(position)`, `undoLastPoint()`, `commit()`, `cancel()`, and the `DrawPreview` type.

The corner radius is not a magic number: it is `minimumRadiusForSpeed` of the class's own design speed. Draw a highway and its corners are automatically gentler than a gravel track's, because that is what the standard demands.

- [ ] **Step 1: Write the failing tests**

Create `src/tool/drawTool.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { RoadNetwork } from '../network/graph'
import { DrawTool } from './drawTool'

const straight = (x: number, y: number, heading: number, length: number) =>
  new Alignment([new Line({ x, y }, heading, length)])

describe('DrawTool', () => {
  it('starts with nothing pending', () => {
    const tool = new DrawTool(new RoadNetwork(), 'rural')
    expect(tool.points).toEqual([])
    expect(tool.preview).toBeUndefined()
  })

  it('offers no preview from a single point', () => {
    const tool = new DrawTool(new RoadNetwork(), 'rural')
    tool.place({ x: 0, y: 0 })
    expect(tool.points).toHaveLength(1)
    expect(tool.preview).toBeUndefined()
  })

  it('previews a straight once two points are placed', () => {
    const tool = new DrawTool(new RoadNetwork(), 'rural')
    tool.place({ x: 0, y: 0 })
    tool.place({ x: 200, y: 0 })

    expect(tool.preview?.ok).toBe(true)
    if (!tool.preview?.ok) return
    expect(tool.preview.alignment.length).toBeCloseTo(200, 6)
  })

  it('includes the hovered position in the preview without placing it', () => {
    const tool = new DrawTool(new RoadNetwork(), 'rural')
    tool.place({ x: 0, y: 0 })
    tool.hover({ x: 200, y: 0 })

    expect(tool.points).toHaveLength(1)
    expect(tool.preview?.ok).toBe(true)
    if (!tool.preview?.ok) return
    expect(tool.preview.alignment.length).toBeCloseTo(200, 6)
  })

  it('drops the hovered position once it is placed', () => {
    const tool = new DrawTool(new RoadNetwork(), 'rural')
    tool.place({ x: 0, y: 0 })
    tool.hover({ x: 200, y: 0 })
    tool.place({ x: 200, y: 0 })

    // Two placed points, not three: the hover must not survive as a duplicate.
    expect(tool.points).toHaveLength(2)
    if (!tool.preview?.ok) return
    expect(tool.preview.alignment.length).toBeCloseTo(200, 6)
  })

  it('snaps a placed point to a nearby node', () => {
    const net = new RoadNetwork()
    const existing = net.addRoad(straight(0, 0, 0, 100), 'rural')
    const startNode = net.road(existing).startNode

    const tool = new DrawTool(net, 'rural')
    tool.place({ x: 3, y: 4 })

    expect(tool.points[0]).toEqual({ x: 0, y: 0 })
    expect(tool.snapAt(0)?.kind).toBe('node')
    if (tool.snapAt(0)?.kind !== 'node') return
    expect(tool.snapAt(0)).toMatchObject({ nodeId: startNode })
  })

  it('surfaces a rejection instead of a preview when the geometry is impossible', () => {
    const tool = new DrawTool(new RoadNetwork(), 'rural')
    tool.place({ x: 0, y: 0 })
    tool.place({ x: 1000, y: 0 })
    tool.place({ x: 0, y: 1 })

    expect(tool.preview?.ok).toBe(false)
    if (tool.preview?.ok !== false) return
    expect(tool.preview.rejection.reason).toBe('corner-too-sharp')
  })

  it('uses a larger corner radius for a faster class', () => {
    const gravel = new DrawTool(new RoadNetwork(), 'gravel')
    const highway = new DrawTool(new RoadNetwork(), 'highway')
    expect(highway.cornerRadius).toBeGreaterThan(gravel.cornerRadius)
  })

  it('undoes the last placed point', () => {
    const tool = new DrawTool(new RoadNetwork(), 'rural')
    tool.place({ x: 0, y: 0 })
    tool.place({ x: 200, y: 0 })
    tool.undoLastPoint()

    expect(tool.points).toHaveLength(1)
    expect(tool.preview).toBeUndefined()
  })

  it('undoing with nothing placed is harmless', () => {
    const tool = new DrawTool(new RoadNetwork(), 'rural')
    expect(() => tool.undoLastPoint()).not.toThrow()
    expect(tool.points).toEqual([])
  })

  it('commits a road into the network and clears itself', () => {
    const net = new RoadNetwork()
    const tool = new DrawTool(net, 'rural')
    tool.place({ x: 0, y: 0 })
    tool.place({ x: 200, y: 0 })

    const result = tool.commit()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(net.roads).toHaveLength(1)
    expect(net.road(result.roadId).className).toBe('rural')
    expect(tool.points).toEqual([])
    expect(tool.preview).toBeUndefined()
  })

  it('refuses to commit an impossible alignment and keeps the points', () => {
    const net = new RoadNetwork()
    const tool = new DrawTool(net, 'rural')
    tool.place({ x: 0, y: 0 })
    tool.place({ x: 1000, y: 0 })
    tool.place({ x: 0, y: 1 })

    const result = tool.commit()
    expect(result.ok).toBe(false)
    expect(net.roads).toHaveLength(0)
    // The player's work is not thrown away because the last corner is bad.
    expect(tool.points).toHaveLength(3)
  })

  it('refuses to commit fewer than two points', () => {
    const net = new RoadNetwork()
    const tool = new DrawTool(net, 'rural')
    tool.place({ x: 0, y: 0 })

    expect(tool.commit().ok).toBe(false)
    expect(net.roads).toHaveLength(0)
  })

  it('splits an existing road when a placed point lands on one', () => {
    const net = new RoadNetwork()
    const existing = net.addRoad(straight(0, 0, 0, 400), 'rural')

    const tool = new DrawTool(net, 'rural')
    tool.place({ x: 200, y: 3 })   // on the existing road, away from its ends
    tool.place({ x: 200, y: 300 })

    const result = tool.commit()
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The original is gone, replaced by its two halves plus the new road.
    expect(() => net.road(existing)).toThrow(RangeError)
    expect(net.roads).toHaveLength(3)

    // And the new road starts at the junction, which now has three legs.
    const startNode = net.road(result.roadId).startNode
    expect(net.isJunction(startNode)).toBe(true)
  })

  it('cancels without touching the network', () => {
    const net = new RoadNetwork()
    const tool = new DrawTool(net, 'rural')
    tool.place({ x: 0, y: 0 })
    tool.place({ x: 200, y: 0 })
    tool.cancel()

    expect(tool.points).toEqual([])
    expect(net.roads).toHaveLength(0)
  })
})
```

The split test is the one that proves the tool is doing engineering rather than drawing: clicking on an existing road has to divide it, so the new road meets a real junction instead of crossing an unbroken one.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/tool/drawTool.test.ts`

Expected: FAIL — cannot resolve `./drawTool`.

- [ ] **Step 3: Implement the tool**

Create `src/tool/drawTool.ts`:

```ts
import { minimumRadiusForSpeed } from '../geometry/designSpeed'
import {
  type PolylineRejection,
  buildPolylineAlignment,
} from '../geometry/polyline'
import type { Alignment } from '../geometry/alignment'
import type { Vec2 } from '../geometry/vec2'
import type { RoadId, RoadNetwork } from '../network/graph'
import { ROAD_CLASSES, type RoadClassName } from '../network/roadClass'
import { type SnapTarget, resolveSnap } from './snap'

export type DrawPreview =
  | { readonly ok: true; readonly alignment: Alignment }
  | { readonly ok: false; readonly rejection: PolylineRejection }

export type CommitResult =
  | { readonly ok: true; readonly roadId: RoadId }
  | { readonly ok: false; readonly rejection: PolylineRejection }

/**
 * How far from the pointer the tool looks for something to snap to, metres.
 *
 * A usability threshold, not a topological one — see `resolveSnap`.
 */
export const SNAP_RADIUS = 15

/**
 * Placing points and turning them into a road.
 *
 * Pure state over the network and two geometric services. Nothing here knows
 * about pointers, cameras or three.js, which is what lets the behaviour that
 * matters — snapping, previewing, splitting on commit — be tested directly.
 */
export class DrawTool {
  private readonly placed: { position: Vec2; snap: SnapTarget }[] = []
  private hovered: Vec2 | undefined

  /** Corner radius for this class, metres. */
  readonly cornerRadius: number

  constructor(
    private readonly network: RoadNetwork,
    readonly className: RoadClassName,
  ) {
    // Not an arbitrary number: the tightest curve this class's own design
    // speed permits. A highway drawn with a gravel track's corners would be
    // illegal the moment it was built.
    this.cornerRadius = minimumRadiusForSpeed(ROAD_CLASSES[className].designSpeedKph)
  }

  get points(): readonly Vec2[] {
    return this.placed.map((p) => p.position)
  }

  /** What the point at an index snapped to, if anything. */
  snapAt(index: number): SnapTarget | undefined {
    return this.placed[index]?.snap
  }

  /** The placed points plus whatever is currently hovered. */
  private get pending(): Vec2[] {
    return this.hovered ? [...this.points, this.hovered] : [...this.points]
  }

  /**
   * What would be built right now, or why it cannot be.
   *
   * `undefined` while there is nothing to show — fewer than two points is not
   * a rejection, it is an unfinished gesture.
   */
  get preview(): DrawPreview | undefined {
    const points = this.pending
    if (points.length < 2) return undefined

    const result = buildPolylineAlignment(points, this.cornerRadius)
    return result.ok
      ? { ok: true, alignment: result.alignment }
      : { ok: false, rejection: result.rejection }
  }

  /** Move the provisional last point. Snaps, so the preview shows the truth. */
  hover(position: Vec2): void {
    this.hovered = resolveSnap(this.network, position, SNAP_RADIUS).position
  }

  place(position: Vec2): void {
    const snap = resolveSnap(this.network, position, SNAP_RADIUS)
    this.placed.push({ position: snap.position, snap })
    this.hovered = undefined
  }

  undoLastPoint(): void {
    this.placed.pop()
  }

  cancel(): void {
    this.placed.length = 0
    this.hovered = undefined
  }

  /**
   * Build the road.
   *
   * A point placed on an existing road splits it first, so the new road meets
   * a real junction rather than crossing an unbroken one. Splitting before
   * adding matters: the split must exist for `addRoad` to snap the new road's
   * end to the node it creates.
   *
   * On rejection the placed points survive. A player whose last corner is too
   * sharp wants to move that corner, not to draw the whole road again.
   */
  commit(): CommitResult {
    const built = buildPolylineAlignment(this.points, this.cornerRadius)
    if (!built.ok) return { ok: false, rejection: built.rejection }

    for (const { snap } of this.placed) {
      if (snap.kind !== 'road') continue
      // The road may already have been split by an earlier point, or the
      // station may be too close to an end to divide; neither is fatal, since
      // addRoad will snap to whatever node is there.
      try {
        this.network.splitRoad(snap.roadId, snap.station)
      } catch {
        // Nothing to do: the position is already a node, or too near one.
      }
    }

    const roadId = this.network.addRoad(built.alignment, this.className)
    this.cancel()
    return { ok: true, roadId }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/tool/drawTool.test.ts`

Expected: PASS, 15 tests.

- [ ] **Step 5: Run everything, check types and commit**

Run: `npm test` then `npx tsc --noEmit`

```bash
git add src/tool/drawTool.ts src/tool/drawTool.test.ts
git commit -m "feat: drawing tool state machine"
```

---

### Task 4: Ray against the terrain

Turning a screen position into a world position means intersecting a ray with the ground. Raycasting the rendered mesh would tie the answer to how finely the terrain happens to be tessellated; marching the ray against the heightfield gives the same answer at any level of detail, and is testable without a renderer.

**Files:**
- Create: `src/terrain/rayCast.ts`
- Create: `src/terrain/rayCast.test.ts`

**Interfaces:**
- Consumes: `TerrainSampler` from `src/terrain/heightmap` (structural type with `heightAt(x: number, y: number): number` — read the file for its exact shape before writing against it).
- Produces:

```ts
export type Ray3 = {
  readonly origin: { readonly x: number; readonly y: number; readonly z: number }
  /** Need not be normalized. */
  readonly direction: { readonly x: number; readonly y: number; readonly z: number }
}

export const rayTerrainIntersection: (
  ray: Ray3,
  terrain: TerrainSampler,
  maxDistance?: number,
) => Vec2 | undefined
```

The method: step along the ray until the point passes below the ground, then bisect the last interval. A ray that never goes below ground within `maxDistance` misses — the player is pointing at the sky.

- [ ] **Step 1: Write the failing tests**

Create `src/terrain/rayCast.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { rayTerrainIntersection } from './rayCast'

/** Flat ground at a fixed height. */
const flat = (z: number) => ({ heightAt: () => z })

/** Ground rising one metre per metre east. */
const ramp = { heightAt: (x: number) => x }

describe('rayTerrainIntersection', () => {
  it('finds the point where a straight-down ray meets flat ground', () => {
    const hit = rayTerrainIntersection(
      { origin: { x: 10, y: 20, z: 100 }, direction: { x: 0, y: 0, z: -1 } },
      flat(0),
    )
    expect(hit).toBeDefined()
    expect(hit?.x).toBeCloseTo(10, 3)
    expect(hit?.y).toBeCloseTo(20, 3)
  })

  it('finds the point where an oblique ray meets flat ground', () => {
    // From 100m up, descending at 45 degrees along +x: hits z=0 at x=100.
    const hit = rayTerrainIntersection(
      { origin: { x: 0, y: 0, z: 100 }, direction: { x: 1, y: 0, z: -1 } },
      flat(0),
    )
    expect(hit).toBeDefined()
    expect(hit?.x).toBeCloseTo(100, 1)
    expect(hit?.y).toBeCloseTo(0, 3)
  })

  it('accounts for the height of the ground it lands on', () => {
    const hit = rayTerrainIntersection(
      { origin: { x: 0, y: 0, z: 100 }, direction: { x: 1, y: 0, z: -1 } },
      flat(40),
    )
    // Descending 1:1 from 100, ground at 40 is reached after 60m of travel.
    expect(hit?.x).toBeCloseTo(60, 1)
  })

  it('does not care whether the direction is normalized', () => {
    const a = rayTerrainIntersection(
      { origin: { x: 0, y: 0, z: 100 }, direction: { x: 1, y: 0, z: -1 } },
      flat(0),
    )
    const b = rayTerrainIntersection(
      { origin: { x: 0, y: 0, z: 100 }, direction: { x: 17, y: 0, z: -17 } },
      flat(0),
    )
    expect(a?.x).toBeCloseTo(b?.x ?? NaN, 3)
  })

  it('hits sloping ground at the right place', () => {
    // Ground rises 1:1 with x; ray descends 1:1 from 100 at x=0.
    // Ground z = x, ray z = 100 - x, so they meet at x = 50.
    const hit = rayTerrainIntersection(
      { origin: { x: 0, y: 0, z: 100 }, direction: { x: 1, y: 0, z: -1 } },
      ramp,
    )
    expect(hit?.x).toBeCloseTo(50, 1)
  })

  it('misses when the ray points at the sky', () => {
    const hit = rayTerrainIntersection(
      { origin: { x: 0, y: 0, z: 100 }, direction: { x: 1, y: 0, z: 1 } },
      flat(0),
    )
    expect(hit).toBeUndefined()
  })

  it('misses when the ground is out of range', () => {
    // Descending very shallowly: ground is thousands of metres away.
    const hit = rayTerrainIntersection(
      { origin: { x: 0, y: 0, z: 100 }, direction: { x: 1, y: 0, z: -0.001 } },
      flat(0),
      500,
    )
    expect(hit).toBeUndefined()
  })

  it('reports the origin when it already starts underground', () => {
    const hit = rayTerrainIntersection(
      { origin: { x: 7, y: 8, z: -10 }, direction: { x: 0, y: 0, z: -1 } },
      flat(0),
    )
    expect(hit?.x).toBeCloseTo(7, 6)
    expect(hit?.y).toBeCloseTo(8, 6)
  })

  it('rejects a zero-length direction', () => {
    expect(() =>
      rayTerrainIntersection(
        { origin: { x: 0, y: 0, z: 100 }, direction: { x: 0, y: 0, z: 0 } },
        flat(0),
      ),
    ).toThrow(RangeError)
  })
})
```

The sloping-ground test is the one a flat-plane shortcut cannot pass: solving `z = 0` analytically gives `x = 100`, and the right answer is 50.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/terrain/rayCast.test.ts`

Expected: FAIL — cannot resolve `./rayCast`.

- [ ] **Step 3: Implement the cast**

Create `src/terrain/rayCast.ts`:

```ts
import type { Vec2 } from '../geometry/vec2'
import type { TerrainSampler } from './heightmap'

export type Vec3 = {
  readonly x: number
  readonly y: number
  readonly z: number
}

export type Ray3 = {
  readonly origin: Vec3
  /** Need not be normalized. */
  readonly direction: Vec3
}

/** Coarse step along the ray, metres. */
const STEP = 4

/** Bisection passes once a crossing is bracketed. */
const REFINEMENT_PASSES = 24

/** Default search length along the ray, metres. */
const DEFAULT_MAX_DISTANCE = 20000

/**
 * Where a ray meets the ground.
 *
 * Marches the heightfield rather than raycasting the rendered mesh, so the
 * answer does not change with the terrain's level of detail — a picked
 * position stays put when the mesh is rebuilt at a different resolution.
 *
 * Returns the horizontal position of the hit. A ray that never passes below
 * ground within `maxDistance` misses: the player is pointing at the sky.
 */
export const rayTerrainIntersection = (
  ray: Ray3,
  terrain: TerrainSampler,
  maxDistance: number = DEFAULT_MAX_DISTANCE,
): Vec2 | undefined => {
  const { origin, direction } = ray
  const magnitude = Math.hypot(direction.x, direction.y, direction.z)
  if (!(magnitude > 0)) {
    throw new RangeError('ray direction must be non-zero')
  }

  const step = {
    x: direction.x / magnitude,
    y: direction.y / magnitude,
    z: direction.z / magnitude,
  }

  /** Height above ground at a distance along the ray. Negative is underground. */
  const clearanceAt = (t: number): number => {
    const x = origin.x + step.x * t
    const y = origin.y + step.y * t
    const z = origin.z + step.z * t
    return z - terrain.heightAt(x, y)
  }

  if (clearanceAt(0) <= 0) {
    return { x: origin.x, y: origin.y }
  }

  let previous = 0
  for (let t = STEP; t <= maxDistance; t += STEP) {
    if (clearanceAt(t) <= 0) {
      // Bracketed: above ground at `previous`, below at `t`.
      let low = previous
      let high = t
      for (let i = 0; i < REFINEMENT_PASSES; i++) {
        const mid = (low + high) / 2
        if (clearanceAt(mid) > 0) low = mid
        else high = mid
      }
      const hit = (low + high) / 2
      return { x: origin.x + step.x * hit, y: origin.y + step.y * hit }
    }
    previous = t
  }

  return undefined
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/terrain/rayCast.test.ts`

Expected: PASS, 9 tests.

- [ ] **Step 5: Run everything, check types and commit**

Run: `npm test` then `npx tsc --noEmit`

```bash
git add src/terrain/rayCast.ts src/terrain/rayCast.test.ts
git commit -m "feat: intersect a ray with the heightfield"
```

**Known limitation to record:** a four-metre step can tunnel through a ridge thinner than four metres along the ray, reporting a hit on the far side. The generated terrain has no such features, so this is not a live problem — but it is the failure mode to look for if a picked position ever lands somewhere surprising.

---

### Task 5: The camera rig

The scene currently orbits on a timer, which is a demo, not a game. The rig holds an orbit state — azimuth, elevation, distance, target — and turns it into a camera position. Keeping that arithmetic separate from three.js makes it testable, and makes the event handling in Task 6 trivial.

**Files:**
- Create: `src/render/cameraRig.ts`
- Create: `src/render/cameraRig.test.ts`

**Interfaces:**
- Consumes: nothing outside itself. This file must NOT import three.js — it produces plain numbers that Task 6 hands to a camera.
- Produces: `class CameraRig` with `target`, `azimuth`, `elevation`, `distance`, `position` (a world-space `{x, y, z}` in the project's own convention, *not* three.js's), `orbit(dAzimuth, dElevation)`, `pan(dRight, dForward)`, `zoom(factor)`, plus `MIN_ELEVATION`, `MAX_ELEVATION`, `MIN_DISTANCE`, `MAX_DISTANCE`.

Elevation is clamped away from straight down and from the horizon: at exactly vertical the azimuth stops meaning anything, and below the horizon the camera is underground.

- [ ] **Step 1: Write the failing tests**

Create `src/render/cameraRig.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  CameraRig,
  MAX_DISTANCE,
  MAX_ELEVATION,
  MIN_DISTANCE,
  MIN_ELEVATION,
} from './cameraRig'

describe('CameraRig', () => {
  it('places the camera at the requested distance from the target', () => {
    const rig = new CameraRig({ x: 100, y: 200, z: 10 }, 800)
    const { position, target } = rig
    const d = Math.hypot(
      position.x - target.x,
      position.y - target.y,
      position.z - target.z,
    )
    expect(d).toBeCloseTo(800, 3)
  })

  it('places the camera above the target', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 0 }, 500)
    expect(rig.position.z).toBeGreaterThan(0)
  })

  it('moves the camera around the target when orbiting, keeping the distance', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 0 }, 500)
    const before = { ...rig.position }
    rig.orbit(Math.PI / 2, 0)
    const after = rig.position

    expect(Math.hypot(after.x, after.y, after.z)).toBeCloseTo(500, 3)
    expect(after.x).not.toBeCloseTo(before.x, 1)
  })

  it('a full turn returns the camera to where it started', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 0 }, 500)
    const before = { ...rig.position }
    rig.orbit(Math.PI * 2, 0)
    expect(rig.position.x).toBeCloseTo(before.x, 6)
    expect(rig.position.y).toBeCloseTo(before.y, 6)
    expect(rig.position.z).toBeCloseTo(before.z, 6)
  })

  it('clamps elevation below vertical', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 0 }, 500)
    rig.orbit(0, 10)
    expect(rig.elevation).toBeLessThanOrEqual(MAX_ELEVATION)
    // At exactly vertical the azimuth stops meaning anything.
    expect(MAX_ELEVATION).toBeLessThan(Math.PI / 2)
  })

  it('clamps elevation above the horizon', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 0 }, 500)
    rig.orbit(0, -10)
    expect(rig.elevation).toBeGreaterThanOrEqual(MIN_ELEVATION)
    expect(MIN_ELEVATION).toBeGreaterThan(0)
    // Above the horizon means the camera stays above the target's plane.
    expect(rig.position.z).toBeGreaterThan(0)
  })

  it('zooms within bounds', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 0 }, 500)
    rig.zoom(0.5)
    expect(rig.distance).toBeCloseTo(250, 6)

    rig.zoom(0.0001)
    expect(rig.distance).toBe(MIN_DISTANCE)

    rig.zoom(100000)
    expect(rig.distance).toBe(MAX_DISTANCE)
  })

  it('rejects a non-positive zoom factor', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 0 }, 500)
    expect(() => rig.zoom(0)).toThrow(RangeError)
    expect(() => rig.zoom(-1)).toThrow(RangeError)
  })

  it('pans the target in the camera\'s own frame, not the world\'s', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 0 }, 500)
    // Face along +x, then pan "forward": the target must move along the
    // camera's forward axis, not along world +y.
    rig.orbit(-rig.azimuth, 0)
    const before = { ...rig.target }
    rig.pan(0, 100)

    const moved = Math.hypot(rig.target.x - before.x, rig.target.y - before.y)
    expect(moved).toBeCloseTo(100, 3)
    expect(rig.target.z).toBeCloseTo(before.z, 9)
  })

  it('pans right perpendicular to forward', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 0 }, 500)
    const before = { ...rig.target }
    rig.pan(100, 0)
    const right = { x: rig.target.x - before.x, y: rig.target.y - before.y }

    const after = { ...rig.target }
    rig.pan(0, 100)
    const forward = { x: rig.target.x - after.x, y: rig.target.y - after.y }

    expect(right.x * forward.x + right.y * forward.y).toBeCloseTo(0, 6)
  })

  it('keeps panning horizontal however steep the view', () => {
    const rig = new CameraRig({ x: 0, y: 0, z: 50 }, 500)
    rig.orbit(0, 10)   // clamped to near-vertical
    const before = rig.target.z
    rig.pan(100, 100)
    expect(rig.target.z).toBeCloseTo(before, 9)
  })

  it('rejects a non-positive starting distance', () => {
    expect(() => new CameraRig({ x: 0, y: 0, z: 0 }, 0)).toThrow(RangeError)
  })
})
```

The two panning tests carry the weight. Panning in world axes instead of the camera's frame feels wrong immediately but passes any test that only checks the target moved; and panning along the camera's true forward vector rather than its horizontal projection drags the target underground as the view steepens.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/render/cameraRig.test.ts`

Expected: FAIL — cannot resolve `./cameraRig`.

- [ ] **Step 3: Implement the rig**

Create `src/render/cameraRig.ts`:

```ts
export type Vec3 = {
  readonly x: number
  readonly y: number
  readonly z: number
}

/**
 * Elevation bounds, radians above the horizontal.
 *
 * Not quite vertical, because at exactly vertical the azimuth stops meaning
 * anything and the view spins on the spot. Not quite horizontal, because
 * below that the camera is underground.
 */
export const MAX_ELEVATION = Math.PI / 2 - 0.05
export const MIN_ELEVATION = 0.1

export const MIN_DISTANCE = 40
export const MAX_DISTANCE = 6000

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value

/**
 * An orbiting camera, as numbers.
 *
 * Deliberately free of three.js: the arithmetic that decides where the camera
 * is belongs to the game, and keeping it here means it can be tested without
 * a renderer, a canvas or a DOM. `render/` converts the result into three.js's
 * handedness at the point of use — this class speaks the project's own
 * convention throughout, `(x, y)` on the ground with `z` up.
 */
export class CameraRig {
  private targetPosition: Vec3
  azimuth = Math.PI / 4
  elevation = Math.PI / 5
  distance: number

  constructor(target: Vec3, distance: number) {
    if (!(distance > 0)) {
      throw new RangeError('camera distance must be positive')
    }
    this.targetPosition = target
    this.distance = clamp(distance, MIN_DISTANCE, MAX_DISTANCE)
  }

  get target(): Vec3 {
    return this.targetPosition
  }

  get position(): Vec3 {
    const horizontal = this.distance * Math.cos(this.elevation)
    return {
      x: this.targetPosition.x + horizontal * Math.cos(this.azimuth),
      y: this.targetPosition.y + horizontal * Math.sin(this.azimuth),
      z: this.targetPosition.z + this.distance * Math.sin(this.elevation),
    }
  }

  orbit(dAzimuth: number, dElevation: number): void {
    this.azimuth += dAzimuth
    this.elevation = clamp(this.elevation + dElevation, MIN_ELEVATION, MAX_ELEVATION)
  }

  /**
   * Slide the target across the ground.
   *
   * `forward` is the camera's heading projected onto the ground, not its true
   * view direction — otherwise panning would drive the target into the terrain
   * as the view steepened, which is not what dragging a map should do.
   */
  pan(dRight: number, dForward: number): void {
    // The camera looks from its position back toward the target, so its
    // ground-plane forward is the opposite of the direction it sits in.
    const forwardX = -Math.cos(this.azimuth)
    const forwardY = -Math.sin(this.azimuth)
    // Right is forward turned ninety degrees clockwise on the ground.
    const rightX = forwardY
    const rightY = -forwardX

    this.targetPosition = {
      x: this.targetPosition.x + rightX * dRight + forwardX * dForward,
      y: this.targetPosition.y + rightY * dRight + forwardY * dForward,
      z: this.targetPosition.z,
    }
  }

  zoom(factor: number): void {
    if (!(factor > 0)) {
      throw new RangeError('zoom factor must be positive')
    }
    this.distance = clamp(this.distance * factor, MIN_DISTANCE, MAX_DISTANCE)
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/render/cameraRig.test.ts`

Expected: PASS, 12 tests.

- [ ] **Step 5: Run everything, check types and commit**

Run: `npm test` then `npx tsc --noEmit`

```bash
git add src/render/cameraRig.ts src/render/cameraRig.test.ts
git commit -m "feat: orbit camera rig"
```

---

### Task 6: Wire it together

Everything above is testable in isolation and none of it is reachable by a player. This task connects them: pointer events drive the rig and the tool, the preview appears in the world, and committing rebuilds the scene.

This is the one task whose acceptance is visual. Its logic lives in Tasks 1–5, which are already covered; what remains is plumbing, and plumbing is verified by using it.

**Files:**
- Modify: `src/debug/roadScene.ts`
- Test: `src/debug/roadScene.test.ts` (exists — extend where the change is testable without a renderer)

**Interfaces:**
- Consumes: `CameraRig` from `src/render/cameraRig`; `rayTerrainIntersection` from `src/terrain/rayCast`; `DrawTool`, `SNAP_RADIUS` from `src/tool/drawTool`; the scene's existing `buildSceneContent` and mesh pipeline.
- Produces: no new exported API. `drawRoadScene` keeps its signature — `(canvas: HTMLCanvasElement) => () => void`, returning a teardown.

- [ ] **Step 1: Replace the automatic orbit with the rig**

`src/debug/roadScene.ts` currently advances a camera around `ORBIT_CENTER` on a timer, using `ORBIT_RADIUS`, `ORBIT_HEIGHT` and `ORBIT_PERIOD_S`. Delete those constants and the animation that reads them.

Construct a `CameraRig` targeting the same place the orbit centred on, and set the three.js camera from it each frame. The rig speaks the project's convention — `(x, y)` on the ground, `z` up — and three.js wants `(x, z, −y)`, which is the conversion `src/render/meshAdapter.ts` already performs for geometry. Apply the same mapping here to both the rig's `position` and its `target`; do not invent a second convention.

- [ ] **Step 2: Drive the rig from pointer events**

On the canvas:

- **Drag with the right button, or with the left button plus shift** — orbit. Scale pixel movement to radians; something near 0.005 rad per pixel feels right, and the sign should be such that dragging right turns the world left, as in every map.
- **Drag with the middle button** — pan. Scale by `rig.distance` so the ground keeps pace with the pointer whatever the zoom.
- **Wheel** — zoom, via `rig.zoom`. Use a multiplicative factor per notch, not an additive one, so zooming feels the same at every scale.

Call `preventDefault` on the wheel and on the context menu so the page does not scroll and the right button does not open a menu.

- [ ] **Step 3: Turn pointer positions into world positions**

For a pointer at client coordinates, build a ray from the camera through that point. three.js's `Raycaster.setFromCamera` gives the ray in three.js space; convert its origin and direction back to the project's convention (invert the mapping from Step 1) and pass them to `rayTerrainIntersection` with the scene's terrain sampler.

Do **not** raycast the terrain mesh. The whole reason Task 4 exists is that a mesh raycast ties the picked position to the tessellation.

- [ ] **Step 4: Drive the tool**

- **Left click without shift** — `tool.place(worldPosition)`.
- **Pointer move without a drag in progress** — `tool.hover(worldPosition)`.
- **Enter, or a double click** — `tool.commit()`. On success, rebuild the scene's meshes from the mutated network and clear the preview. On rejection, leave the points alone and show the rejection.
- **Escape** — `tool.cancel()`.
- **Backspace** — `tool.undoLastPoint()`.

The tool needs the same `RoadNetwork` instance the scene built its meshes from, so `buildSceneContent` must expose it if it does not already.

- [ ] **Step 5: Render the preview**

Each frame, if `tool.preview` exists:

- **`ok: true`** — sample the alignment every few metres, lift each point to the terrain height plus a small margin so it does not z-fight, and draw it as a `THREE.Line`. A pale colour reads as provisional.
- **`ok: false`** — draw the placed points connected by straight segments in a warning colour, so the player sees the shape they have asked for and that it cannot be built. Log the rejection's reason and its numbers to the console; a proper on-screen message is the inspector panel's job, in a later plan.

Also draw a small marker at the snapped hover position, coloured by `SnapTarget.kind`, so it is visible when the pointer has latched onto a node or a road rather than free ground.

Dispose of the preview's geometry when replacing it. A preview rebuilt every frame without disposal leaks GPU memory for as long as the player is drawing.

- [ ] **Step 6: Rebuild on commit**

After a successful commit the network has changed — a new road, possibly a split one. The scene must regenerate the design profiles, the excavation and the meshes for the affected roads. `buildSceneContent` already does all of this for the demo network; the least-risk approach is to extract that body so it can be re-run against the mutated network, and to replace the scene's road meshes with the result.

Remove the old meshes from the scene and dispose their geometries before adding the new ones.

**Known limitation to record:** this rebuilds every road, not just the affected ones. Correct, and slow once the network is large. Measure before making it incremental.

- [ ] **Step 7: Extend what can be tested without a renderer**

`src/debug/roadScene.test.ts` exercises `buildSceneContent` directly. Add a test that the scene content exposes its `RoadNetwork`, and that rebuilding after adding a road produces a mesh for it. Do not attempt to test the event handlers; they need a canvas and a GPU, and the logic they call is already covered.

- [ ] **Step 8: Verify by using it**

Run: `npm run dev`

Open **`http://localhost:5173/chainage/`** — the base path is `/chainage/`, and the bare root returns a redirect and a blank page.

Confirm, and report each:

1. Dragging orbits the view; the camera never flips over the top or sinks below the ground.
2. The wheel zooms, and zooming feels the same when close as when far.
3. Middle-drag pans, and the ground keeps pace with the pointer.
4. Clicking twice on open ground previews a straight; a third click away from the line previews a curve at the corner.
5. The preview's curve visibly has a radius rather than a mitre.
6. Hovering near an existing road's end shows the snap marker change, and the preview endpoint jumps to the node.
7. Committing builds the road: it appears with its pavement layers, its earthworks, and a junction where it meets an existing road.
8. Drawing a deliberately sharp switchback shows the warning colour rather than building something wrong, and the console names the reason.
9. Escape clears a pending road; Backspace removes one point.

- [ ] **Step 9: Commit**

```bash
git add src/debug/roadScene.ts src/debug/roadScene.test.ts
git commit -m "feat: draw roads with the pointer"
```

---

## Deliberately not in this plan

- **Selection, delete, split and upgrade in the UI.** The verbs all exist and are tested; what is missing is a way to pick an existing road and act on it. That is the next plan, and it is the one that finishes what the player asked for.
- **The tilt-shift diorama look.** Camera framing, depth of field, materials and lighting. The rig built here is what that plan will aim.
- **On-screen messages.** Rejections go to the console for now. The inspector panel is a later plan and is where they belong.
- **Incremental mesh rebuild.** Committing rebuilds every road.
- **A spatial index for roads.** `resolveSnap` walks them all on every pointer move.
- **Clothoid transitions in drawn roads.** The builder inserts circular curves only. `Spiral` exists and is tested, and a road that eases into its curves is both more realistic and more comfortable — but it changes the tangent-length arithmetic, so it is its own piece of work.

---

## Self-Review

**Spec coverage.** §4 of the design spec calls for a hybrid freeform draw with smart snap: Task 1 is the freeform half, Task 2 and Task 3 the snap half. §5's legibility requirements are partly met — the preview distinguishes buildable from not, and the snap marker shows what the pointer has caught — and partly deferred to the inspector plan, which is where on-screen text belongs.

The open question I flagged when finishing the previous plan is resolved here, and deliberately: `nodeAt` keeps first-created-wins because it answers a question about topological identity, and the tool gets its own nearest-wins resolution at a much larger radius because it answers a question about aim. Task 2's "prefers the nearest node when two are in range" is built so the earlier-created node is the further one, which makes the divergence load-bearing rather than incidental.

**Type consistency.** `SnapTarget` is defined in Task 2 and consumed by name in Task 3. `PolylineRejection` is defined in Task 1 and re-exported through `DrawPreview` and `CommitResult` in Task 3. `Vec3` is declared independently in Task 4 (`terrain/rayCast.ts`) and Task 5 (`render/cameraRig.ts`) — the duplication is deliberate, since `geometry/` has no 3D vector type and inventing one for two consumers in different layers would be worse than two four-line declarations. If a third consumer appears, promote it.

**One thing I could not verify from the plan alone.** Task 6 Step 3 inverts the handedness mapping applied in Step 1. `src/render/meshAdapter.ts` maps `(x, y, z) → (x, z, −y)`, whose inverse is `(x, y, z) → (x, −z, y)`. The implementer should confirm that against the file rather than trusting this paragraph, and say so if it differs — a sign error here would put every picked position in the wrong place, and it would look like a snapping bug rather than a conversion one.
