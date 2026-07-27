# Selection and Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Click a road you already built and delete it, split it, or upgrade it — and be told in plain words when you cannot.

**Architecture:** The three verbs already exist on the network and are already gated by real engineering checks. What is missing is a way to point at a road and invoke them, and a way to see why an upgrade was refused. Selection and the edit actions go in a pure tool alongside `DrawTool`; turning a refusal into a sentence is a separate pure module, because the interesting part of a message is the numbers it carries and that is worth testing. The scene keeps only the one-line glue.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), vitest 4, three.js. No new dependencies.

## Global Constraints

- **Dependency direction:** `geometry/` imports nothing outside itself. `terrain/` imports `geometry/`. `network/` imports `geometry/`, `terrain/groundProfile` and its own `roadClass`. `mesh/` imports `geometry/`, `terrain/` and `network/`. `tool/` imports `geometry/`, `terrain/`, `network/` and `mesh/`. `render/` imports `mesh/`, `tool/` and three.js. `debug/` may import anything.
- **`src/geometry/`, `src/terrain/`, `src/network/`, `src/mesh/` and `src/tool/` must NOT import three.js.** `src/render/cameraRig.ts` also must not, deliberately.
- Coordinates `(x, y)` in metres with `y` north; `z` positive up. Handedness conversion only in `render/` and the debug scene.
- **Report rather than approximate.** A failure carries enough detail to act on — not a boolean, not a bare string, and never silence. Existing channels: `continuityBreaks`, `truncatedStations`, `infeasibleJunctions`, `elevationMismatches`, `tightCrossings`, `infeasibleRoads`, `ClassChangeRejection`, `UpgradeObstacle`, `PolylineRejection`.
- **TypeScript** `strict: true`, `noUncheckedIndexedAccess: true`. No `any`. No non-null assertion on a value that could genuinely be absent.
- **Tests must discriminate.** This branch's predecessor had four tests that passed against implementations with the property they tested deleted. Every behavioural test here must be checked by removing the code it covers and confirming it fails. That check is part of the task, not an extra.
- Tests colocate with source as `<name>.test.ts`. Run the suite with `npm test`, types with `npx tsc --noEmit`. Both clean at every commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/network/roadClass.ts` (modify) | `ROAD_CLASS_ORDER` — the classes as a ladder, so "upgrade" and "downgrade" mean something |
| `src/tool/selectTool.ts` (create) | Holding a selection and invoking delete, split and reclassify against it |
| `src/tool/messages.ts` (create) | Turning every rejection this project produces into a sentence with its numbers in it |
| `src/debug/roadScene.ts` (modify) | Mode switching, the selection highlight, the message element, key bindings, rebuild |

---

### Task 1: Selection and the three verbs

`removeRoad`, `splitRoad` and `setRoadClass` all exist and are tested. `checkUpgrade` already reports which curve is too tight and which junction stops solving. This task is the thing that points at a road and calls them.

One design point carries the task: **a selection is an identifier, and the road behind it can disappear without the tool being told.** Drawing a new road that lands on the selected one splits it, which deletes it and creates two halves with different identifiers. So `selected` cannot be a stored value handed back verbatim — it has to be checked against the network every time it is read.

**Files:**
- Modify: `src/network/roadClass.ts`
- Create: `src/tool/selectTool.ts`
- Create: `src/tool/selectTool.test.ts`

**Interfaces:**
- Consumes: `RoadNetwork`, `RoadId`, `NodeId` from `src/network/graph`; `roadsAt` from `src/tool/snap`; `checkUpgrade`, `UpgradeObstacle` from `src/mesh/upgradeCheck`; `RoadClassName`, and the new `ROAD_CLASS_ORDER`, from `src/network/roadClass`; `Vec2` from `src/geometry/vec2`.
- Produces: `class SelectTool`, `PICK_RADIUS`, and the three outcome types below.

- [ ] **Step 1: Add the class ladder**

In `src/network/roadClass.ts`:

```ts
/**
 * The classes in ascending order of capacity.
 *
 * A ladder rather than a set, because "upgrade" and "downgrade" have to mean
 * a step, and the order is a design statement — gravel lane to rural two-lane
 * to arterial to divided highway — not something derivable from lane counts,
 * which could coincide.
 */
