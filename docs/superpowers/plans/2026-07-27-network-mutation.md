# Network Mutation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the road network editable — delete a road, split one in two, and upgrade one to a higher class — on a graph whose identifiers survive the edit.

**Architecture:** The network currently stores roads and nodes in arrays and uses the array index as the identifier. Every mutation that removes an element would silently renumber everything after it, so identifiers must come from a counter and storage must become a map before any mutation verb is written. Splitting needs alignments to divide at an arbitrary station, which needs each primitive to divide at an arbitrary station. Upgrading needs a legality check, because a higher class carries a higher design speed and a road's own curves may be too tight for it.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), vitest 4. No new dependencies.

## Global Constraints

- **Dependency direction:** `geometry/` imports nothing. `terrain/` imports `geometry/`. `network/` imports `geometry/` and `terrain/groundProfile`. `mesh/` imports `geometry/`, `terrain/` and `network/`. `render/` imports `mesh/` and three.js. `debug/` may import anything.
- **`src/mesh/` and `src/network/` must NOT import three.js.**
- Coordinates `(x, y)` in metres with `y` north; `z` positive up. Handedness conversion happens only in `render/` and the debug scene.
- **Report rather than approximate.** When the code cannot satisfy a constraint it reports the fact through a named channel rather than silently fudging geometry. Existing channels: `continuityBreaks`, `truncatedStations`, `infeasibleJunctions`, `elevationMismatches`, `tightCrossings`.
- **TypeScript** `strict: true`, `noUncheckedIndexedAccess: true`. No `any`, no non-null assertion on a value that could genuinely be absent.
- `NODE_SNAP_DISTANCE = 0.5` metres — two road ends closer than this are the same node.
- Tests colocate with source as `<name>.test.ts`.
- Run the suite with `npm test`, types with `npx tsc --noEmit`. Both must be clean at every commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/network/graph.ts` (modify) | Map-backed storage, counter-allocated ids, `removeRoad`, `splitRoad` |
| `src/network/nodeIndex.ts` (create) | Uniform-grid spatial index behind `nodeAt` |
| `src/network/roadClass.ts` (move from `src/mesh/`) | The class table — domain data the network owns, not mesh code |
| `src/network/classChange.ts` (create) | Whether a road's own geometry permits a class change |
| `src/geometry/split.ts` (create) | Dividing a primitive and an alignment at a station |
| `src/mesh/upgradeCheck.ts` (create) | Whether an upgrade's junctions still solve at the new width |

`roadClass.ts` moves because the network already owns which class a road is (`Road.className`) and the check in Task 5 needs the table's values, not just its type name. `mesh/` already imports `network/`, so the move creates no new dependency and removes the type-only import workaround in `graph.ts`.

---

### Task 1: Stable identifiers and road removal

Road and node ids are currently array indices. `removeRoad` on an array would renumber every later road, invalidating every `RoadId` the mesh layer, the crossing detector and the debug scene are holding in their maps. Ids must come from a counter that never reuses a value, and storage must become a map, before any removal exists.

These land together because the test that proves an id is stable requires a removal to observe.

**Files:**
- Modify: `src/network/graph.ts`
- Test: `src/network/graph.test.ts` (exists — add to it)

**Interfaces:**
- Consumes: `Alignment` from `src/geometry/alignment`, `Vec2`/`distance` from `src/geometry/vec2`, `RoadClassName` from `src/mesh/roadClass`.
- Produces: `RoadNetwork.removeRoad(id: RoadId): void`. `roads` and `nodes` getters keep their current shapes (`readonly Road[]`, `readonly NetworkNode[]`) and their creation-order iteration. `road(id)` and `node(id)` keep throwing `RangeError` for an absent id.

Consumers to leave alone: `src/mesh/networkMesh.ts`, `src/mesh/junctionLegs.ts`, `src/network/crossings.ts` and `src/debug/roadScene.ts` all key their own maps by `RoadId`/`NodeId` and iterate `network.roads`. None of them index positionally, so none should need a change. If you find one that does, that is a finding worth reporting rather than quietly patching.

- [ ] **Step 1: Write the failing tests**

Add to `src/network/graph.test.ts`:

```ts
import { Arc, Line } from '../geometry/primitives'
import { Alignment } from '../geometry/alignment'
import { RoadNetwork } from './graph'

const straight = (from: { x: number; y: number }, heading: number, length: number) =>
  new Alignment([new Line(from, heading, length)])

describe('removeRoad', () => {
  it('leaves the ids of surviving roads untouched', () => {
    const net = new RoadNetwork()
    const a = net.addRoad(straight({ x: 0, y: 0 }, 0, 100), 'rural')
    const b = net.addRoad(straight({ x: 0, y: 50 }, 0, 100), 'rural')
    const c = net.addRoad(straight({ x: 0, y: 100 }, 0, 100), 'rural')

    net.removeRoad(b)

    expect(net.road(c).id).toBe(c)
    expect(net.road(a).id).toBe(a)
    expect(net.roads.map((r) => r.id)).toEqual([a, c])
    expect(() => net.road(b)).toThrow(RangeError)
  })

  it('never reuses the id of a removed road', () => {
    const net = new RoadNetwork()
    const a = net.addRoad(straight({ x: 0, y: 0 }, 0, 100), 'rural')
    net.removeRoad(a)
    const b = net.addRoad(straight({ x: 0, y: 0 }, 0, 100), 'rural')

    expect(b).not.toBe(a)
  })

  it('deletes a node once nothing references it', () => {
    const net = new RoadNetwork()
    const a = net.addRoad(straight({ x: 0, y: 0 }, 0, 100), 'rural')
    const nodeIds = net.nodes.map((n) => n.id)
    expect(nodeIds).toHaveLength(2)

    net.removeRoad(a)

    expect(net.nodes).toHaveLength(0)
    for (const id of nodeIds) {
      expect(() => net.node(id)).toThrow(RangeError)
    }
  })

  it('keeps a node that another road still uses, and detaches only the removed end', () => {
    const net = new RoadNetwork()
    // Two roads meeting at the origin.
    const a = net.addRoad(straight({ x: 0, y: 0 }, 0, 100), 'rural')
    const b = net.addRoad(straight({ x: 0, y: 0 }, Math.PI / 2, 100), 'rural')

    const shared = net.nodeAt({ x: 0, y: 0 })
    expect(shared?.ends).toHaveLength(2)

    net.removeRoad(a)

    const after = net.nodeAt({ x: 0, y: 0 })
    expect(after?.id).toBe(shared?.id)
    expect(after?.ends).toEqual([{ roadId: b, end: 'start' }])
  })

  it('detaches both ends of a road that loops back to its own node', () => {
    const net = new RoadNetwork()
    // A full circle: curvature 1/50, length 2*pi*50, so the end lands on the start.
    const k = 1 / 50
    const loop = new Alignment([new Arc({ x: 0, y: 0 }, 0, (2 * Math.PI) / k, k)])
    const id = net.addRoad(loop, 'rural')

    const node = net.nodeAt({ x: 0, y: 0 })
    expect(node?.ends).toHaveLength(2)

    net.removeRoad(id)

    expect(net.nodes).toHaveLength(0)
  })

  it('rejects an unknown road id', () => {
    const net = new RoadNetwork()
    expect(() => net.removeRoad(999)).toThrow(RangeError)
  })
})
```

The loop case is the one that catches a partial detach. A road whose start and end snap to the same node contributes two `RoadEnd` entries to it; code that removes "the end for this road" once leaves the node holding a reference to a road that no longer exists.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/network/graph.test.ts`

