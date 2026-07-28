import { describe, expect, it } from 'vitest'
import {
  SCENE_BINDINGS,
  actionForKey,
  controlLabel,
  controlPressed,
  controlsForMode,
  modeLabel,
  type SceneAction,
  type ToolMode,
} from './sceneActions'
import { ROAD_CLASS_ORDER } from '../network/roadClass'
import { DEFAULT_DRAW_CLASS } from '../debug/roadScene'

/**
 * The key map exactly as `debug/roadScene.ts`'s `onKeyDown` implemented it
 * before this table existed, transcribed by hand from that handler.
 *
 * This is the whole point of the file. `roadScene.ts` has no unit tests, so
 * "the buttons and the keys call the same function" is worth nothing on its
 * own — if the extraction that made them share a function also changed what
 * a key does, the sharing would just mean both paths are wrong together.
 * Every row below is a claim about the behaviour a desktop player had BEFORE
 * this change, asserted against the table that produces it AFTER.
 *
 * Transcribed rather than derived, deliberately. Deriving the expectation
 * from `SCENE_BINDINGS` would make this test pass for any table at all.
 */
const EXPECTED: readonly {
  readonly key: string
  readonly mode: ToolMode
  readonly action: SceneAction | undefined
}[] = [
  // Tab was handled before the handler branched on mode, so it fired in both.
  { key: 'Tab', mode: 'draw', action: { kind: 'toggleMode' } },
  { key: 'Tab', mode: 'select', action: { kind: 'toggleMode' } },

  // --- draw mode's own switch ---------------------------------------------
  { key: 'Enter', mode: 'draw', action: { kind: 'commit' } },
  { key: 'Escape', mode: 'draw', action: { kind: 'cancelDrawing' } },
  { key: 'Backspace', mode: 'draw', action: { kind: 'undoLastPoint' } },
  // `setDrawClass(Number(event.key) - 1)`, for '1' through '4'.
  { key: '1', mode: 'draw', action: { kind: 'setDrawClass', index: 0 } },
  { key: '2', mode: 'draw', action: { kind: 'setDrawClass', index: 1 } },
  { key: '3', mode: 'draw', action: { kind: 'setDrawClass', index: 2 } },
  { key: '4', mode: 'draw', action: { kind: 'setDrawClass', index: 3 } },
  // Draw mode's switch had no other cases, so these fell through its
  // `default` and were NOT preventDefaulted — they must stay unbound here.
  { key: 'Delete', mode: 'draw', action: undefined },
  { key: 's', mode: 'draw', action: undefined },
  { key: 'S', mode: 'draw', action: undefined },
  { key: '[', mode: 'draw', action: undefined },
  { key: ']', mode: 'draw', action: undefined },
  { key: '5', mode: 'draw', action: undefined },
  { key: '0', mode: 'draw', action: undefined },

  // --- select mode's own switch -------------------------------------------
  { key: 'Escape', mode: 'select', action: { kind: 'clearSelection' } },
  { key: 'Delete', mode: 'select', action: { kind: 'deleteSelected' } },
  { key: 'Backspace', mode: 'select', action: { kind: 'deleteSelected' } },
  { key: 's', mode: 'select', action: { kind: 'splitSelected' } },
  { key: 'S', mode: 'select', action: { kind: 'splitSelected' } },
  { key: ']', mode: 'select', action: { kind: 'reclassifySelected', direction: 1 } },
  { key: '[', mode: 'select', action: { kind: 'reclassifySelected', direction: -1 } },
  { key: 'Enter', mode: 'select', action: undefined },
  { key: '1', mode: 'select', action: undefined },
  { key: '4', mode: 'select', action: undefined },
]

describe('actionForKey — the pre-existing keyboard map, unchanged', () => {
  for (const { key, mode, action } of EXPECTED) {
    const name =
      action === undefined
        ? `${key} does nothing in ${mode} mode`
        : `${key} is ${action.kind} in ${mode} mode`
    it(name, () => {
      expect(actionForKey(key, mode)).toEqual(action)
    })
  }

  it('every key the old handler ignored is still ignored', () => {
    // A sample of ordinary keys that were in neither switch. If any of these
    // ever gained a binding, `roadScene.ts` would start calling
    // `preventDefault()` on it and swallow the browser's own handling.
    for (const key of ['a', 'z', 'F5', 'ArrowUp', ' ', 'Home', 'PageDown', '/']) {
      expect(actionForKey(key, 'draw')).toBeUndefined()
      expect(actionForKey(key, 'select')).toBeUndefined()
    }
  })

  it('Escape means different things in the two modes', () => {
    // The precedence claim in SCENE_BINDINGS' docstring: two rows share a key
    // and are separated only by mode, so the first matching row must be the
    // one for the mode asked about, not simply the first row with that key.
    expect(actionForKey('Escape', 'draw')).toEqual({ kind: 'cancelDrawing' })
    expect(actionForKey('Escape', 'select')).toEqual({ kind: 'clearSelection' })
  })

  it('Backspace undoes a point while drawing and deletes a road while selecting', () => {
    expect(actionForKey('Backspace', 'draw')).toEqual({ kind: 'undoLastPoint' })
    expect(actionForKey('Backspace', 'select')).toEqual({ kind: 'deleteSelected' })
  })
})