export const ROAD_CLASS_ORDER: readonly RoadClassName[] = [
  'gravel',
  'rural',
  'arterial',
  'highway',
]
```

- [ ] **Step 2: Write the failing tests**

Create `src/tool/selectTool.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { RoadNetwork } from '../network/graph'
import { SelectTool } from './selectTool'

const straight = (x: number, y: number, heading: number, length: number) =>
  new Alignment([new Line({ x, y }, heading, length)])

describe('SelectTool', () => {
  it('starts with nothing selected', () => {
    expect(new SelectTool(new RoadNetwork()).selected).toBeUndefined()
  })

  it('selects a road near the given position', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 200), 'rural')
    const tool = new SelectTool(net)

    expect(tool.select({ x: 100, y: 3 })).toBe(id)
    expect(tool.selected).toBe(id)
  })

  it('selects nothing when the position is away from every road', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 200), 'rural')
    const tool = new SelectTool(net)

    expect(tool.select({ x: 1000, y: 1000 })).toBeUndefined()
    expect(tool.selected).toBeUndefined()
  })

  it('clears an existing selection when nothing is under the new position', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 200), 'rural')
    const tool = new SelectTool(net)

    tool.select({ x: 100, y: 0 })
    tool.select({ x: 1000, y: 1000 })
    expect(tool.selected).toBeUndefined()
  })

  it('picks the nearer of two roads', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 200), 'rural')
    const near = net.addRoad(straight(0, 40, 0, 200), 'rural')
    const tool = new SelectTool(net)

    expect(tool.select({ x: 100, y: 36 })).toBe(near)
  })

  it('forgets a selection whose road has been removed by something else', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 400), 'rural')
    const tool = new SelectTool(net)
    tool.select({ x: 200, y: 0 })
    expect(tool.selected).toBe(id)

    // A road drawn onto this one would split it, which removes it and creates
    // two halves with new identifiers. The tool is never told.
    net.splitRoad(id, 200)

    expect(tool.selected).toBeUndefined()
  })

  it('keeps a selection when a different road is removed', () => {
    const net = new RoadNetwork()
    const keep = net.addRoad(straight(0, 0, 0, 200), 'rural')
    const other = net.addRoad(straight(0, 500, 0, 200), 'rural')
    const tool = new SelectTool(net)
    tool.select({ x: 100, y: 0 })

    net.removeRoad(other)

    expect(tool.selected).toBe(keep)
  })

  describe('deleteSelected', () => {
    it('removes the road and drops the selection', () => {
      const net = new RoadNetwork()
      const id = net.addRoad(straight(0, 0, 0, 200), 'rural')
      const tool = new SelectTool(net)
      tool.select({ x: 100, y: 0 })

      expect(tool.deleteSelected()).toEqual({ ok: true, roadId: id })
      expect(net.roads).toHaveLength(0)
      expect(tool.selected).toBeUndefined()
    })

    it('reports rather than throwing when nothing is selected', () => {
      const tool = new SelectTool(new RoadNetwork())
      expect(tool.deleteSelected()).toEqual({ ok: false, reason: 'nothing-selected' })
    })
  })

  describe('splitSelectedAt', () => {
    it('divides the road and drops the selection', () => {
      const net = new RoadNetwork()
      const id = net.addRoad(straight(0, 0, 0, 400), 'rural')
      const tool = new SelectTool(net)
      tool.select({ x: 200, y: 0 })

      const result = tool.splitSelectedAt({ x: 150, y: 2 })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(net.roads).toHaveLength(2)
      expect(() => net.road(id)).toThrow(RangeError)
      expect(net.road(result.first).alignment.length).toBeCloseTo(150, 1)
      // Both halves are new roads; neither is what was selected.
      expect(tool.selected).toBeUndefined()
    })

    it('reports rather than throwing when nothing is selected', () => {
      const tool = new SelectTool(new RoadNetwork())
      expect(tool.splitSelectedAt({ x: 0, y: 0 })).toEqual({
        ok: false,
        reason: 'nothing-selected',
      })
    })

    it('refuses a position that is not on the selected road', () => {
      const net = new RoadNetwork()
      net.addRoad(straight(0, 0, 0, 400), 'rural')
      const tool = new SelectTool(net)
      tool.select({ x: 200, y: 0 })

      const result = tool.splitSelectedAt({ x: 200, y: 900 })
      expect(result).toEqual({ ok: false, reason: 'not-on-the-selected-road' })
      expect(net.roads).toHaveLength(1)
    })

    it('refuses a position too near an end to divide', () => {
      const net = new RoadNetwork()
      net.addRoad(straight(0, 0, 0, 400), 'rural')
      const tool = new SelectTool(net)
      tool.select({ x: 200, y: 0 })

      const result = tool.splitSelectedAt({ x: 0.2, y: 0 })
      expect(result).toEqual({ ok: false, reason: 'too-near-an-end' })
      expect(net.roads).toHaveLength(1)
    })
  })

  describe('reclassifySelected', () => {
    it('changes the class when the geometry permits', () => {
      const net = new RoadNetwork()
      const id = net.addRoad(straight(0, 0, 0, 400), 'gravel')
      const tool = new SelectTool(net)
      tool.select({ x: 200, y: 0 })

      const result = tool.reclassifySelected('highway')
      expect(result).toEqual({ ok: true, roadId: id, from: 'gravel', to: 'highway' })
      expect(net.road(id).className).toBe('highway')
      // The road survives, so the selection does too.
      expect(tool.selected).toBe(id)
    })

    it('refuses when the road\'s own curves are too tight, and says why', () => {
      const net = new RoadNetwork()
      // A tight arc: legal for gravel, not for a highway's design speed.
      const { Arc } = await import('../geometry/primitives')
      const id = net.addRoad(new Alignment([new Arc({ x: 0, y: 0 }, 0, 200, 1 / 30)]), 'gravel')
      const tool = new SelectTool(net)
      tool.select(net.road(id).alignment.poseAt(100).position)

      const result = tool.reclassifySelected('highway')
      expect(result.ok).toBe(false)
      if (result.ok || result.reason !== 'not-permitted') return
      expect(result.obstacles.some((o) => o.kind === 'alignment')).toBe(true)
      // And nothing changed.
      expect(net.road(id).className).toBe('gravel')
    })

    it('reports rather than throwing when nothing is selected', () => {
      const tool = new SelectTool(new RoadNetwork())
      expect(tool.reclassifySelected('rural')).toEqual({
        ok: false,
        reason: 'nothing-selected',
      })
    })
  })

  describe('classStep', () => {
    it('names the class one step up and one step down', () => {
      const net = new RoadNetwork()
      net.addRoad(straight(0, 0, 0, 200), 'rural')
      const tool = new SelectTool(net)
      tool.select({ x: 100, y: 0 })

      expect(tool.classStep(1)).toBe('arterial')
      expect(tool.classStep(-1)).toBe('gravel')
    })

    it('has nothing above the top or below the bottom', () => {
      const net = new RoadNetwork()
      net.addRoad(straight(0, 0, 0, 200), 'highway')
      net.addRoad(straight(0, 500, 0, 200), 'gravel')
      const tool = new SelectTool(net)

      tool.select({ x: 100, y: 0 })
      expect(tool.classStep(1)).toBeUndefined()

      tool.select({ x: 100, y: 500 })
      expect(tool.classStep(-1)).toBeUndefined()
    })

    it('names nothing when nothing is selected', () => {
      expect(new SelectTool(new RoadNetwork()).classStep(1)).toBeUndefined()
    })
  })
})
```

The two tests that carry this task are "forgets a selection whose road has been removed by something else" and "keeps a selection when a different road is removed". Together they pin the exact behaviour a stored identifier gets wrong in one direction and an over-eager invalidation gets wrong in the other.

Note the `await import` inside a non-async test above will not compile — import `Arc` at the top of the file with the others and delete that line. It is left visible here so the implementer does not silently inherit a mistake.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/tool/selectTool.test.ts`