Expected: FAIL — `net.removeRoad is not a function`.

- [ ] **Step 3: Convert storage to maps with counter-allocated ids**

In `src/network/graph.ts`, replace the two array fields and every method that reads them:

```ts
export class RoadNetwork {
  private readonly roadMap = new Map<RoadId, Road>()
  private readonly nodeMap = new Map<
    NodeId,
    { id: NodeId; position: Vec2; ends: RoadEnd[] }
  >()

  /**
   * Identifiers come from a counter, never from a position.
   *
   * The mesh layer, the crossing detector and the scene all hold `RoadId` and
   * `NodeId` keys across rebuilds. An index-derived id would renumber every
   * later element on removal and silently repoint all of them. A counter that
   * never reuses a value means a stale id is a lookup that throws, which is a
   * bug you find, rather than a lookup that succeeds against the wrong road,
   * which is a bug you ship.
   */
  private nextRoadId: RoadId = 0
  private nextNodeId: NodeId = 0

  get roads(): readonly Road[] {
    return [...this.roadMap.values()]
  }

  get nodes(): readonly NetworkNode[] {
    return [...this.nodeMap.values()].map((n) => ({ ...n, ends: [...n.ends] }))
  }

  road(id: RoadId): Road {
    const found = this.roadMap.get(id)
    if (!found) throw new RangeError(`no road with id ${id}`)
    return { ...found }
  }

  node(id: NodeId): NetworkNode {
    const found = this.nodeMap.get(id)
    if (!found) throw new RangeError(`no node with id ${id}`)
    return { ...found, ends: [...found.ends] }
  }

  nodeAt(position: Vec2): NetworkNode | undefined {
    for (const n of this.nodeMap.values()) {
      if (distance(n.position, position) <= NODE_SNAP_DISTANCE) {
        return { ...n, ends: [...n.ends] }
      }
    }
    return undefined
  }
```

`Map` preserves insertion order, so `roads`, `nodes` and `nodeAt` all iterate in creation order exactly as the arrays did. The first-node-wins snapping documented on `NODE_SNAP_DISTANCE` is therefore unchanged.

Update `addRoad` and `nodeFor` to allocate from the counters:

```ts
  addRoad(alignment: Alignment, className: RoadClassName): RoadId {
    if (alignment.isEmpty) {
      throw new RangeError('cannot add a road with an empty alignment')
    }

    const roadId = this.nextRoadId++
    const startPosition = alignment.poseAt(0).position
    const endPosition = alignment.poseAt(alignment.length).position

    const startNode = this.nodeFor(startPosition)
    const endNode = this.nodeFor(endPosition)

    this.nodeMap.get(startNode)!.ends.push({ roadId, end: 'start' })
    this.nodeMap.get(endNode)!.ends.push({ roadId, end: 'end' })

    this.roadMap.set(roadId, { id: roadId, alignment, className, startNode, endNode })
    return roadId
  }

  private nodeFor(position: Vec2): NodeId {
    const existing = this.nodeAt(position)
    if (existing) return existing.id

    const id = this.nextNodeId++
    this.nodeMap.set(id, { id, position, ends: [] })
    return id
  }
```

- [ ] **Step 4: Implement removeRoad**

```ts
  /**
   * Remove a road and any node it leaves unreferenced.
   *
   * A node exists to record that road ends meet there. Once the last end is
   * gone the node is not an empty junction, it is nothing, and leaving it
   * behind would make it a snap target for roads drawn nowhere near an
   * existing one.
   */
  removeRoad(id: RoadId): void {
    const road = this.roadMap.get(id)
    if (!road) throw new RangeError(`no road with id ${id}`)

    this.roadMap.delete(id)

    // A road may begin and end at the same node; the Set visits it once, and
    // the filter below drops both of that road's ends in that one visit.
    for (const nodeId of new Set([road.startNode, road.endNode])) {
      const node = this.nodeMap.get(nodeId)
      if (!node) continue

      const remaining = node.ends.filter((e) => e.roadId !== id)
      if (remaining.length === 0) {
        this.nodeMap.delete(nodeId)
      } else {
        node.ends = remaining
      }
    }
  }
```

`node.ends` is declared `RoadEnd[]` on the private storage type, so the assignment type-checks; the public `NetworkNode.ends` stays `readonly`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`

Expected: all previously passing tests still pass, plus the six new ones. If any existing test fails, read it before changing it — a test that depended on ids being indices was asserting the behaviour this task exists to remove, but a test that depended on iteration order was asserting something that should still hold.

- [ ] **Step 6: Check types**

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/network/graph.ts src/network/graph.test.ts
git commit -m "feat: counter-allocated network ids and road removal"
```

---

### Task 2: Spatial index for node lookup

`nodeAt` scans every node, and `addRoad` calls it twice. Drawing a network of any size makes road creation quadratic. A uniform grid makes it constant-time in the common case.

The subtlety that makes this worth its own task: the index must not change `nodeAt`'s answer. Two properties have to survive — a node just across a cell boundary is still found, and when several nodes are in range the earliest-created one still wins.

**Files:**
- Create: `src/network/nodeIndex.ts`
- Create: `src/network/nodeIndex.test.ts`
- Modify: `src/network/graph.ts`

**Interfaces:**
- Consumes: `Vec2` and `distance` from `src/geometry/vec2`, `NodeId` and `NODE_SNAP_DISTANCE` from `src/network/graph`.
- Produces: `class NodeIndex` with `insert(id: NodeId, position: Vec2): void`, `remove(id: NodeId): void`, and `nearby(position: Vec2): NodeId[]` returning every candidate id within `NODE_SNAP_DISTANCE`, ascending. Also exports `CELL_SIZE`.

`nodeIndex.ts` importing `NodeId` and `NODE_SNAP_DISTANCE` from `graph.ts` while `graph.ts` imports `NodeIndex` back is a cycle. Break it by having `nodeIndex.ts` import nothing from `graph.ts`: declare its own `id: number` parameter type and take the search radius as a constructor argument. `graph.ts` passes `NODE_SNAP_DISTANCE`.

- [ ] **Step 1: Write the failing tests**

