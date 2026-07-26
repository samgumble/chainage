# Chainage — Construction Visualization Design Spec

**Date:** 2026-07-26
**Status:** Approved design, pending implementation plan
**Extends:** [2026-07-26-chainage-design.md](2026-07-26-chainage-design.md)

---

## 1. Overview

Make the civil engineering visible. When the player commits a road, it does not appear — it gets *built*, in the correct sequence, by the correct equipment, over real time. Alongside that, three optional layers of engineering representation let the player read the site the way an engineer reads a drawing.

This serves the parent spec's second design pillar ("genuine engineering — the domain is the game, not a skin over an abstract puzzle") by making the domain something you can watch rather than only something you infer from numbers.

### What this is not

- **Not a fleet-management mechanic.** The player does not buy, own, or dispatch equipment. This was offered explicitly and declined. Machines appear because work is happening at that place, and leave when it is done.
- **Not a cutscene.** Construction runs in the world while the player continues working elsewhere. There is no modal build sequence and no camera takeover.

## 2. The construction model

The whole system rests on one idea, and everything else falls out of it.

**A road under construction carries seven completion stations** — distances along its alignment, one per layer:

```
cleared ≥ earthworks ≥ structures ≥ subgrade ≥ base ≥ wearing ≥ marked
```

Each is a distance in metres from the alignment's start. The ordering is a hard invariant: a layer can never overtake the layer beneath it, because you cannot pave ground you have not graded.

### What this buys

**The visual is free.** Each layer's mesh is drawn only up to its own station. The road builds itself behind the machines with no animation system, no keyframes, and no per-machine choreography.

**Machines ride frontiers.** Each phase owns exactly one layer, and its equipment renders at that layer's current station. The excavator is wherever earthworks currently ends. Machine placement is a lookup, not a simulation.

**Phases skip themselves.** A road across flat ground generates no earthwork volume, so that station completes in zero time and no excavator ever spawns. A gravel lane has no surfacing layer at all. Nothing needs special-casing — a phase with no work to do is simply already finished.

**Fast-forward is a rate multiplier.** No separate code path.

**Saving is seven floats per road.**

**It is testable with no graphics.** `construction/` is pure logic over numbers, in the same spirit as `geometry/`.

### Progression

Each layer advances at a rate derived from the work remaining in that phase (§4). A road is *open to traffic* when `marked` reaches the alignment's full length — before that, the traffic simulation treats it as not present.

Layers advance concurrently where the invariant permits. The grader can be trimming subgrade at station 200 while the excavator is still cutting at station 340. This is how real linear construction works, and it is why a site looks busy rather than sequential.

## 3. Phases and equipment

Eight phases, each with the equipment that actually performs it.

| # | Phase | Layer advanced | Equipment |
|---|---|---|---|
| 1 | Setting out | none — leads `cleared` | Surveyor, total station, stakes, string lines |
| 2 | Clearing & grubbing | `cleared` | Mulcher, stump grinder, chainsaw crew |
| 3 | Cut | `earthworks` | Excavator loading haul trucks; scraper on long runs |
| 4 | Fill & compaction | `earthworks` | Dozer spreading in lifts, padfoot roller |
| 5 | Structures | `structures` | Piling rig, crawler crane, concrete truck, formwork crew |
| 6 | Subgrade | `subgrade` | Motor grader trimming, smooth drum roller |
| 7 | Base course | `base` | Tippers dropping aggregate, grader spreading, roller |
| 8 | Surfacing | `wearing` | Asphalt paver fed by haul truck, tandem roller, steam |
| 9 | Line marking | `marked` | Line marking truck |

Two of these need their relationship to the six stations spelled out, or the model is ambiguous.

**Setting out advances no station.** Surveyors work *ahead* of the clearing crew, as they do on a real job. The survey party renders at `cleared + leadDistance`, clamped to the alignment end, with `leadDistance` a tunable constant of a few hundred metres. Stakes it has passed remain planted; that is what the in-world chainage annotations (§6.1) attach to.

**Cut and fill share the `earthworks` station, and this is correct rather than a compromise.** At any given station the road is in cut or in fill — never both — depending on whether the design elevation sits below or above existing ground. So a single frontier advancing along the alignment is doing whichever operation applies where it currently is, and the equipment shown changes accordingly: excavator and haul trucks where the frontier is in cut, dozer and padfoot roller where it is in fill. The haul truck cycle visibly carries spoil from the cut reaches to the fill reaches, which is the single most legible piece of civil engineering in the whole game.

Because the two operations have different productivity rates (§4), the frontier advances at different speeds along different reaches of the same road — visibly slowing through a deep cut. That is real, and it is free.

