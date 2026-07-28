import { describe, expect, it } from 'vitest'
import { type Gesture, GestureRecogniser } from './gestures'

const kinds = (gestures: readonly Gesture[]): string[] => gestures.map((g) => g.kind)

const pick = <K extends Gesture['kind']>(
  gestures: readonly Gesture[],
  kind: K,
): Extract<Gesture, { kind: K }>[] =>
  gestures.filter((g): g is Extract<Gesture, { kind: K }> => g.kind === kind)

/** The single two-finger event a move is expected to have produced. */
const twoFinger = (gestures: readonly Gesture[]): Extract<Gesture, { kind: 'twoFinger' }> => {
  const matches = pick(gestures, 'twoFinger')
  expect(matches).toHaveLength(1)
  const first = matches[0]
  if (first === undefined) throw new Error('unreachable: length asserted above')
  return first
}

describe('GestureRecogniser: one finger', () => {
  it('reports a tap for a down and up inside the slop and the timeout', () => {
    const g = new GestureRecogniser()
    g.down(1, 100, 100, 0)
    // Four pixels of tremor, well inside the ten-pixel slop.
    g.move(1, 103, 97, 40)
    const events = g.up(1, 80)

    expect(kinds(events)).toEqual(['tap'])
    const tap = pick(events, 'tap')[0]
    // The tap reports where the finger landed, not where it drifted to.
    expect(tap).toMatchObject({ x: 100, y: 100, time: 80 })
    expect(g.inProgress).toBe(false)
  })

  it('reports a drag, not a tap, when the finger moves beyond the tap slop', () => {
    const g = new GestureRecogniser()
    g.down(1, 100, 100, 0)
    // Forty pixels: far outside the slop, far inside any plausible mutation
    // of it that would still be a believable constant.
    const moved = g.move(1, 140, 100, 30)
    const ended = g.up(1, 60)

    expect(kinds(moved)).toEqual(['dragStart', 'dragMove'])
    expect(kinds(ended)).toEqual(['dragEnd'])
    expect(kinds([...moved, ...ended])).not.toContain('tap')
  })

  it('anchors dragStart at the down position and dragMove at the current one', () => {
    const g = new GestureRecogniser()
    g.down(1, 100, 100, 0)
    const first = g.move(1, 150, 130, 30)

    expect(pick(first, 'dragStart')[0]).toMatchObject({ x: 100, y: 100 })
    expect(pick(first, 'dragMove')[0]).toMatchObject({ x: 150, y: 130, dx: 50, dy: 30 })

    // Subsequent deltas are relative to the previous sample, not the anchor.
    const second = g.move(1, 160, 130, 40)
    expect(pick(second, 'dragMove')[0]).toMatchObject({ x: 160, y: 130, dx: 10, dy: 0 })
  })

  it('reports nothing for a finger held past the tap timeout and lifted without moving', () => {
    const g = new GestureRecogniser()
    g.down(1, 100, 100, 0)
    // 900ms is past the 500ms timeout: a hand resting on the glass, not a tap.
    expect(kinds(g.up(1, 900))).toEqual([])
    expect(g.inProgress).toBe(false)
  })

  it('ignores a move for a pointer that never went down', () => {
    const g = new GestureRecogniser()
    expect(kinds(g.move(7, 100, 100, 0))).toEqual([])
    expect(kinds(g.up(7, 10))).toEqual([])
    expect(g.inProgress).toBe(false)
  })
})