Create `src/network/nodeIndex.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CELL_SIZE, NodeIndex } from './nodeIndex'

const RADIUS = 0.5

describe('NodeIndex', () => {
  it('has cells at least as large as the search radius', () => {
    // The neighbourhood scan below only visits cells within one step of the
    // query's own cell. That is sufficient only while a cell is at least as
    // wide as the radius.
    expect(CELL_SIZE).toBeGreaterThanOrEqual(RADIUS)
  })

  it('finds a node in the same cell', () => {
    const index = new NodeIndex(RADIUS)
    index.insert(7, { x: 1, y: 1 })
    expect(index.nearby({ x: 1.2, y: 1 })).toEqual([7])
  })

  it('finds a node just across a cell boundary', () => {
    const index = new NodeIndex(RADIUS)
    // Straddle the boundary at x = CELL_SIZE: 0.2m apart, different cells.
    index.insert(3, { x: CELL_SIZE - 0.1, y: 0 })
    expect(index.nearby({ x: CELL_SIZE + 0.1, y: 0 })).toEqual([3])
  })

  it('finds a node across a diagonal cell corner', () => {
    const index = new NodeIndex(RADIUS)
    index.insert(4, { x: CELL_SIZE - 0.1, y: CELL_SIZE - 0.1 })
    expect(index.nearby({ x: CELL_SIZE + 0.1, y: CELL_SIZE + 0.1 })).toEqual([4])
  })

  it('works at negative coordinates', () => {
    const index = new NodeIndex(RADIUS)
    index.insert(5, { x: -CELL_SIZE - 0.1, y: -0.1 })
    expect(index.nearby({ x: -CELL_SIZE - 0.3, y: 0.1 })).toEqual([5])
  })

  it('excludes a node outside the radius but inside the cell', () => {
    const index = new NodeIndex(RADIUS)
    index.insert(1, { x: 0.1, y: 0.1 })
    // Same cell (CELL_SIZE is metres and well over 1), but 1.3m away.
    expect(index.nearby({ x: 1.4, y: 0.1 })).toEqual([])
  })

  it('returns candidates in ascending id order', () => {
    const index = new NodeIndex(RADIUS)
    index.insert(9, { x: 0, y: 0 })
    index.insert(2, { x: 0.1, y: 0 })
    index.insert(5, { x: -0.1, y: 0 })
    expect(index.nearby({ x: 0, y: 0 })).toEqual([2, 5, 9])
  })

  it('forgets a removed node', () => {
    const index = new NodeIndex(RADIUS)
    index.insert(1, { x: 0, y: 0 })
    index.remove(1)
    expect(index.nearby({ x: 0, y: 0 })).toEqual([])
  })

  it('ignores removal of an unknown id', () => {
    const index = new NodeIndex(RADIUS)
    expect(() => index.remove(42)).not.toThrow()
  })
})
```

The boundary and diagonal cases are the point of this test file. An index that only reads the query point's own cell passes every same-cell test and then silently stops snapping roads whose ends land a few centimetres the wrong side of an invisible grid line.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/network/nodeIndex.test.ts`

Expected: FAIL — cannot resolve `./nodeIndex`.

- [ ] **Step 3: Implement the index**

Create `src/network/nodeIndex.ts`:

```ts
import { type Vec2, distance } from '../geometry/vec2'

/**
 * Grid cell size, metres.
 *
 * Must be at least the search radius, or the one-cell neighbourhood scan in
 * `nearby` would miss a node two cells away. Four metres keeps the
 * neighbourhood small while making the cell count for a city-sized network
 * comfortably sparse.
 */
export const CELL_SIZE = 4

/**
 * A uniform grid over node positions.
 *
 * Deliberately holds ids, not nodes: the graph owns node state, and a second
 * copy of a position that the graph can change is a desynchronisation waiting
 * to happen. The graph re-inserts on move.
 */
export class NodeIndex {
  private readonly cells = new Map<string, number[]>()
  private readonly positions = new Map<number, Vec2>()

  constructor(private readonly radius: number) {
    if (radius > CELL_SIZE) {
      throw new RangeError(
        `search radius ${radius} exceeds cell size ${CELL_SIZE}; the neighbourhood scan would miss nodes`,
      )
    }
  }

  private static key(cx: number, cy: number): string {
    return `${cx},${cy}`
  }

  private static cellOf(position: Vec2): [number, number] {
    return [Math.floor(position.x / CELL_SIZE), Math.floor(position.y / CELL_SIZE)]
  }

  insert(id: number, position: Vec2): void {
    this.remove(id)
    const [cx, cy] = NodeIndex.cellOf(position)
    const key = NodeIndex.key(cx, cy)
    const bucket = this.cells.get(key)
    if (bucket) bucket.push(id)
    else this.cells.set(key, [id])
    this.positions.set(id, position)
  }

  remove(id: number): void {
    const position = this.positions.get(id)
    if (!position) return
    const [cx, cy] = NodeIndex.cellOf(position)
    const key = NodeIndex.key(cx, cy)
    const bucket = this.cells.get(key)
    if (bucket) {
      const next = bucket.filter((n) => n !== id)
      if (next.length === 0) this.cells.delete(key)
      else this.cells.set(key, next)
    }
    this.positions.delete(id)
  }

  /**
   * Every indexed id within the radius of a position, ascending.
   *
   * Ascending order is not cosmetic. Ids are allocated from a counter, so
   * ascending id is creation order, and the graph's documented snapping rule
   * is that the first node created at a location wins. A grid scan visits
   * cells in an order that has nothing to do with creation, so the sort is
   * what keeps the answer identical to the linear scan it replaces.
   */
  nearby(position: Vec2): number[] {
    const [cx, cy] = NodeIndex.cellOf(position)
    const found: number[] = []

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this.cells.get(NodeIndex.key(cx + dx, cy + dy))
        if (!bucket) continue
        for (const id of bucket) {
          const p = this.positions.get(id)
          if (p && distance(p, position) <= this.radius) found.push(id)
        }
      }
    }

    return found.sort((a, b) => a - b)
  }
}
```

- [ ] **Step 4: Run the index tests**

Run: `npx vitest run src/network/nodeIndex.test.ts`

Expected: PASS, 8 tests.

- [ ] **Step 5: Put the index behind nodeAt**

In `src/network/graph.ts`, add the import and the field:

```ts
import { NodeIndex } from './nodeIndex'
```

```ts
  private readonly index = new NodeIndex(NODE_SNAP_DISTANCE)
```

Replace `nodeAt` with a lookup through the index. The first candidate is the lowest id, which is the earliest created — the same node the linear scan returned:

```ts
  nodeAt(position: Vec2): NetworkNode | undefined {
    const candidates = this.index.nearby(position)
    const first = candidates[0]
    if (first === undefined) return undefined
    const found = this.nodeMap.get(first)
    if (!found) return undefined
    return { ...found, ends: [...found.ends] }
  }
```

Keep the index and the map in step in the two places node membership changes. In `nodeFor`, after `this.nodeMap.set(...)`:

```ts
    this.index.insert(id, position)
```

In `removeRoad`, alongside `this.nodeMap.delete(nodeId)`:

```ts
        this.nodeMap.delete(nodeId)
        this.index.remove(nodeId)
```

- [ ] **Step 6: Run the whole suite**

Run: `npm test`

Expected: everything passes. Task 1's `removeRoad` tests are what prove the index stays in step — the "deletes a node once nothing references it" test fails if `index.remove` is missing, because the stale entry keeps answering `nodeAt`.

- [ ] **Step 7: Check types and commit**

Run: `npx tsc --noEmit`

```bash
git add src/network/nodeIndex.ts src/network/nodeIndex.test.ts src/network/graph.ts
git commit -m "perf: uniform grid index behind nodeAt"
```

**Deliberately not done:** `nearby` returns the earliest-created candidate first, not the nearest. That preserves the documented behaviour this task replaced. Nearest-wins may well be the better rule for the drawing tool, but changing it is a design decision, not a side effect of adding an index — leave it for the tool plan.

---

### Task 3: Splitting primitives and alignments

Splitting a road means splitting its alignment at a station, which means splitting whichever primitive spans that station. Each of the three primitive types divides differently: a line keeps its heading, an arc keeps its curvature, a spiral keeps its curvature *rate* and takes the interpolated curvature at the cut as the boundary value.

**Files:**
- Create: `src/geometry/split.ts`
- Create: `src/geometry/split.test.ts`

