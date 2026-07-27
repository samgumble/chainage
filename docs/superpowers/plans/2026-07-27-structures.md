# Chainage — Structures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the three structure types geometry — retaining walls where a batter has no room, bridges where the design line stands too high above ground to fill, and overpasses where one road crosses another.

**Architecture:** `src/mesh/structures/` produces plain typed arrays like the rest of `src/mesh/`. Two triggers already exist and are unused: `retainingWall()` in the terrain layer reports where a wall stands and how tall, and `classifySupport()` reports which stations need a structure rather than earth. This plan turns both into meshes, and adds the third trigger — road-over-road crossings — which needs the network graph.

**Tech Stack:** TypeScript (strict), Vitest. No three.js below `src/render/`.

## The three triggers, and where each already comes from

| Structure | Trigger | Already computed by |
|---|---|---|
| Retaining wall | The batter has no room to reach natural ground | `retainingWall()` in `src/terrain/corridor.ts` |
| Bridge | The design line stands higher above ground than fill can economically reach | `classifySupport()` in `src/terrain/gradeSolver.ts` |
| Overpass | The alignment crosses another road and must clear it | **Nothing yet — Tasks 4 and 5 add it** |

Both existing triggers have been built, tested, and consumed by nothing. This plan is where they finally do something.

## Global Constraints

- **Dependency direction, one way only:** `geometry/` imports nothing. `terrain/` imports `geometry/`. `network/` imports `geometry/` plus a type-only import of `RoadClassName`. `mesh/` imports `geometry/`, `terrain/` and `network/`. `render/` imports `mesh/` and three.js. `debug/` may import anything.
- **`src/mesh/` and `src/network/` must NOT import three.js.** They produce plain `Float32Array` / `Uint32Array`.
- **Coordinates:** `(x, y)` metres, `y` north; `z` elevation positive up. The handedness conversion happens only inside `src/render/` and the debug scene.
- **`SectionPoint.offset` is negative to the left** of travel; `leftNormal(heading)` points left, so offsets are negated when placing vertices.
- **Winding must agree with normals.** A counter-clockwise face with an upward normal is a front face. This has been got wrong twice in this project — once in the road ribbon, once in the junction plate — and both times the catching test computed the face normal from vertex positions and compared it against the stored normal. Every mesh in this plan gets that test.
- **Report rather than approximate.** The project has four channels for this already — `continuityBreaks`, `truncatedStations`, `infeasibleJunctions`, `elevationMismatches`. A structure that cannot be built correctly is reported, never approximated.
- **TypeScript:** `strict: true`, `noUncheckedIndexedAccess: true`.
- **Float comparison in tests:** `toBeCloseTo` precision 9 for exact-form math, precision 4 for swept or sampled results.
- **Commits:** conventional commit prefixes.

## Existing interfaces this plan builds on

All merged, 381 tests passing.

```ts
// src/geometry/vec2.ts
type Vec2 = { readonly x: number; readonly y: number }
const vec2, add, sub, scale, dot, cross, length, distance, normalize: /* ... */
const fromAngle: (radians: number) => Vec2
const angleOf: (a: Vec2) => number
const leftNormal: (heading: number) => Vec2     // transverse, left of travel
const normalizeAngle: (radians: number) => number

// src/geometry/alignment.ts
class Alignment {
  readonly length: number
  get isEmpty(): boolean
  poseAt(s: number): Pose          // Pose has s, position, heading, curvature
  sample(spacing: number): Pose[]
}

// src/terrain/heightmap.ts
type TerrainSampler = { sample(x: number, y: number): number }

// src/terrain/groundProfile.ts
type ProfilePoint = { readonly s: number; readonly z: number }
const sampleGroundProfile: (a: Alignment, t: TerrainSampler, spacing: number) => ProfilePoint[]
const designElevationAtStation: (profile: readonly ProfilePoint[], s: number) => number

// src/terrain/gradeSolver.ts
type StationSupport = 'earthwork' | 'structure'
const classifySupport: (
  ground: readonly ProfilePoint[], design: readonly ProfilePoint[], maxFillHeight: number,
) => StationSupport[]

// src/terrain/corridor.ts
type CorridorTemplate = {
  readonly formationHalfWidth: number; readonly cutSlope: number
  readonly fillSlope: number; readonly maxBatterWidth?: number
}
const designSurfaceAtOffset: (offset: number, designZ: number, groundZ: number, t: CorridorTemplate) => number
const retainingWall: (
  designZ: number, groundZ: number, t: CorridorTemplate,
) => { readonly offset: number; readonly height: number } | null

// src/mesh/roadClass.ts
const ROAD_CLASSES: Readonly<Record<RoadClassName, RoadClass>>
const formationHalfWidth: (rc: RoadClass) => number
const totalPavementThickness: (rc: RoadClass) => number

// src/mesh/ribbon.ts
type MeshData = {
  readonly positions: Float32Array; readonly normals: Float32Array
  readonly uvs: Float32Array; readonly indices: Uint32Array
  readonly vertexCount: number; readonly triangleCount: number
}

// src/network/graph.ts
class RoadNetwork {
  get roads(): readonly Road[]        // copies
  road(id: RoadId): Road
  isJunction(id: NodeId): boolean
}
type Road = {
  readonly id: RoadId; readonly alignment: Alignment
  readonly className: RoadClassName
  readonly startNode: NodeId; readonly endNode: NodeId
}
```

---

### Task 1: A shared mesh builder

Every structure in this plan is boxes and panels. Writing vertex, normal, UV and index arrays by hand four times over is how winding bugs get in. Build the accumulator once, with the winding rule enforced in one place, and every later task inherits it.

**Files:**
- Create: `src/mesh/meshBuilder.ts`
- Test: `src/mesh/meshBuilder.test.ts`

**Interfaces:**
- Consumes: `Vec2` from `../geometry/vec2`; `MeshData` from `./ribbon`
- Produces:
  - `type Point3 = { readonly x: number; readonly y: number; readonly z: number }`
  - `class MeshBuilder`
    - `addQuad(a: Point3, b: Point3, c: Point3, d: Point3): void` — four corners in counter-clockwise order as seen from the face's front. Emits two triangles and a face normal computed from the corners.
    - `addTriangle(a: Point3, b: Point3, c: Point3): void`
    - `get vertexCount(): number`, `get triangleCount(): number`
    - `build(): MeshData`
  - Vertices are **not** shared between faces — each face gets its own three or four, so face normals stay flat and correct. Structures are boxes; smooth shading would be wrong.
  - UVs are a simple planar projection of `(x, y)` scaled by `UV_METRES_PER_TILE = 4`.

- [ ] **Step 1: Write the failing tests**