Expected: FAIL — cannot resolve `./selectTool`.

- [ ] **Step 4: Implement the tool**

Create `src/tool/selectTool.ts`:

```ts
import type { Vec2 } from '../geometry/vec2'
import { NODE_SNAP_DISTANCE, type RoadId, type RoadNetwork } from '../network/graph'
import { ROAD_CLASS_ORDER, type RoadClassName } from '../network/roadClass'
import type { NodeId } from '../network/graph'
import { type UpgradeObstacle, checkUpgrade } from '../mesh/upgradeCheck'
import { roadsAt } from './snap'

export type DeleteOutcome =
  | { readonly ok: true; readonly roadId: RoadId }
  | { readonly ok: false; readonly reason: 'nothing-selected' }

export type SplitOutcome =
  | {
      readonly ok: true
      readonly first: RoadId
      readonly second: RoadId
      readonly node: NodeId
    }
  | {
      readonly ok: false
      readonly reason: 'nothing-selected' | 'not-on-the-selected-road' | 'too-near-an-end'
    }

export type ReclassifyOutcome =
  | {
      readonly ok: true
      readonly roadId: RoadId
      readonly from: RoadClassName
      readonly to: RoadClassName
    }
  | { readonly ok: false; readonly reason: 'nothing-selected' }
  | {
      readonly ok: false
      readonly reason: 'not-permitted'
      readonly obstacles: readonly UpgradeObstacle[]
    }

/**
 * How far from a click a road may be and still be picked, metres.
 *
 * Wider than the drawing tool's snap radius: picking is a coarser gesture than
 * placing, and a road missed by a click reads as the tool ignoring you.
 */
export const PICK_RADIUS = 20

/**
 * A selected road, and the three things you can do to one.
 *
 * Holds an identifier rather than a road, and re-checks it on every read. A
 * selection can be invalidated by something the tool never hears about: a road
 * drawn onto the selected one splits it, which removes it and creates two
 * halves with new identifiers. A stored road object would go on describing
 * geometry that is no longer in the network.
 */
export class SelectTool {
  private selectedId: RoadId | undefined

  constructor(private readonly network: RoadNetwork) {}

  /** The selected road, if it still exists. */
  get selected(): RoadId | undefined {
    if (this.selectedId === undefined) return undefined
    // Cheaper and clearer than catching what `road()` throws.
    const exists = this.network.roads.some((r) => r.id === this.selectedId)
    if (!exists) this.selectedId = undefined
    return this.selectedId
  }

  /** Select the nearest road to a position, or clear if there is none. */
  select(position: Vec2): RoadId | undefined {
    const candidates = roadsAt(this.network, position, PICK_RADIUS)
    let best: { roadId: RoadId; distance: number } | undefined
    for (const candidate of candidates) {
      const pose = this.network.road(candidate.roadId).alignment.poseAt(candidate.station)
      const distance = Math.hypot(
        pose.position.x - position.x,
        pose.position.y - position.y,
      )
      if (!best || distance < best.distance) best = { roadId: candidate.roadId, distance }
    }

    this.selectedId = best?.roadId
    return this.selectedId
  }

  clear(): void {
    this.selectedId = undefined
  }

  deleteSelected(): DeleteOutcome {
    const roadId = this.selected
    if (roadId === undefined) return { ok: false, reason: 'nothing-selected' }

    this.network.removeRoad(roadId)
    this.selectedId = undefined
    return { ok: true, roadId }
  }

  /**
   * Divide the selected road at whichever of its stations is nearest a position.
   *
   * The selection does not survive: both halves are new roads, and silently
   * moving the selection to one of them would be a guess about which half the
   * player meant.
   */
  splitSelectedAt(position: Vec2): SplitOutcome {
    const roadId = this.selected
    if (roadId === undefined) return { ok: false, reason: 'nothing-selected' }

    const here = roadsAt(this.network, position, PICK_RADIUS).find(
      (c) => c.roadId === roadId,
    )
    if (!here) return { ok: false, reason: 'not-on-the-selected-road' }

    // `splitRoad` throws for a station this close to an end. Check rather than
    // catch, so a genuine error is not swallowed with the expected one.
    const { length } = this.network.road(roadId).alignment
    if (here.station <= NODE_SNAP_DISTANCE || here.station >= length - NODE_SNAP_DISTANCE) {
      return { ok: false, reason: 'too-near-an-end' }
    }

    const { first, second, node } = this.network.splitRoad(roadId, here.station)
    this.selectedId = undefined
    return { ok: true, first, second, node }
  }

  /**
   * Change the selected road's class, if its geometry and junctions allow.
   *
   * The check runs first and the mutation only follows a clean result, so a
   * refused upgrade leaves the network exactly as it was.
   */
  reclassifySelected(to: RoadClassName): ReclassifyOutcome {
    const roadId = this.selected
    if (roadId === undefined) return { ok: false, reason: 'nothing-selected' }

    const from = this.network.road(roadId).className
    const check = checkUpgrade(this.network, roadId, to)
    if (!check.ok) {
      return { ok: false, reason: 'not-permitted', obstacles: check.obstacles }
    }

    this.network.setRoadClass(roadId, to)
    return { ok: true, roadId, from, to }
  }

  /** The class one step up (1) or down (-1) the ladder, if there is one. */
  classStep(direction: 1 | -1): RoadClassName | undefined {
    const roadId = this.selected
    if (roadId === undefined) return undefined

    const current = this.network.road(roadId).className
    const index = ROAD_CLASS_ORDER.indexOf(current)
    return ROAD_CLASS_ORDER[index + direction]
  }
}
```