**Structures get their own station, between earthworks and subgrade.** Bridges, overpasses and retaining walls are built on completed earthworks and must be finished before the pavement layers can run over them, so a station of their own places them correctly in the sequence with no special-casing.

The phase covers three structure types, each with a different trigger:

| Structure | Trigger | Source |
|---|---|---|
| Retaining wall | The batter has no room to daylight, so a wall makes up the height | `retainingWall()` in the terrain layer |
| Bridge | The design line stands high enough above natural ground that fill becomes uneconomic | Height of design line above ground, per station |
| Overpass | The alignment crosses another road and must clear it | Road network graph, plus clearance |

Roads with no structures skip the phase entirely, exactly as a flat road skips earthworks. The retaining-wall trigger is already computed in the terrain layer; the bridge and overpass triggers arrive with the mesh plan, which is where their geometry is generated.

> **The bridge trigger is currently unreachable, and the mesh plan must fix it.** This surfaced in the terrain layer's final review and is easy to miss until it manifests as "why does every river crossing fail?"
>
> `solveGradeProfile` bounds every design elevation to `[ground − maxCutDepth, ground + maxFillHeight]`. A design line standing high above natural ground — precisely the bridge trigger described above — is therefore not something the solver can *produce*. Asked for one, it returns `feasible: false` instead. A ravine that ought to resolve to a bridge instead reads as an impossible alignment.
>
> The fix belongs in the mesh plan: a **structure allowance** distinct from the fill allowance. Below the fill allowance the gap is closed with earth; between the fill allowance and the structure allowance it resolves to a bridge; beyond the structure allowance it is genuinely infeasible. The vertical band between those two limits is what makes a crossing a structure rather than an embankment, and no such band exists today.

Equipment is modelled in the parent spec's low-poly diorama style: simple blocky forms with correct silhouettes and correct motion, not detailed vehicle models. A player must be able to tell an excavator from a grader at a glance; they do not need to identify the make.

## 4. Durations from real productivity

Construction duration is **derived from actual work quantities**, never from an arbitrary timer. Each phase has a productivity rate; the time it takes is the quantity divided by the rate.

Planning-grade figures, to be tuned for pacing:

| Phase | Rate | Basis |
|---|---|---|
| Clearing | 300–600 m²/hr | Mulcher on light-to-medium vegetation |
| Cut | 50–80 m³/hr | 20-tonne excavator, bank measure, after efficiency and swell |
| Fill & compaction | 100–200 m³/hr | D6-class dozer spreading in lifts |
| Structures | per structure, not per metre | Piling, abutments, deck erection — days per bridge, hours per retaining wall panel |
| Subgrade | 500–1,500 m²/hr | Motor grader trimming to level |
| Base course | 400–1,000 m²/hr | Supply-limited by tipper cycle |
| Surfacing | 50–150 m/hr | Asphalt paver, supply-limited by haul trucks |
| Line marking | 5,000–10,000 m/hr | Line marking truck |

> These are planning-grade estimates suitable for game pacing. They are the right order of magnitude and the right *relative* ordering, which is what matters. They are not quoted from a published productivity manual and should not be presented to the player as authoritative figures.

### Why this matters

The cut and fill volumes already come from the earthworks system (parent spec §4.2). Feeding them through a productivity rate means **a road through a hill genuinely takes longer to build than one across a flat, because there is more dirt to move.** The engineering shows through the mechanic instead of sitting on top of it.

### Worked pacing example

A 500m rural road cutting through a low ridge, generating roughly 8,000 m³ of earthwork:

- Cut at 70 m³/hr → ~114 work-hours
- Surfacing at 100 m/hr → ~5 work-hours
- Marking → under an hour

At a starting time scale of **one game-hour per real second**, that is about two minutes of construction, overwhelmingly dominated by earthworks. That is both realistic and desirable: it makes the excavator the star of the show, which is exactly the intent.

The time scale is a single tunable constant. Fast-forward multiplies it.

## 5. Pacing and fast-forward

Construction is non-blocking. The player continues drawing, inspecting, and managing elsewhere while sites work.

A speed control offers normal and fast-forward. The risk to manage is that fast-forward becomes the default and the animation goes unwatched:

- Fast-forward is a **momentary state, not a persisted setting** — it resets to normal speed when all active sites complete, so the player opts into skipping each time rather than once.
- A **site completion notification** is passive and non-modal; the player is never pulled anywhere.
- No phase has a minimum duration. If the maths says a phase takes two seconds, it takes two seconds.

## 6. The three view affordances

Independent, separately toggleable, and each useful alone.

