import { describe, it, expect } from 'vitest'
import { buildBridgeMesh, DECK_DEPTH, PIER_SPACING, SUPPORT_DECK_MARGIN, supportStations } from './bridgeMesh'
import { Alignment } from '../../geometry/alignment'
import { Line, Arc } from '../../geometry/primitives'
import { vec2 } from '../../geometry/vec2'
import { Heightmap } from '../../terrain/heightmap'
import type { ProfilePoint } from '../../terrain/groundProfile'
import type { StructureSpan } from './spans'
import { ROAD_CLASSES, ROAD_CLASS_ORDER, totalPavementThickness } from '../../network/roadClass'

const road = (length: number) => new Alignment([new Line(vec2(0, 0), 0, length)])
const level = (length: number, z: number): ProfilePoint[] => [{ s: 0, z }, { s: length, z }]
const flat = (z: number) => Heightmap.flat(-500, -500, 50, 41, 41, z)

/**
 * Ground on a constant east-facing gradient, `z` metres at x = 0.
 *
 * Linear in x, so bilinear sampling reproduces it exactly and an assertion can
 * name the elevation at a station rather than approximating it. Every other
 * fixture here is level, and level is precisely the case that cannot tell an
 * abutment measured at its own station from one measured at the span
 * boundary — the two coincide.
 */
const ramp = (z: number, slope: number): Heightmap => {
  const cols = 41, rows = 41, cellSize = 50, originX = -500
  const elevations = new Float32Array(cols * rows)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      elevations[row * cols + col] = z + slope * (originX + col * cellSize)
    }
  }
  return new Heightmap(originX, -500, cellSize, cols, rows, elevations)
}

/** A design line climbing at a constant grade from `z` at station 0. */
const graded = (length: number, z: number, grade: number): ProfilePoint[] =>
  [{ s: 0, z }, { s: length, z: z + grade * length }]

const span = (from: number, to: number, maxHeight: number): StructureSpan => ({
  fromStation: from, toStation: to, maxHeight,
})

// Most tests don't care which class they build for; rural stands in as the
// default the same way it did back when DECK_CLEARANCE was a bare constant.
const RURAL = ROAD_CLASSES.rural

const zRange = (m: { positions: Float32Array; vertexCount: number }) => {
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < m.vertexCount; i++) {
    const z = m.positions[i * 3 + 2]!
    lo = Math.min(lo, z); hi = Math.max(hi, z)
  }
  return { lo, hi }
}

/**
 * Signed volume of a triangle mesh via the divergence theorem:
 * V = (1/6) * sum over triangles of a . (b x c).
 *
 * Positive for a closed solid with outward-facing normals; negative if the
 * solid is inside-out. This is independent of the winding-vs-stored-normal
 * check in MeshBuilder, which derives a face's normal from its own winding
 * and so cannot detect a uniformly inverted shape.
 */
const signedVolume = (m: { positions: Float32Array; indices: Uint32Array }): number => {
  let volume = 0
  for (let t = 0; t < m.indices.length; t += 3) {
    const i = m.indices[t]!, j = m.indices[t + 1]!, k = m.indices[t + 2]!
    const ax = m.positions[i * 3]!, ay = m.positions[i * 3 + 1]!, az = m.positions[i * 3 + 2]!
    const bx = m.positions[j * 3]!, by = m.positions[j * 3 + 1]!, bz = m.positions[j * 3 + 2]!
    const cx = m.positions[k * 3]!, cy = m.positions[k * 3 + 1]!, cz = m.positions[k * 3 + 2]!
    const crossX = by * cz - bz * cy
    const crossY = bz * cx - bx * cz
    const crossZ = bx * cy - by * cx
    volume += ax * crossX + ay * crossY + az * crossZ
  }
  return volume / 6
}

