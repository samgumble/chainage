import { describe, expect, it } from 'vitest'
import { Alignment } from '../geometry/alignment'
import { minimumRadiusForSpeed } from '../geometry/designSpeed'
import { Arc, Line } from '../geometry/primitives'
import { RoadNetwork } from '../network/graph'
import { ROAD_CLASSES } from '../network/roadClass'
import { checkUpgrade } from './upgradeCheck'
import { MAX_TRIM_DISTANCE } from './junctionCorners'

const straight = (from: { x: number; y: number }, heading: number, length: number) =>
  new Alignment([new Line(from, heading, length)])

/** Three roads leaving the origin at 120-degree spacing — a clean Y junction. */
const yJunction = () => {
  const net = new RoadNetwork()
  const a = net.addRoad(straight({ x: 0, y: 0 }, 0, 300), 'gravel')
  net.addRoad(straight({ x: 0, y: 0 }, (2 * Math.PI) / 3, 300), 'gravel')
  net.addRoad(straight({ x: 0, y: 0 }, (4 * Math.PI) / 3, 300), 'gravel')
  return { net, a }
}

describe('checkUpgrade', () => {
  it('allows an upgrade a well-spaced junction can absorb', () => {
    const { net, a } = yJunction()
    expect(checkUpgrade(net, a, 'rural')).toEqual({ ok: true })
  })

  it('reports a curve too tight for the new class', () => {
    const net = new RoadNetwork()
    const tight = minimumRadiusForSpeed(ROAD_CLASSES.highway.designSpeedKph) / 4
    const id = net.addRoad(
      new Alignment([new Arc({ x: 0, y: 0 }, 0, 200, 1 / tight)]),
      'gravel',
    )

    const result = checkUpgrade(net, id, 'highway')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.obstacles).toHaveLength(1)
    expect(result.obstacles[0]?.kind).toBe('alignment')
  })

  it('reports a junction that stops solving at the wider formation', () => {
    // Two roads leaving at a shallow angle plus a third: the corner between
    // the near-parallel pair runs away as their half-widths grow. 0.03 rad
    // turned out to already be too tight even at gravel widths (verified by
    // sweeping the angle against the real solver — see task-6-report.md);
    // 0.15 rad is comfortably inside the range (~0.07-0.27 rad) where gravel
    // solves and highway does not.
    const net = new RoadNetwork()
    const a = net.addRoad(straight({ x: 0, y: 0 }, 0, 400), 'gravel')
    net.addRoad(straight({ x: 0, y: 0 }, 0.15, 400), 'gravel')
    net.addRoad(straight({ x: 0, y: 0 }, Math.PI, 400), 'gravel')

    const before = checkUpgrade(net, a, 'gravel')
    expect(before).toEqual({ ok: true })

    const result = checkUpgrade(net, a, 'highway')
    expect(result.ok).toBe(false)
    if (result.ok) return
    const junction = result.obstacles.find((o) => o.kind === 'junction')
    expect(junction).toBeDefined()
  })

  it('says why a junction obstacle cannot be built when the reason is trim-too-long', () => {
    // Same near-parallel pair as "reports a junction that stops solving at
    // the wider formation": a player told 'trim-too-long' alone cannot tell
    // whether they are one metre over the limit or forty, nor which legs are
    // the problem. This pins that the numbers and the offending leg(s) are
    // actually reported.
    const net = new RoadNetwork()
    const a = net.addRoad(straight({ x: 0, y: 0 }, 0, 400), 'gravel')
    const b = net.addRoad(straight({ x: 0, y: 0 }, 0.15, 400), 'gravel')
    const through = net.addRoad(straight({ x: 0, y: 0 }, Math.PI, 400), 'gravel')

    const result = checkUpgrade(net, a, 'highway')
    expect(result.ok).toBe(false)
    if (result.ok) return

    const junction = result.obstacles.find((o) => o.kind === 'junction')
    expect(junction).toBeDefined()
    if (junction?.kind !== 'junction') return
    expect(junction.reason).toBe('trim-too-long')
    if (junction.reason !== 'trim-too-long') return

    expect(junction.worstTrim).toBeGreaterThan(junction.maxTrim)
    expect(junction.maxTrim).toBe(MAX_TRIM_DISTANCE)
    // The near-parallel pair (a and b) is where the corner runs away; the
    // near-straight-through leg contributes almost no trim by comparison, so
    // it must not be reported as the offender.
    expect(junction.worstLegs.length).toBeGreaterThan(0)
    expect(junction.worstLegs.every((leg) => leg.roadId === a || leg.roadId === b)).toBe(true)
    expect(junction.worstLegs.some((leg) => leg.roadId === through)).toBe(false)
  })

  it('checks the junctions at both ends', () => {
    const net = new RoadNetwork()
    const spine = net.addRoad(straight({ x: 0, y: 0 }, 0, 400), 'gravel')
    // A tight fan at the far end only.
    const far = { x: 400, y: 0 }
    net.addRoad(straight(far, 0.03, 400), 'gravel')
    net.addRoad(straight(far, Math.PI + 0.5, 400), 'gravel')

    const result = checkUpgrade(net, spine, 'highway')
    expect(result.ok).toBe(false)
    if (result.ok) return
    const junction = result.obstacles.find((o) => o.kind === 'junction')
    expect(junction).toBeDefined()
    if (junction?.kind !== 'junction') return
    expect(junction.nodeId).toBe(net.road(spine).endNode)
  })

  it('ignores nodes that are not junctions', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight({ x: 0, y: 0 }, 0, 400), 'gravel')
    // Two dead ends. solveJunction would call these 'too-few-legs', which is
    // a fact about a dead end, not an obstacle to upgrading.
    expect(checkUpgrade(net, id, 'highway')).toEqual({ ok: true })
  })

  it('reports every obstacle at once', () => {
    const net = new RoadNetwork()
    const tight = minimumRadiusForSpeed(ROAD_CLASSES.highway.designSpeedKph) / 4
    const arc = new Arc({ x: 0, y: 0 }, 0, 200, 1 / tight)
    const id = net.addRoad(new Alignment([arc]), 'gravel')
    net.addRoad(straight({ x: 0, y: 0 }, 0.15, 400), 'gravel')
    net.addRoad(straight({ x: 0, y: 0 }, Math.PI, 400), 'gravel')

    const result = checkUpgrade(net, id, 'highway')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.obstacles.some((o) => o.kind === 'alignment')).toBe(true)
    expect(result.obstacles.some((o) => o.kind === 'junction')).toBe(true)
  })

  it('rejects an unknown road id', () => {
    const net = new RoadNetwork()
    expect(() => checkUpgrade(net, 999, 'rural')).toThrow(RangeError)
  })
})
