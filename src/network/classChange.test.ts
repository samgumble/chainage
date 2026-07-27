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
    // Not toBeGreaterThan(60): Alignment.primitiveAt assigns an exact
    // boundary station to the later primitive (see alignment.ts and
    // alignment.test.ts "assigns a boundary station to the later
    // primitive"), so with two 60m arcs and the default 1m sample spacing,
    // poseAt(60) already reports the second arc's curvature. The tightest
    // curve genuinely begins at s=60; requiring station > 60 would demand a
    // sample that lands past the joint, which the fixture's round numbers
    // never produce.
    expect(result.rejection.station).toBeGreaterThanOrEqual(60)
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
