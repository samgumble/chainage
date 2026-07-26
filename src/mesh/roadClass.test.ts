import { describe, it, expect } from 'vitest'
import {
  ROAD_CLASSES, carriagewayHalfWidth, formationHalfWidth, totalPavementThickness,
  type RoadClassName,
} from './roadClass'

const ALL: RoadClassName[] = ['gravel', 'rural', 'arterial', 'highway']

describe('ROAD_CLASSES', () => {
  it('defines every class', () => {
    for (const name of ALL) expect(ROAD_CLASSES[name].name).toBe(name)
  })

  it('gets wider and faster up the hierarchy', () => {
    let width = 0
    let speed = 0
    for (const name of ALL) {
      const rc = ROAD_CLASSES[name]
      expect(formationHalfWidth(rc)).toBeGreaterThan(width)
      expect(rc.designSpeedKph).toBeGreaterThan(speed)
      width = formationHalfWidth(rc)
      speed = rc.designSpeedKph
    }
  })

  it('gives every class a positive lane width and lane count', () => {
    for (const name of ALL) {
      expect(ROAD_CLASSES[name].laneWidth).toBeGreaterThan(0)
      expect(ROAD_CLASSES[name].laneCount).toBeGreaterThanOrEqual(1)
    }
  })

  it('uses a crossfall that sheds water without being felt', () => {
    for (const name of ALL) {
      expect(ROAD_CLASSES[name].crossfall).toBeGreaterThanOrEqual(0.02)
      expect(ROAD_CLASSES[name].crossfall).toBeLessThanOrEqual(0.05)
    }
  })
})

describe('layers', () => {
  it('orders layers bottom-up: subgrade, base, wearing', () => {
    for (const name of ALL) {
      expect(ROAD_CLASSES[name].layers.map((l) => l.name)).toEqual([
        'subgrade', 'base', 'wearing',
      ])
    }
  })

  it('gives every layer a positive thickness', () => {
    for (const name of ALL) {
      for (const layer of ROAD_CLASSES[name].layers) {
        expect(layer.thickness).toBeGreaterThan(0)
      }
    }
  })

  it('makes lower layers wider than upper ones', () => {
    for (const name of ALL) {
      const ext = ROAD_CLASSES[name].layers.map((l) => l.widthExtension)
      expect(ext[0]!).toBeGreaterThan(ext[1]!)
      expect(ext[1]!).toBeGreaterThan(ext[2]!)
      expect(ext[2]!).toBe(0)
    }
  })

  it('builds thicker pavement for heavier classes', () => {
    expect(totalPavementThickness(ROAD_CLASSES.highway))
      .toBeGreaterThan(totalPavementThickness(ROAD_CLASSES.gravel))
  })

  it('keeps total pavement within a realistic band', () => {
    for (const name of ALL) {
      const t = totalPavementThickness(ROAD_CLASSES[name])
      expect(t).toBeGreaterThan(0.15)
      expect(t).toBeLessThan(1.2)
    }
  })
})

describe('width helpers', () => {
  it('computes carriageway half width from lanes', () => {
    const rc = ROAD_CLASSES.rural
    expect(carriagewayHalfWidth(rc)).toBeCloseTo((rc.laneCount * rc.laneWidth) / 2, 9)
  })

  it('adds shoulders for formation half width', () => {
    const rc = ROAD_CLASSES.rural
    expect(formationHalfWidth(rc)).toBeCloseTo(
      carriagewayHalfWidth(rc) + rc.shoulderWidth, 9,
    )
  })

  it('gives a divided highway more lanes than a rural road', () => {
    expect(ROAD_CLASSES.highway.laneCount).toBeGreaterThan(ROAD_CLASSES.rural.laneCount)
  })
})