**Interfaces:**
- Consumes: `Primitive`, `Line`, `Arc` from `src/geometry/primitives`; `Spiral` from `src/geometry/spiral` (constructor `(start: Vec2, heading: number, length: number, startCurvature: number, endCurvature: number)`); `Alignment` from `src/geometry/alignment`.
- Produces: `splitPrimitive(p: Primitive, s: number): [Primitive, Primitive]` and `splitAlignment(a: Alignment, s: number): [Alignment, Alignment]`. Both throw `RangeError` when `s` is not strictly inside the length.

- [ ] **Step 1: Write the failing tests**

Create `src/geometry/split.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Alignment } from './alignment'
import { Arc, Line, type Primitive } from './primitives'
import { Spiral } from './spiral'
import { splitAlignment, splitPrimitive } from './split'

/**
 * The two halves must reproduce the original everywhere, not merely add up to
 * its length. Position alone is not enough: an arc half constructed with the
 * wrong start heading can still trace positions that look plausible at a
 * glance, so heading and curvature are checked at every sample too.
 */
const expectSplitReproducesOriginal = (original: Primitive, cut: number) => {
  const [head, tail] = splitPrimitive(original, cut)

  expect(head.length).toBeCloseTo(cut, 9)
  expect(tail.length).toBeCloseTo(original.length - cut, 9)

  const samples = 40
  for (let i = 0; i <= samples; i++) {
    const s = (i / samples) * original.length
    const expected = original.poseAt(s)
    const actual = s <= cut ? head.poseAt(s) : tail.poseAt(s - cut)

    expect(actual.position.x).toBeCloseTo(expected.position.x, 6)
    expect(actual.position.y).toBeCloseTo(expected.position.y, 6)
    expect(Math.cos(actual.heading)).toBeCloseTo(Math.cos(expected.heading), 6)
    expect(Math.sin(actual.heading)).toBeCloseTo(Math.sin(expected.heading), 6)
    expect(actual.curvature).toBeCloseTo(expected.curvature, 6)
  }
}

describe('splitPrimitive', () => {
  it('splits a line', () => {
    expectSplitReproducesOriginal(new Line({ x: 10, y: -5 }, 0.7, 120), 43)
  })

  it('splits an arc', () => {
    expectSplitReproducesOriginal(new Arc({ x: 0, y: 0 }, 0.3, 90, 1 / 60), 31)
  })

  it('splits a right-hand arc', () => {
    expectSplitReproducesOriginal(new Arc({ x: 4, y: 2 }, -1.1, 75, -1 / 40), 50)
  })

  it('splits a spiral', () => {
    expectSplitReproducesOriginal(
      new Spiral({ x: 0, y: 0 }, 0.2, 80, 0, 1 / 50),
      29,
    )
  })

  it('splits a spiral that unwinds', () => {
    expectSplitReproducesOriginal(
      new Spiral({ x: -3, y: 7 }, 1.4, 60, 1 / 30, -1 / 90),
      37,
    )
  })

  it('rejects a cut at either end', () => {
    const line = new Line({ x: 0, y: 0 }, 0, 100)
    expect(() => splitPrimitive(line, 0)).toThrow(RangeError)
    expect(() => splitPrimitive(line, 100)).toThrow(RangeError)
    expect(() => splitPrimitive(line, -1)).toThrow(RangeError)
    expect(() => splitPrimitive(line, 101)).toThrow(RangeError)
  })
})

describe('splitAlignment', () => {
  const chain = () =>
    new Alignment([
      new Line({ x: 0, y: 0 }, 0, 50),
      new Arc({ x: 50, y: 0 }, 0, 40, 1 / 80),
      new Line(new Arc({ x: 50, y: 0 }, 0, 40, 1 / 80).poseAt(40).position, 0.5, 30),
    ])

  it('reproduces the original across the cut', () => {
    const a = chain()
    const [head, tail] = splitAlignment(a, 70)

    expect(head.length).toBeCloseTo(70, 9)
    expect(tail.length).toBeCloseTo(a.length - 70, 9)

    for (let i = 0; i <= 40; i++) {
      const s = (i / 40) * a.length
      const expected = a.poseAt(s)
      const actual = s <= 70 ? head.poseAt(s) : tail.poseAt(s - 70)
      expect(actual.position.x).toBeCloseTo(expected.position.x, 6)
      expect(actual.position.y).toBeCloseTo(expected.position.y, 6)
    }
  })

  it('produces no zero-length primitive when the cut lands on a joint', () => {
    const a = chain()
    const [head, tail] = splitAlignment(a, 50)

    expect(head.primitives).toHaveLength(1)
    expect(tail.primitives).toHaveLength(2)
    for (const p of [...head.primitives, ...tail.primitives]) {
      expect(p.length).toBeGreaterThan(0)
    }
  })

  it('keeps both halves continuous', () => {
    const [head, tail] = splitAlignment(chain(), 70)
    expect(head.isContinuous).toBe(true)
    expect(tail.isContinuous).toBe(true)
  })

  it('rejects a cut at either end and an empty alignment', () => {
    const a = chain()
    expect(() => splitAlignment(a, 0)).toThrow(RangeError)
    expect(() => splitAlignment(a, a.length)).toThrow(RangeError)
    expect(() => splitAlignment(new Alignment([]), 1)).toThrow(RangeError)
  })
})
```

The heading check uses `cos`/`sin` rather than the raw angle so a joint straddling ±π reads as equal instead of as a full turn — the same reason `checkContinuity` compares through `normalizeAngle`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/geometry/split.test.ts`

Expected: FAIL — cannot resolve `./split`.

- [ ] **Step 3: Implement splitting**

Create `src/geometry/split.ts`:

```ts
import { Alignment } from './alignment'
import { Arc, Line, type Primitive } from './primitives'
import { Spiral } from './spiral'

/**
 * Divide a primitive at a station, producing two of the same kind.
 *
 * Each type carries a different invariant across the cut. A line keeps its
 * heading. An arc keeps its curvature and takes the swept heading at the cut.
 * A spiral keeps its curvature *rate*, which is preserved implicitly: the
 * curvature at the cut is the boundary value for both halves, so
 * `(k_cut - k0) / cut` and `(k1 - k_cut) / (length - cut)` are both the
 * original rate.
 */
export const splitPrimitive = (p: Primitive, s: number): [Primitive, Primitive] => {
  if (!(s > 0 && s < p.length)) {
    throw new RangeError(
      `split station ${s} must lie strictly inside (0, ${p.length})`,
    )
  }

  const at = p.poseAt(s)
  const rest = p.length - s

  if (p instanceof Line) {
    return [new Line(p.start, p.heading, s), new Line(at.position, p.heading, rest)]
  }

  if (p instanceof Arc) {
    return [
      new Arc(p.start, p.heading, s, p.curvature),
      new Arc(at.position, at.heading, rest, p.curvature),
    ]
  }

  if (p instanceof Spiral) {
    return [
      new Spiral(p.start, p.heading, s, p.startCurvature, at.curvature),
      new Spiral(at.position, at.heading, rest, at.curvature, p.endCurvature),
    ]
  }

  throw new TypeError('cannot split an unrecognised primitive type')
}

/**
 * Divide an alignment at a station.
 *
 * A cut landing exactly on a joint moves the whole primitive to the second
 * half rather than splitting it into a zero-length piece and itself.
 */
