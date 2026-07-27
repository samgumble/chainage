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
