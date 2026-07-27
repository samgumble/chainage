import { describe, expect, it } from 'vitest'
import { rayTerrainIntersection } from './rayCast'

/** Flat ground at a fixed height. */
const flat = (z: number) => ({ sample: () => z })

/** Ground rising one metre per metre east. */
const ramp = { sample: (x: number) => x }

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