export const splitAlignment = (a: Alignment, s: number): [Alignment, Alignment] => {
  if (a.isEmpty) {
    throw new RangeError('cannot split an empty alignment')
  }
  if (!(s > 0 && s < a.length)) {
    throw new RangeError(
      `split station ${s} must lie strictly inside (0, ${a.length})`,
    )
  }

  const { index, localS } = a.primitiveAt(s)
  const before = a.primitives.slice(0, index)
  const after = a.primitives.slice(index + 1)
  const target = a.primitives[index]!

  // `primitiveAt` resolves a tie to the primitive *starting* at the station,
  // so a cut on a joint arrives here as localS === 0. The mirror case,
  // localS === target.length, can only arise at s === a.length, excluded above.
  if (localS === 0) {
    return [new Alignment(before), new Alignment([target, ...after])]
  }

  const [head, tail] = splitPrimitive(target, localS)
  return [new Alignment([...before, head]), new Alignment([tail, ...after])]
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/geometry/split.test.ts`

Expected: PASS, 10 tests.

- [ ] **Step 5: Check types and commit**

Run: `npx tsc --noEmit`

```bash
git add src/geometry/split.ts src/geometry/split.test.ts
git commit -m "feat: split primitives and alignments at a station"
```

---

### Task 4: Splitting a road in the network

Split one road into two that meet at a new node. The order of operations matters more than the arithmetic: add both halves before removing the original, or the original's end nodes lose their last reference, get deleted, and come back with new ids — invalidating every `NodeId` the mesh layer holds for a junction the split never touched.

**Files:**
- Modify: `src/network/graph.ts`
- Test: `src/network/graph.test.ts`

**Interfaces:**
- Consumes: `splitAlignment` from `src/geometry/split`; `removeRoad` and `addRoad` from Task 1.
- Produces: `RoadNetwork.splitRoad(id: RoadId, s: number): { readonly first: RoadId; readonly second: RoadId; readonly node: NodeId }`.

- [ ] **Step 1: Write the failing tests**

Add to `src/network/graph.test.ts`:

```ts
describe('splitRoad', () => {
  it('produces two roads meeting at a new node', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight({ x: 0, y: 0 }, 0, 100), 'rural')

    const { first, second, node } = net.splitRoad(id, 40)

    expect(net.roads).toHaveLength(2)
    expect(() => net.road(id)).toThrow(RangeError)
    expect(net.road(first).alignment.length).toBeCloseTo(40, 9)
    expect(net.road(second).alignment.length).toBeCloseTo(60, 9)
    expect(net.road(first).endNode).toBe(node)
    expect(net.road(second).startNode).toBe(node)
    expect(net.node(node).ends).toHaveLength(2)
  })

  it('preserves the identifiers of the untouched end nodes', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight({ x: 0, y: 0 }, 0, 100), 'rural')
    const startNode = net.road(id).startNode
    const endNode = net.road(id).endNode

    const { first, second } = net.splitRoad(id, 40)

    expect(net.road(first).startNode).toBe(startNode)
    expect(net.road(second).endNode).toBe(endNode)
  })

  it('leaves a junction at an end intact', () => {
    const net = new RoadNetwork()
    const main = net.addRoad(straight({ x: 0, y: 0 }, 0, 100), 'rural')
    net.addRoad(straight({ x: 0, y: 0 }, Math.PI / 2, 50), 'rural')
    net.addRoad(straight({ x: 0, y: 0 }, -Math.PI / 2, 50), 'rural')

    const junction = net.road(main).startNode
    expect(net.isJunction(junction)).toBe(true)

    const { first } = net.splitRoad(main, 40)

    expect(net.road(first).startNode).toBe(junction)
    expect(net.isJunction(junction)).toBe(true)
    expect(net.node(junction).ends).toHaveLength(3)
  })

  it('carries the class onto both halves', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight({ x: 0, y: 0 }, 0, 100), 'gravel')
    const { first, second } = net.splitRoad(id, 40)
    expect(net.road(first).className).toBe('gravel')
    expect(net.road(second).className).toBe('gravel')
  })

  it('rejects a split at either end or on an unknown road', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight({ x: 0, y: 0 }, 0, 100), 'rural')
    expect(() => net.splitRoad(id, 0)).toThrow(RangeError)
    expect(() => net.splitRoad(id, 100)).toThrow(RangeError)
    expect(() => net.splitRoad(999, 40)).toThrow(RangeError)
  })

  it('rejects a split that would leave a piece shorter than the snap distance', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight({ x: 0, y: 0 }, 0, 100), 'rural')
    // Both halves' ends would fall inside NODE_SNAP_DISTANCE of each other,
    // so the new node would snap onto an existing one and the two halves
    // would share both endpoints.
    expect(() => net.splitRoad(id, 0.2)).toThrow(RangeError)
    expect(() => net.splitRoad(id, 99.8)).toThrow(RangeError)
  })
})
```

The last test is the case that produces nonsense rather than an error if left unguarded: a cut 20cm from the start puts the new node inside the start node's snap radius, so `addRoad` snaps it there and the "two" roads share both endpoints.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/network/graph.test.ts`

Expected: FAIL — `net.splitRoad is not a function`.

- [ ] **Step 3: Implement splitRoad**

Add the import to `src/network/graph.ts`:

```ts
import { splitAlignment } from '../geometry/split'
```

```ts
  /**
   * Divide a road at a station into two roads meeting at a new node.
   *
   * Both halves are added before the original is removed. Removing first
   * would drop the original's last reference to its own end nodes, delete
   * them as orphans, and hand the halves freshly allocated ids for junctions
   * the split never touched — silently repointing every `NodeId` the mesh
   * layer holds for those junctions.
   */
  splitRoad(
    id: RoadId,
    s: number,
  ): { readonly first: RoadId; readonly second: RoadId; readonly node: NodeId } {
    const road = this.roadMap.get(id)
    if (!road) throw new RangeError(`no road with id ${id}`)

    if (s <= NODE_SNAP_DISTANCE || s >= road.alignment.length - NODE_SNAP_DISTANCE) {
      throw new RangeError(
        `split station ${s} must leave at least ${NODE_SNAP_DISTANCE}m on each side of a road ${road.alignment.length}m long`,
      )
    }

    const [head, tail] = splitAlignment(road.alignment, s)

    const first = this.addRoad(head, road.className)
    const second = this.addRoad(tail, road.className)
    this.removeRoad(id)

    return { first, second, node: this.road(first).endNode }
  }
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Check types and commit**

Run: `npx tsc --noEmit`

```bash
git add src/network/graph.ts src/network/graph.test.ts
git commit -m "feat: split a road at a station"
```

---

### Task 5: The class table moves, and a road's own geometry gates its class

Spec §4.7: "A higher class carries a higher design speed, which demands a larger minimum curve radius. Upgrading a winding rural road to a highway can make its own curves illegal — which is real, and is exactly the sort of engineering consequence this game exists to surface rather than hide."

The check needs the class table's *values*, not just its type. `roadClass.ts` currently lives in `src/mesh/`, which `src/network/` may not import from. Moving it to `src/network/` is the honest fix — the class table is domain data about a road, the network already stores `Road.className`, and `mesh/` already imports `network/`.

**Files:**
- Move: `src/mesh/roadClass.ts` → `src/network/roadClass.ts` (and its test alongside)
- Modify: every importer of `../mesh/roadClass` or `./roadClass`
- Create: `src/network/classChange.ts`
- Create: `src/network/classChange.test.ts`

**Interfaces:**
- Consumes: `ROAD_CLASSES`, `RoadClassName` from the moved `src/network/roadClass`; `minimumRadiusForSpeed` from `src/geometry/designSpeed`; `Road` from `src/network/graph`.
- Produces:

```ts
export type ClassChangeRejection = {
  readonly reason: 'curve-too-tight'
  /** Station on the road carrying the tightest curve, metres. */
  readonly station: number
  /** Radius there, metres. */
  readonly actualRadius: number
  /** Radius the new class's design speed requires, metres. */
  readonly requiredRadius: number
}

