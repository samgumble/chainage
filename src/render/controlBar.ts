/**
 * The on-screen control bar: a button for every keyboard-only action.
 *
 * A phone has no keyboard, and until now the road class, the mode switch, the
 * build, the undo and the cancel were all reachable only by pressing a key. A
 * player on a phone could place points and nothing else.
 *
 * ## What this module is not allowed to do
 *
 * It does not know what any of the buttons do. Every button carries a
 * `SceneAction` — a name from `tool/sceneActions.ts` — and hands it to the
 * `onAction` callback the caller supplied; `debug/roadScene.ts` turns that
 * name into exactly the same call its key handler makes. There is no second
 * implementation of "build the road" in here, because a second implementation
 * would drift from the first and nothing would fail when it did.
 *
 * It also holds no state. `setState` is called by the scene whenever the mode
 * or the armed class changes, and the bar re-renders from what it was told.
 * A bar that tracked its own idea of the current class would be a second
 * source of truth about it, which is the same defect one level down.
 *
 * ## What is not tested
 *
 * All of it. This project's suite has no DOM (`vitest` runs in node here with
 * no `environment` configured), so nothing below can be exercised — no
 * element is constructed, no click is dispatched, no style is read back. That
 * is why everything with a decision in it lives elsewhere and is tested
 * there: the action table and which control is shown or highlighted in
 * `tool/sceneActions.ts`, the 44px minimum in `tool/touchTarget.ts`. What is
 * left here is element construction and CSS, which is verified by looking at
 * it. See the accompanying report for the precise list of what to look at.
 *
 * ## Three.js
 *
 * None, despite living in `src/render/`. This is a DOM overlay drawn beside
 * the canvas, not anything in the scene graph — which is also what lets
 * `src/tool/touchTarget.ts` be imported from here without either direction of
 * that dependency dragging a renderer into the other.
 */

import {
  controlLabel,
  controlPressed,
  controlsForMode,
  type ControlState,
  type SceneAction,
  type SceneBinding,
} from '../tool/sceneActions'
import { MIN_TOUCH_TARGET_PX } from '../tool/touchTarget'

export type ControlBar = {
  /** Re-render for a new mode / armed class. Idempotent. */
  setState: (state: ControlState) => void
  /** Remove the bar from the document. */
  dispose: () => void
}

/**
 * How far the bar sits from the bottom of its host, CSS pixels, on top of
 * whatever safe-area inset the device reports.
 *
 * Matches the message line's own 12px offset from the top-left corner rather
 * than being chosen separately — two overlays inset by different amounts from
 * opposite corners read as an accident.
 */
const BAR_EDGE_INSET_PX = 12

/** Gap between buttons. Wide enough that a fingertip landing between two of
 * them misses both rather than hitting the wrong one. */
const BAR_GAP_PX = 8

const applyContainerStyle = (el: HTMLElement): void => {
  el.style.position = 'absolute'
  // Bottom edge, spanning the full width and centring its own contents.
  //
  // Bottom, because that is where a thumb reaches on a phone and because the
  // message line already owns the top-left corner — the two must not overlap,
  // and a bar in the top-right would collide with it the moment a long
  // refusal message wraps.
  //
  // It does sit over the tilt-shift pass' NEAR blur band: the pass is
  // symmetric about the focal distance (`render/tiltShift.ts`), so at the
  // rig's raised framing the sharp band lands across the middle of the frame
  // and the bottom of the frame is the nearest, most blurred ground. That is
  // the right place for it. The blur is applied to the WebGL canvas and never
  // to this overlay, so the buttons stay crisp; what they cover is the part
  // of the frame carrying the least readable detail, and the sharp band —
  // where the diorama actually reads and where the player is drawing — is
  // left alone. Putting the bar in the sharp band to keep it "clear of the
  // blur" would trade a legible corner for the one part of the picture the
  // whole tilt-shift effect exists to draw the eye to.
  el.style.left = '0'
  el.style.right = '0'
  // Phones with a home indicator or a rounded chin report it through
  // `env(safe-area-inset-bottom)`; on everything else the fallback is 0 and
  // this reduces to the plain inset. A `calc` so the two ADD — a bar inset
  // only by the safe area sits flush against the chin on the phones that
  // report one, and only by the 12px sits under the home indicator on the
  // same phones.
  el.style.bottom = `calc(${BAR_EDGE_INSET_PX}px + env(safe-area-inset-bottom, 0px))`
  el.style.display = 'flex'
  el.style.flexWrap = 'wrap'
  el.style.justifyContent = 'center'
  el.style.gap = `${BAR_GAP_PX}px`
  el.style.padding = `0 ${BAR_EDGE_INSET_PX}px`
  // The container spans the whole width, so it would otherwise swallow every
  // pointer event across the bottom of the canvas — including the drags and
  // taps that place road points. Only the buttons themselves take input.
  el.style.pointerEvents = 'none'
  el.style.font = '13px/1.4 ui-sans-serif, system-ui, sans-serif'
  // Above the canvas, below nothing else — there is nothing else.
  el.style.zIndex = '1'
}

