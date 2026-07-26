# Chainage — Design Spec

**Date:** 2026-07-26
**Status:** Approved design, pending implementation plan
**Working name:** Chainage (surveyor's term for distance measured along a route). Placeholder — easily changed.

---

## 1. Overview

A zen civil engineering game for the browser. The player is the engineer for a growing region: they draw road alignments across real terrain, watch traffic use them, upgrade what strains, and keep the network healthy as it ages.

No fail state. No timer. The pull is that the network is visibly alive and visibly the player's own.

The concept originates from the road-print play rug of 1990s childhoods — but only as a seed. That rug was effectively a plan view, a site drawing a child crawls over. The game takes the calm, top-down, road-network-as-play-object feeling and puts it in a real world at real scale. There is no rug, toy, or living room in the game.

### Reference points

- **Mini Motorways** — calm, legible, no clutter
- **Dorfromantik** — "one more piece"
- **Cities: Skylines** — the road tool to learn from, and the traffic legibility mistakes to avoid
- **Workers & Resources: Soviet Republic** — construction as a real process
- Actual civil engineering practice — which most zen builders leave entirely on the table

## 2. Design pillars

1. **Calm.** No fail state, no timer, no punishment. Pressure comes only from a network that could be better.
2. **Genuine engineering.** Real alignment geometry, real capacity models, real pavement physics. The domain is the game, not a skin over an abstract puzzle.
3. **Legible, never jargon.** The simulation is real; the interface speaks in seconds and plain words. "Cars wait 42s here," never "v/c = 0.94."
4. **Emergent, not scripted.** Induced demand, phantom jams, and the roundabout/signal crossover all fall out of correct models. Nothing is faked.
5. **Yours.** The map at hour five should feel like a personal artifact.

## 3. Core loop

```
draw an alignment
  → traffic starts using it
    → a town grows because it is now reachable
      → demand rises
        → something starts backing up
          → diagnose and fix (upgrade class / turn lane / change junction control)
            → the fix induces more demand
              → repeat, outward
```

The loop closes on itself by design. Induced demand means improvements partly consume their own benefit — the central irony of the profession, and here an emergent property of the demand model rather than a scripted penalty.

## 4. Systems

### 4.1 Alignment geometry

Road centerlines are **sequences of curvature-parameterized primitives**, not free splines. This follows the ASAM OpenDRIVE data model, which is the industry interchange format and what Civil 3D and OpenRoads use internally.

| Primitive | Curvature κ(s) |
|---|---|
| Line | 0 |
| Arc | constant |
| Spiral (clothoid) | linear in s |

Every record carries `(s, x, y, heading, length)` — an absolute anchor plus a local frame. Lane widths hang off the reference line as polynomials in `ds`. Elevation and superelevation are **separate profiles**, not baked into the plan geometry.

Consequences worth stating: curve radius is a property of the data rather than something derived after the fact, so design speed follows directly (AASHTO radius/superelevation/speed relationship). Vertical alignment can be edited without disturbing the horizontal.

**Joints carry the geometry.** Following Cities: Skylines, a node stores position and a shared tangent direction; the curve between two nodes is *derived*. C¹ continuity across joints falls out with no global solve. This is the single most important structural decision in the geometry layer.

**Editing model** — hybrid freeform, per the approved design:

- Drag to draw. Endpoints snap to existing nodes and segments.
- Corners auto-fillet to a legal minimum radius.
- Live readout of curve radius and design speed while dragging.
- Constraints are enforced *for* the player, with the reason shown — not taught as a prerequisite.

**Segment length bounds:** maximum ~100m per segment (subdivide longer runs); minimum ~7m (reject shorter). The minimum exists because tiny segments are a documented source of both visual artifacts and pathfinding failures in Cities: Skylines.

**Snapping must arbitrate, never stack.** Each snap source proposes a candidate with a priority score; the best single candidate wins and the rest are discarded. Cities: Skylines 2's `CalculateSnapPriority` is the model: a hard tier plus a soft score that decays with displacement.

Three rules, each derived from a documented CS2 failure:

1. **One snap wins.** Two sources must never both modify the point. CS2 allows this and it produces float drift and spurious elevation changes.
2. **Snapping is idempotent.** Snapping an already-snapped point is a no-op. Work in fixed-point grid coordinates; convert to float only for rendering.
3. **Show which snap fired.** Draw the guide line, print the angle and distance. If the player cannot see why the point moved, they will conclude the tool is broken.

A held modifier suppresses all snapping. This is table stakes and both Cities: Skylines games get it wrong.

**Preview and commit share one code path.** The preview runs the actual build function in test mode. Preview and commit cannot diverge because they are the same function.

### 4.2 Terrain and earthworks

Heightmap terrain, deformed by road construction. Cut and fill volumes are computed and costed.

**Feasibility solving.** Gradient checking is a min/max interval propagation solver, adapted from CS1's `CheckNodeHeights`: each candidate node carries `minY`/`maxY`; sweep forward then backward tightening bounds by `Δxz · maxGrade`; if any node ends with `minY > maxY`, the alignment is infeasible.

This answers *and* corrects in one pass — the player gets a working vertical alignment rather than a rejection. Materially better than a per-segment gradient test.

**Terrain edits are non-destructive.** Deformation lives on a separate edit layer over the base heightmap, following Unreal's landscape spline model. This makes earthworks undoable, which directly addresses the most-complained-about flaw in Cities: Skylines 2 (terrain edits with no undo).

**Bridges** generate automatically when the design profile sits far enough above terrain: deck, piers at intervals, abutments.

**Undo** is one command stack, not several. Granularity is one committed drag, not one internal segment. The geometry layer must be undoable independently of any simulated layer — this is precisely why Cities: Skylines cannot offer undo, since road placement there mutates zoning, buildings, and agent routes inseparably.

### 4.3 Traffic simulation

**Microscopic** — IDM car-following plus MOBIL lane changing.

This was expected to be a compromise and is not. Measured cost is ~20–23ns per vehicle per substep with struct-of-arrays typed arrays. **20,000 vehicles at 20Hz is under 0.5% of one core.** Rendering and geometry rebuilds are the real constraints.

The decisive argument is legibility, not performance. Microscopic simulation produces the **phantom jam** — a stop-and-go wave that travels backwards through traffic on an open road with no bottleneck at all. It is the most readable traffic phenomenon that exists, and mesoscopic and macroscopic models cannot produce it.

**IDM:**

```
dv/dt  = a · [ 1 − (v/v₀)^δ − (s*(v,Δv) / s)² ]
s*(v,Δv) = s₀ + max(0, v·T + v·Δv / (2√(a·b)))
```

`s` = bumper-to-bumper gap, `Δv` = v − v_lead, δ = 4, s₀ = 2m, b = 1.5–2.0.

Stability is a **design knob, not a correctness constraint**. Low `a` and low `T` produce dramatic phantom jams; high values produce calm flow. Suggested: highways smooth (a=2.0, T=1.5), town streets twitchy (a=1.0, T=1.0).

**Integration:** ballistic, dt ≤ 0.25s. Not Euler, not RK4 — ballistic is what SUMO uses and it outperforms both here. Naive Euler position updates make stop-and-go traffic visibly jitter.

**Stopping is one mechanism.** Red lights, stop signs, and unaccepted gaps all insert a **phantom stationary vehicle** at the stop line; normal car-following brakes for it. No separate approach controller, no state machine, no discontinuity when the light changes. One code path.

This needs a dilemma-zone rule, or approaching vehicles emergency-brake:

```
on yellow: if d_to_line < v²/(2b) + v·t_react  →  proceed
                                    otherwise  →  insert phantom, stop
```

**Data layout:** per-lane arrays sorted by position; leader is the previous index. Vehicles almost never swap order within a lane, so insertion sort is effectively O(n). Lane changes are explicit splices.

**LOD:** microscopic where the camera is, mesoscopic elsewhere. Past ~6km view width a car is under 1.5px, so on-screen instance count caps around 2–3k regardless of network size. The transition is invisible.

### 4.4 Routing

**Weighted A\*, heuristic weight ~1.6.** Measured: 290µs → 109µs at weight 1.6, and 14.5µs at weight 2.0 on a 10k-node graph. Slightly suboptimal paths are *correct* for a game — humans do not route optimally either.

Contraction hierarchies and CRP are wrong at this scale; their value is amortizing over millions of nodes, and their preprocessing cost is incompatible with a graph the player edits constantly.

**Invalidation** — the real problem, and it is cheap:

| Strategy | Cost (10k nodes, 5000 vehicles, one edit) |
|---|---|
| Recompute all paths | 550ms — unacceptable stall |
| Recompute affected only | 0.74ms |
| Budgeted replan queue, 8/frame | 0.88ms/frame, drains in one frame |

Store paths as edge-ID arrays; bump a graph version on edit; each vehicle checks "is my next edge still valid" on arrival at each node. O(1) per node crossing, no reverse index needed.

**Structural optimizations:**

- **Segment abstraction** — collapse chains of degree-2 nodes so only decision points are graph nodes. Free 3–10× graph shrink. This is what OpenTTD's YAPF does.
- **Backward Dijkstra distance fields per destination** — one backward pass labels every node with `dist(v→t)`; all vehicles heading to `t` follow the gradient with no per-vehicle search. Collapses O(vehicles) to O(destinations).

**Rerouting stability.** Naive "everyone picks the current best route" oscillates catastrophically. Measured on a two-route network with exact equilibrium at 1090.8 veh/h:

| Rule | Final | Oscillation |
|---|---|---|
| Everyone reroutes (λ=1) | 0 | 1500 — total flip-flop |
| λ=1 + EMA smoothing | 1500 | 1500 — **smoothing alone does not fix it** |
| Reroute 5%/tick only | 1093 | 66 |
| **5% + smoothing + 10% hysteresis** | **1095** | **0** |

Two counterintuitive results: **partial rerouting is the primary fix, not smoothing** — and smoothing alone can *add* lag-driven oscillation. Sharp logit choice without smoothing is also unstable.

Stack: smooth link *speeds* (not times) with α≈0.1; reroute 5%/tick; hysteresis 10–15%; per-vehicle seeded weight jitter ±15% to break grid ties.

**Congestion cost — BPR, retuned:**

```
t = t₀ · (1 + α(v/c)^β)
```

Standard α=0.15, β=4 is **far too gentle for a game** — at v/c = 1.0 you still move at 87% of free-flow, which no player reads as congestion. Use **α=1.5, β=8**, which gives 40% at v/c = 1.0 and a sharp visible knee.

**Braess's paradox** should be allowed to emerge. It will — the literature says it occurs roughly as often as not when routes are added. Instrument it with a rolling average-commute baseline and surface it through a "what if I closed this road?" overlay.

### 4.5 Intersections

**Architecture:** geometry produces a fixed **conflict matrix** (which movements cross which). The control type changes only the **yield matrix** layered on top. Conflicts are geometry; yielding is policy.

This combines SUMO's foe/response bitmask data model with A/B Street's reservation-based arbitration — the reservation model is dramatically easier to keep deadlock-free and to debug than letting each vehicle decide for itself.

**Gap acceptance validates against theory.** Microscopic agents that wait for a gap ≥ `t_c` then discharge at headway `t_f` reproduce HCM analytic capacity **within 1%** across conflicting flows of 200–1200 veh/h. The capacity formula is never implemented for the simulation — only for the player-facing readout and the low-LOD fallback. This gives the simulation published ground truth to unit-test against, which is a rare luxury.

Critical headways (HCM): minor left 7.1s, minor through 6.5s, minor right 6.2s, major left 4.1s. Draw `t_c` **per driver from a lognormal**, σ≈0.3–0.4 — this reproduces the recognizable behavior where one driver darts out and the next dithers.

**Impatience is required, not flavor.** `t_c_effective` decreases with accumulated wait time. Without it, minor approaches starve permanently under heavy major flow — unrealistic, and a gameplay dead end.

**The control-type crossover is the progression curve.** All verified against HCM:

| Total veh/h | Stop | Roundabout | Signal | Best |
|---|---|---|---|---|
| 400–1000 | 11–21s | **5–11s** | 16–18s | roundabout |
| 1400 | 72s | 24s | **20s** | signal |
| 1800 | gridlock | 64s | **23s** | signal |
| 2800 | gridlock | gridlock | **36s** | signal |

Below ~800 veh/h stop signs cost nothing. From ~800–2500 the roundabout wins — no fixed lost time. Past ~2500 the signal wins as roundabout entry saturates. Past ~3400 the answer is lanes, not control.

**Level of Service** thresholds are directly usable as grading, and the built-in asymmetry is a free difficulty curve: the unsignalized scale is stricter (LOS C ends at 25s) than the signalized scale (LOS C ends at 35s), because drivers tolerate more delay at a signal. So the same 30s delay grades C at a signal and D at a stop sign.

**Signal tuning holds a genuine discovery.** At a 900 veh/h approach: retiming alone is *free* and cuts delay from >200s to 138s; adding a lane reaches 39s; both reach 24s. And **a shorter cycle at the same green ratio reduces delay**, because long cycles mean long red waits. That is counterintuitive, true, and a satisfying thing for a player to work out.

**Turn lanes** scale with left-turn share: 18% improvement at 15% lefts, 40% at 35%. So the intersection inspector must show the turning-movement breakdown — a small fan of arrows with counts reads instantly and explains the fix.

**Highest-leverage UI feature:** because the analytic HCM models are microsecond-cheap, hovering a control-type tool over an existing junction can show *projected* delay and grade before committing. This turns intersection choice from trial-and-error into an informed engineering decision, which is the entire fantasy.

### 4.6 Demand and town growth

Two steps, not the classic four. Mode split is skipped (single mode) and assignment is the existing router.

```
Trip generation:  P_i = pop_i · rate · (Acc_i / Acc_ref)^ε
Accessibility:    Acc_i = Σ_j A_j · exp(−β · c_ij)          (Hansen)
Distribution:     T_ij = P_i · A_j·f(c_ij) / Σ_j' A_j'·f(c_ij')
```

β ≈ 0.06/min (half-life ~11.5 min), ε ≈ 0.5.

**The model must be singly-constrained (origin-constrained).** A doubly-constrained gravity model forces total trips to equal total attractions, which *mathematically cancels induced demand* — the growth term becomes exactly zero. This is a real trap and was hit during research.

**Induced demand, measured:** upgrading one corridor from 25 to 12 minutes produced **+24% total trips region-wide and +61% flow on the upgraded corridor** (1138 → 1831 veh/h). The improvement eats most of its own capacity gain. This matches Duranton & Turner's empirical elasticity of VKT to capacity, which is essentially unity.

Towns grow where accessibility is high. Roads shape growth; the player never places buildings.

### 4.7 Road classes and upgrades

Gravel lane → rural two-lane → arterial with turn lanes → divided highway.

Upgrading in place is a first-class verb, not a demolish-and-rebuild. This is what gives the traffic feedback loop *answers* — congestion appears, and the player has a menu of real interventions with real tradeoffs.

Class determines: lane count, design speed, capacity, construction cost per metre, earthwork tolerance, and pavement durability.

### 4.8 Pavement lifecycle

Governed by the AASHTO fourth-power law: damage scales with axle load to the fourth power.

```
LEF = (load / 18,000 lb)⁴
```

A car is ~0.0003 ESAL; a loaded semi ~3.0. **One truck ≈ 1,000 cars.** At 10,000 veh/day with 5% trucks, cars contribute 0.2% of total pavement wear.

This makes maintenance a **freight routing mechanic**, not a generic tax. Modelled decay from new (PSI 4.2) to failed (PSI 2.5):

| Class | Life under load |
|---|---|
| Gravel | months |
| Rural two-lane | 2.4 years |
| Arterial | 11.9 years |
| Divided highway | 59 years |

The resulting gameplay: *route trucks off your gravel roads or they die.* A real constraint with a real answer, and one the player can reason about.

## 5. Legibility

**The congestion metric is delay ratio**, `(free-flow time / actual time) − 1`. Not flow relative to capacity.

| Metric | v/c 0.6 | 0.8 | 1.0 | 1.2 |
|---|---|---|---|---|
| flow / capacity | 0.60 | 0.80 | 1.00 | 1.00 |
| speed ratio | 0.98 | 0.80 | 0.40 | 0.13 |
| **delay ratio** | **0.01** | **0.06** | **0.38** | **1.00** |

Flow/capacity is the worst available choice and it is what Cities: Skylines uses — which is the precise cause of the documented player complaint that red indicates *usage* rather than *congestion*. A busy healthy motorway lights up red, and v/c 0.8 and 1.0 look nearly identical.

Delay ratio is near zero while flowing, rises sharply and without bound as things break, is directly meaningful ("this trip takes 2.4× as long as it should"), and **aggregates** — sum along a path to grade a corridor, over the network to grade the region.

**Colour:** Viridis or Cividis. Perceptually uniform, monotonic in lightness, colourblind-safe. Never red-green.

**Language:** seconds and plain words. "Cars wait 42s here" is understood instantly; "v/c = 0.94" is not. LOS letters may appear alongside the number for players who want them.

**Overlays:**
- Delay-ratio heatmap on segments
- Back-of-queue bars behind stop lines — spillback reaching the upstream junction is the most satisfying failure to watch and then fix
- Per-movement capacity bars in the intersection inspector — shows *which* approach is failing, which is the actionable part
- Time–space diagram for a signal corridor; aligning the green bands is a complete puzzle mechanic on its own

A hard-won lesson from Colossal Order: when everything gridlocks, an overlay that paints everything red identifies nothing. Congestion visualization must isolate the *bottleneck*, not the symptom.

## 6. Presentation

3D, WebGL2, tilt-shift diorama over real landscape. Shallow depth of field, believable light, physically-based materials. Reads as an architectural model.

The player builds from a comfortable raised angle and can drop the camera low for photography. Miniature framing is chosen deliberately: small scenes at high fidelity are cheap to render and expensive to look at, which is the entire strategy for reaching a premium look inside a browser budget.

Detailed rendering decisions (LOD strategy, vegetation instancing, post chain, water) are deferred to the implementation plan.

## 7. Architecture

Strict dependency direction. Nothing below depends on anything above it.

| Module | Responsibility | Depends on |
|---|---|---|
| `geometry/` | Alignment primitives, curve math, offsets, fillets | nothing |
| `terrain/` | Heightmap, edit layers, cut/fill volumes | `geometry` |
| `network/` | Road graph: nodes, edges, classes, topology ops | `geometry` |
| `mesh/` | Road ribbons, junction polygons, bridges → BufferGeometry | `geometry`, `network`, `terrain` |
| `sim/` | **Worker.** Traffic, routing, demand, pavement | `network` (serialized) |
| `render/` | three.js scene, camera, materials, post | `mesh`, sim snapshots |
| `tools/` | Road tool: control points, snapping, preview, commit | all of the above |
| `app/` | Bootstrap, UI, persistence | all of the above |

Two boundaries are load-bearing:

- **`geometry/` depends on nothing.** No three.js, no DOM, no engine types. Pure functions over numbers, fully unit-testable, and the place where correctness matters most.
- **`sim/` never touches three.js.** It receives a serialized network and emits state snapshots. It must be runnable headless for testing and validation against HCM analytics.

### Threading

Simulation runs in a Web Worker at fixed timestep. The renderer treats it like a netcode server.

**GitHub Pages cannot serve the COOP/COEP headers that `SharedArrayBuffer` requires.** The request has been open since March 2022, acknowledged by GitHub staff in July 2023 with no ETA, and remains open. This must not be planned around.

It does not matter. Transferring a 780KB state buffer (50k vehicles × 4 floats) costs **0.046ms** — 0.14% of a core at 30Hz. Use a **three-buffer transferable rotation**: the worker owns one, the renderer owns one, and a third holds the most recent completed frame.

Two documented traps:

1. **Detached buffers fail silently.** After transfer, indexed reads on a stale view return `undefined` — not an exception — which becomes `NaN` downstream with no stack trace. Re-create views from the received buffer every message; check `buffer.detached`.
2. **Worker and main thread have different `performance.timeOrigin`.** Publish `performance.now() + performance.timeOrigin` and convert.

Render at approximately `now − 2 × tickInterval` (~66ms at 30Hz) and interpolate between bracketing snapshots. Use generational handles `(index, generation)` for entity identity so spawns and despawns can be deferred to match snapshot timing.

Fixed-timestep accumulator inside the worker, with the standard 0.25s spiral-of-death clamp.

### Vehicle rendering

`InstancedMesh` for vehicles; `BatchedMesh` for static roads and buildings. **Not `BatchedMesh` for moving objects** — its per-frame culling path is an O(N) JS loop, and `setMatrixAt` re-uploads the entire matrix texture.

Trap: `InstancedMesh.boundingSphere` is computed lazily once and never invalidated, so moving vehicles causes the whole fleet to pop out of view. Set `frustumCulled = false` or assign a hand-computed world-sized sphere. Never recompute per frame.

Set `instanceMatrix.setUsage(THREE.DynamicDrawUsage)` — `InstancedMesh` does not do this automatically. LOD by compaction: write surviving vehicles to the front of the buffer and set `mesh.count`.

## 8. Tech stack

- **TypeScript**, strict
- **Vite** — `base` must be set to the repo path for GitHub Pages
- **three.js** r185, WebGL2 (WebGPU is ~84% coverage with real gaps on Firefox Linux and Android; nothing here requires it)
- **Vitest** for unit tests, particularly `geometry/` and `sim/`
- **Web Worker** via `new Worker(new URL('./sim.worker.ts', import.meta.url), {type: 'module'})` — the `new URL()` must be inline, not hoisted, or it silently 404s in production
- Static build → GitHub Pages
- Save via `localStorage`, with schema versioning from the first release

## 9. Milestones

**The implementation plan covers M1 only.** Later milestones are sketched here for direction and are not yet specified to plan depth.

**M1 — Tool-first vertical slice.** *(approved build order)*

Alignment geometry, drawing tool with snapping, terrain with cut and fill, road mesh generation, and enough renderer to judge the look. One valley. No traffic, no economy, no aging. Deployed to Pages and genuinely pleasant to drag roads around in.

M1's renderer scope is deliberately bounded: terrain, road, and water materials under sun and sky, shadows, tone mapping, and depth of field. Vegetation, weather, and the full post chain are M5.

Rationale: the drag-a-road interaction is touched every second of play — if it is not superb, no amount of simulation depth compensates. It is also where the hardest technical problems meet (spline geometry, mesh generation, junction polygons, terrain deformation), so failing there early is cheap.

**M2 — Traffic.** Vehicle simulation, routing, intersection control, the delay-ratio overlay.

**M3 — Region.** Towns, demand, growth, accessibility, induced demand.

**M4 — Stewardship.** Road classes, upgrades, budget, pavement aging, freight.

**M5 — Polish.** Photo mode, audio, save/load, onboarding.

## 10. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Junction geometry** — generating clean polygons where 2+ ribbons meet is the hardest problem in the project and every shipped game has visible failure modes | High | Prototype in M1 against the ugliest cases first: acute angles, differing widths, 5+ legs, steep grade |
| Road tool feel doesn't land | High | It is M1's entire purpose; check in early and often on feel specifically |
| Diorama look costs more than the frame budget allows | Medium | Measure on target hardware in week one, before committing to an architecture |
| Terrain LOD versus runtime deformation conflict | Medium | Design the edit layer and the LOD scheme together, not sequentially |
| Scope — five systems is a lot | Medium | Milestones are independently shippable; M1 alone is a real thing |
| Some HCM constants unverified | Low | Flagged in research; none load-bearing. Verify against a real HCM copy before shipping capacity readouts |

## 11. Open questions

- GitHub username and repository name (needed for Vite `base` before first deploy)
- Final name — Chainage is a placeholder
- Mobile/touch support: out of scope for now, revisit after M1
- Audio direction: deferred to M5

## 12. Research provenance

Three parallel research streams informed this design, with reports retained in the session:

1. **Road alignment geometry and mesh generation** — OpenDRIVE data model, clothoid math, junction generation, cut/fill, bridges
2. **Rendering** — WebGPU/WebGL2 decision, tilt-shift technique, terrain and vegetation, post chain, GitHub Pages delivery budget
3. **Simulation architecture** — IDM/MOBIL, routing and invalidation, threading, demand modelling, legibility. Includes original benchmarks measured in V8 and a Monte-Carlo validation of gap acceptance against HCM analytic capacity

Two follow-on streams covered Cities: Skylines road tool internals (decompiled sources) and HCM/MUTCD intersection capacity and warrants.

Numbers presented as measured are measured. Items the researchers could not verify against a primary source are flagged in their reports and are noted above where relevant — chiefly a small number of HCM exhibit constants where the source PDF was incomplete.