`src/mesh/meshBuilder.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

/** A unit square in the z=0 plane, counter-clockwise seen from above. */
const flatQuad = (b: MeshBuilder, z = 0) => {
  b.addQuad(
    { x: 0, y: 0, z }, { x: 1, y: 0, z }, { x: 1, y: 1, z }, { x: 0, y: 1, z },
  )
}

describe('MeshBuilder counts', () => {
  it('starts empty', () => {
    const b = new MeshBuilder()
    expect(b.vertexCount).toBe(0)
    expect(b.triangleCount).toBe(0)
  })

  it('emits four vertices and two triangles per quad', () => {
    const b = new MeshBuilder()
    flatQuad(b)
    expect(b.vertexCount).toBe(4)
    expect(b.triangleCount).toBe(2)
  })

  it('emits three vertices and one triangle per triangle', () => {
    const b = new MeshBuilder()
    b.addTriangle({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })
    expect(b.vertexCount).toBe(3)
    expect(b.triangleCount).toBe(1)
  })

  it('does not share vertices between faces', () => {
    const b = new MeshBuilder()
    flatQuad(b)
    flatQuad(b)
    expect(b.vertexCount).toBe(8)
  })

  it('builds an empty mesh when nothing was added', () => {
    const m = new MeshBuilder().build()
    expect(m.vertexCount).toBe(0)
    expect(m.triangleCount).toBe(0)
    expect(m.positions).toHaveLength(0)
    expect(m.indices).toHaveLength(0)
  })
})

describe('MeshBuilder geometry', () => {
  it('writes the corner positions it was given', () => {
    const b = new MeshBuilder()
    flatQuad(b, 7)
    const m = b.build()
    expect(m.positions[0]).toBeCloseTo(0, 6)
    expect(m.positions[1]).toBeCloseTo(0, 6)
    expect(m.positions[2]).toBeCloseTo(7, 6)
  })

  it('gives an upward normal to a counter-clockwise horizontal quad', () => {
    const b = new MeshBuilder()
    flatQuad(b)
    const m = b.build()
    for (let i = 0; i < m.vertexCount; i++) {
      expect(m.normals[i * 3 + 2]).toBeCloseTo(1, 6)
    }
  })

  it('gives a downward normal when the corners are reversed', () => {
    const b = new MeshBuilder()
    b.addQuad(
      { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 },
    )
    const m = b.build()
    expect(m.normals[2]).toBeCloseTo(-1, 6)
  })

  it('gives a horizontal normal to a vertical quad', () => {
    const b = new MeshBuilder()
    // A wall in the x=0 plane, facing +x.
    b.addQuad(
      { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 1 }, { x: 0, y: 0, z: 1 },
    )
    const m = b.build()
    expect(m.normals[0]).toBeCloseTo(1, 6)
    expect(m.normals[2]).toBeCloseTo(0, 6)
  })

  it('gives unit-length normals', () => {
    const b = new MeshBuilder()
    b.addQuad(
      { x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 1 }, { x: 3, y: 2, z: 4 }, { x: 0, y: 2, z: 3 },
    )
    const m = b.build()
    for (let i = 0; i < m.vertexCount; i++) {
      expect(Math.hypot(m.normals[i * 3]!, m.normals[i * 3 + 1]!, m.normals[i * 3 + 2]!))
        .toBeCloseTo(1, 5)
    }
  })

  it('winds every triangle to agree with its normal', () => {
    const b = new MeshBuilder()
    flatQuad(b)
    b.addQuad(
      { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 1 }, { x: 0, y: 0, z: 1 },
    )
    const m = b.build()
    for (let t = 0; t < m.indices.length; t += 3) {
      const [i, j, k] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!]
      const ax = m.positions[i * 3]!, ay = m.positions[i * 3 + 1]!, az = m.positions[i * 3 + 2]!
      const ux = m.positions[j * 3]! - ax, uy = m.positions[j * 3 + 1]! - ay, uz = m.positions[j * 3 + 2]! - az
      const vx = m.positions[k * 3]! - ax, vy = m.positions[k * 3 + 1]! - ay, vz = m.positions[k * 3 + 2]! - az
      const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx
      const dot = fx * m.normals[i * 3]! + fy * m.normals[i * 3 + 1]! + fz * m.normals[i * 3 + 2]!
      expect(dot).toBeGreaterThan(0)
    }
  })

  it('emits a zero normal rather than NaN for a degenerate face', () => {
    const b = new MeshBuilder()
    const p = { x: 1, y: 1, z: 1 }
    b.addTriangle(p, p, p)
    const m = b.build()
    for (let i = 0; i < 3; i++) {
      expect(Number.isFinite(m.normals[i])).toBe(true)
    }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/mesh/meshBuilder.test.ts
```

Expected: FAIL — `Failed to resolve import "./meshBuilder"`.

- [ ] **Step 3: Write the implementation**

`src/mesh/meshBuilder.ts`:

```ts
import type { MeshData } from './ribbon'

export type Point3 = {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** Metres of world per UV tile. Structures are concrete; the scale is arbitrary but consistent. */
const UV_METRES_PER_TILE = 4

/**
 * Accumulates flat-shaded faces into a mesh.
 *
 * Vertices are never shared between faces — each face carries its own, so its
 * normal is exactly its face normal. Structures are boxes and panels; smooth
 * shading across their edges would be wrong.
 *
 * Winding is enforced in one place. Pass a quad's corners counter-clockwise as
 * seen from the front, and the emitted triangles and normal agree by
 * construction. Getting winding wrong has cost this project two separate bugs
 * — an inside-out road ribbon and an inside-out junction plate — and both were
 * caught only by a test comparing face normals against stored normals. Doing
 * it once here means the later tasks cannot repeat it.
 */
export class MeshBuilder {
  private readonly positions: number[] = []
  private readonly normals: number[] = []
  private readonly uvs: number[] = []
  private readonly indices: number[] = []

  get vertexCount(): number {
    return this.positions.length / 3
  }

  get triangleCount(): number {
    return this.indices.length / 3
  }

  addTriangle(a: Point3, b: Point3, c: Point3): void {
    const base = this.vertexCount
    const normal = faceNormal(a, b, c)
    for (const point of [a, b, c]) this.push(point, normal)
    this.indices.push(base, base + 1, base + 2)
  }

  addQuad(a: Point3, b: Point3, c: Point3, d: Point3): void {
    const base = this.vertexCount
    // The normal comes from the first three corners; a quad is assumed planar
    // enough that the fourth agrees, which is true for every box face here.
    const normal = faceNormal(a, b, c)
    for (const point of [a, b, c, d]) this.push(point, normal)
    this.indices.push(base, base + 1, base + 2)
    this.indices.push(base, base + 2, base + 3)
  }

  build(): MeshData {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      indices: new Uint32Array(this.indices),
      vertexCount: this.vertexCount,
      triangleCount: this.triangleCount,
    }
  }

  private push(point: Point3, normal: Point3): void {
    this.positions.push(point.x, point.y, point.z)
    this.normals.push(normal.x, normal.y, normal.z)
    this.uvs.push(point.x / UV_METRES_PER_TILE, point.y / UV_METRES_PER_TILE)
  }
}

/** (b − a) × (c − a), normalized. Zero for a degenerate face rather than NaN. */
const faceNormal = (a: Point3, b: Point3, c: Point3): Point3 => {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z
  const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z

  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx

  const len = Math.hypot(nx, ny, nz)
  if (len === 0) return { x: 0, y: 0, z: 0 }
  return { x: nx / len, y: ny / len, z: nz / len }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/mesh/meshBuilder.test.ts
```

Expected: PASS, 13 tests.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/mesh/meshBuilder.ts src/mesh/meshBuilder.test.ts
git commit -m "feat: add flat-shaded mesh builder with winding enforced once"
```

---

### Task 2: Retaining wall geometry

The terrain layer already reports where a wall stands and how tall. Turn that into panels running along the alignment.

**Files:**
- Create: `src/mesh/structures/retainingWallMesh.ts`
- Test: `src/mesh/structures/retainingWallMesh.test.ts`

**Interfaces:**
- Consumes: `Alignment`; `leftNormal`, `add`, `scale` from `../../geometry/vec2`; `ProfilePoint`, `designElevationAtStation` from `../../terrain/groundProfile`; `TerrainSampler`; `CorridorTemplate`, `retainingWall`, `designSurfaceAtOffset` from `../../terrain/corridor`; `MeshBuilder` from `../meshBuilder`; `MeshData` from `../ribbon`
- Produces:
  - `type WallSegment = { readonly s: number; readonly side: 'left' | 'right'; readonly offset: number; readonly topZ: number; readonly bottomZ: number }`
  - `wallSegments(alignment, terrain, design, template, spacing?): WallSegment[]` — `spacing` defaults to 4 metres. One entry per station per side where a wall is needed.
  - `buildRetainingWallMesh(alignment, segments): MeshData` — panels between consecutive same-side segments. Returns an empty mesh for fewer than two segments on every side.
  - A wall shorter than `MIN_WALL_HEIGHT = 0.3` metres is not a wall — a 20cm step is a kerb, and emitting a panel for it produces slivers.

- [ ] **Step 1: Write the failing tests**

`src/mesh/structures/retainingWallMesh.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { wallSegments, buildRetainingWallMesh } from './retainingWallMesh'
import { Alignment } from '../../geometry/alignment'
import { Line } from '../../geometry/primitives'
import { vec2 } from '../../geometry/vec2'
import { Heightmap } from '../../terrain/heightmap'
import type { ProfilePoint } from '../../terrain/groundProfile'
import type { CorridorTemplate } from '../../terrain/corridor'

const road = (length: number) => new Alignment([new Line(vec2(0, 0), 0, length)])
const level = (length: number, z: number): ProfilePoint[] => [{ s: 0, z }, { s: length, z }]
const flat = (z: number) => Heightmap.flat(-500, -500, 50, 41, 41, z)

/** Batters capped at 1m, so anything deeper than 0.5m needs a wall at 2H:1V. */
const walled: CorridorTemplate = {
  formationHalfWidth: 5, cutSlope: 2, fillSlope: 3, maxBatterWidth: 1,
}
const unwalled: CorridorTemplate = { formationHalfWidth: 5, cutSlope: 2, fillSlope: 3 }

