import { describe, expect, it } from 'vitest'
import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { distance } from '../geometry/vec2'
import { NODE_SNAP_DISTANCE, RoadNetwork } from '../network/graph'
import { DrawTool, type CommitResult } from './drawTool'
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
    // Hover well away from where the next point actually lands. `points`
    // never includes the hover and `buildPolylineAlignment` collapses an
    // exact duplicate, so hovering and then placing at the *same* spot
    // can't tell a leaked hover apart from a correctly cleared one — only a
    // hover placed somewhere else can.
    tool.hover({ x: 200, y: 100 })
    tool.place({ x: 200, y: 0 })

    expect(tool.points).toHaveLength(2)
    expect(tool.preview?.ok).toBe(true)
    if (!tool.preview?.ok) return

    // A leaked hover would survive as a third pending point at (200, 100),
    // bending the alignment through a corner there instead of ending
    // straight at the placed (200, 0) — changing both the length and the
    // endpoint. Only a genuinely two-point, straight preview produces both
    // of these.
    expect(tool.preview.alignment.length).toBeCloseTo(200, 6)
    const end = tool.preview.alignment.poseAt(tool.preview.alignment.length)
    expect(end.position.x).toBeCloseTo(200, 6)
    expect(end.position.y).toBeCloseTo(0, 6)
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

  describe('suppressing snap', () => {
    it('hovers at the raw position when snap is suppressed near a node', () => {
      const net = new RoadNetwork()
      net.addRoad(straight(0, 0, 0, 100), 'rural')

      const tool = new DrawTool(net, 'rural')
      tool.place({ x: 500, y: 500 }) // an anchor point, far from anything
      tool.hover({ x: 3, y: 4 }, true) // well within SNAP_RADIUS of (0,0)

      expect(tool.preview?.ok).toBe(true)
      if (!tool.preview?.ok) return
      const end = tool.preview.alignment.poseAt(tool.preview.alignment.length)
      expect(end.position.x).toBeCloseTo(3, 6)
      expect(end.position.y).toBeCloseTo(4, 6)
    })

    it('still snaps a hover when suppression is not requested', () => {
      const net = new RoadNetwork()
      net.addRoad(straight(0, 0, 0, 100), 'rural')

      const tool = new DrawTool(net, 'rural')
      tool.place({ x: 500, y: 500 })
      tool.hover({ x: 3, y: 4 })

      expect(tool.preview?.ok).toBe(true)
      if (!tool.preview?.ok) return
      const end = tool.preview.alignment.poseAt(tool.preview.alignment.length)
      expect(end.position.x).toBeCloseTo(0, 6)
      expect(end.position.y).toBeCloseTo(0, 6)
    })

    it('places at the raw position when snap is suppressed near a node', () => {
      const net = new RoadNetwork()
      net.addRoad(straight(0, 0, 0, 100), 'rural')

      const tool = new DrawTool(net, 'rural')
      tool.place({ x: 3, y: 4 }, true) // well within SNAP_RADIUS of (0,0)

      expect(tool.points[0]).toEqual({ x: 3, y: 4 })
      expect(tool.snapAt(0)?.kind).toBe('free')
    })

    it('still snaps a placed point to a node when suppression is not requested', () => {
      const net = new RoadNetwork()
      net.addRoad(straight(0, 0, 0, 100), 'rural')

      const tool = new DrawTool(net, 'rural')
      tool.place({ x: 3, y: 4 })

      expect(tool.points[0]).toEqual({ x: 0, y: 0 })
      expect(tool.snapAt(0)?.kind).toBe('node')
    })

    it('still splits a road at commit even when the point that lands on it was placed with snapping suppressed', () => {
      // commit() re-derives containment from position, never from how a
      // point was placed — see place()'s docstring. A suppressed point that
      // happens to land on a road's centreline is not exempt from that.
      const net = new RoadNetwork()
      const existing = net.addRoad(straight(0, 0, 0, 400), 'rural')

      const tool = new DrawTool(net, 'rural')
      tool.place({ x: 200, y: 0 }, true) // exactly on the existing road, suppressed
      expect(tool.snapAt(0)?.kind).toBe('free')
      tool.place({ x: 200, y: 300 })

      const result = tool.commit()
      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(() => net.road(existing)).toThrow(RangeError)
      expect(net.roads).toHaveLength(3)
      const startNode = net.road(result.roadId).startNode
      expect(net.isJunction(startNode)).toBe(true)
    })
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

  it('splits both roads at an at-grade crossing when a point lands on it', () => {
    // Two roads crossing at (0,0): one running east-west, one north-south.
    // A point placed exactly on the crossing must split *both* — leaving
    // one through unbroken would make the node look like a three-legged
    // junction to isJunction() while a whole road silently passes over it.
    const net = new RoadNetwork()
    const roadA = net.addRoad(straight(-100, 0, 0, 200), 'rural') // x: -100..100, y=0
    const roadB = net.addRoad(straight(0, -100, Math.PI / 2, 200), 'rural') // y: -100..100, x=0

    const tool = new DrawTool(net, 'rural')
    tool.place({ x: 0, y: 0 }) // exactly the crossing
    tool.place({ x: 150, y: 150 }) // off both roads

    const result = tool.commit()
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Both originals are gone, each replaced by two halves, plus the new
    // road: 5 roads total.
    expect(() => net.road(roadA)).toThrow(RangeError)
    expect(() => net.road(roadB)).toThrow(RangeError)
    expect(net.roads).toHaveLength(5)

    // The crossing alone needs 4 legs (two roads split in half each); the
    // new road's own start adds a fifth.
    const startNode = net.road(result.roadId).startNode
    expect(net.isJunction(startNode)).toBe(true)
    expect(net.node(startNode).ends).toHaveLength(5)
  })

  describe('the node-skip guard at commit', () => {
    // commit() must not try to re-split a road where a node already exists —
    // its own end, or a node an earlier point in the same loop just created.
    // Gutting this guard does not fail any test that existed before this
    // describe block: every one of them keeps placed points well clear of
    // any node. These two are the guard's only coverage.

    it('starts a new road at an existing node without throwing', () => {
      const net = new RoadNetwork()
      const existing = net.addRoad(straight(0, 0, 0, 200), 'rural')
      const existingEnd = net.road(existing).endNode // at (200, 0)

      const tool = new DrawTool(net, 'rural')
      tool.place({ x: 200, y: 2 }) // within SNAP_RADIUS of the existing end node
      expect(tool.snapAt(0)?.kind).toBe('node')
      tool.place({ x: 200, y: 300 }) // a fresh direction away from it

      let result: CommitResult | undefined
      expect(() => {
        result = tool.commit()
      }).not.toThrow()
      expect(result?.ok).toBe(true)
      if (!result?.ok) return

      const newRoad = net.road(result.roadId)
      expect(newRoad.startNode).toBe(existingEnd)
      // The dead end became a through connection: the original road's end
      // plus the new road's start, two ends, not (yet) a junction.
      expect(net.node(existingEnd).ends).toHaveLength(2)
    })

    it('skips a road where an earlier split in the same commit already left a node close by', () => {
      const net = new RoadNetwork()
      const main = net.addRoad(straight(0, 0, 0, 1000), 'rural')

      const tool = new DrawTool(net, 'gravel')
      // At place time `main` is still one continuous, unsplit road, so both
      // of these resolve as 'road' snaps — station ~300 and ~300.3 — not as
      // 'node' snaps. Two intervening waypoints keep every clicked segment
      // comfortably clear of the minimum length, and route the path back to
      // (300.3, 0) from the east so no corner is anywhere near a reversal.
      tool.place({ x: 300, y: 0 }) // on `main`, station 300 — splits it
      expect(tool.snapAt(0)?.kind).toBe('road')
      tool.place({ x: 300, y: 300 })
      tool.place({ x: 600, y: 300 })
      tool.place({ x: 300.3, y: 0 }) // 0.3m from the first point's split —
      // within NODE_SNAP_DISTANCE (0.5) of the fresh node, but not placed
      // exactly on it: no node existed there when this point was placed.
      expect(tool.snapAt(3)?.kind).toBe('road')

      let result: CommitResult | undefined
      expect(() => {
        result = tool.commit()
      }).not.toThrow()
      expect(result?.ok).toBe(true)
      if (!result?.ok) return

      // `main` is split exactly once (at station 300), not a second time at
      // the near-duplicate station the last point resolves to: two halves
      // plus the new road, three roads total.
      expect(() => net.road(main)).toThrow(RangeError)
      expect(net.roads).toHaveLength(3)

      const node = net.nodeAt({ x: 300, y: 0 })
      expect(node).toBeDefined()
      expect(node?.ends).toHaveLength(4) // both halves of `main`, plus the
      // new road's start and end, which both land within snap distance of
      // this same node.
      expect(net.isJunction(node!.id)).toBe(true)
    })
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

describe('DrawTool corner radius by class', () => {
  // The defect this guards: a class whose minimum radius exceeds the
  // distance a player can click within the camera frame rejects every
  // road. Gravel must be drawable at diorama scale; rural must not
  // silently become drawable by having its radius quietly reduced.
  it('accepts a 90-degree corner with 60m legs on gravel', () => {
    const tool = new DrawTool(new RoadNetwork(), 'gravel')
    tool.place({ x: 0, y: 0 })
    tool.place({ x: 60, y: 0 })
    tool.place({ x: 60, y: 60 })
    const result = tool.commit()
    expect(result.ok).toBe(true)
  })

  it('rejects the same corner on rural rather than shrinking the radius', () => {
    const tool = new DrawTool(new RoadNetwork(), 'rural')
    tool.place({ x: 0, y: 0 })
    tool.place({ x: 60, y: 0 })
    tool.place({ x: 60, y: 60 })
    const result = tool.commit()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.reason).toBe('curves-overlap')
  })

  it('gives each class the radius its design speed requires', () => {
    expect(new DrawTool(new RoadNetwork(), 'gravel').cornerRadius).toBeCloseTo(43.4, 0)
    expect(new DrawTool(new RoadNetwork(), 'rural').cornerRadius).toBeCloseTo(252.0, 0)
  })
})
