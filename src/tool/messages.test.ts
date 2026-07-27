import { describe, expect, it } from 'vitest'
import {
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
    expect(message).toContain('100')
    expect(message).toContain('60')
  })

  it('gives the length and the limit when a segment is too short', () => {
    const message = describePolylineRejection({
      reason: 'segment-too-short',
      index: 0,
      length: 4.2,
      limit: 7,
    })
    expect(message).toContain('4.2')
    expect(message).toContain('7')
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
    expect(message).toContain('240')
    expect(message).toContain('85.5')
    expect(message).toContain('394')
  })

  it('gives the trim and the limit for a junction that cannot be pulled back far enough', () => {
    const message = describeUpgradeObstacle({
      kind: 'junction',
      nodeId: 7,
      reason: 'trim-too-long',
      worstTrim: 91.3,
      maxTrim: 60,
      worstLegs: [],
    })
    expect(message).toContain('91.3')
    expect(message).toContain('60')
  })

  it('explains near-parallel legs without inventing numbers', () => {
    const message = describeUpgradeObstacle({
      kind: 'junction',
      nodeId: 2,
      reason: 'near-parallel-legs',
    })
    expect(message).toMatch(/parallel/i)
    expect(message).not.toMatch(/NaN|undefined/)
  })

  it('explains too few legs', () => {
    const message = describeUpgradeObstacle({
      kind: 'junction',
      nodeId: 2,
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
      { kind: 'junction', nodeId: 3, reason: 'near-parallel-legs' },
    ])
    expect(message).toMatch(/curve/i)
    expect(message).toMatch(/parallel/i)
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
})
