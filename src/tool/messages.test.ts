import { describe, expect, it } from 'vitest'
import {
  describeInfeasibleCrossings,
  describeInfeasibleRoads,
  describePolylineRejection,
  describeSplitOutcome,
  describeUpgradeObstacle,
  describeUpgradeObstacles,
} from './messages'

describe('describePolylineRejection', () => {
  it('explains too few points', () => {
    expect(describePolylineRejection({ reason: 'too-few-points' })).toMatch(/two points/i)
  })

  it('names the corner that is too sharp', () => {
    const message = describePolylineRejection({ reason: 'corner-too-sharp', index: 3 })
    expect(message).toMatch(/corner/i)
    // Points are numbered from one for a player, not from zero.
    expect(message).toContain('4')
  })

  it('gives both lengths when curves overlap', () => {
    const message = describePolylineRejection({
      reason: 'curves-overlap',
      index: 1,
      required: 100,
      available: 60,
    })
    // Pinned to the phrase each number plays a role in, not just its
    // presence — `required` and `available` swapped still passes a bare
    // `toContain('100')`/`toContain('60')` pair, since both numbers are
    // still somewhere in the sentence either way.
    expect(message).toMatch(/needs 100\.0m/)
    expect(message).toMatch(/only 60\.0m/)
  })

  it('gives the length and the limit when a segment is too short', () => {
    const message = describePolylineRejection({
      reason: 'segment-too-short',
      index: 0,
      length: 4.2,
      limit: 7,
    })
    // As above: pinned to which number is the actual length and which is
    // the minimum, not merely that both appear.
    expect(message).toMatch(/only 4\.2m long/)
    expect(message).toMatch(/the 7\.0m minimum/)
  })
})

describe('describeUpgradeObstacle', () => {
  it('gives the station and both radii for a curve that is too tight', () => {
    const message = describeUpgradeObstacle({
      kind: 'alignment',
      rejection: {
        reason: 'curve-too-tight',
        station: 240,
        actualRadius: 85.5,
        requiredRadius: 394.2,
      },
    })
    // Pinned to role, not presence: `actualRadius`/`requiredRadius` swapped
    // reads as "radius of 394.2m, tighter than the 85.5m this class
    // requires" — nonsense, since 394.2 is not tighter than 85.5 — and a
    // bare `toContain` pair for both numbers would not catch that.
    expect(message).toMatch(/station 240\.0/)
    expect(message).toMatch(/radius of 85\.5m/)
    expect(message).toMatch(/tighter than the 394\.2m/)
  })

  it('gives the trim and the limit for a junction that cannot be pulled back far enough', () => {
    const message = describeUpgradeObstacle({
      kind: 'junction',
      nodeId: 7,
      roadEnd: 'end',
      reason: 'trim-too-long',
      worstTrim: 91.3,
      maxTrim: 60,
      worstLegs: [],
    })
    // Pinned to role: `worstTrim`/`maxTrim` swapped would still contain both
    // numbers, just with which one is the actual trim and which is the
    // limit reversed.
    expect(message).toMatch(/pull back 91\.3m/)
    expect(message).toMatch(/beyond the 60\.0m limit/)
  })

  it('names which end of the road a junction obstacle is at', () => {
    const start = describeUpgradeObstacle({
      kind: 'junction',
      nodeId: 2,
      roadEnd: 'start',
      reason: 'near-parallel-legs',
    })
    const end = describeUpgradeObstacle({
      kind: 'junction',
      nodeId: 9,
      roadEnd: 'end',
      reason: 'near-parallel-legs',
    })
    expect(start).toMatch(/start/)
    expect(end).toMatch(/\bend\b/)
    // The raw node id is an internal counter with no meaning to a player —
    // it must not leak into the sentence.
    expect(start).not.toMatch(/\b2\b/)
    expect(end).not.toMatch(/\b9\b/)
  })

  it('explains near-parallel legs without inventing numbers', () => {
    const message = describeUpgradeObstacle({
      kind: 'junction',
      nodeId: 2,
      roadEnd: 'start',
      reason: 'near-parallel-legs',
    })
    expect(message).toMatch(/parallel/i)
    expect(message).not.toMatch(/NaN|undefined/)
  })

  it('explains too few legs', () => {
    const message = describeUpgradeObstacle({
      kind: 'junction',
      nodeId: 2,
      roadEnd: 'start',
      reason: 'too-few-legs',
    })
    expect(message).not.toMatch(/NaN|undefined/)
  })
})