`ROAD_CLASS_ORDER[index + direction]` is `RoadClassName | undefined` under `noUncheckedIndexedAccess`, which is exactly the return type — the out-of-range cases at both ends need no explicit guard. A negative index also yields `undefined` from an array, so stepping below the bottom is covered by the same expression.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/tool/selectTool.test.ts`

Expected: PASS.

- [ ] **Step 6: Confirm the tests discriminate**

For each of these, make the change, run the file, confirm a failure, and revert:

- Make `selected` return `this.selectedId` without checking existence. "Forgets a selection whose road has been removed" must fail.
- Make `selected` return `undefined` whenever any road has been removed since selection. "Keeps a selection when a different road is removed" must fail.
- Make `select` return the first candidate rather than the nearest. "Picks the nearer of two roads" must fail.
- Make `reclassifySelected` skip `checkUpgrade` and mutate unconditionally. "Refuses when the road's own curves are too tight" must fail.
- Remove the near-an-end guard in `splitSelectedAt`. "Refuses a position too near an end" must fail — with a `RangeError` escaping, which is the point of checking rather than catching.

Record each outcome in your report. A test that survives its own mutation is a defect to fix before this task is done.

- [ ] **Step 7: Run everything, check types and commit**

Run: `npm test` then `npx tsc --noEmit`

```bash
git add src/network/roadClass.ts src/tool/selectTool.ts src/tool/selectTool.test.ts
git commit -m "feat: select a road and delete, split or reclassify it"
```

---

### Task 2: Saying why, in words

Every refusal in this project carries its numbers. None of them carries a sentence, so the scene currently logs objects to the console and a player sees nothing.

This task turns each rejection into a line of English with its numbers in it. It is pure and testable, which matters: the interesting part of a message is whether it names the right station and the right radius, and that is exactly the kind of thing that silently goes wrong.

**Files:**
- Create: `src/tool/messages.ts`
- Create: `src/tool/messages.test.ts`

**Interfaces:**
- Consumes: `PolylineRejection` from `src/geometry/polyline`; `UpgradeObstacle` from `src/mesh/upgradeCheck`; `RoadId` from `src/network/graph`; the outcome types from `src/tool/selectTool`.
- Produces: `describePolylineRejection`, `describeUpgradeObstacle`, `describeUpgradeObstacles`, `describeSplitOutcome`, `describeInfeasibleRoads`.

- [ ] **Step 1: Write the failing tests**

Create `src/tool/messages.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  describeInfeasibleRoads,
  describePolylineRejection,
  describeSplitOutcome,
  describeUpgradeObstacle,
  describeUpgradeObstacles,
} from './messages'

