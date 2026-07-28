import { describe, it, expect } from 'vitest'
import { terrainBounds, terrainFocus, distanceToFrame, frameRoadRun } from './cameraFraming'
import { Heightmap } from '../terrain/heightmap'
import { buildTerrain } from '../debug/roadScene'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import type { ProfilePoint } from '../terrain/groundProfile'

/**
 * `terrainBounds` sizes the sun's shadow camera and `terrainFocus` aims the
 * camera rig (see `drawRoadScene`), so these are the two pieces of that setup
 * that are pure functions of the terrain and testable without a renderer —
 * everything else there needs a real `THREE.DirectionalLight` and a GPU.
 *
 * They used to live in `debug/roadScene.ts`, the one file in this project
 * without unit tests and the one every defect in its history has lived in.
 * They are arithmetic, so they moved out.
 */
describe('terrainBounds', () => {
  it('centres on a flat heightmap\'s footprint, at its own elevation', () => {
    // 3x3 grid, cellSize 10, all elevations 0: a 20x20 footprint centred on
    // (10, 10), with no elevation spread at all.
    const flat = new Heightmap(0, 0, 10, 3, 3, new Float32Array(9))
    const bounds = terrainBounds(flat)

    expect(bounds.centerX).toBe(10)
    expect(bounds.centerY).toBe(10)
    expect(bounds.centerZ).toBe(0)
    // Half-footprint is (10, 10) with no elevation spread, so the enclosing
    // sphere's radius is exactly the flat diagonal: hypot(10, 10, 0).
    expect(bounds.radius).toBeCloseTo(Math.hypot(10, 10, 0), 10)
  })

  it("grows the radius to cover the heightmap's own elevation spread", () => {
    // 2x2 grid, cellSize 1, origin (5, 5): a single cell, one corner raised
    // 10m above the other three — minZ=0, maxZ=10.
    const elevations = new Float32Array([0, 0, 0, 10])
    const bumpy = new Heightmap(5, 5, 1, 2, 2, elevations)
    const bounds = terrainBounds(bumpy)

    expect(bounds.centerX).toBe(5.5)
    expect(bounds.centerY).toBe(5.5)
    // Midpoint of the elevation range, not the mean of the four samples.
    expect(bounds.centerZ).toBe(5)
    // Half-footprint (0.5, 0.5) plus half the elevation spread (5) — a
    // flat-heightmap radius (as above) would badly undersize the shadow
    // camera's frustum against this much relief.
    expect(bounds.radius).toBeCloseTo(Math.hypot(0.5, 0.5, 5), 10)
  })
})

/**
 * Where the camera looks when there is nothing built to look at.
 *
 * The rig used to target `JUNCTION`, `vec2(900, 1280)` — the point the demo
 * network's three arms were built around. Those arms no longer ship, so that
 * coordinate stopped meaning anything while still looking deliberate, which is
 * the worst of both.
 *
 * The game now opens on a bridge and `frameRoadRun` aims at that instead; this
 * is the fallback, and it is not a dead branch — it is the scene the moment a
 * player deletes their last road.
 */
describe('terrainFocus', () => {
  it('aims at the middle of the footprint, on the ground there', () => {
    // A 4x4 grid at cellSize 10 from origin (100, 200): a 30x30 footprint, so
    // the plan centre is (115, 215). Elevations climb 7m per row, so the
    // bilinear sample halfway between rows 1 and 2 is 10.5.
    const elevations = new Float32Array(16)
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) elevations[row * 4 + col] = row * 7
    }
    const slope = new Heightmap(100, 200, 10, 4, 4, elevations)

    const focus = terrainFocus(slope)
    expect(focus.x).toBe(115)
    expect(focus.y).toBe(215)
    expect(focus.z).toBeCloseTo(10.5, 10)
  })

  it('stands on the ground, not halfway up the elevation range', () => {
    // The trap `terrainBounds.centerZ` would have walked into. A basin: a flat
    // floor at 0 with a single 100m peak in one corner. `centerZ` is 50 —
    // fifty metres of clear air above the ground the camera is looking at.
    const elevations = new Float32Array(9)
    elevations[0] = 100
    const basin = new Heightmap(0, 0, 10, 3, 3, elevations)

    expect(terrainBounds(basin).centerZ).toBe(50)
    expect(terrainFocus(basin).z).toBe(0)
  })

  it('reads the ground from whatever sampler it is given', () => {
    // The elevation comes from the second argument when there is one, so a
    // caller holding an edit layer can aim at excavated ground rather than at
    // the natural surface underneath it.
    const flat = new Heightmap(0, 0, 10, 3, 3, new Float32Array(9))
    const dug = { sample: () => -12 }

    expect(terrainFocus(flat, dug)).toEqual({ x: 10, y: 10, z: -12 })
  })

  it('is not the junction the camera was once hardcoded to', () => {
    // The mutation this test exists to catch: restoring `vec2(900, 1280)`,
    // the demo T junction, as the rig target. It is a point defined by three
    // roads the game no longer ships, and on this terrain it is 380m west of
    // the middle of the map.
    const focus = terrainFocus(buildTerrain())

    // The terrain is a 2560m square from the origin, so its middle is
    // (1280, 1280) — derived, and nowhere near the old x.
    expect(focus.x).toBe(1280)
    expect(focus.y).toBe(1280)
    expect(focus.x).not.toBe(900)
    expect(Math.hypot(focus.x - 900, focus.y - 1280)).toBeCloseTo(380, 6)

    // And it really is on the ground — the valley floor, a little off the
    // meandering axis. Well below the ridges (floor 100 + ridgeHeight 70) and
    // well above nothing at all, so a focus that silently became 0 or the
    // elevation midpoint would fail here.
    expect(focus.z).toBeCloseTo(89.9615, 4)
  })
})

