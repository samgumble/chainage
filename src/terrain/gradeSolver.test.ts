import { describe, it, expect } from 'vitest'
import { solveGradeProfile, classifySupport, type GradeConstraints } from './gradeSolver'
import type { ProfilePoint } from './groundProfile'

const constraints = (over: Partial<GradeConstraints> = {}): GradeConstraints => ({
  maxGrade: 0.07,
  maxCutDepth: 10,
  maxFillHeight: 10,
  ...over,
})

/** Ground points every 25m from a list of elevations. */
const ground = (elevations: number[]): ProfilePoint[] =>
  elevations.map((z, i) => ({ s: i * 25, z }))

const gradesOf = (p: readonly ProfilePoint[]): number[] => {
  const g: number[] = []
  for (let i = 1; i < p.length; i++) {
    g.push((p[i]!.z - p[i - 1]!.z) / (p[i]!.s - p[i - 1]!.s))
  }
  return g
}

describe('solveGradeProfile — feasible cases', () => {
  it('follows flat ground exactly', () => {
    const r = solveGradeProfile(ground([100, 100, 100, 100]), constraints())
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    for (const p of r.profile) expect(p.z).toBeCloseTo(100, 9)
  })

  it('follows gentle ground exactly when within the grade limit', () => {
    // 1m rise per 25m = 4% grade, under the 7% limit.
    const r = solveGradeProfile(ground([100, 101, 102, 103]), constraints())
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    expect(r.profile.map((p) => p.z)).toEqual([100, 101, 102, 103])
  })

  it('never exceeds the maximum grade on steep ground', () => {
    // 5m rise per 25m = 20% ground grade, far over the limit.
    const r = solveGradeProfile(ground([100, 105, 110, 115, 120]), constraints())
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    for (const g of gradesOf(r.profile)) {
      expect(Math.abs(g)).toBeLessThanOrEqual(0.07 + 1e-9)
    }
  })

  it('smooths a single sharp bump rather than following it', () => {
    const r = solveGradeProfile(ground([100, 100, 108, 100, 100]), constraints())
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    // The peak must be cut down; 8m over 25m is 32%.
    expect(r.profile[2]!.z).toBeLessThan(108)
    for (const g of gradesOf(r.profile)) {
      expect(Math.abs(g)).toBeLessThanOrEqual(0.07 + 1e-9)
    }
  })

  it('stays within the permitted cut and fill envelope', () => {
    // Ground rises 5m per 25m station — a 20% grade against a 7% limit — so
    // the solver must deviate substantially and the envelope genuinely binds.
    // A 10m allowance is the smallest that keeps this feasible: the solution
    // lands exactly on the cut limit at the final station. With 6m the bands
    // collapse to min 114 > max 113 there and the alignment is infeasible.
    const gp = ground([100, 105, 110, 115, 120])
    const allowance = 10
    const r = solveGradeProfile(
      gp,
      constraints({ maxCutDepth: allowance, maxFillHeight: allowance }),
    )
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    r.profile.forEach((p, i) => {
      expect(p.z).toBeGreaterThanOrEqual(gp[i]!.z - allowance - 1e-9)
      expect(p.z).toBeLessThanOrEqual(gp[i]!.z + allowance + 1e-9)
    })
    // The last station sits exactly at the cut limit, so this is not a
    // vacuous pass — a solver that ignored the envelope would overshoot it.
    const last = r.profile[r.profile.length - 1]!
    expect(last.z).toBeCloseTo(gp[gp.length - 1]!.z - allowance, 6)
  })

  it('honours fixed start and end elevations', () => {
    const r = solveGradeProfile(
      ground([100, 100, 100, 100, 100]),
      constraints({ fixedStart: 98, fixedEnd: 102 }),
    )
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    expect(r.profile[0]!.z).toBeCloseTo(98, 9)
    expect(r.profile[4]!.z).toBeCloseTo(102, 9)
  })

  it('handles a single point', () => {
    const r = solveGradeProfile(ground([100]), constraints())
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    expect(r.profile).toHaveLength(1)
    expect(r.profile[0]!.z).toBeCloseTo(100, 9)
  })

  it('preserves the input stations exactly', () => {
    const gp = ground([100, 105, 110])
    const r = solveGradeProfile(gp, constraints())
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    expect(r.profile.map((p) => p.s)).toEqual(gp.map((p) => p.s))
  })
})

describe('solveGradeProfile — infeasible cases', () => {
  it('reports infeasible when fixed ends demand too steep a grade', () => {
    // 20m rise over 50m = 40%, with only 7% allowed.
    const r = solveGradeProfile(
      ground([100, 100, 100]),
      constraints({ fixedStart: 100, fixedEnd: 120, maxCutDepth: 0, maxFillHeight: 0 }),
    )
    expect(r.feasible).toBe(false)
  })

  it('reports infeasible when a cliff exceeds the cut and fill envelope', () => {
    // 40m step with only 2m of cut and fill available either side.
    const r = solveGradeProfile(
      ground([100, 100, 140, 140]),
      constraints({ maxCutDepth: 2, maxFillHeight: 2 }),
    )
    expect(r.feasible).toBe(false)
  })

  it('names the station where feasibility failed', () => {
    const r = solveGradeProfile(
      ground([100, 100, 140, 140]),
      constraints({ maxCutDepth: 2, maxFillHeight: 2 }),
    )
    expect(r.feasible).toBe(false)
    if (r.feasible) return
    expect(typeof r.failedAtStation).toBe('number')
    expect(r.failedAtStation).toBeGreaterThanOrEqual(0)
  })
})

