import { describe, it, expect } from 'vitest'
import { junctionLegs } from './junctionLegs'
import { RoadNetwork } from '../network/graph'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import { ROAD_CLASSES, formationHalfWidth } from './roadClass'

/** Three roads radiating from (100, 0): west, north, south. */
const tJunction = () => {
  const net = new RoadNetwork()
  // Arrives from the west, so its 'end' is at the node and points back west.
  net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 100)]), 'rural')
  net.addRoad(new Alignment([new Line(vec2(100, 0), Math.PI / 2, 100)]), 'rural')
  net.addRoad(new Alignment([new Line(vec2(100, 0), -Math.PI / 2, 100)]), 'rural')
  return net
}

describe('junctionLegs', () => {
  it('returns one leg per connected road end', () => {
    const net = tJunction()
    const legs = junctionLegs(net, net.nodeAt(vec2(100, 0))!.id)
    expect(legs).toHaveLength(3)
  })

  it('points every direction outward from the node', () => {
    const net = tJunction()
    const legs = junctionLegs(net, net.nodeAt(vec2(100, 0))!.id)
    // West-pointing (the arriving road reversed), north, south.
    const bearings = legs.map((l) => Math.round((l.bearing * 180) / Math.PI))
    expect(bearings.sort((a, b) => a - b)).toEqual([-90, 90, 180])
  })

  it('sorts legs counter-clockwise by bearing', () => {
    const net = tJunction()
    const legs = junctionLegs(net, net.nodeAt(vec2(100, 0))!.id)
    for (let i = 1; i < legs.length; i++) {
      expect(legs[i]!.bearing).toBeGreaterThan(legs[i - 1]!.bearing)
    }
  })

  it('gives each leg the half width of its road class', () => {
    const net = tJunction()
    const legs = junctionLegs(net, net.nodeAt(vec2(100, 0))!.id)
    const expected = formationHalfWidth(ROAD_CLASSES.rural)
    for (const leg of legs) expect(leg.halfWidth).toBeCloseTo(expected, 9)
  })

  it('reads a wider half width for a wider class', () => {
    const net = new RoadNetwork()
    net.addRoad(new Alignment([new Line(vec2(0, 0), 0, 100)]), 'highway')
    net.addRoad(new Alignment([new Line(vec2(100, 0), Math.PI / 2, 100)]), 'gravel')
    const legs = junctionLegs(net, net.nodeAt(vec2(100, 0))!.id)
    const widths = legs.map((l) => l.halfWidth).sort((a, b) => a - b)
    expect(widths[0]).toBeCloseTo(formationHalfWidth(ROAD_CLASSES.gravel), 9)
    expect(widths[1]).toBeCloseTo(formationHalfWidth(ROAD_CLASSES.highway), 9)
  })

  it('gives a unit direction vector', () => {
    const net = tJunction()
    const legs = junctionLegs(net, net.nodeAt(vec2(100, 0))!.id)
    for (const leg of legs) {
      expect(Math.hypot(leg.direction.x, leg.direction.y)).toBeCloseTo(1, 9)
    }
  })

  it('agrees between direction and bearing', () => {
    const net = tJunction()
    const legs = junctionLegs(net, net.nodeAt(vec2(100, 0))!.id)
    for (const leg of legs) {
      expect(Math.cos(leg.bearing)).toBeCloseTo(leg.direction.x, 9)
      expect(Math.sin(leg.bearing)).toBeCloseTo(leg.direction.y, 9)
    }
  })

  it('records which road end each leg came from', () => {
    const net = tJunction()
    const legs = junctionLegs(net, net.nodeAt(vec2(100, 0))!.id)
    expect(legs.filter((l) => l.end === 'end')).toHaveLength(1)
    expect(legs.filter((l) => l.end === 'start')).toHaveLength(2)
  })

  it('returns a single leg for a dead end', () => {
    const net = tJunction()
    const legs = junctionLegs(net, net.nodeAt(vec2(0, 0))!.id)
    expect(legs).toHaveLength(1)
    // The road leaves the dead end heading east.
    expect(legs[0]!.direction.x).toBeCloseTo(1, 9)
  })
})