export type ClassChangeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejection: ClassChangeRejection }

export const checkClassChange: (
  road: Road,
  to: RoadClassName,
  sampleSpacing?: number,
) => ClassChangeResult
```

- [ ] **Step 1: Move the class table**

```bash
git mv src/mesh/roadClass.ts src/network/roadClass.ts
git mv src/mesh/roadClass.test.ts src/network/roadClass.test.ts
```

Fix the imports. In `src/network/graph.ts`, the type-only import becomes local and no longer needs to be type-only:

```ts
import type { RoadClassName } from './roadClass'
```

Every file that imported `./roadClass` from within `src/mesh/` now imports `../network/roadClass`. Find them:

```bash
grep -rln --include=\*.ts "roadClass" src/
```

Update each. Run `npx tsc --noEmit` until clean, then `npm test` — the suite passing unchanged is what proves the move was mechanical.

- [ ] **Step 2: Commit the move on its own**

```bash
git add -A src/
git commit -m "refactor: move the road class table into the network layer"
```

Keeping the move in its own commit means the next commit's diff is the new behaviour, not a thousand lines of relocation.

- [ ] **Step 3: Write the failing tests**

Create `src/network/classChange.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Alignment } from '../geometry/alignment'
import { minimumRadiusForSpeed } from '../geometry/designSpeed'
import { Arc, Line } from '../geometry/primitives'
import { checkClassChange } from './classChange'
import { RoadNetwork } from './graph'
import { ROAD_CLASSES } from './roadClass'

const roadWith = (alignment: Alignment, className: 'gravel' | 'rural') => {
  const net = new RoadNetwork()
  return net.road(net.addRoad(alignment, className))
}

describe('checkClassChange', () => {
  it('allows a straight road to become anything', () => {
    const road = roadWith(new Alignment([new Line({ x: 0, y: 0 }, 0, 500)]), 'gravel')
    expect(checkClassChange(road, 'highway')).toEqual({ ok: true })
  })

  it('allows a gentle curve to become a highway', () => {
    const required = minimumRadiusForSpeed(ROAD_CLASSES.highway.designSpeedKph)
    const generous = required * 2
    const road = roadWith(
      new Alignment([new Arc({ x: 0, y: 0 }, 0, 200, 1 / generous)]),
      'gravel',
    )
    expect(checkClassChange(road, 'highway')).toEqual({ ok: true })
  })

  it('rejects a curve too tight for the new design speed, and says by how much', () => {
    const required = minimumRadiusForSpeed(ROAD_CLASSES.highway.designSpeedKph)
    const tight = required / 3
    const road = roadWith(
      new Alignment([new Arc({ x: 0, y: 0 }, 0, 100, 1 / tight)]),
      'gravel',
    )

    const result = checkClassChange(road, 'highway')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe('curve-too-tight')
    expect(result.rejection.actualRadius).toBeCloseTo(tight, 3)
    expect(result.rejection.requiredRadius).toBeCloseTo(required, 6)
  })

  it('is indifferent to the direction of the turn', () => {
    const required = minimumRadiusForSpeed(ROAD_CLASSES.highway.designSpeedKph)
    const tight = required / 3
    const left = roadWith(new Alignment([new Arc({ x: 0, y: 0 }, 0, 100, 1 / tight)]), 'gravel')
    const right = roadWith(new Alignment([new Arc({ x: 0, y: 0 }, 0, 100, -1 / tight)]), 'gravel')

    expect(checkClassChange(left, 'highway').ok).toBe(false)
    expect(checkClassChange(right, 'highway').ok).toBe(false)
  })

  it('reports the tightest curve, not the first', () => {
    const required = minimumRadiusForSpeed(ROAD_CLASSES.highway.designSpeedKph)
    const mild = required / 1.5
    const severe = required / 4
    const firstArc = new Arc({ x: 0, y: 0 }, 0, 60, 1 / mild)
    const secondStart = firstArc.poseAt(60)
    const road = roadWith(
      new Alignment([
        firstArc,
        new Arc(secondStart.position, secondStart.heading, 60, 1 / severe),
      ]),
      'gravel',
    )

    const result = checkClassChange(road, 'highway')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.actualRadius).toBeCloseTo(severe, 3)
    expect(result.rejection.station).toBeGreaterThan(60)
  })

  it('allows a downgrade that the geometry already satisfies', () => {
    const required = minimumRadiusForSpeed(ROAD_CLASSES.rural.designSpeedKph)
    const road = roadWith(
      new Alignment([new Arc({ x: 0, y: 0 }, 0, 100, 1 / (required * 1.1))]),
      'rural',
    )
    expect(checkClassChange(road, 'gravel')).toEqual({ ok: true })
  })

  it('accepts a change to the class the road already is', () => {
    const road = roadWith(new Alignment([new Line({ x: 0, y: 0 }, 0, 100)]), 'rural')
    expect(checkClassChange(road, 'rural')).toEqual({ ok: true })
  })
})
```

"Reports the tightest curve, not the first" is the test that catches an implementation that returns on the first violation — which would tell the player to fix a curve that is not the worst one, and hand them a second rejection after they fix it.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run src/network/classChange.test.ts`

Expected: FAIL — cannot resolve `./classChange`.

- [ ] **Step 5: Implement the check**

Create `src/network/classChange.ts`:

```ts
import { minimumRadiusForSpeed } from '../geometry/designSpeed'
import type { Road } from './graph'
import { ROAD_CLASSES, type RoadClassName } from './roadClass'

export type ClassChangeRejection = {
  readonly reason: 'curve-too-tight'
  /** Station on the road carrying the tightest curve, metres. */
  readonly station: number
  /** Radius there, metres. */
  readonly actualRadius: number
  /** Radius the new class's design speed requires, metres. */
  readonly requiredRadius: number
}

export type ClassChangeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejection: ClassChangeRejection }

/** How often the alignment's curvature is inspected, metres. */
const DEFAULT_SAMPLE_SPACING = 1

/**
 * Whether a road's own geometry permits it to become another class.
 *
 * A higher class carries a higher design speed, and a higher design speed
 * demands a larger minimum radius. A winding rural road cannot become a
 * highway without its own curves becoming illegal. Saying so is the point:
 * silently building a highway that violates the standard it claims to meet
 * would hide exactly the consequence this project exists to show.
 *
 * Only the road's own alignment is examined here. Whether its junctions still
 * solve at the wider formation is a mesh-layer question — see
 * `src/mesh/upgradeCheck.ts`.
 */
export const checkClassChange = (
  road: Road,
  to: RoadClassName,
  sampleSpacing: number = DEFAULT_SAMPLE_SPACING,
): ClassChangeResult => {
  const requiredRadius = minimumRadiusForSpeed(ROAD_CLASSES[to].designSpeedKph)

  let worstCurvature = 0
  let worstStation = 0

  for (const pose of road.alignment.sample(sampleSpacing)) {
    const magnitude = Math.abs(pose.curvature)
    if (magnitude > worstCurvature) {
      worstCurvature = magnitude
      worstStation = pose.s
    }
  }

  if (worstCurvature === 0) return { ok: true }

  const actualRadius = 1 / worstCurvature
  if (actualRadius >= requiredRadius) return { ok: true }

  return {
    ok: false,
    rejection: {
      reason: 'curve-too-tight',
      station: worstStation,
      actualRadius,
      requiredRadius,
    },
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/network/classChange.test.ts`

