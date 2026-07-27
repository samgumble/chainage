import { minimumRadiusForSpeed } from '../geometry/designSpeed'
import {
  type PolylineRejection,
  buildPolylineAlignment,
} from '../geometry/polyline'
import type { Alignment } from '../geometry/alignment'
import type { Vec2 } from '../geometry/vec2'
import type { RoadId, RoadNetwork } from '../network/graph'
import { ROAD_CLASSES, type RoadClassName } from '../network/roadClass'
import { type SnapTarget, resolveSnap } from './snap'

export type DrawPreview =
  | { readonly ok: true; readonly alignment: Alignment }
  | { readonly ok: false; readonly rejection: PolylineRejection }

export type CommitResult =
  | { readonly ok: true; readonly roadId: RoadId }
  | { readonly ok: false; readonly rejection: PolylineRejection }

/**
 * How far from the pointer the tool looks for something to snap to, metres.
 *
 * A usability threshold, not a topological one — see `resolveSnap`.
 */
export const SNAP_RADIUS = 15

/**
 * Placing points and turning them into a road.
 *
 * Pure state over the network and two geometric services. Nothing here knows
 * about pointers, cameras or three.js, which is what lets the behaviour that
 * matters — snapping, previewing, splitting on commit — be tested directly.
 */
export class DrawTool {
  private readonly placed: { position: Vec2; snap: SnapTarget }[] = []
  private hovered: Vec2 | undefined

  /** Corner radius for this class, metres. */
  readonly cornerRadius: number

  constructor(
    private readonly network: RoadNetwork,
    readonly className: RoadClassName,
  ) {
    // Not an arbitrary number: the tightest curve this class's own design
    // speed permits. A highway drawn with a gravel track's corners would be
    // illegal the moment it was built.
    this.cornerRadius = minimumRadiusForSpeed(ROAD_CLASSES[className].designSpeedKph)
  }

  get points(): readonly Vec2[] {
    return this.placed.map((p) => p.position)
  }

  /** What the point at an index snapped to, if anything. */
  snapAt(index: number): SnapTarget | undefined {
    return this.placed[index]?.snap
  }

  /** The placed points plus whatever is currently hovered. */
  private get pending(): Vec2[] {
    return this.hovered ? [...this.points, this.hovered] : [...this.points]
  }

  /**
   * What would be built right now, or why it cannot be.
   *
   * `undefined` while there is nothing to show — fewer than two points is not
   * a rejection, it is an unfinished gesture.
   */
  get preview(): DrawPreview | undefined {
    const points = this.pending
    if (points.length < 2) return undefined

    const result = buildPolylineAlignment(points, this.cornerRadius)
    return result.ok
      ? { ok: true, alignment: result.alignment }
      : { ok: false, rejection: result.rejection }
  }

  /** Move the provisional last point. Snaps, so the preview shows the truth. */
  hover(position: Vec2): void {
    this.hovered = resolveSnap(this.network, position, SNAP_RADIUS).position
  }

  place(position: Vec2): void {
    const snap = resolveSnap(this.network, position, SNAP_RADIUS)
    this.placed.push({ position: snap.position, snap })
    this.hovered = undefined
  }

  undoLastPoint(): void {
    this.placed.pop()
  }

  cancel(): void {
    this.placed.length = 0
    this.hovered = undefined
  }

  /**
   * Build the road.
   *
   * A point placed on an existing road splits it first, so the new road meets
   * a real junction rather than crossing an unbroken one. Splitting before
   * adding matters: the split must exist for `addRoad` to snap the new road's
   * end to the node it creates.
   *
   * On rejection the placed points survive. A player whose last corner is too
   * sharp wants to move that corner, not to draw the whole road again.
   */
  commit(): CommitResult {
    const built = buildPolylineAlignment(this.points, this.cornerRadius)
    if (!built.ok) return { ok: false, rejection: built.rejection }

    for (const { snap } of this.placed) {
      if (snap.kind !== 'road') continue
      // The road may already have been split by an earlier point, or the
      // station may be too close to an end to divide; neither is fatal, since
      // addRoad will snap to whatever node is there.
      try {
        this.network.splitRoad(snap.roadId, snap.station)
      } catch {
        // Nothing to do: the position is already a node, or too near one.
      }
    }

    const roadId = this.network.addRoad(built.alignment, this.className)
    this.cancel()
    return { ok: true, roadId }
  }
}
