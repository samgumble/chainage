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
