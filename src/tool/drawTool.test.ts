import { describe, expect, it } from 'vitest'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { RoadNetwork } from '../network/graph'
import { DrawTool } from './drawTool'

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
