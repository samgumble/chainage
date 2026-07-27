import { minimumRadiusForSpeed } from '../geometry/designSpeed'
import {
  type PolylineRejection,
  buildPolylineAlignment,
} from '../geometry/polyline'
import type { Alignment } from '../geometry/alignment'
import type { Vec2 } from '../geometry/vec2'
import { NODE_SNAP_DISTANCE, type RoadId, type RoadNetwork } from '../network/graph'
import { ROAD_CLASSES, type RoadClassName } from '../network/roadClass'
import { type SnapTarget, resolveSnap, roadAt } from './snap'

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
 * How close a position must be to a road's centreline to still count as "on"
 * it when re-deriving containment at commit time. See `roadAt` for why this
 * needs to be tight rather than reusing `SNAP_RADIUS`.
 */
const ROAD_CONTAINMENT_TOLERANCE = 0.1

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
   * a real junction rather than crossing an unbroken one.
   *
   * Containment is re-derived here with `roadAt`, not trusted from the
   * `SnapTarget` captured when each point was placed: an earlier iteration of
   * this same loop can already have split the road a later point's captured
   * id refers to, leaving that id stale. `resolveSnap` cannot stand in for
   * this re-derivation — its node-first radius would resolve a point back to
   * the node an earlier split just created and skip the split it is meant to
   * perform, the same bug in a narrower case (see `roadAt`'s docstring).
   *
   * Splitting every point before adding the new road matters, and not for the
   * reason it might look like — `addRoad`'s own node lookup dedupes by
   * position regardless of which call created the node first, so it does not
   * itself need the split to exist first (verified: reversing the two steps
   * still passes the single-split three-leg-junction test, because of that
   * dedup). What breaks is `roadAt`. Once the new road has been added, its
   * own centreline touches every point in `this.placed` at distance zero —
   * that is where it was snapped to meet them — so it becomes a second
   * candidate tied with the pre-existing road at every point still waiting to
   * be split. `roadAt` only takes a strictly closer candidate, so nothing
   * should override an already-found zero-distance match, but the "zero" on
   * each side is really the bisection refinement's residual, and those
   * residuals are not equal in practice: measured against this codebase,
   * adding the new road first before resolving any point makes `roadAt`
   * match the fresh road instead of the pre-existing one at *every* point,
   * silently skipping every split and leaving both ends unconnected (see the
   * "ordering" test in drawTool.test.ts, which reproduces this against a live
   * network rather than asserting it from reasoning about the code).
   * Splitting first avoids the ambiguity entirely: the new road does not
   * exist yet to tie against anything while its points are being resolved.
   *
   * On rejection the placed points survive. A player whose last corner is too
   * sharp wants to move that corner, not to draw the whole road again.
   */
  commit(): CommitResult {
    const built = buildPolylineAlignment(this.points, this.cornerRadius)
    if (!built.ok) return { ok: false, rejection: built.rejection }

    for (const { position } of this.placed) {
      const found = roadAt(this.network, position, ROAD_CONTAINMENT_TOLERANCE)
      if (!found) continue // Not on any road any more.

      const road = this.network.road(found.roadId)
      const distanceToEnd = road.alignment.length - found.station
      if (found.station <= NODE_SNAP_DISTANCE || distanceToEnd <= NODE_SNAP_DISTANCE) {
        // A node already exists here — this road's own end, or an earlier
        // split in this loop — and addRoad will snap to it. Nothing to split.
        continue
      }

      this.network.splitRoad(found.roadId, found.station)
    }

    const roadId = this.network.addRoad(built.alignment, this.className)
    this.cancel()
    return { ok: true, roadId }
  }
}