describe('describePolylineRejection', () => {
  it('explains too few points', () => {
    expect(describePolylineRejection({ reason: 'too-few-points' })).toMatch(/two points/i)
  })

  it('names the corner that is too sharp', () => {
    const message = describePolylineRejection({ reason: 'corner-too-sharp', index: 3 })
    expect(message).toMatch(/corner/i)
    // Points are numbered from one for a player, not from zero.
    expect(message).toContain('4')
  })

  it('gives both lengths when curves overlap', () => {
    const message = describePolylineRejection({
      reason: 'curves-overlap',
      index: 1,
      required: 100,
      available: 60,
    })
    expect(message).toContain('100')
    expect(message).toContain('60')
  })

  it('gives the length and the limit when a segment is too short', () => {
    const message = describePolylineRejection({
      reason: 'segment-too-short',
      index: 0,
      length: 4.2,
      limit: 7,
    })
    expect(message).toContain('4.2')
    expect(message).toContain('7')
  })
})

describe('describeUpgradeObstacle', () => {
  it('gives the station and both radii for a curve that is too tight', () => {
    const message = describeUpgradeObstacle({
      kind: 'alignment',
      rejection: {
        reason: 'curve-too-tight',
        station: 240,
        actualRadius: 85.5,
        requiredRadius: 394.2,
      },
    })
    expect(message).toContain('240')
    expect(message).toContain('85.5')
    expect(message).toContain('394')
  })

  it('gives the trim and the limit for a junction that cannot be pulled back far enough', () => {
    const message = describeUpgradeObstacle({
      kind: 'junction',
      nodeId: 7,
      reason: 'trim-too-long',
      worstTrim: 91.3,
      maxTrim: 60,
      worstLegs: [],
    })
    expect(message).toContain('91.3')
    expect(message).toContain('60')
  })

  it('explains near-parallel legs without inventing numbers', () => {
    const message = describeUpgradeObstacle({
      kind: 'junction',
      nodeId: 2,
      reason: 'near-parallel-legs',
    })
    expect(message).toMatch(/parallel/i)
    expect(message).not.toMatch(/NaN|undefined/)
  })

  it('explains too few legs', () => {
    const message = describeUpgradeObstacle({
      kind: 'junction',
      nodeId: 2,
      reason: 'too-few-legs',
    })
    expect(message).not.toMatch(/NaN|undefined/)
  })
})