describe('GestureRecogniser: double tap', () => {
  it('reports a doubleTap for two taps inside the window, and not a second tap', () => {
    const g = new GestureRecogniser()
    g.down(1, 200, 200, 0)
    expect(kinds(g.up(1, 50))).toEqual(['tap'])

    g.down(2, 205, 203, 150)
    const second = g.up(2, 190)

    // Exactly one event, and it is the doubleTap: a consumer that also saw a
    // `tap` here would place a second road point on the double tap.
    expect(kinds(second)).toEqual(['doubleTap'])
    expect(pick(second, 'doubleTap')[0]).toMatchObject({ x: 205, y: 203, time: 190 })
  })

  it('reports two separate taps when the second falls outside the double-tap window', () => {
    const g = new GestureRecogniser()
    g.down(1, 200, 200, 0)
    expect(kinds(g.up(1, 50))).toEqual(['tap'])

    // 450ms after the first tap: past the 300ms window.
    g.down(2, 200, 200, 400)
    expect(kinds(g.up(2, 500))).toEqual(['tap'])
  })

  it('reports two separate taps when the second is far away, however quickly it follows', () => {
    const g = new GestureRecogniser()
    g.down(1, 200, 200, 0)
    expect(kinds(g.up(1, 20))).toEqual(['tap'])

    // 100px away — several fingertips over — but only 30ms later.
    g.down(2, 300, 200, 50)
    expect(kinds(g.up(2, 70))).toEqual(['tap'])
  })

  it('does not chain a third tap onto a doubleTap', () => {
    const g = new GestureRecogniser()
    g.down(1, 200, 200, 0)
    g.up(1, 20)
    g.down(2, 200, 200, 60)
    expect(kinds(g.up(2, 80))).toEqual(['doubleTap'])

    g.down(3, 200, 200, 120)
    expect(kinds(g.up(3, 140))).toEqual(['tap'])
  })
})

describe('GestureRecogniser: starting a two-finger gesture', () => {
  it('cancels the in-progress drag when a second pointer goes down, rather than committing it', () => {
    const g = new GestureRecogniser()
    g.down(1, 100, 100, 0)
    expect(kinds(g.move(1, 160, 100, 20))).toEqual(['dragStart', 'dragMove'])

    const events = g.down(2, 300, 100, 40)

    // The one that matters. A `dragEnd` here would place a road point the
    // player never asked for, purely by the act of starting a pinch.
    expect(kinds(events)).toEqual(['dragCancel', 'twoFingerStart'])
    expect(kinds(events)).not.toContain('dragEnd')
    expect(pick(events, 'twoFingerStart')[0]).toMatchObject({ centre: { x: 230, y: 100 } })

    // And nothing later resurrects the abandoned drag as a commit either.
    const rest = [...g.move(1, 120, 100, 60), ...g.up(1, 80), ...g.up(2, 90)]
    expect(kinds(rest)).not.toContain('dragEnd')
    expect(kinds(rest)).not.toContain('tap')
  })

  it('starts a two-finger gesture with no drag events when the first finger never crossed the slop', () => {
    const g = new GestureRecogniser()
    g.down(1, 100, 100, 0)
    g.move(1, 103, 101, 10)

    const events = g.down(2, 200, 100, 20)
    expect(kinds(events)).toEqual(['twoFingerStart'])
    expect(kinds(events)).not.toContain('dragCancel')
  })

  it('does not pair a tap from before a two-finger gesture with one from after it', () => {
    const g = new GestureRecogniser()
    g.down(1, 200, 200, 0)
    expect(kinds(g.up(1, 20))).toEqual(['tap'])

    // A pinch in between, entirely inside the double-tap window.
    g.down(2, 100, 100, 40)
    g.down(3, 300, 100, 50)
    g.up(2, 60)
    g.up(3, 70)

    g.down(4, 200, 200, 100)
    expect(kinds(g.up(4, 120))).toEqual(['tap'])
  })
})