describe('buildBridgeMesh', () => {
  it('produces geometry for a span', () => {
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(50, 150, 40), 5, RURAL)
    expect(m.vertexCount).toBeGreaterThan(0)
    expect(m.triangleCount).toBeGreaterThan(0)
  })

  it('returns an empty mesh for a zero-length span', () => {
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(80, 80, 40), 5, RURAL)
    expect(m.vertexCount).toBe(0)
  })

  it('keeps the deck below the design elevation', () => {
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(50, 150, 40), 5, RURAL)
    expect(zRange(m).hi).toBeLessThan(100)
  })

  it('reaches down to the ground', () => {
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(50, 150, 40), 5, RURAL)
    expect(zRange(m).lo).toBeCloseTo(60, 0)
  })

  it('makes a taller structure over deeper ground', () => {
    const shallow = buildBridgeMesh(road(200), flat(90), level(200, 100), span(50, 150, 10), 5, RURAL)
    const deep = buildBridgeMesh(road(200), flat(50), level(200, 100), span(50, 150, 50), 5, RURAL)
    const height = (m: ReturnType<typeof buildBridgeMesh>) => {
      const r = zRange(m)
      return r.hi - r.lo
    }
    expect(height(deep)).toBeGreaterThan(height(shallow))
  })

  it('gives the deck the requested depth', () => {
    const m = buildBridgeMesh(road(200), flat(99), level(200, 100), span(50, 150, 1), 5, RURAL, {
      pierSpacing: 1000,
    })
    // Ground almost at design, so the whole structure is essentially the deck.
    const r = zRange(m)
    expect(r.hi - r.lo).toBeGreaterThanOrEqual(DECK_DEPTH - 0.5)
  })

  it('adds more piers to a longer span', () => {
    const shortSpan = buildBridgeMesh(road(400), flat(60), level(400, 100), span(50, 90, 40), 5, RURAL)
    const longSpan = buildBridgeMesh(road(400), flat(60), level(400, 100), span(50, 350, 40), 5, RURAL)
    expect(longSpan.vertexCount).toBeGreaterThan(shortSpan.vertexCount)
  })

  it('places no pier when the span is shorter than the pier spacing', () => {
    const withPiers = buildBridgeMesh(road(400), flat(60), level(400, 100), span(50, 350, 40), 5, RURAL)
    const withoutPiers = buildBridgeMesh(
      road(400), flat(60), level(400, 100), span(50, 350, 40), 5, RURAL, { pierSpacing: 10000 },
    )
    expect(withoutPiers.vertexCount).toBeLessThan(withPiers.vertexCount)
  })

  it('spans the full road width', () => {
    const halfWidth = 7
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(50, 150, 40), halfWidth, RURAL)
    let widest = 0
    for (let i = 0; i < m.vertexCount; i++) {
      widest = Math.max(widest, Math.abs(m.positions[i * 3 + 1]!))
    }
    expect(widest).toBeCloseTo(halfWidth, 4)
  })

  it('stays within the span stations', () => {
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(50, 150, 40), 5, RURAL)
    for (let i = 0; i < m.vertexCount; i++) {
      const x = m.positions[i * 3]!
      expect(x).toBeGreaterThanOrEqual(50 - 1e-4)
      expect(x).toBeLessThanOrEqual(150 + 1e-4)
    }
  })

  it('gives unit-length normals', () => {
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(50, 150, 40), 5, RURAL)
    for (let i = 0; i < m.vertexCount; i++) {
      const len = Math.hypot(m.normals[i * 3]!, m.normals[i * 3 + 1]!, m.normals[i * 3 + 2]!)
      expect(len).toBeCloseTo(1, 4)
    }
  })

  it('winds every triangle to agree with its normal', () => {
    const m = buildBridgeMesh(road(200), flat(60), level(200, 100), span(50, 150, 40), 5, RURAL)
    for (let t = 0; t < m.indices.length; t += 3) {
      const [i, j, k] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!]
      const ax = m.positions[i * 3]!, ay = m.positions[i * 3 + 1]!, az = m.positions[i * 3 + 2]!
      const ux = m.positions[j * 3]! - ax, uy = m.positions[j * 3 + 1]! - ay, uz = m.positions[j * 3 + 2]! - az
      const vx = m.positions[k * 3]! - ax, vy = m.positions[k * 3 + 1]! - ay, vz = m.positions[k * 3 + 2]! - az
      const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx
      const dot = fx * m.normals[i * 3]! + fy * m.normals[i * 3 + 1]! + fz * m.normals[i * 3 + 2]!
      expect(dot).toBeGreaterThan(0)
    }
  })

  it('exports sane defaults', () => {
    expect(DECK_DEPTH).toBeGreaterThan(0)
    expect(PIER_SPACING).toBeGreaterThan(DECK_DEPTH)
  })

  it('puts the deck top exactly at the pavement underside for every class', () => {
    // The design line IS the top of the wearing course, so the deck's own top
    // has to sit exactly one pavement-stack thickness below it — not a
    // constant shared across classes, whose thicknesses differ (0.4, 0.5,
    // 0.61, 0.73m for gravel/rural/arterial/highway respectively).
    const designZ = 100
    for (const name of ROAD_CLASS_ORDER) {
      const rc = ROAD_CLASSES[name]
      const m = buildBridgeMesh(road(200), flat(60), level(200, designZ), span(50, 150, 40), 5, rc)
      // Precision 4, not tighter: positions round-trip through a Float32Array,
      // whose ~7 significant digits only hold values near 100 to about 1e-5.
      expect(zRange(m).hi).toBeCloseTo(designZ - totalPavementThickness(rc), 4)
    }
  })

  it('keeps the abutment top clear of the deck underside', () => {
    const designZ = 100
    const deckUnderside = designZ - totalPavementThickness(RURAL) - DECK_DEPTH
    // Ground far below, and piers spaced wider than the span, so the only
    // supports built are the two abutments — nothing else can be mistaken
    // for the surface being measured.
    const m = buildBridgeMesh(road(200), flat(10), level(200, designZ), span(90, 110, 90), 5, RURAL, {
      pierSpacing: 1000,
    })
    // The abutment's top face is the highest surface strictly below the deck
    // underside; every other vertex below the deck (ground, abutment sides
    // and bottom) sits much further down.
    let highestBelowDeck = -Infinity
    for (let i = 0; i < m.vertexCount; i++) {
      const z = m.positions[i * 3 + 2]!
      if (z < deckUnderside - 1e-6) highestBelowDeck = Math.max(highestBelowDeck, z)
    }
    // Precision 4: `highestBelowDeck` comes from a Float32Array, whose ~7
    // significant digits only hold values near 100 to about 1e-5.
    expect(deckUnderside - highestBelowDeck).toBeCloseTo(SUPPORT_DECK_MARGIN, 4)
  })

  // Signed-volume checks: a winding-vs-normal test (see above) is true by
  // construction in MeshBuilder and cannot catch a uniformly inverted solid.
  // Every piece of the bridge is a closed solid — deck slab included, since
  // its ends are capped — so the divergence-theorem volume is the true
  // enclosed volume, independent of where the origin happens to be. That
  // independence is what makes the sign an invariant rather than a race
  // between whichever part of the mesh sits furthest from (0, 0, 0).

  it('gives the deck slab its exact volume, with no supports in the mesh', () => {
    // Ground above the deck's underside, so every support is skipped and the
    // slab is all that is left: 100m long, 10m wide, DECK_DEPTH thick.
    const m = buildBridgeMesh(road(200), flat(99), level(200, 100), span(50, 150, 1), 5, RURAL)
    expect(signedVolume(m)).toBeCloseTo(100 * 10 * DECK_DEPTH, 1)
  })

  it('measures the same volume wherever the origin is put', () => {
    // A CURVED road on purpose. On a straight one the two end caps face
    // exactly opposite ways, so their area vectors cancel and an uncapped
    // slab is accidentally origin-independent anyway — the test would pass
    // on the very mesh it exists to reject. Through a one-radian bend they
    // do not cancel.
    const bend = new Alignment([new Arc(vec2(0, 0), 0, 200, 1 / 200)])
    const m = buildBridgeMesh(bend, flat(10), level(200, 100), span(50, 150, 90), 5, RURAL)
    const shifted = {
      positions: Float32Array.from(m.positions, (v, i) =>
        v + [1e4, 2e4, 3e4][i % 3]!),
      indices: m.indices,
    }
    // Relative tolerance: Float32 positions 30km from the origin cannot hold
    // a cubic metre exactly, but an unclosed surface would not be close at all.
    expect(signedVolume(shifted)).toBeCloseTo(signedVolume(m), -2)
  })

  it('has positive signed volume for an abutments-only bridge', () => {
    const m = buildBridgeMesh(road(200), flat(10), level(200, 100), span(90, 110, 90), 5, RURAL, {
      pierSpacing: 1000, // longer than the span, so only abutments are placed
    })
    expect(signedVolume(m)).toBeGreaterThan(0)
  })

  it('has positive signed volume for a bridge with piers', () => {
    const m = buildBridgeMesh(road(200), flat(10), level(200, 100), span(50, 150, 90), 5, RURAL, {
      pierSpacing: 25,
    })
    expect(signedVolume(m)).toBeGreaterThan(0)
  })

  describe('supportStations', () => {
    it('places piers at exactly the requested spacing for 100m at 25m', () => {
      const stations = supportStations(0, 100, 25)
      // 2 abutments + 3 piers, at 25m gaps: 0, 25, 50, 75, 100.
      expect(stations).toHaveLength(5)
      const sorted = [...stations].sort((a, b) => a - b)
      expect(sorted).toEqual([0, 25, 50, 75, 100])
    })

    it('never places a pier on a span end', () => {
      for (const spacing of [5, 10, 17, 25, 33, 50]) {
        const stations = supportStations(0, 100, spacing)
        for (const s of stations.slice(2)) {
          expect(s).toBeGreaterThan(0)
          expect(s).toBeLessThan(100)
        }
      }
    })
  })

  /**
   * An abutment is measured at its OWN station, not at the span boundary.
   *
   * `addBox` centres its footprint on the station it is given, so an abutment
   * sitting exactly on a span boundary would hang half its length outside the
   * span. It is shifted inward by its own half-length instead — and once it
   * has been, the ground under it and the deck's underside over it are both at
   * a different station from the boundary.
   *
   * Both fixtures below are sloped for exactly that reason. On a level fixture
   * the two stations give the same answer and the distinction is invisible,
   * which is how measuring at the wrong one survived every test here.
   *
   * `pierSpacing` is wider than the span throughout, so the only supports
   * built are the two abutments and nothing else can be mistaken for them. The
   * near abutment's box is centred at station 91 (90 + `PIER_HALF_WIDTH`) and
   * runs from 90 to 92; the deck slab steps in 5m from 90, so x = 92 belongs
   * to the abutment alone.
   */
  describe('an abutment on sloped ground', () => {
    /** Vertices whose station is `s`, within Float32 noise. */
    const zAtStation = (
      m: ReturnType<typeof buildBridgeMesh>,
      s: number,
    ): number[] => {
      const zs: number[] = []
      for (let i = 0; i < m.vertexCount; i++) {
        if (Math.abs(m.positions[i * 3]! - s) < 1e-3) zs.push(m.positions[i * 3 + 2]!)
      }
      return zs
    }

    it('stands on the ground under its own footprint, not under the span end', () => {
      // Ground climbing at 0.2, so the 1m inward shift moves it 0.2m — twenty
      // times any Float32 noise in these numbers, and invisible on a level
      // fixture.
      const ground = ramp(10, 0.2)
      const m = buildBridgeMesh(
        road(200), ground, level(200, 100), span(90, 110, 90), 5, RURAL,
        { pierSpacing: 1000 },
      )

      const near = zAtStation(m, 92)
      expect(near.length).toBeGreaterThan(0)
      // The box's bottom is ground at station 91 — where the box actually is —
      // and not ground at station 90, which is 0.2m lower.
      expect(Math.min(...near)).toBeCloseTo(ground.sample(91, 0), 3)
      expect(ground.sample(90, 0)).not.toBeCloseTo(ground.sample(91, 0), 3)
    })

    it('reaches the deck underside above its own footprint, not above the span end', () => {
      // Level ground far below, so nothing about the ground can account for
      // the difference; the design line is what slopes here, at 0.1.
      const design = graded(200, 100, 0.1)
      const m = buildBridgeMesh(
        road(200), flat(10), design, span(90, 110, 90), 5, RURAL,
        { pierSpacing: 1000 },
      )

      const near = zAtStation(m, 92)
      expect(near.length).toBeGreaterThan(0)
      // Design line at 91, less the pavement stack, less the deck, less the
      // margin that keeps the two faces off each other.
      const expected =
        100 + 0.1 * 91 - totalPavementThickness(RURAL) - DECK_DEPTH - SUPPORT_DECK_MARGIN
      expect(Math.max(...near)).toBeCloseTo(expected, 3)
      // Measured at station 90 instead it would be 0.1m lower — short of the
      // deck rather than into it, which is the defect.
      expect(Math.max(...near)).not.toBeCloseTo(expected - 0.1, 3)
    })

    it('does the same at the far abutment, shifted the other way', () => {
      // The far abutment shifts INWARD too, so its box is centred at 109 and
      // its free station is 108. A fix that shifted both the same direction
      // would pass the near-end assertions above and fail here.
      const ground = ramp(10, 0.2)
      const m = buildBridgeMesh(
        road(200), ground, level(200, 100), span(90, 110, 90), 5, RURAL,
        { pierSpacing: 1000 },
      )

      const far = zAtStation(m, 108)
      expect(far.length).toBeGreaterThan(0)
      expect(Math.min(...far)).toBeCloseTo(ground.sample(109, 0), 3)
    })
  })
})