describe('describeUpgradeObstacles', () => {
  it('reports every obstacle, not just the first', () => {
    const message = describeUpgradeObstacles([
      {
        kind: 'alignment',
        rejection: {
          reason: 'curve-too-tight',
          station: 10,
          actualRadius: 20,
          requiredRadius: 400,
        },
      },
      { kind: 'junction', nodeId: 3, reason: 'near-parallel-legs' },
    ])
    expect(message).toMatch(/curve/i)
    expect(message).toMatch(/parallel/i)
  })

  it('says nothing useful is wrong for an empty list', () => {
    expect(describeUpgradeObstacles([])).toBe('')
  })
})

describe('describeSplitOutcome', () => {
  it('explains each refusal', () => {
    expect(describeSplitOutcome({ ok: false, reason: 'nothing-selected' })).toMatch(/select/i)
    expect(describeSplitOutcome({ ok: false, reason: 'not-on-the-selected-road' })).toMatch(
      /road/i,
    )
    expect(describeSplitOutcome({ ok: false, reason: 'too-near-an-end' })).toMatch(/end/i)
  })

  it('confirms a successful split', () => {
    const message = describeSplitOutcome({ ok: true, first: 1, second: 2, node: 3 })
    expect(message).toMatch(/split/i)
  })
})

describe('describeInfeasibleRoads', () => {
  it('is empty when every road solved', () => {
    expect(describeInfeasibleRoads(new Map())).toBe('')
  })

  it('names how many roads failed and where the first one gave up', () => {
    const message = describeInfeasibleRoads(new Map([[4, 132.5]]))
    expect(message).toMatch(/grade|gradient|vertical/i)
    expect(message).toContain('132.5')
  })

  it('counts several failures', () => {
    const message = describeInfeasibleRoads(
      new Map([
        [4, 10],
        [9, 20],
      ]),
    )
    expect(message).toContain('2')
  })
})
```

Every test here asserts a *number* appears, not a phrase. That is deliberate: the wording is free to change, and a test that pins prose becomes an obstacle. What must not change is that a player is told the actual station, the actual radius and the actual limit — the whole point of `ClassChangeRejection` carrying them.

The "points are numbered from one" assertion is the one most likely to catch a real mistake. Indices are zero-based everywhere in the code and one-based everywhere a person counts.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tool/messages.test.ts`

Expected: FAIL — cannot resolve `./messages`.

- [ ] **Step 3: Implement**

Create `src/tool/messages.ts`. Write the bodies yourself — the shapes below are the contract, and the wording is yours:

```ts
import type { PolylineRejection } from '../geometry/polyline'
import type { RoadId } from '../network/graph'
import type { UpgradeObstacle } from '../mesh/upgradeCheck'
import type { SplitOutcome } from './selectTool'

export const describePolylineRejection: (rejection: PolylineRejection) => string
export const describeUpgradeObstacle: (obstacle: UpgradeObstacle) => string
export const describeUpgradeObstacles: (obstacles: readonly UpgradeObstacle[]) => string
export const describeSplitOutcome: (outcome: SplitOutcome) => string
export const describeInfeasibleRoads: (
  infeasible: ReadonlyMap<RoadId, number>,
) => string
```

Rules the tests enforce and the prose must respect:

