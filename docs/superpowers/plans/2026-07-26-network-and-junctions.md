# Chainage — Network Graph & Junctions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make roads connect. A network graph that knows which roads meet where, road ribbons trimmed back to clear each other, and a junction surface filling the gap they leave.

**Architecture:** `src/network/` holds the graph — pure topology over alignment references, no geometry generation. `src/mesh/junction.ts` turns a node's connected road ends into a trim distance per leg and a polygon mesh. Both are plain-typed-array producers like the rest of `src/mesh/`; nothing here imports three.js.

**Tech Stack:** TypeScript (strict), Vitest.

## Why this is the risky one

The design spec names junction geometry the project's highest risk, and it is right. Every shipped city builder has visible junction failure modes. The reason is that the maths degenerates: as two roads approach parallel, the corner between their edges shoots off toward infinity, and a naive implementation happily emits a junction kilometres wide.

This plan takes the same stance the earthworks layer took toward truncated cross-sections: **detect the degenerate case and report it, rather than emitting confident garbage.** A junction that cannot be built is a fact the tool can show the player. A junction that is silently wrong is a bug nobody finds until it is on screen.

## The geometry, worked out

A junction node sits at point `P`. Some number of road ends — **legs** — meet there. Each leg has an outward direction `d` (a unit vector pointing away from `P` along that road) and a half-width `w`.

**Sort legs counter-clockwise by bearing.** Everything downstream depends on that ordering.

**Corners.** Between each adjacent pair of legs there is one corner. Sweeping counter-clockwise from leg `i` to leg `j`, the sector between them is bounded by leg `i`'s **left** edge and leg `j`'s **right** edge, so the corner is where those two lines cross:

```
line A:  through P + n_i·w_i,  direction d_i      (n_i = d_i rotated +90°, i.e. left)
line B:  through P − n_j·w_j,  direction d_j
```

Standard line-line intersection: for `a + t·u = b + s·v`,

```
denominator = cross(u, v)
t = cross(b − a, v) / denominator
```

**A near-zero `denominator` means two different things, and conflating them breaks every T junction.** `cross(d_i, d_j)` vanishes when the legs point nearly the *same* way **and** when they point nearly *opposite*. Only the first is a defect:

- **Same direction** (`dot(d_i, d_j) > 0`): two roads leaving the node on top of each other. There is no usable corner and no sensible junction. Report `near-parallel-legs`.
- **Opposite directions** (`dot(d_i, d_j) < 0`): a road passing straight through, which is the commonest junction there is — every T has one. The two facing edges are *parallel*, and coincident when the widths match, so there is no unique intersection point. But nothing is wrong. Place the corner at the foot of the perpendicular from the node, laterally at the wider of the two half-widths:

  ```
  corner = left(d_i) · max(w_i, w_j)
  ```

  Because that point is perpendicular to both legs, `dot(corner, d_i)` is zero — it contributes no trim, which is right: a road running straight through needs no pulling back on its outer side.

Getting this wrong rejects every T junction as degenerate, which is exactly what happened on the first implementation attempt.

**Trim distance.** Leg `i` must be pulled back far enough to clear both of its corners:

```
trim_i = max(0, dot(cornerBefore − P, d_i), dot(cornerAfter − P, d_i))
```

**Junction polygon.** Counter-clockwise, for each leg in order: the leg's trimmed right point, its trimmed left point, then the corner between it and the next leg. Three vertices per leg. Triangulate as a fan from `P`, which is valid because a junction polygon is star-shaped about its own node for any geometry that is not already degenerate.

**Nodes with fewer than three legs are not junctions.** One leg is a dead end; two legs are a road passing through, which the alignment already handles as a bend. Only three or more legs need a junction surface. This mirrors how Cities: Skylines classifies nodes, and it removes a whole family of edge cases.

## Global Constraints

- **Dependency direction, one way only:** `geometry/` imports nothing. `terrain/` imports `geometry/`. `network/` imports `geometry/`. `mesh/` imports `geometry/`, `terrain/` and `network/`. `render/` imports `mesh/` and three.js. `debug/` may import anything.
- **One stated exception, and the reason it is safe.** `network/graph.ts` needs the `RoadClassName` union to type a road's class, and that type lives in `mesh/roadClass.ts` — while `mesh/junctionLegs.ts` imports `network/graph.ts`. That looks like a cycle and is not one, provided the import is written `import type { RoadClassName } from '../mesh/roadClass'`. This project sets `verbatimModuleSyntax`, so a type-only import emits nothing at all: there is no runtime edge and no bundler edge, only a compile-time reference. **It must be `import type`, never a value import.** If road classes ever gain runtime dependencies of their own, move the union to its own leaf module rather than relaxing this.
- **`src/network/` and `src/mesh/` must NOT import three.js.**
- **Coordinates:** `(x, y)` metres, `y` north; `z` elevation positive up. The handedness conversion to three's `+Y`-up happens only inside `src/render/` and the debug scene.
- **Leg directions point OUTWARD from the junction node**, always. A road arriving at a node contributes a leg pointing back the way it came.
- **Legs are sorted counter-clockwise by bearing.** Every corner, trim and polygon routine assumes it.
- **`SectionPoint.offset` is negative to the left** of travel; `fromAngle(heading + π/2)` points left, so offsets are negated when placing vertices.
- **TypeScript:** `strict: true`, `noUncheckedIndexedAccess: true`.
- **Float comparison in tests:** `toBeCloseTo` precision 9 for exact-form math, precision 4 for swept or sampled results.
- **Commits:** conventional commit prefixes.

## Existing interfaces this plan builds on

All merged, 283 tests passing.

```ts
// src/geometry/vec2.ts
type Vec2 = { readonly x: number; readonly y: number }
const vec2, add, sub, scale, dot, cross, length, distance, normalize: /* ... */
const fromAngle: (radians: number) => Vec2
const angleOf: (a: Vec2) => number
const normalizeAngle: (radians: number) => number      // into (-PI, PI]
const signedAngleBetween: (from: Vec2, to: Vec2) => number

// src/geometry/alignment.ts
class Alignment {
  readonly primitives: readonly Primitive[]
  readonly length: number
  readonly continuityBreaks: ContinuityBreak[]
  get isEmpty(): boolean
  get isContinuous(): boolean
  poseAt(s: number): Pose                 // Pose.s is the alignment-wide station
  primitiveAt(s: number): { readonly index: number; readonly localS: number }
  sample(spacing: number): Pose[]
}
type Pose = { readonly s: number; readonly position: Vec2; readonly heading: number; readonly curvature: number }

// src/terrain/groundProfile.ts
type ProfilePoint = { readonly s: number; readonly z: number }
const designElevationAtStation: (profile: readonly ProfilePoint[], s: number) => number

// src/mesh/roadClass.ts
type RoadClassName = 'gravel' | 'rural' | 'arterial' | 'highway'
type LayerName = 'subgrade' | 'base' | 'wearing'
type RoadClass = { /* laneCount, laneWidth, shoulderWidth, crossfall, designSpeedKph, layers */ }
const ROAD_CLASSES: Readonly<Record<RoadClassName, RoadClass>>
const formationHalfWidth: (rc: RoadClass) => number
const totalPavementThickness: (rc: RoadClass) => number

// src/mesh/crossSection.ts
type SectionPoint = { readonly offset: number; readonly dz: number }
const layerTopProfile: (rc: RoadClass, layer: LayerName) => SectionPoint[]

// src/mesh/ribbon.ts
type MeshData = {
  readonly positions: Float32Array; readonly normals: Float32Array
  readonly uvs: Float32Array; readonly indices: Uint32Array
  readonly vertexCount: number; readonly triangleCount: number
}
type RibbonOptions = {
  readonly spacing?: number; readonly startStation?: number
  readonly endStation?: number; readonly uvTileLength?: number
}
const sweepRibbon: (a: Alignment, design: readonly ProfilePoint[], section: readonly SectionPoint[], o?: RibbonOptions) => MeshData

// src/mesh/roadMesh.ts
type LayerStations = Readonly<Partial<Record<LayerName, number>>>
type RoadMesh = { readonly layers: readonly { readonly name: LayerName; readonly mesh: MeshData }[] }
const buildRoadMesh: (a, design, rc, stations?, options?) => RoadMesh
```

---

### Task 1: Roads can be trimmed at both ends

Carried forward from plan 3a's final review. `buildRoadMesh` hardcodes `startStation: 0`, so a road always begins at its alignment start. Junctions need it pulled back from **both** ends. `sweepRibbon` already supports an arbitrary range; only the assembler refuses to use it.

The existing comment advises slicing the alignment instead. That advice is wrong and should go: slicing would renumber every station, destroying global chainage — the measurement the game is named after.

**Files:**
- Modify: `src/mesh/roadMesh.ts`, `src/mesh/roadMesh.test.ts`