### 6.1 In-world annotations (toggle)

The site annotated as a drawing, in three dimensions:

- Survey stakes carrying real chainage labels (`0+340`)
- Grade callouts on slopes (`6.2%`)
- Cut areas and fill areas hatched the way a drawing hatches them, in opposing directions
- A live section at the excavator's cut face, showing layers as they are laid
- Curve data at each arc: radius, deflection, design speed

This is the affordance with no precedent in the genre, and it pairs with the build animation rather than competing with it — the annotations describe work that is visibly happening.

### 6.2 Blueprint view (toggle)

A key flips the world from rendered diorama to engineering drawing: linework, hatching, dimension lines, chainage ticks, north arrow, everything annotated. This is a second render pass over the same scene — the most expensive of the three affordances, and the most screenshot-worthy.

### 6.3 Inspector panel

Click any stretch of road for the formal documents:

- **Cross-section** at the clicked chainage, layers to scale with thicknesses called out
- **Long-section profile** with vertical exaggeration, grades annotated, existing ground versus design line
- **Mass-haul diagram** showing cumulative cut balanced against fill — the classic civil engineering plot, and the clearest possible statement of whether an alignment is balanced

The inspector is where exact numbers live. In-world annotations are for reading at a glance; the panel is for reading precisely.

## 7. Architecture

Dependency direction is strict and one-way.

| Module | Responsibility | Depends on |
|---|---|---|
| `construction/` | Layer stations, phase definitions, productivity rates, advance logic | `geometry`, `terrain` |
| `render/machines/` | Equipment models, placement at layer frontiers, motion | `construction`, `render` |
| `render/annotations/` | In-world chainage, grades, hatching, live section | `construction`, `geometry`, `render` |
| `render/blueprint/` | Blueprint render pass | `render`, `geometry` |
| `ui/inspector/` | Cross-section, profile, mass-haul drawings | `construction`, `geometry`, `terrain` |

`construction/` contains no rendering code and no engine types. It must be runnable headless, so construction progress can be unit-tested and fast-forwarded without a canvas — the same discipline `geometry/` already follows.

The traffic simulation reads only one thing from this system: whether a road is open. That keeps the coupling to a single boolean.

## 8. Impact on the existing M1 plans

**Plan 3's scope changes before it is written.** It was to generate a road mesh; it must now generate a **layer-aware** mesh — subgrade, base and wearing course separately addressable, each drawable to an arbitrary station along the alignment.

This is not deferrable. Retrofitting layer-awareness onto a monolithic road mesh would mean rewriting mesh generation wholesale, and mesh generation is already the highest-risk piece of the project (parent spec §10). The requirement must be in plan 3 from the outset.

Nothing else in the existing plans changes.

## 9. Revised sequence

| Plan | Scope |
|---|---|
| 1 | Foundation & alignment geometry — **complete** |
| 2 | Terrain & earthworks — heightmap, grade solver, cut/fill volumes |
| 3 | **Layered** road mesh & junctions |
| 4 | Interactive tool & look |
| 5 | Construction simulation & machines |
| 6 | Annotations, blueprint view, inspector |

Plans 5 and 6 are separable: 5 delivers the build sequence with equipment, 6 delivers the engineering representation. Either is a coherent shipping point on its own.

## 10. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Around sixteen machine models is the largest art task in the project so far | Medium | Low-poly diorama style; correct silhouette and motion matter far more than detail. Build one machine end to end first and judge it before committing to the rest. |
| Structure geometry (bridge decks, piers, wall panels) is generated, not authored | Medium | Retaining walls are the easy case and land first — a wall is an extruded panel along the alignment at a known offset and height. Bridges and overpasses follow once the mesh layer exists. |
| Fast-forward becomes the default and the animation goes unseen | Medium | Fast-forward is momentary, not persisted (§5). Watch this in playtesting — if players hold it down constantly, durations are too long, not the feature wrong. |
| Blueprint view is effectively a second render pipeline | Medium | Sequenced last, and separable from the annotations work in the same plan. |
| Layer-aware mesh is harder than a monolithic one | Medium | Accepted deliberately and scheduled into plan 3 rather than retrofitted. |
| Productivity rates are estimates, not sourced figures | Low | Flagged in §4. Relative ordering is what drives pacing, and that ordering is confidently correct. Verify against a productivity manual before surfacing any figure to the player as fact. |

## 11. Open questions

- Time scale constant (one game-hour per real second is a starting point, not a decision)
- Whether machines should be visible on completed roads for maintenance and resurfacing, once the pavement lifecycle system exists
- Audio for the construction site — deferred with all other audio to M5