describe('GestureRecogniser: two-finger camera gestures', () => {
  const pinchStart = (): GestureRecogniser => {
    const g = new GestureRecogniser()
    g.down(1, 100, 100, 0)
    g.down(2, 200, 100, 10)
    return g
  }

  it('reports a pinch above one when the two pointers move apart', () => {
    const g = pinchStart()
    // Span 100 -> 150 -> 200.
    expect(twoFinger(g.move(1, 50, 100, 20)).pinch).toBeCloseTo(1.5)
    expect(twoFinger(g.move(2, 250, 100, 30)).pinch).toBeCloseTo(200 / 150)
  })

  it('reports a pinch below one when the two pointers move together', () => {
    const g = pinchStart()
    // Span 100 -> 60 -> 20.
    expect(twoFinger(g.move(1, 140, 100, 20)).pinch).toBeCloseTo(0.6)
    expect(twoFinger(g.move(2, 160, 100, 30)).pinch).toBeCloseTo(20 / 60)
  })

  it('reports a two-finger pan with no net scale or twist when both pointers move the same way', () => {
    const g = pinchStart()
    // Both fingers translate by (+30, +20). The events arrive one pointer at a
    // time, so each intermediate sample legitimately sees the span and axis
    // change; only the totals over the whole gesture are pure translation.
    const events = [...g.move(1, 130, 120, 20), ...g.move(2, 230, 120, 30)]
    const moves = pick(events, 'twoFinger')
    expect(moves).toHaveLength(2)

    const pan = moves.reduce(
      (acc, m) => ({ dx: acc.dx + m.pan.dx, dy: acc.dy + m.pan.dy }),
      { dx: 0, dy: 0 },
    )
    expect(pan.dx).toBeCloseTo(30)
    expect(pan.dy).toBeCloseTo(20)
    expect(moves.reduce((acc, m) => acc * m.pinch, 1)).toBeCloseTo(1)
    expect(moves.reduce((acc, m) => acc + m.twist, 0)).toBeCloseTo(0)
  })

  it('reports a twist when the two pointers rotate about their midpoint', () => {
    const g = pinchStart()
    // A quarter turn about (150, 100): (100,100),(200,100) -> (150,50),(150,150).
    const events = [...g.move(1, 150, 50, 20), ...g.move(2, 150, 150, 30)]
    const moves = pick(events, 'twoFinger')
    expect(moves).toHaveLength(2)

    // Positive is clockwise as the player sees it, because this module works
    // in screen pixels where y increases downward.
    expect(moves.reduce((acc, m) => acc + m.twist, 0)).toBeCloseTo(Math.PI / 2)
    expect(moves.reduce((acc, m) => acc * m.pinch, 1)).toBeCloseTo(1)

    const pan = moves.reduce(
      (acc, m) => ({ dx: acc.dx + m.pan.dx, dy: acc.dy + m.pan.dy }),
      { dx: 0, dy: 0 },
    )
    expect(pan.dx).toBeCloseTo(0)
    expect(pan.dy).toBeCloseTo(0)
  })

  it('reports the current midpoint as the centre to pivot about', () => {
    const g = pinchStart()
    expect(twoFinger(g.move(1, 100, 300, 20)).centre).toEqual({ x: 150, y: 200 })
  })

  it('does not resume the single-finger drag when one of the two pointers lifts', () => {
    const g = pinchStart()
    g.move(1, 120, 100, 20)

    expect(kinds(g.up(2, 30))).toEqual(['twoFingerEnd'])

    // Pointer 1 is still down. Dragging it must not jump the pending road
    // point across the screen, and lifting it must not place one.
    expect(kinds(g.move(1, 400, 400, 40))).toEqual([])
    expect(kinds(g.up(1, 50))).toEqual([])
    expect(g.inProgress).toBe(false)
  })

  it('resumes a two-finger gesture when a lifted finger is put back down', () => {
    const g = pinchStart()
    g.up(2, 20)

    const events = g.down(3, 300, 100, 30)
    expect(kinds(events)).toEqual(['twoFingerStart'])
    expect(pick(events, 'twoFingerStart')[0]).toMatchObject({ centre: { x: 200, y: 100 } })
    // Span 200 -> 300, measured from the new pair, not the old one.
    expect(twoFinger(g.move(3, 400, 100, 40)).pinch).toBeCloseTo(1.5)
  })
})