**Interfaces:**
- Consumes: `buildRoadMesh`, `LayerStations`, `RoadMesh` as they exist
- Produces:
  - `type RoadExtent = { readonly from: number; readonly to: number }` — the stations between which this road physically exists, after junction trimming
  - `buildRoadMesh(alignment, design, roadClass, stations?, options?, extent?)` — `extent` defaults to the whole alignment
  - Per-layer stations remain **absolute alignment stations**, not offsets from `extent.from`. A layer renders from `extent.from` to `clamp(station, extent.from, extent.to)`. Omitting a layer means it renders nothing.
  - Throws `RangeError` if `extent.to < extent.from`

- [ ] **Step 1: Write the failing tests**

Append to `src/mesh/roadMesh.test.ts`:

```ts
describe('buildRoadMesh extent', () => {
  it('builds the whole alignment when no extent is given', () => {
    const withOut = buildRoadMesh(road(200), level(200, 50), rural, undefined, { spacing: 50 })
    const whole = buildRoadMesh(road(200), level(200, 50), rural, undefined, { spacing: 50 },
      { from: 0, to: 200 })
    expect(whole.layers[0]!.mesh.vertexCount).toBe(withOut.layers[0]!.mesh.vertexCount)
  })

  it('starts the road at the extent start, not the alignment start', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural, undefined, { spacing: 100 },
      { from: 40, to: 200 })
    // First crown vertex x is the extent start, not 0.
    const wearing = m.layers.find((l) => l.name === 'wearing')!.mesh
    let smallestX = Infinity
    for (let i = 0; i < wearing.vertexCount; i++) {
      smallestX = Math.min(smallestX, wearing.positions[i * 3]!)
    }
    expect(smallestX).toBeCloseTo(40, 4)
  })

  it('ends the road at the extent end', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural, undefined, { spacing: 100 },
      { from: 0, to: 160 })
    const wearing = m.layers.find((l) => l.name === 'wearing')!.mesh
    let largestX = -Infinity
    for (let i = 0; i < wearing.vertexCount; i++) {
      largestX = Math.max(largestX, wearing.positions[i * 3]!)
    }
    expect(largestX).toBeCloseTo(160, 4)
  })

  it('clamps a construction station into the extent', () => {
    // Station 500 is past the extent end; the layer must stop at 160, not 500.
    const m = buildRoadMesh(road(200), level(200, 50), rural,
      { subgrade: 500, base: 500, wearing: 500 }, { spacing: 100 }, { from: 0, to: 160 })
    const wearing = m.layers.find((l) => l.name === 'wearing')!.mesh
    let largestX = -Infinity
    for (let i = 0; i < wearing.vertexCount; i++) {
      largestX = Math.max(largestX, wearing.positions[i * 3]!)
    }
    expect(largestX).toBeCloseTo(160, 4)
  })

  it('treats a construction station before the extent start as nothing built', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural,
      { subgrade: 20 }, { spacing: 50 }, { from: 40, to: 200 })
    expect(m.layers.find((l) => l.name === 'subgrade')!.mesh.vertexCount).toBe(0)
  })

  it('trims both ends at once', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural, undefined, { spacing: 20 },
      { from: 30, to: 170 })
    const wearing = m.layers.find((l) => l.name === 'wearing')!.mesh
    let smallestX = Infinity
    let largestX = -Infinity
    for (let i = 0; i < wearing.vertexCount; i++) {
      const x = wearing.positions[i * 3]!
      smallestX = Math.min(smallestX, x)
      largestX = Math.max(largestX, x)
    }
    expect(smallestX).toBeCloseTo(30, 4)
    expect(largestX).toBeCloseTo(170, 4)
  })

  it('rejects an inverted extent', () => {
    expect(() => buildRoadMesh(road(200), level(200, 50), rural, undefined, {},
      { from: 150, to: 50 })).toThrow(RangeError)
  })

  it('returns an empty mesh for a zero-length extent', () => {
    const m = buildRoadMesh(road(200), level(200, 50), rural, undefined, {},
      { from: 80, to: 80 })
    for (const layer of m.layers) expect(layer.mesh.vertexCount).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/mesh/roadMesh.test.ts
```

Expected: FAIL — `buildRoadMesh` takes five parameters, not six.

- [ ] **Step 3: Write the implementation**

Replace the body of `src/mesh/roadMesh.ts`'s `buildRoadMesh` and add the type:

```ts
/**
 * The stations between which a road physically exists.
 *
 * A road running into a junction is trimmed back so its ribbon does not
 * overlap the junction surface, which means it can start after its alignment
 * starts and end before its alignment ends. Stations stay **absolute** —
 * chainage is measured from the alignment origin and never renumbered, which
 * is the whole point of the measurement the game is named after.
 */
export type RoadExtent = {
  readonly from: number
  readonly to: number
}

export const buildRoadMesh = (
  alignment: Alignment,
  design: readonly ProfilePoint[],
  roadClass: RoadClass,
  stations?: LayerStations,
  options: RibbonOptions = {},
  extent?: RoadExtent,
): RoadMesh => {
  const from = extent ? extent.from : 0
  const to = extent ? extent.to : alignment.length

  if (to < from) {
    throw new RangeError('extent.to must not be less than extent.from')
  }

  const layers = roadClass.layers.map((spec) => {
    // A construction station is an absolute alignment station. Clamp it into
    // the extent: past the end means fully built, before the start means not
    // started. Omitting the layer entirely also means not started.
    const requested = stations === undefined ? to : stations[spec.name] ?? from
    const endStation = requested < from ? from : requested > to ? to : requested

    const section = layerTopProfile(roadClass, spec.name)
    const mesh = sweepRibbon(alignment, design, section, {
      ...options,
      startStation: from,
      endStation,
    })

    return { name: spec.name, mesh }
  })

  return { layers }
}
```

Delete the old comment advising callers to slice the alignment.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS. The suite grows by 8 to 291.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: let roads be trimmed at both ends for junctions"
```

---

### Task 2: Road network graph

Pure topology. Which roads exist, and which ends meet at which nodes. No geometry generation — that is `src/mesh/`'s job.

**Files:**
- Create: `src/network/graph.ts`
- Test: `src/network/graph.test.ts`

**Interfaces:**
- Consumes: `Alignment` from `../geometry/alignment`; `Vec2`, `distance` from `../geometry/vec2`
- Produces:
  - `type NodeId = number`, `type RoadId = number`
  - `type RoadEnd = { readonly roadId: RoadId; readonly end: 'start' | 'end' }`
  - `type NetworkNode = { readonly id: NodeId; readonly position: Vec2; readonly ends: readonly RoadEnd[] }`
  - `type Road = { readonly id: RoadId; readonly alignment: Alignment; readonly className: RoadClassName; readonly startNode: NodeId; readonly endNode: NodeId }`
  - `class RoadNetwork` with:
    - `addRoad(alignment: Alignment, className: RoadClassName): RoadId` — creates or reuses nodes at both ends
    - `readonly roads: readonly Road[]`, `readonly nodes: readonly NetworkNode[]`
    - `road(id: RoadId): Road`, `node(id: NodeId): NetworkNode` — both throw `RangeError` for an unknown id
    - `nodeAt(position: Vec2): NetworkNode | undefined` — finds an existing node within `NODE_SNAP_DISTANCE`
    - `isJunction(id: NodeId): boolean` — three or more ends
  - `NODE_SNAP_DISTANCE = 0.5` metres — two road ends this close are the same node

- [ ] **Step 1: Write the failing tests**

`src/network/graph.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { RoadNetwork, NODE_SNAP_DISTANCE } from './graph'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'

const straight = (fromX: number, fromY: number, heading: number, length: number) =>
  new Alignment([new Line(vec2(fromX, fromY), heading, length)])

describe('RoadNetwork basics', () => {
  it('creates two nodes for the first road', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    expect(net.roads).toHaveLength(1)
    expect(net.nodes).toHaveLength(2)
  })

  it('records which nodes a road connects', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 100), 'rural')
    const road = net.road(id)
    expect(net.node(road.startNode).position.x).toBeCloseTo(0, 6)
    expect(net.node(road.endNode).position.x).toBeCloseTo(100, 6)
  })

  it('reuses a node when a second road ends at the same point', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    net.addRoad(straight(100, 0, Math.PI / 2, 100), 'rural')
    expect(net.nodes).toHaveLength(3)
  })

  it('reuses a node within the snap distance', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    net.addRoad(straight(100 + NODE_SNAP_DISTANCE / 2, 0, Math.PI / 2, 100), 'rural')
    expect(net.nodes).toHaveLength(3)
  })

  it('does not reuse a node beyond the snap distance', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    net.addRoad(straight(100 + NODE_SNAP_DISTANCE * 4, 0, Math.PI / 2, 100), 'rural')
    expect(net.nodes).toHaveLength(4)
  })

  it('records every end meeting at a shared node', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    net.addRoad(straight(100, 0, Math.PI / 2, 100), 'rural')
    const shared = net.nodeAt(vec2(100, 0))!
    expect(shared).toBeDefined()
    expect(shared.ends).toHaveLength(2)
  })

  it('distinguishes a start end from an end end', () => {
    const net = new RoadNetwork()
    const a = net.addRoad(straight(0, 0, 0, 100), 'rural')
    const b = net.addRoad(straight(100, 0, Math.PI / 2, 100), 'rural')
    const shared = net.nodeAt(vec2(100, 0))!
    expect(shared.ends).toContainEqual({ roadId: a, end: 'end' })
    expect(shared.ends).toContainEqual({ roadId: b, end: 'start' })
  })

  it('carries the road class', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 100), 'highway')
    expect(net.road(id).className).toBe('highway')
  })
})