describe('the class bindings follow ROAD_CLASS_ORDER', () => {
  it('binds one one-based key per class, in ladder order', () => {
    ROAD_CLASS_ORDER.forEach((name, index) => {
      const action = actionForKey(String(index + 1), 'draw')
      expect(action).toEqual({ kind: 'setDrawClass', index })
      const binding = SCENE_BINDINGS.find(
        (b) => b.action.kind === 'setDrawClass' && b.action.index === index,
      )
      expect(binding?.label).toBe(name)
    })
  })

  it('binds no key beyond the ladder', () => {
    expect(actionForKey(String(ROAD_CLASS_ORDER.length + 1), 'draw')).toBeUndefined()
  })

  it("the default draw class' own key selects it", () => {
    // `DEFAULT_DRAW_CLASS` is the class the scene arms at startup, and
    // `describeStartingHint` tells the player its number. If this table
    // numbered the ladder differently from that hint, the opening message
    // would name a key that armed some other class.
    const index = ROAD_CLASS_ORDER.indexOf(DEFAULT_DRAW_CLASS)
    expect(index).toBeGreaterThanOrEqual(0)
    expect(actionForKey(String(index + 1), 'draw')).toEqual({ kind: 'setDrawClass', index })
  })
})

describe('controlsForMode', () => {
  it('offers exactly the actions the same mode\'s keys reach', () => {
    for (const mode of ['draw', 'select'] as const) {
      for (const binding of controlsForMode(mode)) {
        // Every offered control must be reachable by at least one of its own
        // keys in this mode — the guarantee that a button can never do
        // something the keyboard cannot.
        const reached = binding.keys.some(
          (key) => JSON.stringify(actionForKey(key, mode)) === JSON.stringify(binding.action),
        )
        expect(reached, `${binding.label} in ${mode} mode`).toBe(true)
      }
    }
  })

  it('never offers the other mode\'s controls', () => {
    const labels = (mode: ToolMode): string[] => controlsForMode(mode).map((b) => b.label)
    expect(labels('draw')).toContain('Build')
    expect(labels('draw')).not.toContain('Delete')
    expect(labels('select')).toContain('Delete')
    expect(labels('select')).not.toContain('Build')
  })

  it('offers the mode toggle in both modes', () => {
    for (const mode of ['draw', 'select'] as const) {
      expect(controlsForMode(mode).filter((b) => b.action.kind === 'toggleMode')).toHaveLength(1)
    }
  })

  it('covers every keyboard-only action named in the brief', () => {
    const kinds = new Set(
      [...controlsForMode('draw'), ...controlsForMode('select')].map((b) => b.action.kind),
    )
    for (const kind of ['toggleMode', 'commit', 'cancelDrawing', 'undoLastPoint', 'setDrawClass']) {
      expect(kinds).toContain(kind)
    }
    expect(controlsForMode('draw').filter((b) => b.action.kind === 'setDrawClass')).toHaveLength(
      ROAD_CLASS_ORDER.length,
    )
  })

  it('every control has a description naming its key', () => {
    for (const binding of SCENE_BINDINGS) {
      expect(binding.description.length).toBeGreaterThan(0)
      expect(binding.description).toContain('(')
    }
  })
})

describe('modeLabel', () => {
  it('names both modes', () => {
    expect(modeLabel('draw')).toBe('Draw')
    expect(modeLabel('select')).toBe('Select')
  })
})

describe('controlLabel and controlPressed — showing state, not just setting it', () => {
  const toggle = SCENE_BINDINGS.find((b) => b.action.kind === 'toggleMode')!
  const classBinding = (index: number) =>
    SCENE_BINDINGS.find((b) => b.action.kind === 'setDrawClass' && b.action.index === index)!

  it('the mode button reads the mode it is IN, in both modes', () => {
    expect(controlLabel(toggle, { mode: 'draw', drawClassIndex: 0 })).toBe('Mode: Draw')
    expect(controlLabel(toggle, { mode: 'select', drawClassIndex: 0 })).toBe('Mode: Select')
  })

  it('every other button keeps its own label whatever the state', () => {
    const build = SCENE_BINDINGS.find((b) => b.action.kind === 'commit')!
    expect(controlLabel(build, { mode: 'draw', drawClassIndex: 3 })).toBe('Build')
    expect(controlLabel(classBinding(2), { mode: 'draw', drawClassIndex: 0 })).toBe(
      ROAD_CLASS_ORDER[2],
    )
  })

  it('exactly one class button is pressed, and it is the armed one', () => {
    ROAD_CLASS_ORDER.forEach((_, armed) => {
      const state = { mode: 'draw' as const, drawClassIndex: armed }
      const pressed = SCENE_BINDINGS.filter((b) => controlPressed(b, state))
      expect(pressed).toHaveLength(1)
      expect(pressed[0]!.action).toEqual({ kind: 'setDrawClass', index: armed })
    })
  })

  it('the mode toggle is never pressed — its state is in its label', () => {
    for (const mode of ['draw', 'select'] as const) {
      expect(controlPressed(toggle, { mode, drawClassIndex: 0 })).toBe(false)
    }
  })

  it('no control is pressed for a class index outside the ladder', () => {
    const state = { mode: 'draw' as const, drawClassIndex: ROAD_CLASS_ORDER.length }
    expect(SCENE_BINDINGS.filter((b) => controlPressed(b, state))).toHaveLength(0)
  })
})