- Report every obstacle, never only the first. A player told to fix one problem, who fixes it and is immediately told of another, stops trusting the tool.
- Number points from one. Indices are zero-based in code and one-based to a person.
- Round distances to one decimal place. Metres to the millimetre are noise, and an unrounded float in a sentence looks broken.
- Never emit `NaN` or `undefined`. The obstacle union has variants that carry no numbers; those get a sentence without any.
- Return the empty string for "nothing to say", so a caller can test truthiness rather than compare against a sentinel.

- [ ] **Step 4: Run the tests, then confirm they discriminate**

Run: `npx vitest run src/tool/messages.test.ts`

Then verify: make `describeUpgradeObstacles` return only the first obstacle's sentence, and confirm "reports every obstacle, not just the first" fails. Make the point numbering zero-based, and confirm "names the corner that is too sharp" fails. Revert both, and record the outcomes.

- [ ] **Step 5: Run everything, check types and commit**

Run: `npm test` then `npx tsc --noEmit`

```bash
git add src/tool/messages.ts src/tool/messages.test.ts
git commit -m "feat: turn every rejection into a sentence with its numbers"
```

---

### Task 3: Wire selection into the scene

Two modes, a highlight, a message line, and the keys that invoke the verbs.

This is the task with no unit tests, and on the previous branch that is where nearly every defect lived. Read `src/debug/roadScene.ts` fully before changing it, and be suspicious of the event-handling paths in particular.

**Files:**
- Modify: `src/debug/roadScene.ts`
- Test: `src/debug/roadScene.test.ts` where a change is testable without a renderer

**Interfaces:**
- Consumes: `SelectTool`, `PICK_RADIUS` from `src/tool/selectTool`; the five `describe*` functions from `src/tool/messages`; the existing `DrawTool`, `rebuildNetworkMeshes`, `solveNetwork` and picking machinery already in the scene.
- Produces: no new exported API. `drawRoadScene` keeps its signature.

- [ ] **Step 1: Add a mode**

Two modes: **draw** and **select**. Tab switches between them. Switching cancels anything pending in the mode being left — a half-drawn road does not survive a trip into select mode and back.

Show the current mode in the message line, so the tool is never silently in a state the player did not choose.

- [ ] **Step 2: Add the message line**

A single absolutely-positioned `div` over the canvas, appended next to it. Keep it to one element and one line of text; this is not the inspector panel, which is a later plan. Set its text from the `describe*` functions.

Give it a distinct look when the message is a refusal rather than a confirmation.

Remove the element in the teardown the scene already returns, alongside the disposal that is already there.

- [ ] **Step 3: Show `infeasibleRoads` in it**

`solveNetwork` already reports roads with no feasible vertical alignment, and the previous branch left that reaching only the console — a road that exists in the graph and draws nothing, with no on-screen indication. Feed `describeInfeasibleRoads` into the message line after every rebuild so it is visible.

- [ ] **Step 4: Select on click in select mode**

In select mode, a left click picks a road at the pointer's ground position via `SelectTool.select`. Clicking away from every road clears the selection.

Reuse the existing pointer-to-ground machinery. Do not add a second path — the branch already has one, and two would drift.

- [ ] **Step 5: Highlight the selection**

Draw the selected road's centreline as a bright line above the surface, the way the draw preview already is. Rebuild it when the selection changes, and dispose the previous one — the previous branch leaked geometry in exactly this pattern until it was caught.

Clear the highlight when the selection is cleared, and when the selected road stops existing. Note `SelectTool.selected` already returns `undefined` in that case, so read it rather than caching.

- [ ] **Step 6: Bind the verbs**

In select mode, with a road selected:

- **Delete** or **Backspace** — `deleteSelected`, then rebuild.
- **S** — `splitSelectedAt` the current pointer position, then rebuild.
- **`]`** — `reclassifySelected(classStep(1))`, then rebuild. Do nothing if `classStep` returns `undefined`.
- **`[`** — `reclassifySelected(classStep(-1))`, then rebuild.

Every outcome goes to the message line through the `describe*` functions, success and failure alike. A refused upgrade must say which curve or which junction, with its numbers.

Note Backspace already means "undo the last point" in draw mode. Keep them separate by mode.

- [ ] **Step 7: Rebuild after every mutation**

Delete, split and reclassify all change the network, and reclassify changes a road's width, which changes its corridor, its earthworks and every junction it touches. The scene already has `rebuildNetworkMeshes`; call it.