describe('RoadNetwork junctions', () => {
  it('is not a junction with one road end', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 100), 'rural')
    expect(net.isJunction(net.road(id).startNode)).toBe(false)
  })

  it('is not a junction with two road ends', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    net.addRoad(straight(100, 0, Math.PI / 2, 100), 'rural')
    expect(net.isJunction(net.nodeAt(vec2(100, 0))!.id)).toBe(false)
  })

  it('is a junction with three road ends', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    net.addRoad(straight(100, 0, Math.PI / 2, 100), 'rural')
    net.addRoad(straight(100, 0, -Math.PI / 2, 100), 'rural')
    expect(net.isJunction(net.nodeAt(vec2(100, 0))!.id)).toBe(true)
  })
})

describe('RoadNetwork lookups', () => {
  it('returns undefined for a position with no node', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 100), 'rural')
    expect(net.nodeAt(vec2(500, 500))).toBeUndefined()
  })

  it('rejects an unknown road id', () => {
    const net = new RoadNetwork()
    expect(() => net.road(99)).toThrow(RangeError)
  })

  it('rejects an unknown node id', () => {
    const net = new RoadNetwork()
    expect(() => net.node(99)).toThrow(RangeError)
  })

  it('rejects an empty alignment', () => {
    const net = new RoadNetwork()
    expect(() => net.addRoad(new Alignment([]), 'rural')).toThrow(RangeError)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/network/graph.test.ts
```

Expected: FAIL — `Failed to resolve import "./graph"`.

- [ ] **Step 3: Write the implementation**

`src/network/graph.ts`:

```ts
import type { Alignment } from '../geometry/alignment'
import { type Vec2, distance } from '../geometry/vec2'
import type { RoadClassName } from '../mesh/roadClass'

export type NodeId = number
export type RoadId = number

/** Which end of which road. A road contributes one of each to the network. */
export type RoadEnd = {
  readonly roadId: RoadId
  readonly end: 'start' | 'end'
}

export type NetworkNode = {
  readonly id: NodeId
  readonly position: Vec2
  readonly ends: readonly RoadEnd[]
}

export type Road = {
  readonly id: RoadId
  readonly alignment: Alignment
  readonly className: RoadClassName
  readonly startNode: NodeId
  readonly endNode: NodeId
}

/**
 * Two road ends closer than this are treated as the same node.
 *
 * Half a metre: far below any meaningful road separation, far above the
 * floating-point noise of two alignments computed independently.
 */
export const NODE_SNAP_DISTANCE = 0.5

/**
 * Which roads exist and which ends meet where.
 *
 * Pure topology over alignment references. No geometry is generated here —
 * junction surfaces and trimmed ribbons belong to `src/mesh/`. Keeping the
 * graph free of geometry means it can be queried, mutated and reasoned about
 * without touching a vertex buffer.
 */
export class RoadNetwork {
  private readonly roadList: Road[] = []
  private readonly nodeList: { id: NodeId; position: Vec2; ends: RoadEnd[] }[] = []

  get roads(): readonly Road[] {
    return this.roadList
  }

  get nodes(): readonly NetworkNode[] {
    return this.nodeList
  }

  road(id: RoadId): Road {
    const found = this.roadList[id]
    if (!found) throw new RangeError(`no road with id ${id}`)
    return found
  }

  node(id: NodeId): NetworkNode {
    const found = this.nodeList[id]
    if (!found) throw new RangeError(`no node with id ${id}`)
    return found
  }

  nodeAt(position: Vec2): NetworkNode | undefined {
    return this.nodeList.find(
      (n) => distance(n.position, position) <= NODE_SNAP_DISTANCE,
    )
  }

  /** Three or more road ends. Fewer is a dead end or a road passing through. */
  isJunction(id: NodeId): boolean {
    return this.node(id).ends.length >= 3
  }

  addRoad(alignment: Alignment, className: RoadClassName): RoadId {
    if (alignment.isEmpty) {
      throw new RangeError('cannot add a road with an empty alignment')
    }

    const roadId = this.roadList.length
    const startPosition = alignment.poseAt(0).position
    const endPosition = alignment.poseAt(alignment.length).position

    const startNode = this.nodeFor(startPosition)
    const endNode = this.nodeFor(endPosition)

    this.nodeList[startNode]!.ends.push({ roadId, end: 'start' })
    this.nodeList[endNode]!.ends.push({ roadId, end: 'end' })

    this.roadList.push({ id: roadId, alignment, className, startNode, endNode })
    return roadId
  }

  /** An existing node within snapping distance, or a new one. */
  private nodeFor(position: Vec2): NodeId {
    const existing = this.nodeAt(position)
    if (existing) return existing.id

    const id = this.nodeList.length
    this.nodeList.push({ id, position, ends: [] })
    return id
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/network/graph.test.ts
```

Expected: PASS, 15 tests.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/network/graph.ts src/network/graph.test.ts
git commit -m "feat: add road network graph"
```

---

### Task 3: Junction legs

Turn a node's connected road ends into legs: outward direction and half-width, sorted counter-clockwise. Every later step assumes this ordering, so it is worth its own task and its own tests.

**Files:**
- Create: `src/mesh/junctionLegs.ts`
- Test: `src/mesh/junctionLegs.test.ts`

**Interfaces:**
- Consumes: `RoadNetwork`, `NodeId` from `../network/graph`; `Vec2`, `fromAngle`, `angleOf`, `normalizeAngle` from `../geometry/vec2`; `ROAD_CLASSES`, `formationHalfWidth` from `./roadClass`
- Produces:
  - `type JunctionLeg = { readonly roadId: RoadId; readonly end: 'start' | 'end'; readonly direction: Vec2; readonly halfWidth: number; readonly bearing: number }`
  - `junctionLegs(network: RoadNetwork, nodeId: NodeId): JunctionLeg[]` — sorted counter-clockwise by bearing, starting from the leg with the smallest bearing in `(−π, π]`
  - `direction` points **outward from the node**. For a road's `start` end that is its heading at station 0; for its `end` end it is the reverse of its heading at the final station.

- [ ] **Step 1: Write the failing tests**

`src/mesh/junctionLegs.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { junctionLegs } from './junctionLegs'
import { RoadNetwork } from '../network/graph'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import { ROAD_CLASSES, formationHalfWidth } from './roadClass'

/** Three roads radiating from (100, 0): west, north, south. */
const tJunction = () => {
  const net = new RoadNetwork()
  // Arrives from the west, so its 'end' is at the node and points back west.
  net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 100)]), 'rural')
  net.addRoad(new Alignment([new Line(vec2(100, 0), Math.PI / 2, 100)]), 'rural')
  net.addRoad(new Alignment([new Line(vec2(100, 0), -Math.PI / 2, 100)]), 'rural')
  return net
}

describe('junctionLegs', () => {
  it('returns one leg per connected road end', () => {
    const net = tJunction()
    const legs = junctionLegs(net, net.nodeAt(vec2(100, 0))!.id)
    expect(legs).toHaveLength(3)
  })

  it('points every direction outward from the node', () => {
    const net = tJunction()
    const legs = junctionLegs(net, net.nodeAt(vec2(100, 0))!.id)
    // West-pointing (the arriving road reversed), north, south.
    const bearings = legs.map((l) => Math.round((l.bearing * 180) / Math.PI))
    expect(bearings.sort((a, b) => a - b)).toEqual([-90, 90, 180])
  })

  it('sorts legs counter-clockwise by bearing', () => {
    const net = tJunction()
    const legs = junctionLegs(net, net.nodeAt(vec2(100, 0))!.id)
    for (let i = 1; i < legs.length; i++) {
      expect(legs[i]!.bearing).toBeGreaterThan(legs[i - 1]!.bearing)
    }
  })

  it('gives each leg the half width of its road class', () => {
    const net = tJunction()
    const legs = junctionLegs(net, net.nodeAt(vec2(100, 0))!.id)
    const expected = formationHalfWidth(ROAD_CLASSES.rural)
    for (const leg of legs) expect(leg.halfWidth).toBeCloseTo(expected, 9)
  })

  it('reads a wider half width for a wider class', () => {
    const net = new RoadNetwork()
    net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 100)]), 'highway')
    net.addRoad(new Alignment([new Line(vec2(100, 0), Math.PI / 2, 100)]), 'gravel')
    const legs = junctionLegs(net, net.nodeAt(vec2(100, 0))!.id)
    const widths = legs.map((l) => l.halfWidth).sort((a, b) => a - b)
    expect(widths[0]).toBeCloseTo(formationHalfWidth(ROAD_CLASSES.gravel), 9)
    expect(widths[1]).toBeCloseTo(formationHalfWidth(ROAD_CLASSES.highway), 9)
  })

  it('gives a unit direction vector', () => {
    const net = tJunction()
    const legs = junctionLegs(net, net.nodeAt(vec2(100, 0))!.id)
    for (const leg of legs) {
      expect(Math.hypot(leg.direction.x, leg.direction.y)).toBeCloseTo(1, 9)
    }
  })

  it('agrees between direction and bearing', () => {
    const net = tJunction()
    const legs = junctionLegs(net, net.nodeAt(vec2(100, 0))!.id)
    for (const leg of legs) {
      expect(Math.cos(leg.bearing)).toBeCloseTo(leg.direction.x, 9)
      expect(Math.sin(leg.bearing)).toBeCloseTo(leg.direction.y, 9)
    }
  })

  it('records which road end each leg came from', () => {
    const net = tJunction()
    const legs = junctionLegs(net, net.nodeAt(vec2(100, 0))!.id)
    expect(legs.filter((l) => l.end === 'end')).toHaveLength(1)
    expect(legs.filter((l) => l.end === 'start')).toHaveLength(2)
  })

  it('returns a single leg for a dead end', () => {
    const net = tJunction()
    const legs = junctionLegs(net, net.nodeAt(vec2(0, 0))!.id)
    expect(legs).toHaveLength(1)
    // The road leaves the dead end heading east.
    expect(legs[0]!.direction.x).toBeCloseTo(1, 9)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/mesh/junctionLegs.test.ts
```

Expected: FAIL — `Failed to resolve import "./junctionLegs"`.

- [ ] **Step 3: Write the implementation**

`src/mesh/junctionLegs.ts`:

```ts
import type { RoadNetwork, NodeId, RoadId } from '../network/graph'
import { type Vec2, fromAngle, normalizeAngle } from '../geometry/vec2'
import { ROAD_CLASSES, formationHalfWidth } from './roadClass'

/**
 * One road end arriving at a junction node.
 *
 * `direction` always points AWAY from the node, whichever end of the road is
 * attached — a road arriving from the west contributes a leg pointing west.
 * Uniform outward directions are what make the corner and trim maths below
 * work without per-end special cases.
 */
export type JunctionLeg = {
  readonly roadId: RoadId
  readonly end: 'start' | 'end'
  readonly direction: Vec2
  readonly halfWidth: number
  /** Angle of `direction`, radians in (-PI, PI]. */
  readonly bearing: number
}

/**
 * The legs of a node, sorted counter-clockwise by bearing.
 *
 * The ordering is load-bearing: corners are formed between *adjacent* legs,
 * and "adjacent" only means anything once the legs are in angular order.
 */
export const junctionLegs = (
  network: RoadNetwork,
  nodeId: NodeId,
): JunctionLeg[] => {
  const node = network.node(nodeId)

  const legs = node.ends.map((roadEnd) => {
    const road = network.road(roadEnd.roadId)

    // Outward from the node: the start end leaves along its own heading; the
    // end end leaves back the way the road came.
    const bearing =
      roadEnd.end === 'start'
        ? road.alignment.poseAt(0).heading
        : normalizeAngle(road.alignment.poseAt(road.alignment.length).heading + Math.PI)

    return {
      roadId: roadEnd.roadId,
      end: roadEnd.end,
      direction: fromAngle(bearing),
      halfWidth: formationHalfWidth(ROAD_CLASSES[road.className]),
      bearing,
    }
  })

  return legs.sort((a, b) => a.bearing - b.bearing)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/mesh/junctionLegs.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/mesh/junctionLegs.ts src/mesh/junctionLegs.test.ts
git commit -m "feat: extract sorted junction legs from a network node"
```

---

### Task 4: Corners and trim distances

The heart of the task, and the place it can degenerate. Between each adjacent pair of legs, find where their facing edges cross; from those corners, work out how far each leg must be pulled back.

**Read the geometry section at the top of this plan before implementing.** The corner between leg `i` and the next leg counter-clockwise is the intersection of leg `i`'s **left** edge with leg `j`'s **right** edge, because those are the two edges bounding the sector swept between them.

**Files:**
- Create: `src/mesh/junctionCorners.ts`
- Test: `src/mesh/junctionCorners.test.ts`

**Interfaces:**
- Consumes: `JunctionLeg` from `./junctionLegs`; `Vec2`, `vec2`, `add`, `sub`, `scale`, `dot`, `cross`, `fromAngle` from `../geometry/vec2`
- Produces:
  - `type JunctionCorner = { readonly position: Vec2; readonly beforeLeg: number; readonly afterLeg: number }` — indices into the sorted leg array
  - `type JunctionGeometry = { readonly feasible: true; readonly corners: JunctionCorner[]; readonly trims: number[] } | { readonly feasible: false; readonly reason: 'too-few-legs' | 'near-parallel-legs' | 'trim-too-long' }`
  - `solveJunction(legs: readonly JunctionLeg[], maxTrim?: number): JunctionGeometry` — `maxTrim` defaults to `MAX_TRIM_DISTANCE`
  - `MAX_TRIM_DISTANCE = 60` metres — beyond this the junction is absurd and something is wrong
  - `PARALLEL_TOLERANCE = 1e-3` — the smallest usable `|cross(d_i, d_j)|`
  - `trims[i]` is the distance leg `i` must be pulled back from the node

- [ ] **Step 1: Write the failing tests**

`src/mesh/junctionCorners.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { solveJunction, MAX_TRIM_DISTANCE } from './junctionCorners'
import type { JunctionLeg } from './junctionLegs'
import { fromAngle } from '../geometry/vec2'

/** Legs at the given bearings, all the same half width, sorted ascending. */
const legsAt = (bearingsDeg: number[], halfWidth = 5): JunctionLeg[] =>
  bearingsDeg
    .map((deg, i) => {
      const bearing = (deg * Math.PI) / 180
      return {
        roadId: i, end: 'start' as const,
        direction: fromAngle(bearing), halfWidth, bearing,
      }
    })
    .sort((a, b) => a.bearing - b.bearing)

describe('solveJunction feasibility', () => {
  it('rejects fewer than three legs', () => {
    const r = solveJunction(legsAt([0, 180]))
    expect(r.feasible).toBe(false)
    if (r.feasible) return
    expect(r.reason).toBe('too-few-legs')
  })

  it('solves a symmetric T junction', () => {
    const r = solveJunction(legsAt([180, 90, -90]))
    expect(r.feasible).toBe(true)
  })

  it('solves a four-way crossroads', () => {
    const r = solveJunction(legsAt([0, 90, 180, -90]))
    expect(r.feasible).toBe(true)
  })

  it('solves a five-leg junction', () => {
    const r = solveJunction(legsAt([0, 72, 144, -144, -72]))
    expect(r.feasible).toBe(true)
  })

  it('rejects two legs that are nearly parallel', () => {
    // Two legs a thousandth of a degree apart, plus one elsewhere.
    const r = solveJunction(legsAt([0, 0.001, 180]))
    expect(r.feasible).toBe(false)
    if (r.feasible) return
    expect(r.reason).toBe('near-parallel-legs')
  })

  it('accepts opposite legs, which are a road running straight through', () => {
    // The through pair of a T has cross() of essentially zero, exactly like a
    // coincident pair — but it is the commonest junction there is. Rejecting
    // it would reject every T.
    const r = solveJunction(legsAt([180, 90, -90]))
    expect(r.feasible).toBe(true)
  })

  it('gives a through pair zero trim on its outer side', () => {
    // The corner between the two opposite legs is perpendicular to both, so it
    // contributes nothing; each leg's trim comes only from its other corner.
    const w = 5
    const r = solveJunction(legsAt([180, 90, -90], w))
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    for (const trim of r.trims) expect(trim).toBeCloseTo(w, 6)
  })

  it('accepts a through pair of unequal widths', () => {
    const legs = [
      { roadId: 0, end: 'start' as const, direction: fromAngle(-Math.PI / 2), halfWidth: 4, bearing: -Math.PI / 2 },
      { roadId: 1, end: 'start' as const, direction: fromAngle(Math.PI / 2), halfWidth: 9, bearing: Math.PI / 2 },
      { roadId: 2, end: 'start' as const, direction: fromAngle(Math.PI), halfWidth: 5, bearing: Math.PI },
    ].sort((a, b) => a.bearing - b.bearing)
    const r = solveJunction(legs)
    expect(r.feasible).toBe(true)
  })

  it('rejects a junction demanding an absurd trim', () => {
    // A very acute pair pushes the corner far from the node.
    const r = solveJunction(legsAt([0, 2, 180]), MAX_TRIM_DISTANCE)
    expect(r.feasible).toBe(false)
    if (r.feasible) return
    expect(r.reason).toBe('trim-too-long')
  })
})

describe('solveJunction corners and trims', () => {
  it('produces one corner per adjacent pair, wrapping around', () => {
    const r = solveJunction(legsAt([0, 90, 180, -90]))
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    expect(r.corners).toHaveLength(4)
  })

  it('produces one trim per leg', () => {
    const r = solveJunction(legsAt([0, 90, 180, -90]))
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    expect(r.trims).toHaveLength(4)
  })

  it('trims a square crossroads by exactly the half width', () => {
    // Perpendicular legs of equal half width: the corner sits at (w, w) from
    // the node, so each leg is pulled back exactly w.
    const w = 5
    const r = solveJunction(legsAt([0, 90, 180, -90], w))
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    for (const trim of r.trims) expect(trim).toBeCloseTo(w, 6)
  })

  it('places a crossroads corner at the expected point', () => {
    const w = 5
    const r = solveJunction(legsAt([0, 90, 180, -90], w))
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    // Some corner must sit at (5, 5) — the north-east one.
    const found = r.corners.some(
      (c) => Math.abs(c.position.x - w) < 1e-6 && Math.abs(c.position.y - w) < 1e-6,
    )
    expect(found).toBe(true)
  })

  it('trims further for a sharper angle', () => {
    const square = solveJunction(legsAt([0, 90, 180, -90]))
    const sharp = solveJunction(legsAt([0, 45, 180, -90]))
    expect(square.feasible).toBe(true)
    expect(sharp.feasible).toBe(true)
    if (!square.feasible || !sharp.feasible) return
    expect(Math.max(...sharp.trims)).toBeGreaterThan(Math.max(...square.trims))
  })

  it('trims further against a wider neighbour', () => {
    const narrow = solveJunction(legsAt([180, 90, -90], 5))
    const wide = solveJunction(legsAt([180, 90, -90], 12))
    expect(narrow.feasible).toBe(true)
    expect(wide.feasible).toBe(true)
    if (!narrow.feasible || !wide.feasible) return
    expect(Math.max(...wide.trims)).toBeGreaterThan(Math.max(...narrow.trims))
  })

  it('never returns a negative trim', () => {
    const r = solveJunction(legsAt([0, 100, 200]))
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    for (const trim of r.trims) expect(trim).toBeGreaterThanOrEqual(0)
  })

  it('labels each corner with the legs it lies between', () => {
    const r = solveJunction(legsAt([0, 90, 180, -90]))
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    for (const corner of r.corners) {
      expect(corner.afterLeg).toBe((corner.beforeLeg + 1) % 4)
    }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/mesh/junctionCorners.test.ts
```

Expected: FAIL — `Failed to resolve import "./junctionCorners"`.

- [ ] **Step 3: Write the implementation**

`src/mesh/junctionCorners.ts`:

```ts
import type { JunctionLeg } from './junctionLegs'
import { type Vec2, add, sub, scale, dot, cross, fromAngle } from '../geometry/vec2'

/** Where two adjacent legs' facing edges cross. */
export type JunctionCorner = {
  readonly position: Vec2
  /** Index into the sorted leg array of the leg clockwise of this corner. */
  readonly beforeLeg: number
  /** Index of the leg counter-clockwise of it. */
  readonly afterLeg: number
}

export type JunctionGeometry =
  | {
      readonly feasible: true
      readonly corners: JunctionCorner[]
      /** trims[i] is how far leg i must be pulled back from the node, metres. */
      readonly trims: number[]
    }
  | {
      readonly feasible: false
      readonly reason: 'too-few-legs' | 'near-parallel-legs' | 'trim-too-long'
    }

/**
 * Beyond this a junction is absurd, metres.
 *
 * The corner between two legs runs away to infinity as they approach
 * parallel, so an unbounded solve will happily produce a junction kilometres
 * across. Sixty metres is already larger than any real intersection.
 */
export const MAX_TRIM_DISTANCE = 60

/** The smallest usable |cross(d_i, d_j)|. Below this the legs are parallel. */
export const PARALLEL_TOLERANCE = 1e-3

/**
 * Intersect two lines given as point plus direction.
 * Returns null when they are parallel within tolerance.
 */
const intersectLines = (
  a: Vec2, u: Vec2, b: Vec2, v: Vec2,
): Vec2 | null => {
  const denominator = cross(u, v)
  if (Math.abs(denominator) < PARALLEL_TOLERANCE) return null
  const t = cross(sub(b, a), v) / denominator
  return add(a, scale(u, t))
}

/**
 * Are two legs opposite rather than coincident?
 *
 * `cross` vanishes for both, so it cannot tell them apart on its own. Opposite
 * legs are a road passing straight through — the commonest junction there is —
 * while coincident legs are two roads leaving on top of each other, which has
 * no sensible junction at all.
 */
const isThroughPair = (a: JunctionLeg, b: JunctionLeg): boolean =>
  dot(a.direction, b.direction) < 0

/**
 * Work out where a junction's corners sit and how far each leg pulls back.
 *
 * Legs must already be sorted counter-clockwise. The corner between leg i and
 * the next leg counter-clockwise is the intersection of leg i's LEFT edge with
 * that leg's RIGHT edge — those are the two edges bounding the sector swept
 * between them.
 *
 * Reports infeasible rather than emitting garbage. Two legs approaching
 * parallel send their corner toward infinity, and an unbounded solve produces
 * a junction the size of a town. A junction that cannot be built is something
 * the tool can show the player; one that is silently wrong is a bug nobody
 * finds until it is on screen.
 */
export const solveJunction = (
  legs: readonly JunctionLeg[],
  maxTrim: number = MAX_TRIM_DISTANCE,
): JunctionGeometry => {
  if (legs.length < 3) {
    return { feasible: false, reason: 'too-few-legs' }
  }

  const n = legs.length
  const corners: JunctionCorner[] = []

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const legI = legs[i]!
    const legJ = legs[j]!

    // Left of a direction is that direction rotated +90 degrees.
    const leftI = fromAngle(legI.bearing + Math.PI / 2)
    const leftJ = fromAngle(legJ.bearing + Math.PI / 2)

    // Leg i's left edge, and leg j's right edge, both offset from the node.
    const originI = scale(leftI, legI.halfWidth)
    const originJ = scale(leftJ, -legJ.halfWidth)

    const position = intersectLines(originI, legI.direction, originJ, legJ.direction)

    if (!position) {
      // No unique intersection. Which of the two degenerate cases is it?
      if (!isThroughPair(legI, legJ)) {
        // Coincident: two roads leaving on top of each other. No junction.
        return { feasible: false, reason: 'near-parallel-legs' }
      }
      // Opposite: a road running straight through. The facing edges are
      // parallel — coincident when the widths match — so there is no unique
      // crossing point, but nothing is wrong. Put the corner at the foot of
      // the perpendicular, laterally at the wider of the two. Being
      // perpendicular to both legs, it contributes zero trim, which is right:
      // a through road needs no pulling back on its outer side.
      corners.push({
        position: scale(leftI, Math.max(legI.halfWidth, legJ.halfWidth)),
        beforeLeg: i,
        afterLeg: j,
      })
      continue
    }

    corners.push({ position, beforeLeg: i, afterLeg: j })
  }

  // Each leg must clear the corner on either side of it.
  const trims = legs.map((leg, i) => {
    const after = corners[i]!
    const before = corners[(i - 1 + n) % n]!
    return Math.max(
      0,
      dot(after.position, leg.direction),
      dot(before.position, leg.direction),
    )
  })

  if (trims.some((t) => t > maxTrim)) {
    return { feasible: false, reason: 'trim-too-long' }
  }

  return { feasible: true, corners, trims }
}
```

Note the corners and trims are computed **relative to the node at the origin** — every leg direction and offset is a vector from the node, so `dot(corner, direction)` is already the distance along that leg. The caller adds the node position when placing vertices.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/mesh/junctionCorners.test.ts
```

Expected: PASS, 17 tests.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/mesh/junctionCorners.ts src/mesh/junctionCorners.test.ts
git commit -m "feat: solve junction corners and trim distances"
```

---

### Task 5: Junction surface mesh

Turn the solved corners and trims into a triangle mesh filling the gap the trimmed ribbons leave.

**Files:**
- Create: `src/mesh/junctionMesh.ts`
- Test: `src/mesh/junctionMesh.test.ts`

**Interfaces:**
- Consumes: `JunctionLeg` from `./junctionLegs`; `JunctionGeometry` from `./junctionCorners`; `MeshData` from `./ribbon`; `Vec2`, `add`, `scale`, `fromAngle` from `../geometry/vec2`
- Produces:
  - `buildJunctionMesh(node: Vec2, elevation: number, legs: readonly JunctionLeg[], geometry: JunctionGeometry): MeshData` — an empty `MeshData` when the geometry is infeasible
  - Vertices are laid out as a fan: the node centre first, then the boundary counter-clockwise. Boundary order per leg is its trimmed right point, its trimmed left point, then the corner after it.
  - Winding matches the ribbon's convention so faces point up.

- [ ] **Step 1: Write the failing tests**

`src/mesh/junctionMesh.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildJunctionMesh } from './junctionMesh'
import { solveJunction } from './junctionCorners'
import type { JunctionLeg } from './junctionLegs'
import { vec2, fromAngle } from '../geometry/vec2'

const legsAt = (bearingsDeg: number[], halfWidth = 5): JunctionLeg[] =>
  bearingsDeg
    .map((deg, i) => {
      const bearing = (deg * Math.PI) / 180
      return {
        roadId: i, end: 'start' as const,
        direction: fromAngle(bearing), halfWidth, bearing,
      }
    })
    .sort((a, b) => a.bearing - b.bearing)

const crossroads = () => {
  const legs = legsAt([0, 90, 180, -90])
  return { legs, geometry: solveJunction(legs) }
}

describe('buildJunctionMesh', () => {
  it('emits a centre vertex plus three per leg', () => {
    const { legs, geometry } = crossroads()
    const m = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    expect(m.vertexCount).toBe(1 + 4 * 3)
  })

  it('emits one triangle per boundary edge', () => {
    const { legs, geometry } = crossroads()
    const m = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    expect(m.triangleCount).toBe(4 * 3)
  })

  it('places the centre vertex at the node', () => {
    const { legs, geometry } = crossroads()
    const m = buildJunctionMesh(vec2(120, -40), 50, legs, geometry)
    expect(m.positions[0]).toBeCloseTo(120, 6)
    expect(m.positions[1]).toBeCloseTo(-40, 6)
    expect(m.positions[2]).toBeCloseTo(50, 6)
  })

  it('puts every vertex at the given elevation', () => {
    const { legs, geometry } = crossroads()
    const m = buildJunctionMesh(vec2(0, 0), 87.5, legs, geometry)
    for (let i = 0; i < m.vertexCount; i++) {
      expect(m.positions[i * 3 + 2]).toBeCloseTo(87.5, 6)
    }
  })

  it('offsets the whole junction by the node position', () => {
    const { legs, geometry } = crossroads()
    const atOrigin = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    const moved = buildJunctionMesh(vec2(1000, 2000), 50, legs, geometry)
    for (let i = 0; i < atOrigin.vertexCount; i++) {
      expect(moved.positions[i * 3]! - atOrigin.positions[i * 3]!).toBeCloseTo(1000, 4)
      expect(moved.positions[i * 3 + 1]! - atOrigin.positions[i * 3 + 1]!).toBeCloseTo(2000, 4)
    }
  })

  it('points every normal up', () => {
    const { legs, geometry } = crossroads()
    const m = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    for (let i = 0; i < m.vertexCount; i++) {
      expect(m.normals[i * 3 + 2]).toBeCloseTo(1, 6)
    }
  })

  it('winds every triangle to agree with its normals', () => {
    const { legs, geometry } = crossroads()
    const m = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    for (let t = 0; t < m.indices.length; t += 3) {
      const a = m.indices[t]!, b = m.indices[t + 1]!, c = m.indices[t + 2]!
      const ax = m.positions[a * 3]!, ay = m.positions[a * 3 + 1]!
      const bx = m.positions[b * 3]!, by = m.positions[b * 3 + 1]!
      const cx = m.positions[c * 3]!, cy = m.positions[c * 3 + 1]!
      // Signed area of the triangle in plan; positive means counter-clockwise,
      // which with an upward normal is a front face.
      const twiceArea = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
      expect(twiceArea).toBeGreaterThan(0)
    }
  })

  it('reaches at least the trim distance along each leg', () => {
    const { legs, geometry } = crossroads()
    expect(geometry.feasible).toBe(true)
    if (!geometry.feasible) return
    const m = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    let furthest = 0
    for (let i = 0; i < m.vertexCount; i++) {
      furthest = Math.max(furthest, Math.hypot(m.positions[i * 3]!, m.positions[i * 3 + 1]!))
    }
    expect(furthest).toBeGreaterThanOrEqual(Math.max(...geometry.trims) - 1e-6)
  })

  it('returns an empty mesh for infeasible geometry', () => {
    const legs = legsAt([0, 180])
    const geometry = solveJunction(legs)
    expect(geometry.feasible).toBe(false)
    const m = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    expect(m.vertexCount).toBe(0)
    expect(m.triangleCount).toBe(0)
    expect(m.positions).toHaveLength(0)
    expect(m.indices).toHaveLength(0)
  })

  it('handles a three-leg junction', () => {
    const legs = legsAt([180, 90, -90])
    const geometry = solveJunction(legs)
    const m = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    expect(m.vertexCount).toBe(1 + 3 * 3)
    expect(m.triangleCount).toBe(3 * 3)
  })

  it('handles a five-leg junction', () => {
    const legs = legsAt([0, 72, 144, -144, -72])
    const geometry = solveJunction(legs)
    const m = buildJunctionMesh(vec2(0, 0), 50, legs, geometry)
    expect(m.vertexCount).toBe(1 + 5 * 3)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/mesh/junctionMesh.test.ts
```

Expected: FAIL — `Failed to resolve import "./junctionMesh"`.

- [ ] **Step 3: Write the implementation**

`src/mesh/junctionMesh.ts`:

```ts
import type { JunctionLeg } from './junctionLegs'
import type { JunctionGeometry } from './junctionCorners'
import type { MeshData } from './ribbon'
import { type Vec2, add, scale, fromAngle } from '../geometry/vec2'

const EMPTY: MeshData = {
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  uvs: new Float32Array(0),
  indices: new Uint32Array(0),
  vertexCount: 0,
  triangleCount: 0,
}

/**
 * The surface filling the gap that trimmed ribbons leave at a junction.
 *
 * Laid out as a triangle fan: the node centre first, then the boundary
 * counter-clockwise. Each leg contributes three boundary points — its trimmed
 * right edge, its trimmed left edge, and the corner between it and the next
 * leg. A fan is valid here because a junction polygon is star-shaped about its
 * own node for any geometry that is not already reported infeasible.
 *
 * Flat at a single elevation. Warping the surface to meet legs on different
 * grades is a later problem; a flat junction is what almost every real one is.
 */
export const buildJunctionMesh = (
  node: Vec2,
  elevation: number,
  legs: readonly JunctionLeg[],
  geometry: JunctionGeometry,
): MeshData => {
  if (!geometry.feasible) return EMPTY

  const n = legs.length
  const boundary: Vec2[] = []

  for (let i = 0; i < n; i++) {
    const leg = legs[i]!
    const trim = geometry.trims[i]!
    const left = fromAngle(leg.bearing + Math.PI / 2)
    const along = scale(leg.direction, trim)

    // Right edge first, then left, so the boundary runs counter-clockwise.
    boundary.push(add(along, scale(left, -leg.halfWidth)))
    boundary.push(add(along, scale(left, leg.halfWidth)))
    boundary.push(geometry.corners[i]!.position)
  }

  const vertexCount = 1 + boundary.length
  const triangleCount = boundary.length

  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  const indices = new Uint32Array(triangleCount * 3)

  // Centre.
  positions[0] = node.x
  positions[1] = node.y
  positions[2] = elevation
  uvs[0] = 0.5
  uvs[1] = 0.5

  // Boundary, offset by the node position — the solve works about the origin.
  boundary.forEach((point, i) => {
    const v = i + 1
    positions[v * 3] = node.x + point.x
    positions[v * 3 + 1] = node.y + point.y
    positions[v * 3 + 2] = elevation
    // UVs are a crude radial projection; junction markings are a later task.
    uvs[v * 2] = 0.5 + point.x * 0.05
    uvs[v * 2 + 1] = 0.5 + point.y * 0.05
  })

  for (let i = 0; i < vertexCount; i++) {
    normals[i * 3] = 0
    normals[i * 3 + 1] = 0
    normals[i * 3 + 2] = 1
  }

  // Fan. Counter-clockwise boundary with an upward normal gives front faces,
  // matching the ribbon's winding convention.
  for (let i = 0; i < boundary.length; i++) {
    const current = i + 1
    const next = ((i + 1) % boundary.length) + 1
    indices[i * 3] = 0
    indices[i * 3 + 1] = current
    indices[i * 3 + 2] = next
  }

  return { positions, normals, uvs, indices, vertexCount, triangleCount }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/mesh/junctionMesh.test.ts
```

Expected: PASS, 11 tests.

If the winding test fails with a negative signed area, the boundary is running clockwise — swap the order in which each leg's right and left points are pushed, rather than reversing the index order, so the reason stays legible.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/mesh/junctionMesh.ts src/mesh/junctionMesh.test.ts
git commit -m "feat: build junction surface meshes"
```

---

### Task 6: Build a whole network

Tie it together: for a network, produce every road's trimmed mesh and every junction's surface, with each road trimmed by whatever its two end nodes demand.

**Files:**
- Create: `src/mesh/networkMesh.ts`
- Test: `src/mesh/networkMesh.test.ts`

**Interfaces:**
- Consumes: `RoadNetwork`, `RoadId`, `NodeId` from `../network/graph`; `junctionLegs` from `./junctionLegs`; `solveJunction`, `JunctionGeometry` from `./junctionCorners`; `buildJunctionMesh` from `./junctionMesh`; `buildRoadMesh`, `RoadMesh`, `RoadExtent`, `LayerStations` from `./roadMesh`; `ROAD_CLASSES` from `./roadClass`; `ProfilePoint`, `designElevationAtStation` from `../terrain/groundProfile`; `MeshData` from `./ribbon`
- Produces:
  - `type NetworkMeshOptions = { readonly spacing?: number; readonly stations?: ReadonlyMap<RoadId, LayerStations> }`
  - `type NetworkMesh = { readonly roads: ReadonlyMap<RoadId, RoadMesh>; readonly junctions: ReadonlyMap<NodeId, MeshData>; readonly infeasibleJunctions: ReadonlyMap<NodeId, string> }`
  - `buildNetworkMesh(network, designs: ReadonlyMap<RoadId, readonly ProfilePoint[]>, options?): NetworkMesh`
  - A road whose two trims overlap — trimmed to nothing — still appears in `roads`, with empty layer meshes.

- [ ] **Step 1: Write the failing tests**

`src/mesh/networkMesh.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildNetworkMesh } from './networkMesh'
import { RoadNetwork } from '../network/graph'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import type { ProfilePoint } from '../terrain/groundProfile'
import type { RoadId } from '../network/graph'

const level = (length: number, z: number): ProfilePoint[] => [{ s: 0, z }, { s: length, z }]

/** Three rural roads meeting at (100, 0). */
const tJunction = () => {
  const net = new RoadNetwork()
  const west = net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 100)]), 'rural')
  const north = net.addRoad(new Alignment([new Line(vec2(100, 0), Math.PI / 2, 100)]), 'rural')
  const south = net.addRoad(new Alignment([new Line(vec2(100, 0), -Math.PI / 2, 100)]), 'rural')
  const designs = new Map<RoadId, ProfilePoint[]>([
    [west, level(100, 50)], [north, level(100, 50)], [south, level(100, 50)],
  ])
  return { net, designs, west, north, south }
}

