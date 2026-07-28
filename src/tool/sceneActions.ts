/**
 * The named things a player can do, and the one table that says how they are
 * reached.
 *
 * ## Why this module exists
 *
 * A phone has no keyboard, so several actions that used to be spelled only as
 * key handlers now need on-screen buttons too. The obvious way to add them is
 * to give each button a click handler that does what the key does — and that
 * is the mistake. Two spellings of "build the road" drift, and the drift is
 * invisible: nothing fails, nothing warns, and the first anyone hears of it is
 * a report that the button behaves subtly differently from Enter.
 *
 * So a button does not *do* anything. It *names* an action, and one dispatcher
 * in `debug/roadScene.ts` (`runAction`) turns that name into the same call the
 * key already made. There is exactly one implementation per action, and the
 * two input paths differ only in how they arrive at the name.
 *
 * `SCENE_BINDINGS` below is the single table both paths read: `actionForKey`
 * looks a `KeyboardEvent.key` up in it, and `controlsForMode` lists the
 * buttons to show. That shared table buys something a shared dispatcher alone
 * would not — a button cannot exist for an action no key reaches, and cannot
 * appear in a mode where its key would do nothing, because both facts are read
 * off the same row.
 *
 * ## Pure
 *
 * No DOM, no three.js, no scene state. Everything here is a lookup over a
 * literal table, which is what lets the key mapping — the part where a
 * regression to existing desktop behaviour would actually hide — be asserted
 * key by key in `sceneActions.test.ts`, against a file that has no unit tests
 * of its own.
 */

import { ROAD_CLASS_ORDER } from '../network/roadClass'

/**
 * The two things a player can be doing.
 *
 * Lived in `debug/roadScene.ts` until the binding table needed it: a row has
 * to say which mode it belongs to, and that file cannot be imported from here
 * (it would pull three.js into `src/tool/`, which this directory forbids).
 * Moved rather than copied, for the same reason everything else in this
 * module is shared rather than duplicated.
 */
export type ToolMode = 'draw' | 'select'

/**
 * Everything a player can ask the scene to do, as data.
 *
 * A discriminated union rather than a set of bare strings so the two
 * parameterised actions can carry their parameter: which class to draw in, and
 * which way along the class ladder to step. Encoding those as
 * `'setDrawClass0'`..`'setDrawClass3'` would put the class count in the type
 * and make adding a fifth class a change here rather than in
 * `ROAD_CLASS_ORDER` alone.
 *
 * Deliberately *not* every input the scene has. Pointer gestures — placing a
 * point, picking a road, panning, orbiting, zooming — are not here, because
 * they are not keyboard-only and so need no on-screen control; they also carry
 * a screen position, which a button does not have. This union is exactly the
 * set of actions a keypress can express.
 */
export type SceneAction =
  /** Draw <-> select. */
  | { readonly kind: 'toggleMode' }
  /** Build the road currently being drawn. */
  | { readonly kind: 'commit' }
  /** Discard the road currently being drawn. */
  | { readonly kind: 'cancelDrawing' }
  /** Take back the last point placed. */
  | { readonly kind: 'undoLastPoint' }
  /** Draw in `ROAD_CLASS_ORDER[index]` from now on. */
  | { readonly kind: 'setDrawClass'; readonly index: number }
  /** Drop the current selection. */
  | { readonly kind: 'clearSelection' }
  /** Delete the selected road. */
  | { readonly kind: 'deleteSelected' }
  /** Split the selected road under the pointer. */
  | { readonly kind: 'splitSelected' }
  /** Step the selected road one rung up (1) or down (-1) the class ladder. */
  | { readonly kind: 'reclassifySelected'; readonly direction: 1 | -1 }

/**
 * One row of the table: an action, the mode it fires in, the keys that reach
 * it, and how it is labelled on screen.
 */
export type SceneBinding = {
  readonly action: SceneAction
  /** `'any'` fires in both modes; `'draw'`/`'select'` only in that one. */
  readonly mode: ToolMode | 'any'
  /**
   * Every `KeyboardEvent.key` that triggers this action.
   *
   * More than one where the existing handler already accepted more than one:
   * Delete and Backspace both delete a selected road, and `s`/`S` both split
   * (the shifted spelling is what a player with caps lock on produces, and
   * refusing it would be a silent no-op). The list is matched by exact
   * `event.key` equality, exactly as the `switch` statements this replaced
   * did — no case folding, no `code` fallback, so a change in behaviour here
   * would have to be written down rather than emerge.
   */
  readonly keys: readonly string[]
  /** The button's face. Kept short: it has to fit a phone. */
  readonly label: string
  /** The button's accessible name, which also names the key. */
  readonly description: string
}

/** 'draw' -> 'Draw'. The message line's mode prefix and the mode button's own
 * face both come from here rather than from two `? :` expressions that would
 * be free to disagree about capitalisation. */
export const modeLabel = (mode: ToolMode): string => (mode === 'draw' ? 'Draw' : 'Select')

/**
 * One row per road class, built from the ladder rather than typed out.
 *
 * The one-based numbering is not decorative — it is the actual binding.
 * `roadScene.ts` used to compute `Number(event.key) - 1` inside its key
 * handler to turn '1'..'4' into `ROAD_CLASS_ORDER` indices 0..3; that
 * subtraction now happens once, here, in the other direction, so the keys a
 * class is reachable by move with the ladder instead of being four hardcoded
 * `case` labels that would quietly name the wrong class the day a rung is
 * inserted. `messages.ts`'s `describeStartingHint` numbers the same list the
 * same way for the same reason.
 */
