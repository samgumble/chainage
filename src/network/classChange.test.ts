import { describe, expect, it } from 'vitest'
import { Alignment } from '../geometry/alignment'
import { minimumRadiusForSpeed } from '../geometry/designSpeed'
import { Arc, Line } from '../geometry/primitives'
import { Spiral } from '../geometry/spiral'
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
    // The severe arc spans stations 60 to 120 and has constant curvature
    // throughout, so with the endpoint scan the reported station must be one
    // of its two ends — a real constraint on the implementation, not a
    // tautology like ">= 60" (which the first arc's own end station would
    // already satisfy regardless of which arc is reported).
    expect(result.rejection.station).toBeGreaterThanOrEqual(60)
    expect(result.rejection.station).toBeLessThanOrEqual(120)
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

  it('catches a sub-metre illegal arc that a 1-metre sampling grid steps over', () => {
    const required = minimumRadiusForSpeed(ROAD_CLASSES.highway.designSpeedKph)
    const tight = required / 3

    // A 0.5m arc sitting strictly between the s=10 and s=11 grid points, with
    // dead-straight, curvature-0 line either side. A fixed 1m sample grid
    // visits 10 and 11 and nothing in between, so it never sees the arc.
    const line1 = new Line({ x: 0, y: 0 }, 0, 10.3)
    const p1 = line1.poseAt(10.3)
    const arc = new Arc(p1.position, p1.heading, 0.5, 1 / tight)
    const p2 = arc.poseAt(0.5)
    const line2 = new Line(p2.position, p2.heading, 10)

    const road = roadWith(new Alignment([line1, arc, line2]), 'gravel')

    const result = checkClassChange(road, 'highway')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.actualRadius).toBeCloseTo(tight, 3)
    expect(result.rejection.station).toBeGreaterThanOrEqual(10.3)
    expect(result.rejection.station).toBeLessThanOrEqual(10.8)
  })

  it("finds a Spiral's peak curvature at its start, off the sample grid", () => {
    // Mirror of the test below: a road that OPENS with a spiral unwinding
    // from an illegal curvature down to a legal one. This is how a road
    // leaves a curve, so it is a realistic shape, not a contrived one. A
    // scan that only checks each primitive's end station (dropping station 0
    // entirely) would see curvature 0 at the spiral's end and 0 throughout
    // the trailing line, and never see the illegal peak at station 0.
    const required = minimumRadiusForSpeed(ROAD_CLASSES.highway.designSpeedKph)
    const startCurvature = 1 / (0.99 * required)

    const spiral = new Spiral({ x: 0, y: 0 }, 0, 10.5, startCurvature, 0)
    const p = spiral.poseAt(10.5)
    const line = new Line(p.position, p.heading, 10)

    const road = roadWith(new Alignment([spiral, line]), 'gravel')

    const result = checkClassChange(road, 'highway')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.actualRadius).toBeCloseTo(0.99 * required, 3)
    expect(result.rejection.station).toBeCloseTo(0, 6)
  })

  it("finds a Spiral's peak curvature at its endpoint, off the sample grid", () => {
    const required = minimumRadiusForSpeed(ROAD_CLASSES.highway.designSpeedKph)
    // Just barely illegal at the very tip of the spiral; curvature scales
    // linearly down from there, so both neighbouring 1m grid points (10 and
    // 11) sit comfortably on the legal side.
    const endCurvature = 1 / (0.99 * required)

    const spiral = new Spiral({ x: 0, y: 0 }, 0, 10.5, 0, endCurvature)
    const p = spiral.poseAt(10.5)
    const line = new Line(p.position, p.heading, 10)

    const road = roadWith(new Alignment([spiral, line]), 'gravel')

    const result = checkClassChange(road, 'highway')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.actualRadius).toBeCloseTo(0.99 * required, 3)
    expect(result.rejection.station).toBeCloseTo(10.5, 6)
  })
})