describe('wallSegments', () => {
  it('finds no wall where the batter has room', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 98), unwalled, 25)
    expect(segments).toHaveLength(0)
  })

  it('finds no wall where the design sits on the ground', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 100), walled, 25)
    expect(segments).toHaveLength(0)
  })

  it('finds walls on both sides of a constrained cut', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 95), walled, 25)
    expect(segments.filter((w) => w.side === 'left').length).toBeGreaterThan(0)
    expect(segments.filter((w) => w.side === 'right').length).toBeGreaterThan(0)
  })

  it('places the two sides at mirrored offsets', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 95), walled, 50)
    const left = segments.find((w) => w.side === 'left')!
    const right = segments.find((w) => w.side === 'right')!
    expect(left.offset).toBeCloseTo(-right.offset, 6)
  })

  it('puts the wall top above its bottom', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 95), walled, 25)
    for (const w of segments) expect(w.topZ).toBeGreaterThan(w.bottomZ)
  })

  it('makes the wall taller for a deeper cut', () => {
    const shallow = wallSegments(road(100), flat(100), level(100, 98.5), walled, 50)
    const deep = wallSegments(road(100), flat(100), level(100, 94), walled, 50)
    const height = (ws: { topZ: number; bottomZ: number }[]) =>
      Math.max(...ws.map((w) => w.topZ - w.bottomZ))
    expect(height(deep)).toBeGreaterThan(height(shallow))
  })

  it('ignores a wall below the minimum height', () => {
    // A 0.6m cut at 2H:1V needs 1.2m of batter; 1m is allowed, so the wall is
    // 0.6 - 1/2 = 0.1m — a kerb, not a wall.
    const segments = wallSegments(road(100), flat(100), level(100, 99.4), walled, 25)
    expect(segments).toHaveLength(0)
  })

  it('records the station of each segment', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 95), walled, 50)
    const stations = [...new Set(segments.map((w) => w.s))].sort((a, b) => a - b)
    expect(stations[0]).toBeCloseTo(0, 6)
    expect(stations[stations.length - 1]).toBeCloseTo(100, 6)
  })

  it('finds walls in fill as well as cut', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 105), walled, 25)
    expect(segments.length).toBeGreaterThan(0)
  })
})

