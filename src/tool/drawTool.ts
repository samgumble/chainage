import { minimumRadiusForSpeed } from '../geometry/designSpeed'
import {
  type PolylineRejection,
  buildPolylineAlignment,
} from '../geometry/polyline'
import type { Alignment } from '../geometry/alignment'
import type { Vec2 } from '../geometry/vec2'
import { NODE_SNAP_DISTANCE, type RoadId, type RoadNetwork } from '../network/graph'
import { ROAD_CLASSES, type RoadClassName } from '../network/roadClass'
import { type SnapTarget, resolveSnap, roadsAt } from './snap'

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

  /**
   * Move the provisional last point. Snaps, so the preview shows the truth.
   *
   * `suppressSnap` bypasses snap resolution entirely and uses `position`
   * exactly as given — the held-modifier escape hatch §4.1 requires ("A
   * held modifier suppresses all snapping. This is table stakes and both
   * Cities: Skylines games get it wrong"). The scene is expected to pass
   * the modifier's current held state through on every call, the same way
   * it already passes the pointer position through on every call — not to
   * toggle some sticky mode on the tool.
   *
   * This only changes how the point's position is decided, nothing more:
   * see `place`'s docstring for why suppressing snap does not also exempt
   * the point from what `commit` does with it afterwards.
   */
  hover(position: Vec2, suppressSnap = false): void {
    this.hovered = suppressSnap
      ? position
      : resolveSnap(this.network, position, SNAP_RADIUS).position
  }

  /**
   * Place a point. Snaps by default; see `hover` for `suppressSnap`.
   *
   * A suppressed point is recorded with `kind: 'free'` — the same as a point
   * that simply had nothing nearby to snap to, since from here on that is
   * exactly what it is: a raw position, not a claim about any node or road.
   *
   * Deliberately **not** exempt from `commit`'s splitting, though. `commit`
   * does not consult how a point was placed at all — it re-derives which
   * roads a point's final position falls on fresh, every time (see its
   * docstring), precisely so stale place-time information can never steer a
   * mutation. A point placed with snapping suppressed that happens to land
   * exactly on an existing road's centreline is, topologically, on that
   * road; giving it immunity because of *how* it got there would mean
   * carrying "this point asked not to snap" as extra state all the way to
   * commit time — reintroducing the trust-the-place-time-metadata bug
   * `commit` was already fixed once to not have. Suppressing snap is about
   * player control over where a point lands, not about controlling what the
   * graph does once it has landed there.
   */
  place(position: Vec2, suppressSnap = false): void {
    const snap: SnapTarget = suppressSnap
      ? { kind: 'free', position }
      : resolveSnap(this.network, position, SNAP_RADIUS)
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
   * a real junction rather than crossing an unbroken one. A point placed
   * where two roads cross at grade splits *both* — a crossing that leaves one
   * road unbroken looks like a junction to `isJunction` (the other road's
   * ends still make it 3+) while actually being a stub with a road silently
   * passing through it, the same shape of bug as splitting nothing at all.
   *
   * Containment is re-derived here with `roadsAt`, not trusted from the
   * `SnapTarget` captured when each point was placed: an earlier iteration of
   * this same loop can already have split a road a later point's captured id
   * refers to, leaving that id stale. `resolveSnap` cannot stand in for this
   * re-derivation — its node-first radius would resolve a point back to the
   * node an earlier split just created and skip the split it is meant to
   * perform, the same bug in a narrower case (see `roadAt`'s docstring, which
   * `roadsAt` shares).
   *
   * Splitting every point before adding the new road matters, and not for the
   * reason it might look like — `addRoad`'s own node lookup dedupes by
   * position regardless of which call created the node first, so it does not
   * itself need the split to exist first (verified: reversing the two steps
   * still passes the single-split three-leg-junction test, because of that
   * dedup). What breaks is `roadsAt`. Once the new road has been added, its
   * own centreline touches every point in `this.placed` at distance zero —
   * that is where it was snapped to meet them — so it becomes an extra
   * candidate alongside any pre-existing road at every point still waiting to
   * be split, and would itself get "split" nonsensically. Splitting first
   * avoids the ambiguity entirely: the new road does not exist yet to appear
   * as a candidate while its points are being resolved (see the "ordering"
   * test in drawTool.test.ts, which reproduces the single-road version of
   * this failure against a live network rather than asserting it from
   * reasoning about the code).
   *
   * On rejection the placed points survive. A player whose last corner is too
   * sharp wants to move that corner, not to draw the whole road again.
   */
  commit(): CommitResult {
    const built = buildPolylineAlignment(this.points, this.cornerRadius)
    if (!built.ok) return { ok: false, rejection: built.rejection }

    for (const { position } of this.placed) {
      for (const found of roadsAt(this.network, position, ROAD_CONTAINMENT_TOLERANCE)) {
        const road = this.network.road(found.roadId)
        const distanceToEnd = road.alignment.length - found.station
        if (found.station <= NODE_SNAP_DISTANCE || distanceToEnd <= NODE_SNAP_DISTANCE) {
          // A node already exists here — this road's own end, or an earlier
          // split in this loop — and addRoad will snap to it. Nothing to
          // split.
          continue
        }

        this.network.splitRoad(found.roadId, found.station)
      }
    }

    const roadId = this.network.addRoad(built.alignment, this.className)
    this.cancel()
    return { ok: true, roadId }
  }
}
