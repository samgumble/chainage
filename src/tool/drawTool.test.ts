import { describe, expect, it } from 'vitest'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { distance } from '../geometry/vec2'
import { NODE_SNAP_DISTANCE, RoadNetwork } from '../network/graph'
import { DrawTool } from './drawTool'
import { roadAt } from './snap'

const straight = (x: number, y: number, heading: number, length: number) =>
  new Alignment([new Line({ x, y }, heading, length)])

describe('DrawTool', () => {
  it('starts with nothing pending', () => {
    const tool = new DrawTool(new RoadNetwork(), 'rural')
    expect(tool.points).toEqual([])
    expect(tool.preview).toBeUndefined()
  })

  it('offers no preview from a single point', () => {
    const tool = new DrawTool(new RoadNetwork(), 'rural')
    tool.place({ x: 0, y: 0 })
    expect(tool.points).toHaveLength(1)
    expect(tool.preview).toBeUndefined()
  })

  it('previews a straight once two points are placed', () => {
    const tool = new DrawTool(new RoadNetwork(), 'rural')
    tool.place({ x: 0, y: 0 })
    tool.place({ x: 200, y: 0 })

    expect(tool.preview?.ok).toBe(true)
    if (!tool.preview?.ok) return
    expect(tool.preview.alignment.length).toBeCloseTo(200, 6)
  })

  it('includes the hovered position in the preview without placing it', () => {
    const tool = new DrawTool(new RoadNetwork(), 'rural')
    tool.place({ x: 0, y: 0 })
    tool.hover({ x: 200, y: 0 })

    expect(tool.points).toHaveLength(1)
    expect(tool.preview?.ok).toBe(true)
    if (!tool.preview?.ok) return
    expect(tool.preview.alignment.length).toBeCloseTo(200, 6)
  })

  it('drops the hovered position once it is placed', () => {
    const tool = new DrawTool(new RoadNetwork(), 'rural')
    tool.place({ x: 0, y: 0 })
    tool.hover({ x: 200, y: 0 })
    tool.place({ x: 200, y: 0 })

    // Two placed points, not three: the hover must not survive as a duplicate.
    expect(tool.points).toHaveLength(2)
    if (!tool.preview?.ok) return
    expect(tool.preview.alignment.length).toBeCloseTo(200, 6)
  })

  it('snaps a placed point to a nearby node', () => {
    const net = new RoadNetwork()
    const existing = net.addRoad(straight(0, 0, 0, 100), 'rural')
    const startNode = net.road(existing).startNode

    const tool = new DrawTool(net, 'rural')
    tool.place({ x: 3, y: 4 })

    expect(tool.points[0]).toEqual({ x: 0, y: 0 })
    expect(tool.snapAt(0)?.kind).toBe('node')
    if (tool.snapAt(0)?.kind !== 'node') return
    expect(tool.snapAt(0)).toMatchObject({ nodeId: startNode })
  })

  it('surfaces a rejection instead of a preview when the geometry is impossible', () => {
    const tool = new DrawTool(new RoadNetwork(), 'rural')
    tool.place({ x: 0, y: 0 })
    tool.place({ x: 1000, y: 0 })
    tool.place({ x: 0, y: 1 })

    expect(tool.preview?.ok).toBe(false)
    if (tool.preview?.ok !== false) return
    expect(tool.preview.rejection.reason).toBe('corner-too-sharp')
  })

  it('uses a larger corner radius for a faster class', () => {
    const gravel = new DrawTool(new RoadNetwork(), 'gravel')
    const highway = new DrawTool(new RoadNetwork(), 'highway')
    expect(highway.cornerRadius).toBeGreaterThan(gravel.cornerRadius)
  })

  it('undoes the last placed point', () => {
    const tool = new DrawTool(new RoadNetwork(), 'rural')
    tool.place({ x: 0, y: 0 })
    tool.place({ x: 200, y: 0 })
    tool.undoLastPoint()

    expect(tool.points).toHaveLength(1)
    expect(tool.preview).toBeUndefined()
  })

  it('undoing with nothing placed is harmless', () => {
    const tool = new DrawTool(new RoadNetwork(), 'rural')
    expect(() => tool.undoLastPoint()).not.toThrow()
    expect(tool.points).toEqual([])
  })

  it('commits a road into the network and clears itself', () => {
    const net = new RoadNetwork()
    const tool = new DrawTool(net, 'rural')
    tool.place({ x: 0, y: 0 })
    tool.place({ x: 200, y: 0 })

    const result = tool.commit()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(net.roads).toHaveLength(1)
    expect(net.road(result.roadId).className).toBe('rural')
    expect(tool.points).toEqual([])
    expect(tool.preview).toBeUndefined()
  })

  it('refuses to commit an impossible alignment and keeps the points', () => {
    const net = new RoadNetwork()
    const tool = new DrawTool(net, 'rural')
    tool.place({ x: 0, y: 0 })
    tool.place({ x: 1000, y: 0 })
    tool.place({ x: 0, y: 1 })

    const result = tool.commit()
    expect(result.ok).toBe(false)
    expect(net.roads).toHaveLength(0)
    // The player's work is not thrown away because the last corner is bad.
    expect(tool.points).toHaveLength(3)
  })

  it('refuses to commit fewer than two points', () => {
    const net = new RoadNetwork()
    const tool = new DrawTool(net, 'rural')
    tool.place({ x: 0, y: 0 })

    expect(tool.commit().ok).toBe(false)
    expect(net.roads).toHaveLength(0)
  })

  it('splits an existing road when a placed point lands on one', () => {
    const net = new RoadNetwork()
    const existing = net.addRoad(straight(0, 0, 0, 400), 'rural')

    const tool = new DrawTool(net, 'rural')
    tool.place({ x: 200, y: 3 })   // on the existing road, away from its ends
    tool.place({ x: 200, y: 300 })

    const result = tool.commit()
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The original is gone, replaced by its two halves plus the new road.
    expect(() => net.road(existing)).toThrow(RangeError)
    expect(net.roads).toHaveLength(3)

    // And the new road starts at the junction, which now has three legs.
    const startNode = net.road(result.roadId).startNode
    expect(net.isJunction(startNode)).toBe(true)
  })

  it('splits an existing road at both ends when a bypass starts and ends on it', () => {
    const net = new RoadNetwork()
    const main = net.addRoad(straight(0, 0, 0, 1000), 'rural')

    const tool = new DrawTool(net, 'gravel')
    tool.place({ x: 300, y: 5 }) // snaps onto the main road, station ~300
    tool.place({ x: 500, y: 200 }) // off the road entirely — the detour
    tool.place({ x: 700, y: 5 }) // snaps onto the main road, station ~700

    const result = tool.commit()
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The main road is gone, replaced by three pieces (cut at both ends of
    // the bypass), plus the bypass itself: four roads total.
    expect(() => net.road(main)).toThrow(RangeError)
    expect(net.roads).toHaveLength(4)

    // Both ends of the new road are real junctions — three legs each, not a
    // through-road silently passing beside an unconnected node.
    const newRoad = net.road(result.roadId)
    expect(net.isJunction(newRoad.startNode)).toBe(true)
    expect(net.isJunction(newRoad.endNode)).toBe(true)
  })

  it('splits both ends correctly even when they are closer together than SNAP_RADIUS', () => {
    const net = new RoadNetwork()
    const main = net.addRoad(straight(0, 0, 0, 1000), 'rural')

    const tool = new DrawTool(net, 'gravel')
    // 10 metres apart — inside SNAP_RADIUS (15), so a fix that re-resolves
    // the second point with `resolveSnap` after the first split would find
    // the node the first split just created and wrongly skip the split.
    tool.place({ x: 300, y: 0 })
    tool.place({ x: 310, y: 0 })

    const result = tool.commit()
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(() => net.road(main)).toThrow(RangeError)
    expect(net.roads).toHaveLength(4)

    const newRoad = net.road(result.roadId)
    expect(net.isJunction(newRoad.startNode)).toBe(true)
    expect(net.isJunction(newRoad.endNode)).toBe(true)
  })

  it('breaks a bypass commit if the new road is added before its points are split', () => {
    // commit() always splits every placed point before adding the new road.
    // This test proves that ordering is load-bearing by replaying the same
    // two primitives (`roadAt`, `network.splitRoad`/`addRoad`) commit() uses,
    // but in the reversed order, directly against the network — DrawTool has
    // no public way to reverse its own internal order, so this reproduces
    // the reversed sequence at the level below it instead of asserting it
    // from reasoning about the code.
    const net = new RoadNetwork()
    const main = net.addRoad(straight(0, 0, 0, 1000), 'rural')

    const p1 = { x: 300, y: 0 }
    const p3 = { x: 700, y: 0 }
    const newAlignment = new Alignment([new Line(p1, 0, distance(p1, p3))])

    // Reversed: add the new road first...
    const newRoadId = net.addRoad(newAlignment, 'rural')

    // ...then try to split the points it landed on, exactly as commit()'s
    // loop does.
    for (const position of [p1, p3]) {
      const found = roadAt(net, position, 0.1)
      if (!found) continue
      const road = net.road(found.roadId)
      const distanceToEnd = road.alignment.length - found.station
      if (found.station <= NODE_SNAP_DISTANCE || distanceToEnd <= NODE_SNAP_DISTANCE) continue
      net.splitRoad(found.roadId, found.station)
    }

    // The new road's own centreline touches both points at distance zero —
    // that is where it was snapped to meet them — so it ties with the main
    // road as a candidate there. Once added, it wins that tie in practice,
    // so `roadAt` reports the new road itself as the match at both points,
    // and both look like they are already at one of its ends: nothing gets
    // split, and the main road never connects to the new one at all.
    expect(() => net.road(main)).not.toThrow()
    expect(net.roads).toHaveLength(2)
    const newRoad = net.road(newRoadId)
    expect(net.isJunction(newRoad.startNode)).toBe(false)
    expect(net.isJunction(newRoad.endNode)).toBe(false)
  })

  it('cancels without touching the network', () => {
    const net = new RoadNetwork()
    const tool = new DrawTool(net, 'rural')
    tool.place({ x: 0, y: 0 })
    tool.place({ x: 200, y: 0 })
    tool.cancel()

    expect(tool.points).toEqual([])
    expect(net.roads).toHaveLength(0)
  })
})