Expected: PASS, 7 tests.

- [ ] **Step 7: Add the mutation to the graph**

`checkClassChange` answers the question; something has to act on the answer. Add to `src/network/graph.ts`:

```ts
  /**
   * Change a road's class.
   *
   * Deliberately unconditional: legality is `checkClassChange`'s job and, for
   * junctions, `checkUpgrade`'s. Folding the check in here would make the
   * graph import the mesh layer to ask about junction geometry, inverting the
   * dependency direction. The caller checks, then commits.
   */
  setRoadClass(id: RoadId, className: RoadClassName): void {
    const road = this.roadMap.get(id)
    if (!road) throw new RangeError(`no road with id ${id}`)
    this.roadMap.set(id, { ...road, className })
  }
```

Add a test to `src/network/graph.test.ts`:

```ts
describe('setRoadClass', () => {
  it('changes the class and keeps the id and topology', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight({ x: 0, y: 0 }, 0, 100), 'gravel')
    const before = net.road(id)

    net.setRoadClass(id, 'highway')

    const after = net.road(id)
    expect(after.className).toBe('highway')
    expect(after.id).toBe(id)
    expect(after.startNode).toBe(before.startNode)
    expect(after.endNode).toBe(before.endNode)
    expect(after.alignment).toBe(before.alignment)
  })

  it('rejects an unknown road id', () => {
    const net = new RoadNetwork()
    expect(() => net.setRoadClass(999, 'rural')).toThrow(RangeError)
  })
})
```

- [ ] **Step 8: Run the whole suite, check types and commit**

Run: `npm test` then `npx tsc --noEmit`

```bash
git add src/network/classChange.ts src/network/classChange.test.ts src/network/graph.ts src/network/graph.test.ts
git commit -m "feat: gate a class change on the road's own curve radii"
```

---

### Task 6: Whether an upgrade's junctions still solve

Spec §4.7: "Every junction it touches must re-solve. Trim distances come from the legs' half-widths, so widening one leg pulls every other leg at that node further back. A junction that was feasible can stop being feasible."

This is the half of the upgrade question the network layer cannot answer, because junction geometry lives in `mesh/`. It belongs here, above both.

**Files:**
- Create: `src/mesh/upgradeCheck.ts`
- Create: `src/mesh/upgradeCheck.test.ts`

**Interfaces:**
- Consumes: `RoadNetwork`, `RoadId`, `NodeId` from `src/network/graph`; `checkClassChange`, `ClassChangeRejection` from `src/network/classChange`; `ROAD_CLASSES`, `RoadClassName`, `formationHalfWidth` from `src/network/roadClass`; `junctionLegs` (signature `(network: RoadNetwork, nodeId: NodeId) => JunctionLeg[]`, where `JunctionLeg` is `{ roadId, end, direction, halfWidth, bearing }`) from `src/mesh/junctionLegs`; `solveJunction` (signature `(legs: readonly JunctionLeg[], maxTrim?: number) => JunctionGeometry`) and `JunctionInfeasibility` from `src/mesh/junctionCorners`.
- Produces:

```ts
export type UpgradeObstacle =
  | { readonly kind: 'alignment'; readonly rejection: ClassChangeRejection }
  | { readonly kind: 'junction'; readonly nodeId: NodeId; readonly reason: JunctionInfeasibility }

export type UpgradeCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly obstacles: readonly UpgradeObstacle[] }

export const checkUpgrade: (
  network: RoadNetwork,
  roadId: RoadId,
  to: RoadClassName,
) => UpgradeCheck
```

Every obstacle is reported, not just the first. A player told to fix one problem, who fixes it and is immediately told about a second, learns not to trust the tool.

- [ ] **Step 1: Write the failing tests**

Create `src/mesh/upgradeCheck.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Alignment } from '../geometry/alignment'
import { minimumRadiusForSpeed } from '../geometry/designSpeed'
import { Arc, Line } from '../geometry/primitives'
import { RoadNetwork } from '../network/graph'
import { ROAD_CLASSES } from '../network/roadClass'
import { checkUpgrade } from './upgradeCheck'

const straight = (from: { x: number; y: number }, heading: number, length: number) =>
  new Alignment([new Line(from, heading, length)])

/** Three roads leaving the origin at 120-degree spacing — a clean Y junction. */
const yJunction = () => {
  const net = new RoadNetwork()
  const a = net.addRoad(straight({ x: 0, y: 0 }, 0, 300), 'gravel')
  net.addRoad(straight({ x: 0, y: 0 }, (2 * Math.PI) / 3, 300), 'gravel')
  net.addRoad(straight({ x: 0, y: 0 }, (4 * Math.PI) / 3, 300), 'gravel')
  return { net, a }
}

describe('checkUpgrade', () => {
  it('allows an upgrade a well-spaced junction can absorb', () => {
    const { net, a } = yJunction()
    expect(checkUpgrade(net, a, 'rural')).toEqual({ ok: true })
  })

  it('reports a curve too tight for the new class', () => {
    const net = new RoadNetwork()
    const tight = minimumRadiusForSpeed(ROAD_CLASSES.highway.designSpeedKph) / 4
    const id = net.addRoad(
      new Alignment([new Arc({ x: 0, y: 0 }, 0, 200, 1 / tight)]),
      'gravel',
    )

    const result = checkUpgrade(net, id, 'highway')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.obstacles).toHaveLength(1)
    expect(result.obstacles[0]?.kind).toBe('alignment')
  })

  it('reports a junction that stops solving at the wider formation', () => {
    // Two roads leaving at a very shallow angle plus a third: the corner
    // between the near-parallel pair runs away as their half-widths grow.
    const net = new RoadNetwork()
    const a = net.addRoad(straight({ x: 0, y: 0 }, 0, 400), 'gravel')
    net.addRoad(straight({ x: 0, y: 0 }, 0.03, 400), 'gravel')
    net.addRoad(straight({ x: 0, y: 0 }, Math.PI, 400), 'gravel')

    const before = checkUpgrade(net, a, 'gravel')
    expect(before).toEqual({ ok: true })

    const result = checkUpgrade(net, a, 'highway')
    expect(result.ok).toBe(false)
    if (result.ok) return
    const junction = result.obstacles.find((o) => o.kind === 'junction')
    expect(junction).toBeDefined()
  })

  it('checks the junctions at both ends', () => {
    const net = new RoadNetwork()
    const spine = net.addRoad(straight({ x: 0, y: 0 }, 0, 400), 'gravel')
    // A tight fan at the far end only.
    const far = { x: 400, y: 0 }
    net.addRoad(straight(far, 0.03, 400), 'gravel')
    net.addRoad(straight(far, Math.PI + 0.5, 400), 'gravel')

    const result = checkUpgrade(net, spine, 'highway')
    expect(result.ok).toBe(false)
    if (result.ok) return
    const junction = result.obstacles.find((o) => o.kind === 'junction')
    expect(junction).toBeDefined()
    if (junction?.kind !== 'junction') return
    expect(junction.nodeId).toBe(net.road(spine).endNode)
  })

  it('ignores nodes that are not junctions', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight({ x: 0, y: 0 }, 0, 400), 'gravel')
    // Two dead ends. solveJunction would call these 'too-few-legs', which is
    // a fact about a dead end, not an obstacle to upgrading.
    expect(checkUpgrade(net, id, 'highway')).toEqual({ ok: true })
  })

  it('reports every obstacle at once', () => {
    const net = new RoadNetwork()
    const tight = minimumRadiusForSpeed(ROAD_CLASSES.highway.designSpeedKph) / 4
    const arc = new Arc({ x: 0, y: 0 }, 0, 200, 1 / tight)
    const id = net.addRoad(new Alignment([arc]), 'gravel')
    net.addRoad(straight({ x: 0, y: 0 }, 0.03, 400), 'gravel')
    net.addRoad(straight({ x: 0, y: 0 }, Math.PI, 400), 'gravel')

    const result = checkUpgrade(net, id, 'highway')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.obstacles.some((o) => o.kind === 'alignment')).toBe(true)
    expect(result.obstacles.some((o) => o.kind === 'junction')).toBe(true)
  })

  it('rejects an unknown road id', () => {
    const net = new RoadNetwork()
    expect(() => checkUpgrade(net, 999, 'rural')).toThrow(RangeError)
  })
})
```

