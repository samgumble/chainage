import type { Vec2 } from '../geometry/vec2'
import { NODE_SNAP_DISTANCE, type RoadId, type RoadNetwork } from '../network/graph'
import { ROAD_CLASS_ORDER, type RoadClassName } from '../network/roadClass'
import type { NodeId } from '../network/graph'
import { type UpgradeObstacle, checkUpgrade } from '../mesh/upgradeCheck'
import { roadsAt } from './snap'

export type DeleteOutcome =
  | { readonly ok: true; readonly roadId: RoadId }
  | { readonly ok: false; readonly reason: 'nothing-selected' }

export type SplitOutcome =
  | {
      readonly ok: true
      readonly first: RoadId
      readonly second: RoadId
      readonly node: NodeId
    }
  | {
      readonly ok: false
      readonly reason: 'nothing-selected' | 'not-on-the-selected-road' | 'too-near-an-end'
    }

export type ReclassifyOutcome =
  | {
      readonly ok: true
      readonly roadId: RoadId
      readonly from: RoadClassName
      readonly to: RoadClassName
    }
  | { readonly ok: false; readonly reason: 'nothing-selected' }
  | {
      readonly ok: false
      readonly reason: 'not-permitted'
      readonly obstacles: readonly UpgradeObstacle[]
    }

/**
 * How far from a click a road may be and still be picked, metres.
 *
 * Wider than the drawing tool's snap radius: picking is a coarser gesture than
 * placing, and a road missed by a click reads as the tool ignoring you.
 */
export const PICK_RADIUS = 20

/**
 * A selected road, and the three things you can do to one.
 *
 * Holds an identifier rather than a road, and re-checks it on every read. A
 * selection can be invalidated by something the tool never hears about: a road
 * drawn onto the selected one splits it, which removes it and creates two
 * halves with new identifiers. A stored road object would go on describing
 * geometry that is no longer in the network.
 */
export class SelectTool {
  private selectedId: RoadId | undefined

  constructor(private readonly network: RoadNetwork) {}

  /** The selected road, if it still exists. */
  get selected(): RoadId | undefined {
    if (this.selectedId === undefined) return undefined
    // `hasRoad` is an O(1) map lookup; this runs at the top of every verb and
    // from `updateHighlight` on every frame, so an O(roads) scan here would
    // be the wrong shape however cheap any one call looks.
    if (!this.network.hasRoad(this.selectedId)) this.selectedId = undefined
    return this.selectedId
  }

  /** Select the nearest road to a position, or clear if there is none. */
  select(position: Vec2): RoadId | undefined {
    const candidates = roadsAt(this.network, position, PICK_RADIUS)
    let best: { roadId: RoadId; distance: number } | undefined
    for (const candidate of candidates) {
      const pose = this.network.road(candidate.roadId).alignment.poseAt(candidate.station)
      const distance = Math.hypot(
        pose.position.x - position.x,
        pose.position.y - position.y,
      )
      if (!best || distance < best.distance) best = { roadId: candidate.roadId, distance }
    }

    this.selectedId = best?.roadId
    return this.selectedId
  }

  clear(): void {
    this.selectedId = undefined
  }

  deleteSelected(): DeleteOutcome {
    const roadId = this.selected
    if (roadId === undefined) return { ok: false, reason: 'nothing-selected' }

    this.network.removeRoad(roadId)
    this.selectedId = undefined
    return { ok: true, roadId }
  }

  /**
   * Divide the selected road at whichever of its stations is nearest a position.
   *
   * The selection does not survive: both halves are new roads, and silently
   * moving the selection to one of them would be a guess about which half the
   * player meant.
   */
  splitSelectedAt(position: Vec2): SplitOutcome {
    const roadId = this.selected
    if (roadId === undefined) return { ok: false, reason: 'nothing-selected' }

    const here = roadsAt(this.network, position, PICK_RADIUS).find(
      (c) => c.roadId === roadId,
    )
    if (!here) return { ok: false, reason: 'not-on-the-selected-road' }

    // `splitRoad` throws for a station this close to an end. Check rather than
    // catch, so a genuine error is not swallowed with the expected one.
    const { length } = this.network.road(roadId).alignment
    if (here.station <= NODE_SNAP_DISTANCE || here.station >= length - NODE_SNAP_DISTANCE) {
      return { ok: false, reason: 'too-near-an-end' }
    }

    const { first, second, node } = this.network.splitRoad(roadId, here.station)
    this.selectedId = undefined
    return { ok: true, first, second, node }
  }

  /**
   * Change the selected road's class, if its geometry and junctions allow.
   *
   * The check runs first and the mutation only follows a clean result, so a
   * refused upgrade leaves the network exactly as it was.
   */
  reclassifySelected(to: RoadClassName): ReclassifyOutcome {
    const roadId = this.selected
    if (roadId === undefined) return { ok: false, reason: 'nothing-selected' }

    const from = this.network.road(roadId).className
    const check = checkUpgrade(this.network, roadId, to)
    if (!check.ok) {
      return { ok: false, reason: 'not-permitted', obstacles: check.obstacles }
    }

    this.network.setRoadClass(roadId, to)
    return { ok: true, roadId, from, to }
  }

  /** The class one step up (1) or down (-1) the ladder, if there is one. */
  classStep(direction: 1 | -1): RoadClassName | undefined {
    const roadId = this.selected
    if (roadId === undefined) return undefined

    const current = this.network.road(roadId).className
    const index = ROAD_CLASS_ORDER.indexOf(current)
    return ROAD_CLASS_ORDER[index + direction]
  }
}