const drawClassBindings = (): SceneBinding[] =>
  ROAD_CLASS_ORDER.map((name, index) => ({
    action: { kind: 'setDrawClass', index } as const,
    mode: 'draw' as const,
    keys: [String(index + 1)],
    label: name,
    description: `Draw ${name} roads (key ${index + 1})`,
  }))

/**
 * Every binding, in the order the on-screen bar shows them.
 *
 * Order matters twice. On screen it is reading order: what mode you are in,
 * then what you can draw, then what you can do to what you are drawing. In
 * `actionForKey` it is precedence — the first matching row wins — which is
 * what lets Escape mean "discard the road" while drawing and "drop the
 * selection" while selecting without either row knowing about the other.
 *
 * The mode toggle is first and is `'any'`, matching the key handler this
 * replaced: Tab was tested before the handler branched on mode, so it fires
 * in both. Every other row is mode-specific, which is what stops select
 * mode's Backspace (delete the road) from ever reaching draw mode's Backspace
 * (undo the last point).
 */
export const SCENE_BINDINGS: readonly SceneBinding[] = [
  {
    action: { kind: 'toggleMode' },
    mode: 'any',
    keys: ['Tab'],
    label: 'Mode',
    description: 'Switch between drawing roads and selecting them (Tab)',
  },
  ...drawClassBindings(),
  {
    action: { kind: 'undoLastPoint' },
    mode: 'draw',
    keys: ['Backspace'],
    label: 'Undo',
    description: 'Take back the last point placed (Backspace)',
  },
  {
    action: { kind: 'cancelDrawing' },
    mode: 'draw',
    keys: ['Escape'],
    label: 'Cancel',
    description: 'Discard the road being drawn (Escape)',
  },
  {
    action: { kind: 'commit' },
    mode: 'draw',
    keys: ['Enter'],
    label: 'Build',
    description: 'Build the road being drawn (Enter)',
  },
  {
    action: { kind: 'clearSelection' },
    mode: 'select',
    keys: ['Escape'],
    label: 'Deselect',
    description: 'Drop the current selection (Escape)',
  },
  {
    action: { kind: 'deleteSelected' },
    mode: 'select',
    keys: ['Delete', 'Backspace'],
    label: 'Delete',
    description: 'Delete the selected road (Delete)',
  },
  {
    action: { kind: 'splitSelected' },
    mode: 'select',
    keys: ['s', 'S'],
    label: 'Split',
    description: 'Split the selected road under the pointer (S)',
  },
  {
    action: { kind: 'reclassifySelected', direction: -1 },
    mode: 'select',
    keys: ['['],
    label: 'Downgrade',
    description: 'Step the selected road down one road class ([)',
  },
  {
    action: { kind: 'reclassifySelected', direction: 1 },
    mode: 'select',
    keys: [']'],
    label: 'Upgrade',
    description: 'Step the selected road up one road class (])',
  },
]

/**
 * What a keypress means right now, or `undefined` if it means nothing.
 *
 * `undefined` is load-bearing and not merely an absence: `roadScene.ts`'s key
 * handler calls `event.preventDefault()` if and only if this returns an
 * action. That reproduces the old handler's behaviour exactly — it
 * preventDefaulted inside every `case` and did nothing in its `default` — and
 * it is why a key that is bound in the *other* mode must return `undefined`
 * here rather than some no-op action. Pressing `[` while drawing has always
 * left the browser's own handling of `[` alone, and still does.
 */
export const actionForKey = (key: string, mode: ToolMode): SceneAction | undefined =>
  SCENE_BINDINGS.find(
    (binding) => (binding.mode === 'any' || binding.mode === mode) && binding.keys.includes(key),
  )?.action

/** The buttons to show in a given mode — the same rows `actionForKey` will
 * match in it, so the bar can never offer a control the keyboard would not
 * honour. */
export const controlsForMode = (mode: ToolMode): readonly SceneBinding[] =>
  SCENE_BINDINGS.filter((binding) => binding.mode === 'any' || binding.mode === mode)

/**
 * The state the on-screen controls have to reflect.
 *
 * Both fields exist because neither is visible any other way on a phone. On a
 * desktop the player knows which class is armed because they pressed its key a
 * second ago and read the message line's reply; a player who tapped a button
 * three taps ago has no such memory, and an unlabelled control that silently
 * changed state is worse than no control at all.
 */
export type ControlState = {
  readonly mode: ToolMode
  /** Index into `ROAD_CLASS_ORDER` of the class the draw tool is armed with. */
  readonly drawClassIndex: number
}

/**
 * What a control should read, given the current state.
 *
 * Only the mode toggle is dynamic, and it shows the mode it is *in*, not the
 * mode it switches to: a button labelled with its destination tells you
 * nothing about where you are, which is the one thing the phone player cannot
 * otherwise find out. Its `description` says what tapping does.
 */
export const controlLabel = (binding: SceneBinding, state: ControlState): string =>
  binding.action.kind === 'toggleMode' ? `Mode: ${modeLabel(state.mode)}` : binding.label

/**
 * Whether a control is showing an already-active state — the `aria-pressed`
 * value, and what `controlBar.ts` renders as the highlighted button.
 *
 * Only the class buttons can be "on", and exactly one of them is at any time:
 * they are a radio group over `ROAD_CLASS_ORDER`, and the armed one is the
 * answer to "which class am I drawing in", which is the second thing a phone
 * player cannot otherwise find out. The mode toggle is deliberately never
 * pressed — it is not one of a group, and its state is carried in its label.
 */
export const controlPressed = (binding: SceneBinding, state: ControlState): boolean =>
  binding.action.kind === 'setDrawClass' && binding.action.index === state.drawClassIndex