"Ignores nodes that are not junctions" is the trap. `solveJunction` returns `too-few-legs` for anything under three legs, so a dead-end road checked naively reports an obstacle at both its ends and no upgrade is ever permitted. A dead end is a dead end, not a broken junction.

The near-parallel fixture's exact angle may need adjusting to land on the boundary — `0.03` radians with gravel (2.0m half-width) versus highway (14.1m) should be comfortably either side, but verify rather than assume. If it turns out both classes solve or neither does, tune the angle and say so in your report; do not weaken the assertion to match whatever the code happens to do.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/mesh/upgradeCheck.test.ts`

Expected: FAIL — cannot resolve `./upgradeCheck`.

- [ ] **Step 3: Implement the check**

Create `src/mesh/upgradeCheck.ts`:

```ts
import {
  type ClassChangeRejection,
  checkClassChange,
} from '../network/classChange'
import type { NodeId, RoadId, RoadNetwork } from '../network/graph'
import {
  ROAD_CLASSES,
  type RoadClassName,
  formationHalfWidth,
} from '../network/roadClass'
import type { JunctionInfeasibility } from './junctionCorners'
import { solveJunction } from './junctionCorners'
import { junctionLegs } from './junctionLegs'

export type UpgradeObstacle =
  | { readonly kind: 'alignment'; readonly rejection: ClassChangeRejection }
  | {
      readonly kind: 'junction'
      readonly nodeId: NodeId
      readonly reason: JunctionInfeasibility
    }

export type UpgradeCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly obstacles: readonly UpgradeObstacle[] }

/** Three legs is the smallest thing that is a junction rather than a dead end. */
const MIN_JUNCTION_LEGS = 3

/**
 * Whether a road can become another class without breaking itself or its ends.
 *
 * Two questions, asked in the two layers that can answer them. The road's own
 * curves are a `network/` question; whether its junctions still solve once the
 * formation widens is a `mesh/` one, because trim distances come from leg
 * half-widths and widening one leg pulls every other leg at that node back.
 *
 * Every obstacle is reported, not the first. Fixing one problem only to be
 * shown another is how a tool teaches a player to stop trusting it.
 */
export const checkUpgrade = (
  network: RoadNetwork,
  roadId: RoadId,
  to: RoadClassName,
): UpgradeCheck => {
  // Throws for an unknown id, which is the intended behaviour.
  const road = network.road(roadId)

  const obstacles: UpgradeObstacle[] = []

  const alignment = checkClassChange(road, to)
  if (!alignment.ok) {
    obstacles.push({ kind: 'alignment', rejection: alignment.rejection })
  }

  const newHalfWidth = formationHalfWidth(ROAD_CLASSES[to])

  for (const nodeId of new Set([road.startNode, road.endNode])) {
    const legs = junctionLegs(network, nodeId)
    if (legs.length < MIN_JUNCTION_LEGS) continue

    // Substitute the upgraded road's new width. Both of its ends are replaced
    // when a road loops back to its own node.
    const widened = legs.map((leg) =>
      leg.roadId === roadId ? { ...leg, halfWidth: newHalfWidth } : leg,
    )

    const solved = solveJunction(widened)
    if (!solved.feasible) {
      obstacles.push({ kind: 'junction', nodeId, reason: solved.reason })
    }
  }

  return obstacles.length === 0 ? { ok: true } : { ok: false, obstacles }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/mesh/upgradeCheck.test.ts`

Expected: PASS, 7 tests.

- [ ] **Step 5: Run the whole suite, check types and commit**

Run: `npm test` then `npx tsc --noEmit`

```bash
git add src/mesh/upgradeCheck.ts src/mesh/upgradeCheck.test.ts
git commit -m "feat: check an upgrade against its junctions as well as its curves"
```

---

## Deliberately not in this plan

Recorded so the next plan inherits an accurate ledger rather than rediscovering these as gaps:

- **The drawing tool.** Pointer input, smart snap and live preview are plan 4b. This plan gives that tool the verbs; it does not give it a mouse.
- **The diorama look.** Camera rig, tilt-shift depth of field, materials and lighting are plan 4c.
- **Rebuilding geometry after a mutation.** `buildNetworkMesh` runs over the whole network; nothing here makes it incremental. Splitting a road in a thousand-road network will rebuild all thousand. Correct, and slow — measure before optimising.
- **Re-solving the grade profile after an upgrade.** A wider road has a different corridor and therefore different earthworks. `setRoadClass` changes the class; regenerating the design profile is the caller's job and nothing calls it yet.
- **Nearest-wins snapping.** `nodeAt` keeps first-created-wins, matching what it replaced. Whether the drawing tool wants nearest is a question for the tool.
- **Merging two roads at a node.** The inverse of split. Not requested, so not built.

---

## Self-Review

**Spec coverage.** §4.7's four consequences of an upgrade: the road gets wider (Task 5's `setRoadClass` changes the class the corridor is derived from); every junction re-solves (Task 6); the vertical alignment may no longer be legal (Task 5's curve check); it is construction work (deferred to the construction plan, and recorded above). §4.7's closing requirement — "when an upgrade cannot be built... say so and say why" — is the `ClassChangeRejection` and `UpgradeObstacle` shapes, both carrying the location and the numbers, not a boolean.

The carry-forward list in `.superpowers/sdd/progress.md` named three debts for this plan: stable ids (Task 1), the `nodeAt` spatial index (Task 2), and station-generation helper consolidation. The third is not here — the duplicated helpers live in `groundProfile`, `volumes` and `networkMesh`, none of which this plan touches, and folding an unrelated refactor into a mutation plan would make every task's diff harder to review. It stays on the ledger.

**Type consistency.** `ClassChangeRejection` is defined in Task 5 and consumed by name in Task 6. `JunctionLeg`'s five fields and `solveJunction`'s two-argument signature are quoted in Task 6's Interfaces block from the current source. `RoadClassName` moves module in Task 5, and Task 6 imports it from its new home.

**One known ordering hazard.** Task 5 moves `roadClass.ts`, which Task 6 imports from the new path. A reviewer reading Task 6 before Task 5 will see an import from a file that does not yet exist. That is the plan's order, not an error.