describe('GestureRecogniser: three or more pointers', () => {
  it('ignores a third pointer entirely rather than letting it disturb the pinch', () => {
    const g = new GestureRecogniser()
    g.down(1, 100, 100, 0)
    g.down(2, 200, 100, 10)

    expect(kinds(g.down(3, 500, 500, 20))).toEqual([])
    expect(kinds(g.move(3, 900, 900, 30))).toEqual([])

    // Span still measured from pointers 1 and 2 alone: 100 -> 150.
    expect(twoFinger(g.move(1, 50, 100, 40)).pinch).toBeCloseTo(1.5)

    expect(kinds(g.up(3, 50))).toEqual([])
    expect(g.inProgress).toBe(true)
    expect(kinds(g.up(1, 60))).toEqual(['twoFingerEnd'])
  })

  it('does not report a tap for an ignored third pointer that taps and lifts', () => {
    const g = new GestureRecogniser()
    g.down(1, 100, 100, 0)
    g.down(2, 200, 100, 10)

    g.down(3, 500, 500, 20)
    expect(kinds(g.up(3, 30))).toEqual([])
  })

  it('settles back to idle only once every pointer has lifted', () => {
    const g = new GestureRecogniser()
    g.down(1, 100, 100, 0)
    g.down(2, 200, 100, 10)
    g.down(3, 500, 500, 20)

    g.up(1, 30)
    expect(g.inProgress).toBe(true)
    g.up(2, 40)
    expect(g.inProgress).toBe(true)
    g.up(3, 50)
    expect(g.inProgress).toBe(false)
  })
})

describe('GestureRecogniser: pointer cancellation', () => {
  it('leaves no gesture in progress and reports no tap when a drag is cancelled', () => {
    const g = new GestureRecogniser()
    g.down(1, 100, 100, 0)
    g.move(1, 200, 100, 20)

    const events = g.cancel(1, 30)
    expect(kinds(events)).toEqual(['dragCancel'])
    expect(kinds(events)).not.toContain('tap')
    expect(kinds(events)).not.toContain('dragEnd')
    expect(g.inProgress).toBe(false)
  })

  it('reports no tap when a pointer is cancelled before it ever moved', () => {
    const g = new GestureRecogniser()
    g.down(1, 100, 100, 0)

    expect(kinds(g.cancel(1, 20))).toEqual([])
    expect(g.inProgress).toBe(false)

    // And the cancelled press left no record that a later tap could pair with.
    g.down(2, 100, 100, 40)
    expect(kinds(g.up(2, 60))).toEqual(['tap'])
  })

  it('ends the two-finger gesture when one of its pointers is cancelled', () => {
    const g = new GestureRecogniser()
    g.down(1, 100, 100, 0)
    g.down(2, 200, 100, 10)

    expect(kinds(g.cancel(2, 20))).toEqual(['twoFingerEnd'])
    // Pointer 1 is still down but owns nothing: no drag, no tap.
    expect(kinds(g.move(1, 400, 400, 30))).toEqual([])
    expect(kinds(g.up(1, 40))).toEqual([])
    expect(g.inProgress).toBe(false)
  })

  it('accepts a fresh gesture immediately after a cancellation', () => {
    const g = new GestureRecogniser()
    g.down(1, 100, 100, 0)
    g.move(1, 200, 100, 20)
    g.cancel(1, 30)

    g.down(2, 400, 400, 40)
    expect(kinds(g.move(2, 460, 400, 50))).toEqual(['dragStart', 'dragMove'])
    expect(kinds(g.up(2, 60))).toEqual(['dragEnd'])
  })

  it('ignores a cancel for a pointer that is not down', () => {
    const g = new GestureRecogniser()
    expect(kinds(g.cancel(9, 0))).toEqual([])
    expect(g.inProgress).toBe(false)
  })
})
