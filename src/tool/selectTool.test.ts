import { describe, expect, it } from 'vitest'
import { Alignment } from '../geometry/alignment'
import { Arc, Line } from '../geometry/primitives'
import { RoadNetwork } from '../network/graph'
import { SelectTool } from './selectTool'

const straight = (x: number, y: number, heading: number, length: number) =>
  new Alignment([new Line({ x, y }, heading, length)])

describe('SelectTool', () => {
  it('starts with nothing selected', () => {
    expect(new SelectTool(new RoadNetwork()).selected).toBeUndefined()
  })

  it('clears the selection on demand', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 200), 'rural')
    const tool = new SelectTool(net)

    tool.select({ x: 100, y: 0 })
    expect(tool.selected).toBeDefined()

    tool.clear()
    expect(tool.selected).toBeUndefined()
  })

  it('selects a road near the given position', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 200), 'rural')
    const tool = new SelectTool(net)

    expect(tool.select({ x: 100, y: 3 })).toBe(id)
    expect(tool.selected).toBe(id)
  })

  it('selects nothing when the position is away from every road', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 200), 'rural')
    const tool = new SelectTool(net)

    expect(tool.select({ x: 1000, y: 1000 })).toBeUndefined()
    expect(tool.selected).toBeUndefined()
  })

  it('clears an existing selection when nothing is under the new position', () => {
    const net = new RoadNetwork()
    net.addRoad(straight(0, 0, 0, 200), 'rural')
    const tool = new SelectTool(net)

    tool.select({ x: 100, y: 0 })
    tool.select({ x: 1000, y: 1000 })
    expect(tool.selected).toBeUndefined()
  })

  it('picks the nearer of two roads', () => {
    const net = new RoadNetwork()
    // Both roads must land within PICK_RADIUS of the click, or only one is
    // ever a candidate and the "nearer of two" comparison is never exercised.
    net.addRoad(straight(0, 0, 0, 200), 'rural')
    const near = net.addRoad(straight(0, 15, 0, 200), 'rural')
    const tool = new SelectTool(net)

    expect(tool.select({ x: 100, y: 12 })).toBe(near)
  })

  it('forgets a selection whose road has been removed by something else', () => {
    const net = new RoadNetwork()
    const id = net.addRoad(straight(0, 0, 0, 400), 'rural')
    const tool = new SelectTool(net)
    tool.select({ x: 200, y: 0 })
    expect(tool.selected).toBe(id)

    // A road drawn onto this one would split it, which removes it and creates
    // two halves with new identifiers. The tool is never told.
    net.splitRoad(id, 200)

    expect(tool.selected).toBeUndefined()
  })

  it('keeps a selection when a different road is removed', () => {
    const net = new RoadNetwork()
    const keep = net.addRoad(straight(0, 0, 0, 200), 'rural')
    const other = net.addRoad(straight(0, 500, 0, 200), 'rural')
    const tool = new SelectTool(net)
    tool.select({ x: 100, y: 0 })

    net.removeRoad(other)

    expect(tool.selected).toBe(keep)
  })

  describe('deleteSelected', () => {
    it('removes the road and drops the selection', () => {
      const net = new RoadNetwork()
      const id = net.addRoad(straight(0, 0, 0, 200), 'rural')
      const tool = new SelectTool(net)
      tool.select({ x: 100, y: 0 })

      expect(tool.deleteSelected()).toEqual({ ok: true, roadId: id })
      expect(net.roads).toHaveLength(0)
      expect(tool.selected).toBeUndefined()
    })

    it('reports rather than throwing when nothing is selected', () => {
      const tool = new SelectTool(new RoadNetwork())
      expect(tool.deleteSelected()).toEqual({ ok: false, reason: 'nothing-selected' })
    })
  })

  describe('splitSelectedAt', () => {
    it('divides the road and drops the selection', () => {
      const net = new RoadNetwork()
      const id = net.addRoad(straight(0, 0, 0, 400), 'rural')
      const tool = new SelectTool(net)
      tool.select({ x: 200, y: 0 })

      const result = tool.splitSelectedAt({ x: 150, y: 2 })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(net.roads).toHaveLength(2)
      expect(() => net.road(id)).toThrow(RangeError)
      expect(net.road(result.first).alignment.length).toBeCloseTo(150, 1)
      // Both halves are new roads; neither is what was selected.
      expect(tool.selected).toBeUndefined()
    })

    it('reports rather than throwing when nothing is selected', () => {
      const tool = new SelectTool(new RoadNetwork())
      expect(tool.splitSelectedAt({ x: 0, y: 0 })).toEqual({
        ok: false,
        reason: 'nothing-selected',
      })
    })

    it('refuses a position that is not on the selected road', () => {
      const net = new RoadNetwork()
      net.addRoad(straight(0, 0, 0, 400), 'rural')
      const tool = new SelectTool(net)
      tool.select({ x: 200, y: 0 })

      const result = tool.splitSelectedAt({ x: 200, y: 900 })
      expect(result).toEqual({ ok: false, reason: 'not-on-the-selected-road' })
      expect(net.roads).toHaveLength(1)
    })

    it('refuses a position too near an end to divide', () => {
      const net = new RoadNetwork()
      net.addRoad(straight(0, 0, 0, 400), 'rural')
      const tool = new SelectTool(net)
      tool.select({ x: 200, y: 0 })

      const result = tool.splitSelectedAt({ x: 0.2, y: 0 })
      expect(result).toEqual({ ok: false, reason: 'too-near-an-end' })
      expect(net.roads).toHaveLength(1)
    })
  })

  describe('reclassifySelected', () => {
    it('changes the class when the geometry permits', () => {
      const net = new RoadNetwork()
      const id = net.addRoad(straight(0, 0, 0, 400), 'gravel')
      const tool = new SelectTool(net)
      tool.select({ x: 200, y: 0 })

      const result = tool.reclassifySelected('highway')
      expect(result).toEqual({ ok: true, roadId: id, from: 'gravel', to: 'highway' })
      expect(net.road(id).className).toBe('highway')
      // The road survives, so the selection does too.
      expect(tool.selected).toBe(id)
    })

    it('refuses when the road\'s own curves are too tight, and says why', () => {
      const net = new RoadNetwork()
      // A tight arc: legal for gravel, not for a highway's design speed.
      const id = net.addRoad(new Alignment([new Arc({ x: 0, y: 0 }, 0, 200, 1 / 30)]), 'gravel')
      const tool = new SelectTool(net)
      tool.select(net.road(id).alignment.poseAt(100).position)

      const result = tool.reclassifySelected('highway')
      expect(result.ok).toBe(false)
      if (result.ok || result.reason !== 'not-permitted') return
      expect(result.obstacles.some((o) => o.kind === 'alignment')).toBe(true)
      // And nothing changed.
      expect(net.road(id).className).toBe('gravel')
    })

    it('reports rather than throwing when nothing is selected', () => {
      const tool = new SelectTool(new RoadNetwork())
      expect(tool.reclassifySelected('rural')).toEqual({
        ok: false,
        reason: 'nothing-selected',
      })
    })
  })

  describe('classStep', () => {
    it('names the class one step up and one step down', () => {
      const net = new RoadNetwork()
      net.addRoad(straight(0, 0, 0, 200), 'rural')
      const tool = new SelectTool(net)
      tool.select({ x: 100, y: 0 })

      expect(tool.classStep(1)).toBe('arterial')
      expect(tool.classStep(-1)).toBe('gravel')
    })

    it('has nothing above the top or below the bottom', () => {
      const net = new RoadNetwork()
      net.addRoad(straight(0, 0, 0, 200), 'highway')
      net.addRoad(straight(0, 500, 0, 200), 'gravel')
      const tool = new SelectTool(net)

      tool.select({ x: 100, y: 0 })
      expect(tool.classStep(1)).toBeUndefined()

      tool.select({ x: 100, y: 500 })
      expect(tool.classStep(-1)).toBeUndefined()
    })

    it('names nothing when nothing is selected', () => {
      expect(new SelectTool(new RoadNetwork()).classStep(1)).toBeUndefined()
    })
  })
})