const applyButtonStyle = (el: HTMLButtonElement, pressed: boolean): void => {
  el.style.pointerEvents = 'auto'
  // The accessibility minimum, as a floor rather than a size: a button
  // labelled "Downgrade" is wider than 44px and should be, while the padding
  // below would leave a short label like "Undo" under 44px tall without it.
  el.style.minWidth = `${MIN_TOUCH_TARGET_PX}px`
  el.style.minHeight = `${MIN_TOUCH_TARGET_PX}px`
  el.style.padding = '0 12px'
  el.style.borderRadius = '6px'
  el.style.border = '1px solid rgba(232, 228, 220, 0.25)'
  el.style.font = 'inherit'
  el.style.cursor = 'pointer'
  // Suppresses the ~300ms tap delay and the double-tap-to-zoom gesture on
  // touch browsers. Without it a second tap on "Build" within the double-tap
  // window zooms the page instead of building.
  el.style.touchAction = 'manipulation'
  // A label is never a text selection, and a long-press that starts selecting
  // one is a long-press that did not press the button.
  el.style.userSelect = 'none'
  el.style.webkitUserSelect = 'none'

  // The armed road class is the one thing on this bar a player cannot find
  // out any other way, so it is shown as filled-and-light against the others'
  // dark-and-outlined rather than as a subtle tint.
  if (pressed) {
    el.style.background = '#e8e4dc'
    el.style.color = '#14181d'
    el.style.borderColor = '#e8e4dc'
    el.style.fontWeight = '600'
  } else {
    el.style.background = 'rgba(20, 24, 29, 0.75)'
    el.style.color = '#e8e4dc'
    el.style.borderColor = 'rgba(232, 228, 220, 0.25)'
    el.style.fontWeight = '400'
  }
}

/**
 * Build the bar into `host` and return a handle to it.
 *
 * `onAction` is called with the action a button names — nothing else. The
 * caller decides what that means; see this module's docstring.
 */
export const createControlBar = (
  host: HTMLElement,
  initial: ControlState,
  onAction: (action: SceneAction) => void,
): ControlBar => {
  const container = document.createElement('div')
  applyContainerStyle(container)
  host.appendChild(container)

  const makeButton = (binding: SceneBinding, state: ControlState): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = controlLabel(binding, state)
    button.title = binding.description
    button.setAttribute('aria-label', binding.description)
    if (binding.action.kind === 'setDrawClass') {
      button.setAttribute('aria-pressed', String(controlPressed(binding, state)))
    }

    // Not reachable by Tab, on purpose, and this is the one decision in this
    // file that could change DESKTOP behaviour if got wrong.
    //
    // `roadScene.ts` binds Tab to the mode switch and calls `preventDefault()`
    // on it, so focus never moves to a button by keyboard anyway. But a button
    // focused by a CLICK would then receive the browser's own "activate the
    // focused button" handling for Space on keyup — a key `roadScene.ts` does
    // not bind and therefore does not preventDefault. A desktop player who
    // clicked "Build" and later pressed Space would build a second road, and
    // nothing in this project would have told them why. `tabIndex = -1` plus
    // the `blur()` below means a button is never the focused element for long
    // enough for that to happen.
    //
    // Nothing is lost by it: every action here also has a key, so a
    // keyboard-only player already reaches all of them without the bar.
    button.tabIndex = -1

    applyButtonStyle(button, controlPressed(binding, state))

    // `click` rather than `pointerup`: it is the one event that fires
    // identically for a mouse, a finger and an assistive device, and the
    // canvas never sees it — the bar is a sibling overlay, so an event that
    // lands on a button does not also land on the canvas underneath.
    button.addEventListener('click', () => {
      button.blur()
      onAction(binding.action)
    })

    return button
  }

  const render = (state: ControlState): void => {
    // Rebuilt wholesale rather than diffed. Nine buttons is not a number
    // worth a reconciler, and a full rebuild cannot leave a stale label or a
    // stale highlight behind — which is the entire failure this bar exists to
    // prevent.
    container.replaceChildren(
      ...controlsForMode(state.mode).map((binding) => makeButton(binding, state)),
    )
  }

  render(initial)

  return {
    setState: render,
    dispose: () => container.remove(),
  }
}