describe('solveGradeProfile — argument validation', () => {
  it('returns an empty feasible profile for empty input', () => {
    const r = solveGradeProfile([], constraints())
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    expect(r.profile).toEqual([])
  })

  it('rejects a non-positive maximum grade', () => {
    expect(() => solveGradeProfile(ground([100]), constraints({ maxGrade: 0 }))).toThrow(RangeError)
  })

  it('rejects negative cut or fill allowances', () => {
    expect(() => solveGradeProfile(ground([100]), constraints({ maxCutDepth: -1 }))).toThrow(RangeError)
    expect(() => solveGradeProfile(ground([100]), constraints({ maxFillHeight: -1 }))).toThrow(RangeError)
  })
})

describe('structure allowance', () => {
  it('is infeasible across a ravine without one', () => {
    // A 40m ravine with 10m of fill available.
    const gp = ground([100, 100, 60, 100, 100])
    const r = solveGradeProfile(gp, constraints({ maxCutDepth: 10, maxFillHeight: 10 }))
    expect(r.feasible).toBe(false)
  })

  it('becomes feasible with a structure allowance', () => {
    const gp = ground([100, 100, 60, 100, 100])
    const r = solveGradeProfile(
      gp,
      constraints({ maxCutDepth: 10, maxFillHeight: 10, maxStructureHeight: 45 }),
    )
    expect(r.feasible).toBe(true)
  })

  it('carries the design line across the ravine rather than dropping into it', () => {
    const gp = ground([100, 100, 60, 100, 100])
    const r = solveGradeProfile(
      gp,
      constraints({ maxCutDepth: 10, maxFillHeight: 10, maxStructureHeight: 45 }),
    )
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    // The station over the ravine floor stays far above it.
    expect(r.profile[2]!.z).toBeGreaterThan(90)
  })

  it('still respects the cut side, which a structure does not help', () => {
    const gp = ground([100, 100, 100])
    const r = solveGradeProfile(
      gp,
      constraints({ maxCutDepth: 3, maxFillHeight: 3, maxStructureHeight: 50 }),
    )
    expect(r.feasible).toBe(true)
    if (!r.feasible) return
    for (const p of r.profile) expect(p.z).toBeGreaterThanOrEqual(97 - 1e-9)
  })

  it('rejects a structure allowance below the fill allowance', () => {
    expect(() =>
      solveGradeProfile(ground([100]), constraints({ maxFillHeight: 10, maxStructureHeight: 5 })),
    ).toThrow(RangeError)
  })

  it('behaves identically when the structure allowance equals the fill allowance', () => {
    const gp = ground([100, 105, 110, 115, 120])
    const withOut = solveGradeProfile(gp, constraints({ maxCutDepth: 10, maxFillHeight: 10 }))
    const withEqual = solveGradeProfile(
      gp,
      constraints({ maxCutDepth: 10, maxFillHeight: 10, maxStructureHeight: 10 }),
    )
    expect(withOut.feasible).toBe(true)
    expect(withEqual.feasible).toBe(true)
    if (!withOut.feasible || !withEqual.feasible) return
    expect(withEqual.profile.map((p) => p.z)).toEqual(withOut.profile.map((p) => p.z))
  })
})

describe('classifySupport', () => {
  it('marks stations standing above the fill allowance as structure', () => {
    const gp = ground([100, 100, 60, 100, 100])
    const design = ground([100, 100, 100, 100, 100])
    expect(classifySupport(gp, design, 10)).toEqual([
      'earthwork', 'earthwork', 'structure', 'earthwork', 'earthwork',
    ])
  })

  it('marks everything earthwork when the design hugs the ground', () => {
    const gp = ground([100, 101, 102])
    expect(classifySupport(gp, gp, 10)).toEqual(['earthwork', 'earthwork', 'earthwork'])
  })

  it('marks cut as earthwork however deep', () => {
    const gp = ground([100, 100, 100])
    const design = ground([80, 80, 80])
    expect(classifySupport(gp, design, 10)).toEqual(['earthwork', 'earthwork', 'earthwork'])
  })

  it('treats exactly the fill allowance as earthwork', () => {
    const gp = ground([100])
    const design = ground([110])
    expect(classifySupport(gp, design, 10)).toEqual(['earthwork'])
  })

  it('rejects mismatched lengths', () => {
    expect(() => classifySupport(ground([100, 100]), ground([100]), 10)).toThrow(RangeError)
  })
})