/**
 * How far back the camera stands.
 *
 * The opening distance used to be a constant (`RIG_INITIAL_DISTANCE = 300`)
 * with a paragraph of justification and no way to check it. It is now derived
 * from the size of what is being looked at, which means it is arithmetic, and
 * arithmetic that decides what a player sees on the first frame is exactly
 * what this project keeps out of `roadScene.ts`.
 */
describe('distanceToFrame', () => {
  it('puts a subject exactly across the frame at the classic 90-degree case', () => {
    // At a 90-degree vertical field the frustum's half-height equals the
    // distance, so a subject fills the frame at half its own size. No
    // trigonometry needed to check this one by hand.
    expect(distanceToFrame(100, 90)).toBeCloseTo(50, 10)
  })

  it('is the inverse of the frustum half-height it is solving', () => {
    // The property, rather than a second copy of the formula: whatever
    // distance comes back, the frustum at that distance must be exactly the
    // extent that was asked for.
    for (const [extent, fov] of [[194.475, 45], [30, 60], [2000, 12]] as const) {
      const d = distanceToFrame(extent, fov)
      const frustumHeight = 2 * d * Math.tan((fov * Math.PI) / 360)
      expect(frustumHeight).toBeCloseTo(extent, 8)
    }
  })

  it('stands further back for a narrower lens', () => {
    expect(distanceToFrame(100, 30)).toBeGreaterThan(distanceToFrame(100, 45))
    expect(distanceToFrame(100, 45)).toBeGreaterThan(distanceToFrame(100, 60))
  })

  it('refuses an extent or a field of view that is not a lens', () => {
    expect(() => distanceToFrame(0, 45)).toThrow(RangeError)
    expect(() => distanceToFrame(-1, 45)).toThrow(RangeError)
    expect(() => distanceToFrame(100, 0)).toThrow(RangeError)
    expect(() => distanceToFrame(100, 180)).toThrow(RangeError)
  })
})

describe('frameRoadRun', () => {
  /** A 300m straight running east, with a design line that climbs 30m over
   * it. Deliberately NOT level: the elevation is the part a plan-only framing
   * would get wrong. */
  const straight = new Alignment([new Line(vec2(0, 0), 0, 300)])
  const climbing: ProfilePoint[] = [{ s: 0, z: 100 }, { s: 300, z: 130 }]

  it('aims at the middle of the run, at the elevation it was built to', () => {
    const { target } = frameRoadRun(straight, climbing, 100, 200, 45, 1)

    expect(target.x).toBeCloseTo(150, 10)
    expect(target.y).toBeCloseTo(0, 10)
    // 150m along a line climbing 0.1 m/m from 100m: 115m, not the 0 a missing
    // design profile gives and not the ground, which this never looks at.
    expect(target.z).toBeCloseTo(115, 10)
  })

  it('measures the run in three dimensions, not in plan', () => {
    // 100m of plan, 10m of climb: the chord is hypot(100, 10), so the camera
    // stands slightly further back than a plan-length framing would put it.
    const chord = Math.hypot(100, 10)
    const { distance } = frameRoadRun(straight, climbing, 100, 200, 45, 1)

    expect(distance).toBeCloseTo(distanceToFrame(chord, 45), 10)
    expect(distance).toBeGreaterThan(distanceToFrame(100, 45))
  })

  it('stands proportionally further back for a smaller fill', () => {
    const full = frameRoadRun(straight, climbing, 100, 200, 45, 1)
    const half = frameRoadRun(straight, climbing, 100, 200, 45, 0.5)

    expect(half.distance).toBeCloseTo(full.distance * 2, 8)
    // The target does not move when the framing loosens — only the distance.
    expect(half.target).toEqual(full.target)
  })

  it('refuses a run that is not a run, or a fill that is not a fraction', () => {
    expect(() => frameRoadRun(straight, climbing, 200, 200, 45, 1)).toThrow(RangeError)
    expect(() => frameRoadRun(straight, climbing, 200, 100, 45, 1)).toThrow(RangeError)
    expect(() => frameRoadRun(straight, climbing, 100, 200, 45, 0)).toThrow(RangeError)
    expect(() => frameRoadRun(straight, climbing, 100, 200, 45, 1.5)).toThrow(RangeError)
  })
})