describe('buildNetworkMesh', () => {
  it('produces a mesh for every road', () => {
    const { net, designs } = tJunction()
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    expect(m.roads.size).toBe(3)
  })

  it('produces a junction surface where three roads meet', () => {
    const { net, designs } = tJunction()
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    const junction = net.nodeAt(vec2(100, 0))!
    expect(m.junctions.get(junction.id)!.vertexCount).toBeGreaterThan(0)
  })

  it('produces no junction surface at a dead end', () => {
    const { net, designs } = tJunction()
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    const deadEnd = net.nodeAt(vec2(0, 0))!
    expect(m.junctions.has(deadEnd.id)).toBe(false)
  })

  it('trims a road back from the junction it runs into', () => {
    const { net, designs, west } = tJunction()
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    const wearing = m.roads.get(west)!.layers.find((l) => l.name === 'wearing')!.mesh
    let furthestX = -Infinity
    for (let i = 0; i < wearing.vertexCount; i++) {
      furthestX = Math.max(furthestX, wearing.positions[i * 3]!)
    }
    // The road's alignment ends at x=100; trimming must pull it short of that.
    expect(furthestX).toBeLessThan(100)
  })

  it('does not trim a road at its dead end', () => {
    const { net, designs, west } = tJunction()
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    const wearing = m.roads.get(west)!.layers.find((l) => l.name === 'wearing')!.mesh
    let smallestX = Infinity
    for (let i = 0; i < wearing.vertexCount; i++) {
      smallestX = Math.min(smallestX, wearing.positions[i * 3]!)
    }
    expect(smallestX).toBeCloseTo(0, 4)
  })

  it('records nothing as infeasible for a sound network', () => {
    const { net, designs } = tJunction()
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    expect(m.infeasibleJunctions.size).toBe(0)
  })

  it('records a reason for an infeasible junction', () => {
    const net = new RoadNetwork()
    // Two nearly-parallel roads plus one more, meeting at a point.
    net.addRoad(new Alignment([new Line(vec2(100, 0), 0, 100)]), 'rural')
    net.addRoad(new Alignment([new Line(vec2(100, 0), 0.0005, 100)]), 'rural')
    net.addRoad(new Alignment([new Line(vec2(100, 0), Math.PI, 100)]), 'rural')
    const designs = new Map<RoadId, ProfilePoint[]>([
      [0, level(100, 50)], [1, level(100, 50)], [2, level(100, 50)],
    ])
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    const junction = net.nodeAt(vec2(100, 0))!
    expect(m.infeasibleJunctions.has(junction.id)).toBe(true)
    expect(m.infeasibleJunctions.get(junction.id)).toBe('near-parallel-legs')
  })

  it('emits no junction mesh where the junction is infeasible', () => {
    const net = new RoadNetwork()
    net.addRoad(new Alignment([new Line(vec2(100, 0), 0, 100)]), 'rural')
    net.addRoad(new Alignment([new Line(vec2(100, 0), 0.0005, 100)]), 'rural')
    net.addRoad(new Alignment([new Line(vec2(100, 0), Math.PI, 100)]), 'rural')
    const designs = new Map<RoadId, ProfilePoint[]>([
      [0, level(100, 50)], [1, level(100, 50)], [2, level(100, 50)],
    ])
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    const junction = net.nodeAt(vec2(100, 0))!
    expect(m.junctions.get(junction.id)?.vertexCount ?? 0).toBe(0)
  })

  it('keeps a road entry even when trimmed to nothing', () => {
    const net = new RoadNetwork()
    // A very short road between two junctions will be trimmed away entirely.
    net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 100)]), 'rural')
    net.addRoad(new Alignment([new Line(vec2(100, 0), 0, 4)]), 'rural')
    net.addRoad(new Alignment([new Line(vec2(100, 0), Math.PI / 2, 100)]), 'rural')
    net.addRoad(new Alignment([new Line(vec2(104, 0), Math.PI / 2, 100)]), 'rural')
    const designs = new Map<RoadId, ProfilePoint[]>([
      [0, level(100, 50)], [1, level(4, 50)], [2, level(100, 50)], [3, level(100, 50)],
    ])
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    expect(m.roads.has(1)).toBe(true)
    expect(m.roads.get(1)!.layers).toHaveLength(3)
  })

  it('applies per-road construction stations', () => {
    const { net, designs, west } = tJunction()
    const m = buildNetworkMesh(net, designs, {
      spacing: 10,
      stations: new Map([[west, { subgrade: 60 }]]),
    })
    const road = m.roads.get(west)!
    expect(road.layers.find((l) => l.name === 'subgrade')!.mesh.vertexCount).toBeGreaterThan(0)
    expect(road.layers.find((l) => l.name === 'wearing')!.mesh.vertexCount).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/mesh/networkMesh.test.ts
```

Expected: FAIL — `Failed to resolve import "./networkMesh"`.

- [ ] **Step 3: Write the implementation**

`src/mesh/networkMesh.ts`:

```ts
import type { RoadNetwork, RoadId, NodeId } from '../network/graph'
import { junctionLegs } from './junctionLegs'
import { solveJunction, type JunctionGeometry } from './junctionCorners'
import { buildJunctionMesh } from './junctionMesh'
import {
  buildRoadMesh, type RoadMesh, type RoadExtent, type LayerStations,
} from './roadMesh'
import { ROAD_CLASSES } from './roadClass'
import { type ProfilePoint, designElevationAtStation } from '../terrain/groundProfile'
import type { MeshData } from './ribbon'

export type NetworkMeshOptions = {
  readonly spacing?: number
  /** Per-road construction stations. A road not listed is fully built. */
  readonly stations?: ReadonlyMap<RoadId, LayerStations>
}

export type NetworkMesh = {
  readonly roads: ReadonlyMap<RoadId, RoadMesh>
  readonly junctions: ReadonlyMap<NodeId, MeshData>
  /** Nodes whose junction could not be solved, and why. */
  readonly infeasibleJunctions: ReadonlyMap<NodeId, string>
}

/**
 * Build every road and junction in a network.
 *
 * Each road is trimmed by whatever its two end nodes demand, so its ribbon
 * stops short of every junction surface it runs into. A road at a dead end is
 * not trimmed there — there is nothing to clear.
 *
 * A junction that cannot be solved produces no surface and an entry in
 * `infeasibleJunctions` naming the reason, rather than a plausible-looking
 * wrong shape. Roads still trim by whatever the failed solve managed, which
 * is nothing, so they run to their full length and visibly overlap — a
 * legible symptom rather than a silent one.
 */
export const buildNetworkMesh = (
  network: RoadNetwork,
  designs: ReadonlyMap<RoadId, readonly ProfilePoint[]>,
  options: NetworkMeshOptions = {},
): NetworkMesh => {
  const { spacing = 4, stations } = options

  const junctions = new Map<NodeId, MeshData>()
  const infeasibleJunctions = new Map<NodeId, string>()
  /** roadId -> { from, to } accumulated from both its end nodes. */
  const trims = new Map<RoadId, { from: number; to: number }>()

  for (const road of network.roads) {
    trims.set(road.id, { from: 0, to: road.alignment.length })
  }

  for (const node of network.nodes) {
    if (!network.isJunction(node.id)) continue

    const legs = junctionLegs(network, node.id)
    const geometry: JunctionGeometry = solveJunction(legs)

    if (!geometry.feasible) {
      infeasibleJunctions.set(node.id, geometry.reason)
      continue
    }

    // Elevation from any leg's design profile at the node.
    const firstLeg = legs[0]!
    const firstRoad = network.road(firstLeg.roadId)
    const design = designs.get(firstLeg.roadId) ?? []
    const stationAtNode =
      firstLeg.end === 'start' ? 0 : firstRoad.alignment.length
    const elevation = designElevationAtStation(design, stationAtNode)

    junctions.set(
      node.id,
      buildJunctionMesh(node.position, elevation, legs, geometry),
    )

    legs.forEach((leg, i) => {
      const trim = geometry.trims[i]!
      const current = trims.get(leg.roadId)!
      const alignment = network.road(leg.roadId).alignment
      if (leg.end === 'start') {
        current.from = Math.max(current.from, trim)
      } else {
        current.to = Math.min(current.to, alignment.length - trim)
      }
    })
  }

  const roads = new Map<RoadId, RoadMesh>()
  for (const road of network.roads) {
    const trim = trims.get(road.id)!
    // A road trimmed past itself has been swallowed by its junctions.
    const extent: RoadExtent = {
      from: trim.from,
      to: Math.max(trim.from, trim.to),
    }

    roads.set(
      road.id,
      buildRoadMesh(
        road.alignment,
        designs.get(road.id) ?? [],
        ROAD_CLASSES[road.className],
        stations?.get(road.id),
        { spacing },
        extent,
      ),
    )
  }

  return { roads, junctions, infeasibleJunctions }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/mesh/networkMesh.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/mesh/networkMesh.ts src/mesh/networkMesh.test.ts
git commit -m "feat: build meshes for a whole road network"
```

---

### Task 7: A junction on screen

Replace the single-road scene with a small network — a road across the valley with a side road branching off it — so the junction and the trimming are visible.

**Files:**
- Modify: `src/debug/roadScene.ts`

**On testing:** this file remains deliberately untested, the same approved decision as the earlier debug views. The geometry beneath it has its own tests; what this adds is a picture, and only a human looking at it can say whether it is right.

**Interfaces:**
- Consumes: everything from Tasks 1–6, plus the existing scene machinery
- Produces: no new exports

- [ ] **Step 1: Build a network in the scene**

In `src/debug/roadScene.ts`, replace the single-alignment section with a network of three roads. Keep the existing terrain generation, excavation, camera orbit and lighting exactly as they are — only what is drawn changes.

**Build the T from three straight roads, not by splitting the existing filleted route.** The route currently in the scene is line-arc-line, so its midpoint falls inside the arc; two straight halves would not meet there and the junction would not form. Three straight alignments meeting at one point is what this task needs to show, and it removes a whole class of accidental failure from the demonstration.

Add these imports:

```ts
import { RoadNetwork, type RoadId } from '../network/graph'
import { buildNetworkMesh } from '../mesh/networkMesh'
```

Replace the alignment construction and grade solve with:

```ts
  // A T junction on the valley floor: a main road running east-west with a
  // narrower gravel branch heading north. Three straight roads meeting at one
  // point, which is exactly what a junction needs and nothing more.
  const JUNCTION = vec2(1300, 1250)

  const network = new RoadNetwork()
  const designs = new Map<RoadId, ProfilePoint[]>()

  const solveFor = (alignment: Alignment): ProfilePoint[] | null => {
    const ground = sampleGroundProfile(alignment, terrain, 10)
    const solution = solveGradeProfile(ground, {
      maxGrade: MAX_GRADE,
      maxCutDepth: MAX_CUT_DEPTH,
      maxFillHeight: MAX_FILL_HEIGHT,
    })
    return solution.feasible ? solution.profile : null
  }

  // West arm arrives at the junction; east arm and the branch leave it.
  const westArm = new Alignment([new Line(vec2(400, 1250), 0, 900)])
  const eastArm = new Alignment([new Line(JUNCTION, 0, 900)])
  const branch = new Alignment([new Line(JUNCTION, Math.PI / 2, 600)])

  const arms: [Alignment, 'rural' | 'gravel'][] = [
    [westArm, 'rural'], [eastArm, 'rural'], [branch, 'gravel'],
  ]

  for (const [alignment, className] of arms) {
    const design = solveFor(alignment)
    if (!design) continue
    designs.set(network.addRoad(alignment, className), design)
  }
```

- [ ] **Step 2: Render the network**

Replace the single-road mesh building and material loop with:

```ts
  const built = buildNetworkMesh(network, designs, { spacing: 4 })

  for (const [, roadMesh] of built.roads) {
    for (const layer of roadMesh.layers) {
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

  for (const [, junctionMesh] of built.junctions) {
    if (junctionMesh.vertexCount === 0) continue
    scene.add(new THREE.Mesh(
      toBufferGeometry(junctionMesh),
      new THREE.MeshStandardMaterial({
        color: LAYER_COLOURS.wearing ?? 0x2e3033,
        roughness: 0.9,
        side: THREE.DoubleSide,
      }),
    ))
  }

  if (built.infeasibleJunctions.size > 0) {
    console.warn('infeasible junctions', [...built.infeasibleJunctions.entries()])
  }
```

The scene currently excavates the corridor for one alignment. Run it over every road instead — the existing `excavateCorridor` helper takes an alignment and its design profile, so call it once per road before building the terrain geometry:

```ts
  for (const road of network.roads) {
    const design = designs.get(road.id)
    if (!design || design.length === 0) continue
    excavateCorridor(editLayer, road.alignment, design)
  }
```

Place this where the single-road excavation call currently sits, so the edited terrain is still built afterwards. If `excavateCorridor`'s current signature differs, adapt the call rather than the helper — it is debug-only code and its shape is not load-bearing.

- [ ] **Step 3: Verify the typecheck and build**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 4: Run the full test suite**

```bash
npm test
```

Expected: PASS, 356 tests across 23 files. Earlier plans and the fix rounds within this one supply the rest; the figure that matters is that nothing regresses.

- [ ] **Step 5: Commit and push**

```bash
git add -A
git commit -m "feat: render a road network with a junction"
git push
```

- [ ] **Step 6: Hand off for visual inspection**

Do not attempt the visual check yourself. Note the dev server serves at `http://localhost:5173/chainage/`, not `/`.

What the reviewer will check:

- Three roads are visible, with the branch leaving the main road at an angle.
- **The junction is a filled surface**, not a hole and not an overlap. The two ribbons stop short of it and it fills the gap between them.
- The junction sits flush with the roads meeting it — no step up or down at the joins.
- The gravel branch is visibly narrower than the rural main road, and the junction accommodates both widths.
- No console warning about infeasible junctions.

---

## Plan complete

Roads now connect. The network knows its topology, ribbons trim back to clear each other, and junction surfaces fill the gap.

### Deliberately not in this plan

**Junction elevation warping.** The junction surface is flat at a single elevation. Where legs arrive on different grades the joins will step. Real junctions are very nearly flat, so this is right far more often than not — but a junction on a hillside will show it.

**Corner rounding.** Junction corners are sharp intersections of edge lines. Real junctions have a kerb radius. That is a refinement of the same corner points, not a different algorithm.

**Lane-level connectivity.** The graph knows roads meet; it does not know which lane feeds which. Traffic needs that, and it belongs with the traffic plan.

**Splitting a road at an arbitrary point.** The scene works around this by constructing two alignments by hand. A real tool needs `splitRoad(roadId, station)` on the network. It belongs with the interactive tool, which is where splitting actually gets triggered.

**Next plan:** Structures — retaining walls, bridges and overpasses. `retainingWall()` already reports where a wall stands and how tall; `classifySupport` already marks which stations need a structure. Both await geometry.