describe('buildRetainingWallMesh', () => {
  it('returns an empty mesh with no segments', () => {
    const m = buildRetainingWallMesh(road(100), [])
    expect(m.vertexCount).toBe(0)
    expect(m.triangleCount).toBe(0)
  })

  it('returns an empty mesh with a single segment per side', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 95), walled, 1000)
    const m = buildRetainingWallMesh(road(100), segments)
    expect(m.triangleCount).toBe(0)
  })

  it('emits panels between consecutive segments', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 95), walled, 25)
    const m = buildRetainingWallMesh(road(100), segments)
    expect(m.triangleCount).toBeGreaterThan(0)
  })

  it('places wall vertices between the recorded top and bottom', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 95), walled, 25)
    const lowest = Math.min(...segments.map((w) => w.bottomZ))
    const highest = Math.max(...segments.map((w) => w.topZ))
    const m = buildRetainingWallMesh(road(100), segments)
    for (let i = 0; i < m.vertexCount; i++) {
      const z = m.positions[i * 3 + 2]!
      expect(z).toBeGreaterThanOrEqual(lowest - 1e-6)
      expect(z).toBeLessThanOrEqual(highest + 1e-6)
    }
  })

  it('gives every panel a roughly horizontal normal', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 95), walled, 25)
    const m = buildRetainingWallMesh(road(100), segments)
    for (let i = 0; i < m.vertexCount; i++) {
      expect(Math.abs(m.normals[i * 3 + 2]!)).toBeLessThan(0.2)
    }
  })

  it('winds every triangle to agree with its normal', () => {
    const segments = wallSegments(road(100), flat(100), level(100, 95), walled, 25)
    const m = buildRetainingWallMesh(road(100), segments)
    for (let t = 0; t < m.indices.length; t += 3) {
      const [i, j, k] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!]
      const ax = m.positions[i * 3]!, ay = m.positions[i * 3 + 1]!, az = m.positions[i * 3 + 2]!
      const ux = m.positions[j * 3]! - ax, uy = m.positions[j * 3 + 1]! - ay, uz = m.positions[j * 3 + 2]! - az
      const vx = m.positions[k * 3]! - ax, vy = m.positions[k * 3 + 1]! - ay, vz = m.positions[k * 3 + 2]! - az
      const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx
      const dot = fx * m.normals[i * 3]! + fy * m.normals[i * 3 + 1]! + fz * m.normals[i * 3 + 2]!
      expect(dot).toBeGreaterThan(0)
    }
  })

  it('rejects non-positive spacing', () => {
    expect(() => wallSegments(road(100), flat(100), level(100, 95), walled, 0)).toThrow(RangeError)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/mesh/structures/retainingWallMesh.test.ts
```

Expected: FAIL — `Failed to resolve import "./retainingWallMesh"`.

- [ ] **Step 3: Write the implementation**

`src/mesh/structures/retainingWallMesh.ts`:

```ts
import type { Alignment } from '../../geometry/alignment'
import { leftNormal, add, scale } from '../../geometry/vec2'
import type { TerrainSampler } from '../../terrain/heightmap'
import {
  type ProfilePoint, designElevationAtStation,
} from '../../terrain/groundProfile'
import {
  type CorridorTemplate, retainingWall, designSurfaceAtOffset,
} from '../../terrain/corridor'
import { MeshBuilder } from '../meshBuilder'
import type { MeshData } from '../ribbon'

/** One station's worth of wall on one side. */
export type WallSegment = {
  readonly s: number
  readonly side: 'left' | 'right'
  /** Transverse offset from the centreline. Negative is left. */
  readonly offset: number
  readonly topZ: number
  readonly bottomZ: number
}

/**
 * Below this a wall is a kerb, metres.
 *
 * A twenty-centimetre step is a kerb, not a retaining structure, and emitting
 * a panel for one produces slivers that read as z-fighting.
 */
export const MIN_WALL_HEIGHT = 0.3

/**
 * Where a road needs retaining walls, and how tall they are.
 *
 * The terrain layer already answers this per station via `retainingWall()` —
 * this walks the alignment asking it, and records the wall's top and bottom
 * elevations so the mesh has something to extrude between.
 *
 * Walls are symmetric: where one is needed, it stands on both sides.
 */
export const wallSegments = (
  alignment: Alignment,
  terrain: TerrainSampler,
  design: readonly ProfilePoint[],
  template: CorridorTemplate,
  spacing: number = 4,
): WallSegment[] => {
  if (spacing <= 0) {
    throw new RangeError('spacing must be positive')
  }
  if (alignment.isEmpty) return []

  const segments: WallSegment[] = []
  const steps = Math.floor(alignment.length / spacing)

  for (let i = 0; i <= steps; i++) {
    const s = Math.min(i * spacing, alignment.length)
    const pose = alignment.poseAt(s)
    const groundZ = terrain.sample(pose.position.x, pose.position.y)
    const designZ = designElevationAtStation(design, s)

    const wall = retainingWall(designZ, groundZ, template)
    if (!wall || wall.height < MIN_WALL_HEIGHT) continue

    const topZ = designSurfaceAtOffset(wall.offset, designZ, groundZ, template)

    for (const side of ['left', 'right'] as const) {
      segments.push({
        s,
        side,
        offset: side === 'left' ? -wall.offset : wall.offset,
        topZ,
        bottomZ: topZ - wall.height,
      })
    }
  }

  // The stepped loop can stop short of the alignment end; include it.
  const last = segments[segments.length - 1]
  if (last && last.s < alignment.length) {
    const s = alignment.length
    const pose = alignment.poseAt(s)
    const groundZ = terrain.sample(pose.position.x, pose.position.y)
    const designZ = designElevationAtStation(design, s)
    const wall = retainingWall(designZ, groundZ, template)
    if (wall && wall.height >= MIN_WALL_HEIGHT) {
      const topZ = designSurfaceAtOffset(wall.offset, designZ, groundZ, template)
      for (const side of ['left', 'right'] as const) {
        segments.push({
          s, side,
          offset: side === 'left' ? -wall.offset : wall.offset,
          topZ, bottomZ: topZ - wall.height,
        })
      }
    }
  }

  return segments
}

/**
 * Panels running between consecutive segments on each side.
 *
 * The face points away from the road, so its winding runs bottom-to-top on the
 * near station and top-to-bottom on the far one for the right side, and the
 * reverse for the left — that is what keeps the outward face frontmost on both.
 */
export const buildRetainingWallMesh = (
  alignment: Alignment,
  segments: readonly WallSegment[],
): MeshData => {
  const builder = new MeshBuilder()

  for (const side of ['left', 'right'] as const) {
    const run = segments
      .filter((w) => w.side === side)
      .sort((a, b) => a.s - b.s)

    for (let i = 1; i < run.length; i++) {
      const from = run[i - 1]!
      const to = run[i]!

      const poseFrom = alignment.poseAt(from.s)
      const poseTo = alignment.poseAt(to.s)

      // Offsets are negative-is-left while leftNormal points left, so negate.
      const pFrom = add(poseFrom.position, scale(leftNormal(poseFrom.heading), -from.offset))
      const pTo = add(poseTo.position, scale(leftNormal(poseTo.heading), -to.offset))

      const a = { x: pFrom.x, y: pFrom.y, z: from.bottomZ }
      const b = { x: pTo.x, y: pTo.y, z: to.bottomZ }
      const c = { x: pTo.x, y: pTo.y, z: to.topZ }
      const d = { x: pFrom.x, y: pFrom.y, z: from.topZ }

      if (side === 'right') builder.addQuad(a, b, c, d)
      else builder.addQuad(b, a, d, c)
    }
  }

  return builder.build()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/mesh/structures/retainingWallMesh.test.ts
```

Expected: PASS, 16 tests.

If the winding test fails, swap the two branches of the `side === 'right'` conditional rather than reversing corner order inside `addQuad`, so the reason stays legible.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/mesh/structures/
git commit -m "feat: add retaining wall geometry"
```

---

### Task 3: Structure spans

`classifySupport` marks stations one at a time. A bridge is a **contiguous run** of them, with abutments landing on solid ground at each end. Grouping is its own concern and its own failure modes.

**Files:**
- Create: `src/mesh/structures/spans.ts`
- Test: `src/mesh/structures/spans.test.ts`

**Interfaces:**
- Consumes: `ProfilePoint` from `../../terrain/groundProfile`; `StationSupport` from `../../terrain/gradeSolver`
- Produces:
  - `type StructureSpan = { readonly fromStation: number; readonly toStation: number; readonly maxHeight: number }` — `maxHeight` is the greatest height of design above ground within the span
  - `structureSpans(stations: readonly ProfilePoint[], support: readonly StationSupport[], ground: readonly ProfilePoint[], options?): StructureSpan[]`
  - `type SpanOptions = { readonly minLength?: number; readonly abutmentExtension?: number }` — `minLength` defaults to `MIN_SPAN_LENGTH = 12` metres, `abutmentExtension` to `ABUTMENT_EXTENSION = 3` metres
  - A run shorter than `minLength` is discarded — one or two stations above the fill allowance is terrain noise, not a bridge.
  - Each span is extended by `abutmentExtension` at both ends, clamped to the profile, so its abutments land on ground the earthworks actually supports.
  - Throws `RangeError` if the three arrays disagree in length.

- [ ] **Step 1: Write the failing tests**

`src/mesh/structures/spans.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { structureSpans, MIN_SPAN_LENGTH, ABUTMENT_EXTENSION } from './spans'
import type { ProfilePoint } from '../../terrain/groundProfile'
import type { StationSupport } from '../../terrain/gradeSolver'

/** Stations every 5m from a list of elevations. */
const at5 = (zs: number[]): ProfilePoint[] => zs.map((z, i) => ({ s: i * 5, z }))
const support = (flags: string): StationSupport[] =>
  [...flags].map((c) => (c === 'S' ? 'structure' : 'earthwork'))

describe('structureSpans', () => {
  it('finds nothing when every station is earthwork', () => {
    const design = at5([100, 100, 100, 100])
    expect(structureSpans(design, support('eeee'), design)).toEqual([])
  })

  it('finds one span for a contiguous run', () => {
    // 8 stations at 5m: a run of 5 is 20m, over the 12m minimum.
    const design = at5([100, 100, 100, 100, 100, 100, 100, 100])
    const ground = at5([100, 100, 60, 60, 60, 60, 100, 100])
    const spans = structureSpans(design, support('eeSSSSee'), ground)
    expect(spans).toHaveLength(1)
  })

  it('finds two spans for two separated runs', () => {
    const design = at5(Array(12).fill(100))
    const ground = at5([100, 60, 60, 60, 60, 100, 100, 60, 60, 60, 60, 100])
    const spans = structureSpans(design, support('eSSSSeeSSSSe'), ground)
    expect(spans).toHaveLength(2)
  })

  it('discards a run below the minimum length', () => {
    // Two stations at 5m is 5m of run, under the 12m minimum.
    const design = at5([100, 100, 100, 100, 100])
    const ground = at5([100, 60, 60, 100, 100])
    expect(structureSpans(design, support('eSSee'), ground)).toEqual([])
  })

  it('extends each span for its abutments', () => {
    const design = at5(Array(8).fill(100))
    const ground = at5([100, 100, 60, 60, 60, 60, 100, 100])
    const spans = structureSpans(design, support('eeSSSSee'), ground)
    // The raw run is stations 10..25; abutments push it out by 3 each way.
    expect(spans[0]!.fromStation).toBeCloseTo(10 - ABUTMENT_EXTENSION, 6)
    expect(spans[0]!.toStation).toBeCloseTo(25 + ABUTMENT_EXTENSION, 6)
  })

  it('clamps the extension to the profile ends', () => {
    const design = at5(Array(6).fill(100))
    const ground = at5([60, 60, 60, 60, 100, 100])
    const spans = structureSpans(design, support('SSSSee'), ground)
    expect(spans[0]!.fromStation).toBeCloseTo(0, 6)
  })

  it('records the greatest height of design above ground', () => {
    const design = at5(Array(8).fill(100))
    const ground = at5([100, 100, 70, 55, 62, 68, 100, 100])
    const spans = structureSpans(design, support('eeSSSSee'), ground)
    expect(spans[0]!.maxHeight).toBeCloseTo(45, 6)
  })

  it('handles a run reaching the very end', () => {
    const design = at5(Array(6).fill(100))
    const ground = at5([100, 100, 60, 60, 60, 60])
    const spans = structureSpans(design, support('eeSSSS'), ground)
    expect(spans).toHaveLength(1)
    expect(spans[0]!.toStation).toBeCloseTo(25, 6)
  })

  it('respects a custom minimum length', () => {
    const design = at5([100, 100, 100, 100, 100])
    const ground = at5([100, 60, 60, 100, 100])
    const spans = structureSpans(design, support('eSSee'), ground, { minLength: 1 })
    expect(spans).toHaveLength(1)
  })

  it('respects a custom abutment extension', () => {
    const design = at5(Array(8).fill(100))
    const ground = at5([100, 100, 60, 60, 60, 60, 100, 100])
    const spans = structureSpans(design, support('eeSSSSee'), ground, { abutmentExtension: 0 })
    expect(spans[0]!.fromStation).toBeCloseTo(10, 6)
  })

  it('rejects mismatched array lengths', () => {
    const design = at5([100, 100, 100])
    expect(() => structureSpans(design, support('ee'), design)).toThrow(RangeError)
  })

  it('returns nothing for empty input', () => {
    expect(structureSpans([], [], [])).toEqual([])
  })

  it('exports a sane default minimum length', () => {
    expect(MIN_SPAN_LENGTH).toBeGreaterThan(0)
    expect(MIN_SPAN_LENGTH).toBeLessThan(50)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/mesh/structures/spans.test.ts
```

Expected: FAIL — `Failed to resolve import "./spans"`.

- [ ] **Step 3: Write the implementation**

`src/mesh/structures/spans.ts`:

```ts
import type { ProfilePoint } from '../../terrain/groundProfile'
import type { StationSupport } from '../../terrain/gradeSolver'

export type StructureSpan = {
  readonly fromStation: number
  readonly toStation: number
  /** Greatest height of the design line above natural ground within the span. */
  readonly maxHeight: number
}

export type SpanOptions = {
  readonly minLength?: number
  readonly abutmentExtension?: number
}

/**
 * Shortest run that counts as a bridge, metres.
 *
 * One or two stations poking above the fill allowance is terrain noise, not a
 * structure. Building a bridge for every bump would litter the map.
 */
export const MIN_SPAN_LENGTH = 12

/**
 * How far a span reaches past its structure stations, metres.
 *
 * Abutments have to land on ground the earthworks actually supports, which is
 * the earthwork station either side of the run — not the first station that
 * needed a structure.
 */
export const ABUTMENT_EXTENSION = 3

/**
 * Group per-station structure flags into spans a bridge can be built over.
 *
 * `classifySupport` answers one station at a time; a bridge is a contiguous
 * run of them. Runs shorter than the minimum are discarded, and each surviving
 * run is extended at both ends so its abutments sit on solid ground.
 */
export const structureSpans = (
  stations: readonly ProfilePoint[],
  support: readonly StationSupport[],
  ground: readonly ProfilePoint[],
  options: SpanOptions = {},
): StructureSpan[] => {
  const {
    minLength = MIN_SPAN_LENGTH,
    abutmentExtension = ABUTMENT_EXTENSION,
  } = options

  if (stations.length !== support.length || stations.length !== ground.length) {
    throw new RangeError('stations, support and ground must have the same length')
  }
  if (stations.length === 0) return []

  const first = stations[0]!.s
  const last = stations[stations.length - 1]!.s

  const spans: StructureSpan[] = []
  let runStart = -1

  const closeRun = (endIndex: number) => {
    if (runStart < 0) return
    const from = stations[runStart]!.s
    const to = stations[endIndex]!.s

    if (to - from >= minLength) {
      let maxHeight = 0
      for (let i = runStart; i <= endIndex; i++) {
        maxHeight = Math.max(maxHeight, stations[i]!.z - ground[i]!.z)
      }
      spans.push({
        fromStation: Math.max(first, from - abutmentExtension),
        toStation: Math.min(last, to + abutmentExtension),
        maxHeight,
      })
    }
    runStart = -1
  }

  for (let i = 0; i < support.length; i++) {
    if (support[i] === 'structure') {
      if (runStart < 0) runStart = i
    } else {
      closeRun(i - 1)
    }
  }
  closeRun(support.length - 1)

  return spans
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/mesh/structures/spans.test.ts
```

Expected: PASS, 13 tests.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/mesh/structures/spans.ts src/mesh/structures/spans.test.ts
git commit -m "feat: group structure stations into bridge spans"
```

---

### Task 4: Bridge geometry

Deck, piers and abutments for a span. The road ribbon already draws the running surface; this is what holds it up.

**Files:**
- Create: `src/mesh/structures/bridgeMesh.ts`
- Test: `src/mesh/structures/bridgeMesh.test.ts`

**Interfaces:**
- Consumes: `Alignment`; `leftNormal`, `add`, `scale` from `../../geometry/vec2`; `TerrainSampler`; `ProfilePoint`, `designElevationAtStation`; `StructureSpan` from `./spans`; `MeshBuilder`, `Point3` from `../meshBuilder`; `MeshData` from `../ribbon`
- Produces:
  - `type BridgeOptions = { readonly deckDepth?: number; readonly pierSpacing?: number; readonly pierHalfWidth?: number; readonly deckClearance?: number }`
  - `buildBridgeMesh(alignment, terrain, design, span, halfWidth, options?): MeshData`
  - `DECK_DEPTH = 1.2`, `PIER_SPACING = 25`, `PIER_HALF_WIDTH = 1.0`, `DECK_CLEARANCE = 0.6` metres — `deckClearance` is how far the deck's top sits below the design elevation, so the pavement stack rests on it rather than intersecting it
  - Piers are placed at `pierSpacing` intervals strictly inside the span, never at its ends where the abutments already are.

- [ ] **Step 1: Write the failing tests**

`src/mesh/structures/bridgeMesh.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildBridgeMesh, DECK_DEPTH, PIER_SPACING } from './bridgeMesh'
import { Alignment } from '../../geometry/alignment'
import { Line } from '../../geometry/primitives'
import { vec2 } from '../../geometry/vec2'
import { Heightmap } from '../../terrain/heightmap'
import type { ProfilePoint } from '../../terrain/groundProfile'
import type { StructureSpan } from './spans'

const road = (length: number) => new Alignment([new Line(vec2(0, 0), 0, length)])
const level = (length: number, z: number): ProfilePoint[] => [{ s: 0, z }, { s: length, z }]
const flat = (z: number) => Heightmap.flat(-500, -500, 50, 41, 41, z)

const span = (from: number, to: number, maxHeight: number): StructureSpan => ({
  fromStation: from, toStation: to, maxHeight,
})

const zRange = (m: { positions: Float32Array; vertexCount: number }) => {
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < m.vertexCount; i++) {
    const z = m.positions[i * 3 + 2]!
    lo = Math.min(lo, z); hi = Math.max(hi, z)
  }
  return { lo, hi }
}

describe('buildBridgeMesh', () => {
  it('produces geometry for a span', () => {
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(50, 150, 40), 5)
    expect(m.vertexCount).toBeGreaterThan(0)
    expect(m.triangleCount).toBeGreaterThan(0)
  })

  it('returns an empty mesh for a zero-length span', () => {
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(80, 80, 40), 5)
    expect(m.vertexCount).toBe(0)
  })

  it('keeps the deck below the design elevation', () => {
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(50, 150, 40), 5)
    expect(zRange(m).hi).toBeLessThan(100)
  })

  it('reaches down to the ground', () => {
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(50, 150, 40), 5)
    expect(zRange(m).lo).toBeCloseTo(60, 0)
  })

  it('makes a taller structure over deeper ground', () => {
    const shallow = buildBridgeMesh(road(200), flat(90), level(200, 100), span(50, 150, 10), 5)
    const deep = buildBridgeMesh(road(200), flat(50), level(200, 100), span(50, 150, 50), 5)
    const height = (m: ReturnType<typeof buildBridgeMesh>) => {
      const r = zRange(m)
      return r.hi - r.lo
    }
    expect(height(deep)).toBeGreaterThan(height(shallow))
  })

  it('gives the deck the requested depth', () => {
    const m = buildBridgeMesh(road(200), flat(99), level(200, 100), span(50, 150, 1), 5, {
      pierSpacing: 1000,
    })
    // Ground almost at design, so the whole structure is essentially the deck.
    const r = zRange(m)
    expect(r.hi - r.lo).toBeGreaterThanOrEqual(DECK_DEPTH - 0.5)
  })

  it('adds more piers to a longer span', () => {
    const shortSpan = buildBridgeMesh(road(400), flat(60), level(400, 100), span(50, 90, 40), 5)
    const longSpan = buildBridgeMesh(road(400), flat(60), level(400, 100), span(50, 350, 40), 5)
    expect(longSpan.vertexCount).toBeGreaterThan(shortSpan.vertexCount)
  })

  it('places no pier when the span is shorter than the pier spacing', () => {
    const withPiers = buildBridgeMesh(road(400), flat(60), level(400, 100), span(50, 350, 40), 5)
    const withoutPiers = buildBridgeMesh(
      road(400), flat(60), level(400, 100), span(50, 350, 40), 5, { pierSpacing: 10000 },
    )
    expect(withoutPiers.vertexCount).toBeLessThan(withPiers.vertexCount)
  })

  it('spans the full road width', () => {
    const halfWidth = 7
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(50, 150, 40), halfWidth)
    let widest = 0
    for (let i = 0; i < m.vertexCount; i++) {
      widest = Math.max(widest, Math.abs(m.positions[i * 3 + 1]!))
    }
    expect(widest).toBeCloseTo(halfWidth, 4)
  })

  it('stays within the span stations', () => {
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(50, 150, 40), 5)
    for (let i = 0; i < m.vertexCount; i++) {
      const x = m.positions[i * 3]!
      expect(x).toBeGreaterThanOrEqual(50 - 1e-4)
      expect(x).toBeLessThanOrEqual(150 + 1e-4)
    }
  })

  it('gives unit-length normals', () => {
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(50, 150, 40), 5)
    for (let i = 0; i < m.vertexCount; i++) {
      const len = Math.hypot(m.normals[i * 3]!, m.normals[i * 3 + 1]!, m.normals[i * 3 + 2]!)
      expect(len).toBeCloseTo(1, 4)
    }
  })

  it('winds every triangle to agree with its normal', () => {
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(50, 150, 40), 5)
    for (let t = 0; t < m.indices.length; t += 3) {
      const [i, j, k] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!]
      const ax = m.positions[i * 3]!, ay = m.positions[i * 3 + 1]!, az = m.positions[i * 3 + 2]!
      const ux = m.positions[j * 3]! - ax, uy = m.positions[j * 3 + 1]! - ay, uz = m.positions[j * 3 + 2]! - az
      const vx = m.positions[k * 3]! - ax, vy = m.positions[k * 3 + 1]! - ay, vz = m.positions[k * 3 + 2]! - az
      const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx
      const dot = fx * m.normals[i * 3]! + fy * m.normals[i * 3 + 1]! + fz * m.normals[i * 3 + 2]!
      expect(dot).toBeGreaterThan(0)
    }
  })

  it('exports sane defaults', () => {
    expect(DECK_DEPTH).toBeGreaterThan(0)
    expect(PIER_SPACING).toBeGreaterThan(DECK_DEPTH)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/mesh/structures/bridgeMesh.test.ts
```

Expected: FAIL — `Failed to resolve import "./bridgeMesh"`.

- [ ] **Step 3: Write the implementation**

`src/mesh/structures/bridgeMesh.ts`:

```ts
import type { Alignment } from '../../geometry/alignment'
import { leftNormal, add, scale } from '../../geometry/vec2'
import type { TerrainSampler } from '../../terrain/heightmap'
import {
  type ProfilePoint, designElevationAtStation,
} from '../../terrain/groundProfile'
import type { StructureSpan } from './spans'
import { MeshBuilder, type Point3 } from '../meshBuilder'
import type { MeshData } from '../ribbon'

/** Depth of the deck slab, metres. */
export const DECK_DEPTH = 1.2
/** Distance between piers, metres. */
export const PIER_SPACING = 25
/** Half the plan size of a pier, metres. */
export const PIER_HALF_WIDTH = 1.0
/** How far the deck's top sits below the design elevation, metres. */
export const DECK_CLEARANCE = 0.6

export type BridgeOptions = {
  readonly deckDepth?: number
  readonly pierSpacing?: number
  readonly pierHalfWidth?: number
  readonly deckClearance?: number
}

/** Longitudinal resolution of the deck slab, metres. */
const DECK_STEP = 5

/**
 * Deck, abutments and piers for one span.
 *
 * The road ribbon already draws the running surface; this is what holds it up.
 * The deck's top sits `deckClearance` below the design elevation so the
 * pavement stack rests on it rather than intersecting it.
 *
 * Piers go at `pierSpacing` intervals strictly inside the span — never at its
 * ends, where the abutments already are.
 */
export const buildBridgeMesh = (
  alignment: Alignment,
  terrain: TerrainSampler,
  design: readonly ProfilePoint[],
  span: StructureSpan,
  halfWidth: number,
  options: BridgeOptions = {},
): MeshData => {
  const {
    deckDepth = DECK_DEPTH,
    pierSpacing = PIER_SPACING,
    pierHalfWidth = PIER_HALF_WIDTH,
    deckClearance = DECK_CLEARANCE,
  } = options

  const builder = new MeshBuilder()
  const length = span.toStation - span.fromStation
  if (length <= 0 || halfWidth <= 0) return builder.build()

  /** Deck cross-section at a station: left and right, top and bottom. */
  const deckSection = (s: number) => {
    const pose = alignment.poseAt(s)
    const normal = leftNormal(pose.heading)
    const top = designElevationAtStation(design, s) - deckClearance
    const left = add(pose.position, scale(normal, halfWidth))
    const right = add(pose.position, scale(normal, -halfWidth))
    return {
      leftTop: { x: left.x, y: left.y, z: top },
      rightTop: { x: right.x, y: right.y, z: top },
      leftBottom: { x: left.x, y: left.y, z: top - deckDepth },
      rightBottom: { x: right.x, y: right.y, z: top - deckDepth },
    }
  }

  // --- Deck slab, stepped along the span ---
  const steps = Math.max(1, Math.ceil(length / DECK_STEP))
  let previous = deckSection(span.fromStation)

  for (let i = 1; i <= steps; i++) {
    const s = span.fromStation + (length * i) / steps
    const current = deckSection(s)

    // Top face, seen from above: right then left runs counter-clockwise.
    builder.addQuad(previous.rightTop, current.rightTop, current.leftTop, previous.leftTop)
    // Underside, reversed so it faces down.
    builder.addQuad(previous.leftBottom, current.leftBottom, current.rightBottom, previous.rightBottom)
    // Left flank, facing outward to the left.
    builder.addQuad(previous.leftTop, current.leftTop, current.leftBottom, previous.leftBottom)
    // Right flank, facing outward to the right.
    builder.addQuad(previous.rightBottom, current.rightBottom, current.rightTop, previous.rightTop)

    previous = current
  }

  // --- Abutments and piers ---
  const supports: number[] = [span.fromStation, span.toStation]
  const pierCount = Math.floor(length / pierSpacing)
  for (let i = 1; i <= pierCount; i++) {
    const s = span.fromStation + (length * i) / (pierCount + 1)
    supports.push(s)
  }

  for (const s of supports) {
    const isAbutment = s === span.fromStation || s === span.toStation
    const section = deckSection(s)
    const pose = alignment.poseAt(s)
    const groundZ = terrain.sample(pose.position.x, pose.position.y)
    const topZ = section.leftBottom.z
    if (topZ <= groundZ) continue

    // An abutment carries the full road width; a pier is a slender column.
    const halfAcross = isAbutment ? halfWidth : pierHalfWidth
    addBox(builder, alignment, s, halfAcross, pierHalfWidth, groundZ, topZ)
  }

  return builder.build()
}

/**
 * A rectangular column, aligned to the road at that station.
 *
 * `halfAcross` is its half size transverse to the road, `halfAlong` its half
 * size along it.
 */
const addBox = (
  builder: MeshBuilder,
  alignment: Alignment,
  s: number,
  halfAcross: number,
  halfAlong: number,
  bottomZ: number,
  topZ: number,
): void => {
  const pose = alignment.poseAt(s)
  const across = leftNormal(pose.heading)
  const along = { x: Math.cos(pose.heading), y: Math.sin(pose.heading) }

  const corner = (a: number, b: number, z: number): Point3 => {
    const p = add(
      add(pose.position, scale(across, a * halfAcross)),
      scale(along, b * halfAlong),
    )
    return { x: p.x, y: p.y, z }
  }

  // Plan corners, counter-clockwise seen from above.
  const t = [corner(1, -1, topZ), corner(1, 1, topZ), corner(-1, 1, topZ), corner(-1, -1, topZ)]
  const b = [corner(1, -1, bottomZ), corner(1, 1, bottomZ), corner(-1, 1, bottomZ), corner(-1, -1, bottomZ)]

  builder.addQuad(t[0]!, t[1]!, t[2]!, t[3]!)
  builder.addQuad(b[3]!, b[2]!, b[1]!, b[0]!)

  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    builder.addQuad(b[i]!, b[j]!, t[j]!, t[i]!)
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/mesh/structures/bridgeMesh.test.ts
```

Expected: PASS, 13 tests.

If the winding test fails on the box's side faces, swap `b[i]`/`b[j]` for `b[j]`/`b[i]` in the side loop rather than reversing the whole quad, so the fix stays readable.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/mesh/structures/bridgeMesh.ts src/mesh/structures/bridgeMesh.test.ts
git commit -m "feat: add bridge deck, abutment and pier geometry"
```

---

### Task 5: Road crossings and overpass clearance

The third trigger. Two roads whose alignments cross in plan but share no node are at different levels — or should be. If the vertical gap between them is too small, that is a collision, and the project's stance is to report it.

**Files:**
- Create: `src/network/crossings.ts`
- Test: `src/network/crossings.test.ts`

**Interfaces:**
- Consumes: `RoadNetwork`, `RoadId` from `./graph`; `Vec2`, `sub`, `cross`, `add`, `scale` from `../geometry/vec2`
- Produces:
  - `type Crossing = { readonly upper: RoadId; readonly lower: RoadId; readonly position: Vec2; readonly upperStation: number; readonly lowerStation: number; readonly clearance: number }`
  - `findCrossings(network, designs: ReadonlyMap<RoadId, readonly ProfilePoint[]>, spacing?): Crossing[]` — `spacing` defaults to 5 metres
  - `MIN_OVERPASS_CLEARANCE = 5.0` metres — below this a crossing is too tight for one road to pass over the other
  - A crossing where the two roads **share a node** is a junction, not an overpass, and is excluded.
  - `clearance` is always non-negative; `upper` is whichever road is higher at the crossing.

- [ ] **Step 1: Write the failing tests**

`src/network/crossings.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { findCrossings, MIN_OVERPASS_CLEARANCE } from './crossings'
import { RoadNetwork, type RoadId } from './graph'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import type { ProfilePoint } from '../terrain/groundProfile'

const level = (length: number, z: number): ProfilePoint[] => [{ s: 0, z }, { s: length, z }]

/** Two roads crossing at (100, 0) at the given elevations, sharing no node. */
const crossingPair = (zA: number, zB: number) => {
  const net = new RoadNetwork()
  const a = net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 200)]), 'rural')
  const b = net.addRoad(new Alignment([new Line(vec2(100, -100), Math.PI / 2, 200)]), 'rural')
  const designs = new Map<RoadId, ProfilePoint[]>([[a, level(200, zA)], [b, level(200, zB)]])
  return { net, designs, a, b }
}

describe('findCrossings', () => {
  it('finds a crossing where two roads cross', () => {
    const { net, designs } = crossingPair(100, 108)
    expect(findCrossings(net, designs)).toHaveLength(1)
  })

  it('finds nothing where roads do not cross', () => {
    const net = new RoadNetwork()
    const a = net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 100)]), 'rural')
    const b = net.addRoad(new Alignment([new Line(vec2(0, 500), 0, 100)]), 'rural')
    const designs = new Map<RoadId, ProfilePoint[]>([[a, level(100, 100)], [b, level(100, 100)]])
    expect(findCrossings(net, designs)).toEqual([])
  })

  it('excludes roads that share a node — that is a junction', () => {
    const net = new RoadNetwork()
    const a = net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 100)]), 'rural')
    const b = net.addRoad(new Alignment([new Line(vec2(100, 0), Math.PI / 2, 100)]), 'rural')
    const designs = new Map<RoadId, ProfilePoint[]>([[a, level(100, 100)], [b, level(100, 100)]])
    expect(findCrossings(net, designs)).toEqual([])
  })

  it('locates the crossing point', () => {
    const { net, designs } = crossingPair(100, 108)
    const c = findCrossings(net, designs)[0]!
    expect(c.position.x).toBeCloseTo(100, 0)
    expect(c.position.y).toBeCloseTo(0, 0)
  })

  it('names the higher road as upper', () => {
    const { net, designs, b } = crossingPair(100, 108)
    expect(findCrossings(net, designs)[0]!.upper).toBe(b)
  })

  it('names the lower road as lower', () => {
    const { net, designs, a } = crossingPair(100, 108)
    expect(findCrossings(net, designs)[0]!.lower).toBe(a)
  })

  it('reports the vertical gap as clearance', () => {
    const { net, designs } = crossingPair(100, 108)
    expect(findCrossings(net, designs)[0]!.clearance).toBeCloseTo(8, 0)
  })

  it('reports a small clearance for roads at the same level', () => {
    const { net, designs } = crossingPair(100, 100)
    expect(findCrossings(net, designs)[0]!.clearance).toBeCloseTo(0, 1)
  })

  it('never reports a negative clearance', () => {
    const { net, designs } = crossingPair(108, 100)
    expect(findCrossings(net, designs)[0]!.clearance).toBeGreaterThanOrEqual(0)
  })

  it('records a station on each road', () => {
    const { net, designs } = crossingPair(100, 108)
    const c = findCrossings(net, designs)[0]!
    expect(c.upperStation).toBeGreaterThan(0)
    expect(c.lowerStation).toBeGreaterThan(0)
  })

  it('finds two crossings where a road crosses two others', () => {
    const net = new RoadNetwork()
    const spine = net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 400)]), 'rural')
    const first = net.addRoad(new Alignment([new Line(vec2(100, -50), Math.PI / 2, 100)]), 'rural')
    const second = net.addRoad(new Alignment([new Line(vec2(300, -50), Math.PI / 2, 100)]), 'rural')
    const designs = new Map<RoadId, ProfilePoint[]>([
      [spine, level(400, 100)], [first, level(100, 110)], [second, level(100, 110)],
    ])
    expect(findCrossings(net, designs)).toHaveLength(2)
  })

  it('rejects non-positive spacing', () => {
    const { net, designs } = crossingPair(100, 108)
    expect(() => findCrossings(net, designs, 0)).toThrow(RangeError)
  })

  it('exports a sane minimum clearance', () => {
    expect(MIN_OVERPASS_CLEARANCE).toBeGreaterThan(3)
    expect(MIN_OVERPASS_CLEARANCE).toBeLessThan(10)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/network/crossings.test.ts
```

Expected: FAIL — `Failed to resolve import "./crossings"`.

- [ ] **Step 3: Write the implementation**

`src/network/crossings.ts`:

```ts
import type { RoadNetwork, RoadId } from './graph'
import { type Vec2, sub, cross, add, scale } from '../geometry/vec2'
import {
  type ProfilePoint, designElevationAtStation,
} from '../terrain/groundProfile'

export type Crossing = {
  /** The road passing over. */
  readonly upper: RoadId
  /** The road passing under. */
  readonly lower: RoadId
  readonly position: Vec2
  readonly upperStation: number
  readonly lowerStation: number
  /** Vertical gap between the two design lines, metres. Never negative. */
  readonly clearance: number
}

/**
 * Least vertical gap for one road to pass over another, metres.
 *
 * Five metres clears a lorry with room for the deck. Below it, a crossing is a
 * collision rather than an overpass, and the caller should say so rather than
 * build a structure that passes through another road.
 */
export const MIN_OVERPASS_CLEARANCE = 5.0

/**
 * Where two roads cross in plan without sharing a node.
 *
 * Roads that share a node meet at a junction and are excluded — a junction is
 * a crossing at the same level, deliberately. What is left is roads that pass
 * over or under one another, which is the overpass trigger.
 *
 * Detection is by sampling: each alignment becomes a polyline and every pair
 * of segments is tested. That is quadratic in sample count and fine for the
 * network sizes this game reaches; a spatial index belongs with the
 * interactive tool, where networks get large and get rebuilt during a drag.
 */
export const findCrossings = (
  network: RoadNetwork,
  designs: ReadonlyMap<RoadId, readonly ProfilePoint[]>,
  spacing: number = 5,
): Crossing[] => {
  if (spacing <= 0) {
    throw new RangeError('spacing must be positive')
  }

  const roads = network.roads
  const polylines = new Map<RoadId, { point: Vec2; s: number }[]>()

  for (const road of roads) {
    const points: { point: Vec2; s: number }[] = []
    const steps = Math.max(1, Math.ceil(road.alignment.length / spacing))
    for (let i = 0; i <= steps; i++) {
      const s = (road.alignment.length * i) / steps
      points.push({ point: road.alignment.poseAt(s).position, s })
    }
    polylines.set(road.id, points)
  }

  const crossings: Crossing[] = []

  for (let ia = 0; ia < roads.length; ia++) {
    for (let ib = ia + 1; ib < roads.length; ib++) {
      const roadA = roads[ia]!
      const roadB = roads[ib]!

      // Sharing a node means they meet at a junction, not an overpass.
      if (
        roadA.startNode === roadB.startNode || roadA.startNode === roadB.endNode ||
        roadA.endNode === roadB.startNode || roadA.endNode === roadB.endNode
      ) {
        continue
      }

      const hit = firstIntersection(polylines.get(roadA.id)!, polylines.get(roadB.id)!)
      if (!hit) continue

      const zA = designElevationAtStation(designs.get(roadA.id) ?? [], hit.sA)
      const zB = designElevationAtStation(designs.get(roadB.id) ?? [], hit.sB)
      const aIsUpper = zA >= zB

      crossings.push({
        upper: aIsUpper ? roadA.id : roadB.id,
        lower: aIsUpper ? roadB.id : roadA.id,
        position: hit.position,
        upperStation: aIsUpper ? hit.sA : hit.sB,
        lowerStation: aIsUpper ? hit.sB : hit.sA,
        clearance: Math.abs(zA - zB),
      })
    }
  }

  return crossings
}

/** The first place two polylines cross, with the station on each. */
const firstIntersection = (
  a: readonly { point: Vec2; s: number }[],
  b: readonly { point: Vec2; s: number }[],
): { position: Vec2; sA: number; sB: number } | null => {
  for (let i = 1; i < a.length; i++) {
    const p = a[i - 1]!
    const q = a[i]!
    const u = sub(q.point, p.point)

    for (let j = 1; j < b.length; j++) {
      const r = b[j - 1]!
      const t = b[j]!
      const v = sub(t.point, r.point)

      const denominator = cross(u, v)
      if (denominator === 0) continue

      const w = sub(r.point, p.point)
      const tA = cross(w, v) / denominator
      const tB = cross(w, u) / denominator

      if (tA < 0 || tA > 1 || tB < 0 || tB > 1) continue

      return {
        position: add(p.point, scale(u, tA)),
        sA: p.s + (q.s - p.s) * tA,
        sB: r.s + (t.s - r.s) * tB,
      }
    }
  }
  return null
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/network/crossings.test.ts
```

Expected: PASS, 13 tests.

- [ ] **Step 5: Verify the typecheck**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/network/crossings.ts src/network/crossings.test.ts
git commit -m "feat: detect road crossings and overpass clearance"
```

---

### Task 6: Wire structures into the network mesh and the scene

Structures currently exist as functions nothing calls. Give `buildNetworkMesh` a structures output, and put one on screen.

**Files:**
- Modify: `src/mesh/networkMesh.ts`, `src/mesh/networkMesh.test.ts`, `src/debug/roadScene.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5
- Produces:
  - `NetworkMesh` gains `readonly structures: ReadonlyMap<RoadId, MeshData>` and `readonly tightCrossings: ReadonlyMap<string, number>` — the latter keyed `"upperId:lowerId"` with the measured clearance, for crossings below `MIN_OVERPASS_CLEARANCE`
  - `NetworkMeshOptions` gains `readonly terrain?: TerrainSampler` and `readonly corridorTemplate?: CorridorTemplate` — structures are built only when a terrain is supplied, since walls and bridges both need ground elevation
  - Without a terrain, `structures` is empty and nothing else changes, so every existing caller keeps working

- [ ] **Step 1: Write the failing tests**

Append to `src/mesh/networkMesh.test.ts`:

```ts
import { Heightmap } from '../terrain/heightmap'
import type { CorridorTemplate } from '../terrain/corridor'

const flatGround = (z: number) => Heightmap.flat(-1000, -1000, 100, 41, 41, z)
const template: CorridorTemplate = {
  formationHalfWidth: 5, cutSlope: 2, fillSlope: 3, maxBatterWidth: 1,
}

describe('buildNetworkMesh structures', () => {
  it('builds no structures without a terrain', () => {
    const { net, designs } = tJunction()
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    expect(m.structures.size).toBe(0)
  })

  it('builds a structure entry per road when a terrain is given', () => {
    const { net, designs } = tJunction()
    const m = buildNetworkMesh(net, designs, {
      spacing: 10, terrain: flatGround(50), corridorTemplate: template,
    })
    expect(m.structures.size).toBe(3)
  })

  it('builds a bridge where the design stands high above ground', () => {
    const { net, designs, west } = tJunction()
    // Ground 40m below the roads, so every station needs a structure.
    const m = buildNetworkMesh(net, designs, {
      spacing: 10, terrain: flatGround(10), corridorTemplate: template,
    })
    expect(m.structures.get(west)!.vertexCount).toBeGreaterThan(0)
  })

  it('builds nothing where the road sits on the ground', () => {
    const { net, designs, west } = tJunction()
    const m = buildNetworkMesh(net, designs, {
      spacing: 10,
      terrain: flatGround(50),
      corridorTemplate: { formationHalfWidth: 5, cutSlope: 2, fillSlope: 3 },
    })
    expect(m.structures.get(west)!.vertexCount).toBe(0)
  })

  it('reports a crossing that is too tight', () => {
    const net = new RoadNetwork()
    const a = net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 200)]), 'rural')
    const b = net.addRoad(new Alignment([new Line(vec2(100, -100), Math.PI / 2, 200)]), 'rural')
    const designs = new Map<RoadId, ProfilePoint[]>([
      [a, level(200, 50)], [b, level(200, 51)],
    ])
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    expect(m.tightCrossings.size).toBe(1)
  })

  it('does not report a crossing with adequate clearance', () => {
    const net = new RoadNetwork()
    const a = net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 200)]), 'rural')
    const b = net.addRoad(new Alignment([new Line(vec2(100, -100), Math.PI / 2, 200)]), 'rural')
    const designs = new Map<RoadId, ProfilePoint[]>([
      [a, level(200, 50)], [b, level(200, 60)],
    ])
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    expect(m.tightCrossings.size).toBe(0)
  })

  it('does not report roads meeting at a junction as a tight crossing', () => {
    const { net, designs } = tJunction()
    const m = buildNetworkMesh(net, designs, { spacing: 10 })
    expect(m.tightCrossings.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/mesh/networkMesh.test.ts
```

Expected: FAIL — `structures` is not a property of the returned object.

- [ ] **Step 3: Extend `buildNetworkMesh`**

In `src/mesh/networkMesh.ts`, add the imports:

```ts
import type { TerrainSampler } from '../terrain/heightmap'
import { type CorridorTemplate } from '../terrain/corridor'
import { classifySupport } from '../terrain/gradeSolver'
import { sampleGroundProfile } from '../terrain/groundProfile'
import { structureSpans } from './structures/spans'
import { buildBridgeMesh } from './structures/bridgeMesh'
import { wallSegments, buildRetainingWallMesh } from './structures/retainingWallMesh'
import { findCrossings, MIN_OVERPASS_CLEARANCE } from '../network/crossings'
import { formationHalfWidth } from './roadClass'
```

Extend the option and result types:

```ts
export type NetworkMeshOptions = {
  readonly spacing?: number
  readonly stations?: ReadonlyMap<RoadId, LayerStations>
  /** Required for structures — walls and bridges both need ground elevation. */
  readonly terrain?: TerrainSampler
  readonly corridorTemplate?: CorridorTemplate
}

export type NetworkMesh = {
  readonly roads: ReadonlyMap<RoadId, RoadMesh>
  readonly junctions: ReadonlyMap<NodeId, MeshData>
  readonly infeasibleJunctions: ReadonlyMap<NodeId, JunctionInfeasibility>
  readonly elevationMismatches: ReadonlyMap<NodeId, number>
  /** Walls and bridges per road. Empty when no terrain was supplied. */
  readonly structures: ReadonlyMap<RoadId, MeshData>
  /**
   * Crossings too tight for one road to pass over the other, keyed
   * `"upperId:lowerId"`, with the measured clearance in metres.
   */
  readonly tightCrossings: ReadonlyMap<string, number>
}
```

Add this before the final `return`, and include both new fields in it:

```ts
  const structures = new Map<RoadId, MeshData>()

  if (options.terrain && options.corridorTemplate) {
    const terrain = options.terrain
    const template = options.corridorTemplate

    for (const road of network.roads) {
      const design = designs.get(road.id) ?? []
      const parts: MeshData[] = []

      if (design.length >= 2) {
        const halfWidth = formationHalfWidth(ROAD_CLASSES[road.className])
        const ground = sampleGroundProfile(road.alignment, terrain, spacing)

        // Resample the design onto the ground profile's own stations, so
        // classifySupport compares like with like. The two profiles are
        // sampled independently and will not otherwise share stations.
        const designAtGround = ground.map((g) => ({
          s: g.s,
          z: designElevationAtStation(design, g.s),
        }))

        const support = classifySupport(ground, designAtGround, MAX_FILL_FOR_STRUCTURE)
        for (const span of structureSpans(designAtGround, support, ground)) {
          parts.push(buildBridgeMesh(road.alignment, terrain, design, span, halfWidth))
        }

        parts.push(
          buildRetainingWallMesh(
            road.alignment,
            wallSegments(road.alignment, terrain, design, template, spacing),
          ),
        )
      }

      structures.set(road.id, mergeMeshes(parts))
    }
  }

  const tightCrossings = new Map<string, number>()
  for (const crossing of findCrossings(network, designs)) {
    if (crossing.clearance < MIN_OVERPASS_CLEARANCE) {
      tightCrossings.set(`${crossing.upper}:${crossing.lower}`, crossing.clearance)
    }
  }
```

Add the fill threshold constant and the merge helper at module level:

```ts
/**
 * How high the design line may stand above ground on fill before it becomes a
 * structure, metres.
 *
 * Above this an embankment stops being economic and starts looking absurd.
 * This mirrors the `maxFillHeight` a caller passes to the grade solver; it is
 * restated here because the network builder is not given those constraints.
 */
export const MAX_FILL_FOR_STRUCTURE = 10

/**
 * Concatenate several meshes into one, renumbering indices.
 *
 * Typed arrays are copied with `set` rather than spread — spreading a large
 * `Float32Array` into a function call blows the argument limit, and these
 * meshes are unbounded in size.
 */
const mergeMeshes = (meshes: readonly MeshData[]): MeshData => {
  let vertexCount = 0
  let indexCount = 0
  for (const mesh of meshes) {
    vertexCount += mesh.vertexCount
    indexCount += mesh.indices.length
  }

  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  const indices = new Uint32Array(indexCount)

  let vertexBase = 0
  let indexBase = 0
  for (const mesh of meshes) {
    positions.set(mesh.positions, vertexBase * 3)
    normals.set(mesh.normals, vertexBase * 3)
    uvs.set(mesh.uvs, vertexBase * 2)
    for (let i = 0; i < mesh.indices.length; i++) {
      indices[indexBase + i] = mesh.indices[i]! + vertexBase
    }
    vertexBase += mesh.vertexCount
    indexBase += mesh.indices.length
  }

  return {
    positions, normals, uvs, indices,
    vertexCount,
    triangleCount: indexCount / 3,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS. The suite grows by 7.

- [ ] **Step 5: Draw structures in the scene**

In `src/debug/roadScene.ts`, pass the terrain and template through, and add a mesh per road's structures. Where `buildNetworkMesh` is currently called, supply the new options:

```ts
  const built = buildNetworkMesh(network, designs, {
    spacing: 4,
    terrain: editLayer,
    corridorTemplate: CORRIDOR_TEMPLATE,
  })
```

`CORRIDOR_TEMPLATE` and `editLayer` already exist in that file. Then, after the junction loop, add:

```ts
  const STRUCTURE_COLOUR = 0x9a958c

  for (const [, structureMesh] of built.structures) {
    if (structureMesh.vertexCount === 0) continue
    scene.add(new THREE.Mesh(
      toBufferGeometry(structureMesh),
      new THREE.MeshStandardMaterial({
        color: STRUCTURE_COLOUR, roughness: 0.85, side: THREE.DoubleSide,
      }),
    ))
  }

  if (built.tightCrossings.size > 0) {
    console.warn('crossings below minimum clearance', [...built.tightCrossings.entries()])
  }
```

- [ ] **Step 6: Verify the typecheck and full suite**

```bash
npm run build && npm test
```

Expected: no TypeScript errors; all tests pass.

- [ ] **Step 7: Commit and push**

```bash
git add -A
git commit -m "feat: wire structures into the network mesh and scene"
git push
```

- [ ] **Step 8: Hand off for visual inspection**

Do not attempt the visual check yourself. The dev server serves at `http://localhost:5173/chainage/`, not `/`.

What the reviewer will check:

- Retaining walls appear as vertical panels along the road where the corridor is constrained.
- No structure appears where the road sits comfortably on the ground.
- No console warning about tight crossings, since the demo network has none.
- The walls sit flush against the road edge rather than floating beside it or sunk into the terrain.

---

## Plan complete

All three structure types have geometry, and both previously-unused triggers finally drive something.

### Deliberately not in this plan

**Overpass geometry.** Task 5 detects crossings and reports tight ones, but a crossing with adequate clearance does not yet force a bridge span. Wiring that in means treating "crosses another road" as a third input to `classifySupport`, which is a change to the grade solver's contract and deserves its own consideration.

**Construction staging for structures.** The construction spec gives structures their own station between earthworks and subgrade. Nothing here renders a half-built bridge.

**Bridge appearance.** Boxes and columns, no parapets, bearings or girders. Enough to read as a bridge at diorama distance; not enough to look at closely.

**Next plan:** Interactive tool and the diorama look — where drawing a road becomes something you do rather than something the code does, and where tilt-shift finally lands.