describe('describeUpgradeObstacles', () => {
  it('reports every obstacle, not just the first', () => {
    const message = describeUpgradeObstacles([
      {
        kind: 'alignment',
        rejection: {
          reason: 'curve-too-tight',
          station: 10,
          actualRadius: 20,
          requiredRadius: 400,
        },
      },
      { kind: 'junction', nodeId: 3, roadEnd: 'start', reason: 'near-parallel-legs' },
    ])
    expect(message).toMatch(/curve/i)
    expect(message).toMatch(/parallel/i)
  })

  it('distinguishes two obstacles at different ends of the same road', () => {
    // The bug this guards against: `checkUpgrade` can emit one obstacle per
    // end of a road, and two `near-parallel-legs` (or two `trim-too-long`)
    // obstacles used to produce two copies of the exact same sentence, with
    // nothing to tell a player which end either one was about.
    const message = describeUpgradeObstacles([
      { kind: 'junction', nodeId: 3, roadEnd: 'start', reason: 'near-parallel-legs' },
      { kind: 'junction', nodeId: 9, roadEnd: 'end', reason: 'near-parallel-legs' },
    ])
    expect(message).toMatch(/start/)
    expect(message).toMatch(/\bend\b/)
  })

  it('says nothing useful is wrong for an empty list', () => {
    expect(describeUpgradeObstacles([])).toBe('')
  })
})

describe('describeSplitOutcome', () => {
  it('explains each refusal', () => {
    expect(describeSplitOutcome({ ok: false, reason: 'nothing-selected' })).toMatch(/select/i)
    expect(describeSplitOutcome({ ok: false, reason: 'not-on-the-selected-road' })).toMatch(
      /road/i,
    )
    expect(describeSplitOutcome({ ok: false, reason: 'too-near-an-end' })).toMatch(/end/i)
  })

  it('confirms a successful split', () => {
    const message = describeSplitOutcome({ ok: true, first: 1, second: 2, node: 3 })
    expect(message).toMatch(/split/i)
  })
})

describe('describeInfeasibleRoads', () => {
  it('is empty when every road solved', () => {
    expect(describeInfeasibleRoads(new Map())).toBe('')
  })

  it('names how many roads failed and where the first one gave up', () => {
    const message = describeInfeasibleRoads(new Map([[4, 132.5]]))
    expect(message).toMatch(/grade|gradient|vertical/i)
    expect(message).toContain('132.5')
  })

  it('counts several failures', () => {
    const message = describeInfeasibleRoads(
      new Map([
        [4, 10],
        [9, 20],
      ]),
    )
    expect(message).toContain('2')
  })

  it('says "road" (singular) for exactly one failure', () => {
    const message = describeInfeasibleRoads(new Map([[4, 100]]))
    // Would still pass if the singular/plural branch were deleted and
    // "roads" always printed — the negative assertion is what pins it.
    expect(message).toMatch(/1 road\b/)
    expect(message).not.toMatch(/\broads\b/)
  })

  it('says "roads" (plural) for more than one failure', () => {
    const message = describeInfeasibleRoads(
      new Map([
        [4, 10],
        [9, 20],
      ]),
    )
    expect(message).toMatch(/2 roads\b/)
  })
})

describe('fmt (number formatting shared by every message)', () => {
  // `fmt` is not exported — its docstring says rounding to one decimal place
  // is deliberate, but every existing test above happens to use values that
  // `String(metres)` would also print correctly. These two pin the actual
  // rounding behaviour through a public function, so replacing `fmt` with
  // `String` would fail them even though it passes everything else.
  it('rounds beyond one decimal place rather than printing full precision', () => {
    const message = describePolylineRejection({
      reason: 'segment-too-short',
      index: 0,
      length: 4.567,
      limit: 7,
    })
    expect(message).toMatch(/4\.6m/)
    expect(message).not.toContain('4.567')
  })

  it('still shows one decimal place for an already-integral value', () => {
    const message = describeInfeasibleRoads(new Map([[4, 132]]))
    // `String(132)` would print "132", with no decimal point at all.
    expect(message).toMatch(/132\.0m/)
  })
})

describe('describeInfeasibleCrossings', () => {
  const crossing = {
    road: 3,
    crosses: 1,
    station: 212.44,
    requiredElevation: 118.06,
    failedAtStation: 40,
  }

  it('is empty when every crossing was separated', () => {
    expect(describeInfeasibleCrossings([])).toBe('')
  })

  it('names both roads, the height needed and where the grade line gave up', () => {
    const message = describeInfeasibleCrossings([crossing])
    expect(message).toContain('118.1')
    expect(message).toContain('212.4')
    expect(message).toContain('40.0')
    expect(message).toMatch(/road 3/)
    expect(message).toMatch(/road 1/)
  })

  it('counts more than one', () => {
    expect(describeInfeasibleCrossings([crossing, { ...crossing, crosses: 2 }])).toMatch(
      /2 crossings/,
    )
  })
})