- [ ] **Step 8: Extend what can be tested without a renderer**

`src/debug/roadScene.test.ts` exercises `buildSceneContent` and `solveNetwork` directly. Add a test that a network mutated the way select mode mutates it — a road removed, a road reclassified — re-solves and rebuilds without error, and that a reclassified road's mesh reflects its new width.

Do not attempt to test the event handlers; they need a canvas and a GPU, and the logic they call is covered.

- [ ] **Step 9: Verify by using it**

Run: `npm run dev`

Open **`http://localhost:5173/chainage/`** — the base path is `/chainage/`; the bare root returns a redirect and a blank page.

Confirm, and report each one honestly. If you cannot exercise something, say so rather than claiming it:

1. Tab switches modes and the message line says which one you are in.
2. Clicking a road in select mode highlights it; clicking away clears it.
3. Delete removes the selected road, and the junction it left behind re-solves — the remaining roads' ends are still correct.
4. `]` upgrades a road: it visibly widens, and its earthworks change with it.
5. `[` downgrades it again.
6. Upgrading a road with a tight curve is refused, and the message line names the station and both radii.
7. **S** splits the selected road at the pointer, and the two halves behave as separate roads afterwards.
8. Switching to draw mode and back does not leave a stale highlight or a stale preview.
9. A road drawn onto the selected road clears the selection rather than highlighting something that no longer exists.

Note that some embedded browser panes report `document.hidden` as true, which stalls `requestAnimationFrame` so nothing re-renders past the first frame. If you hit that, say so plainly and verify what you can programmatically instead.

- [ ] **Step 10: Commit**

```bash
git add src/debug/roadScene.ts src/debug/roadScene.test.ts
git commit -m "feat: select, delete, split and upgrade roads in the scene"
```

---

## Deliberately not in this plan

- **The inspector panel.** One line of text is not it. Live readouts of radius and design speed while drawing, and a panel describing the selected road, are their own plan.
- **The tilt-shift diorama look.** Next.
- **Undo.** Delete is irreversible in this plan. Real undo needs a command history over the network, which is a design in its own right and touches every verb.
- **Multi-selection.**
- **Dragging a node to move it.** The graph has no `moveNode`, and adding one means re-solving every alignment that ends there.
- **§4.1's ~100m maximum segment length.** The spec says to *subdivide* longer runs, and "segment" most likely means the network edge — so this is a decision about routing granularity, and it belongs with the traffic plan whose pathfinding is the stated reason for the bound.
- **§4.1's snap arbitration model** — a priority score with a hard tier and a soft score decaying with displacement, and a visible indication of which snap fired. The current nearest-wins with node-over-road precedence satisfies "one snap wins" and "snapping is idempotent" but not "show which snap fired", which needs the guide line and readout the inspector plan will build.

---

## Self-Review

**Spec coverage.** §4.7 says upgrading in place is a first-class verb and that an upgrade which cannot be built must say so and say why. Task 1 invokes it; Task 2 is the "say why". The four consequences §4.7 lists are now all reachable: the road gets wider (Task 3 rebuilds through `solveNetwork`, which regenerates the corridor), every junction re-solves (`checkUpgrade` before, `rebuildNetworkMeshes` after), the vertical alignment may become illegal (the horizontal radius rule is checked; true crest and sag K values remain unchecked and are recorded as a gap), and it is construction work rather than an instant swap (still deferred to the construction plan).

**Type consistency.** `SplitOutcome` is defined in Task 1 and consumed by name in Task 2. `UpgradeObstacle`'s junction variant is an intersection with `JunctionObstacleReason`, so a `'trim-too-long'` obstacle carries `worstTrim`, `maxTrim` and `worstLegs` while the other two variants carry none — Task 2's tests cover all three so the union is handled exhaustively rather than by casting.

**One deliberate omission I want a reviewer to challenge if they disagree.** `splitSelectedAt` clears the selection rather than moving it to one of the halves. Moving it would be a guess about which half the player meant, and guessing wrong is worse than asking again — but if the interaction feels wrong in Step 9, say so rather than leaving it because the plan said to.

**One thing I could not verify while writing this.** Task 1's `select` recomputes each candidate's distance by sampling the pose at the station `roadsAt` returned. If `roadsAt` already returns a distance, use it rather than recomputing — check the real signature before writing that loop, and say in your report which you found.
