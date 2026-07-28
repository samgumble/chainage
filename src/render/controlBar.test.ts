import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createControlBar } from './controlBar'
import { MIN_TOUCH_TARGET_PX } from '../tool/touchTarget'
import { controlsForMode, type SceneAction } from '../tool/sceneActions'
import { ROAD_CLASS_ORDER } from '../network/roadClass'

/**
 * A DOM small enough to fit in this file.
 *
 * This suite runs in node with no `environment` configured, so there is no
 * `document` and no real element to construct. Rather than add a DOM
 * implementation as a dependency for one module, this stubs the six calls
 * `controlBar.ts` actually makes — `createElement`, `appendChild`,
 * `replaceChildren`, `setAttribute`, `addEventListener`, `remove` — and lets
 * the module build against it.
 *
 * ## What this proves, and what it does not
 *
 * It DOES prove: how many buttons appear and in what order, what each is
 * labelled and described, which one carries the pressed state, that every
 * button is out of the tab order, that a click dispatches exactly the action
 * that button names and nothing else, that a state change re-renders rather
 * than accumulating, and that dispose detaches the bar. Those are behaviours,
 * and every one of them is a way this bar could be wrong.
 *
 * It does NOT prove that any of it is VISIBLE. A stub cannot lay anything
 * out, so nothing here can tell you that 44 CSS px is reached on a real
 * screen, that the bar clears the message line, that `env(safe-area-inset-*)`
 * resolves, or that the buttons are legible over the terrain. Those are
 * looked at, not asserted — see the report's controller-verified list. The
 * style assertions below check only that the right VALUES were written to the
 * right properties, which is the part a typo can break.
 */
type StubElement = {
  tagName: string
  textContent: string
  title: string
  tabIndex: number
  type?: string
  style: Record<string, string>
  attributes: Record<string, string>
  children: StubElement[]
  parent?: StubElement
  listeners: Record<string, (() => void)[]>
  blurCount: number
  setAttribute: (name: string, value: string) => void
  appendChild: (child: StubElement) => StubElement
  replaceChildren: (...children: StubElement[]) => void
  addEventListener: (name: string, fn: () => void) => void
  removeEventListener: (name: string, fn: () => void) => void
  remove: () => void
  blur: () => void
  click: () => void
}

const createStubElement = (tagName: string): StubElement => {
  const el: StubElement = {
    tagName,
    textContent: '',
    title: '',
    tabIndex: 0,
    style: {},
    attributes: {},
    children: [],
    listeners: {},
    blurCount: 0,
    setAttribute: (name, value) => {
      el.attributes[name] = value
    },
    appendChild: (child) => {
      child.parent = el
      el.children.push(child)
      return child
    },
    replaceChildren: (...children) => {
      for (const old of el.children) old.parent = undefined
      for (const child of children) child.parent = el
      el.children = children
    },
    addEventListener: (name, fn) => {
      ;(el.listeners[name] ??= []).push(fn)
    },
    removeEventListener: (name, fn) => {
      el.listeners[name] = (el.listeners[name] ?? []).filter((f) => f !== fn)
    },
    remove: () => {
      const parent = el.parent
      if (!parent) return
      parent.children = parent.children.filter((c) => c !== el)
      el.parent = undefined
    },
    blur: () => {
      el.blurCount += 1
    },
    click: () => {
      for (const fn of el.listeners['click'] ?? []) fn()
    },
  }
  return el
}

const asHost = (el: StubElement): HTMLElement => el as unknown as HTMLElement

let previousDocument: unknown
let host: StubElement

beforeEach(() => {
  previousDocument = (globalThis as Record<string, unknown>)['document']
  ;(globalThis as Record<string, unknown>)['document'] = {
    createElement: (tag: string) => createStubElement(tag),
  }
  host = createStubElement('div')
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>)['document'] = previousDocument
})

/** The bar's own element — the single child `createControlBar` appends. */
const barOf = (): StubElement => host.children[0]!

describe('createControlBar', () => {
  it('appends exactly one element to the host', () => {
    createControlBar(asHost(host), { mode: 'draw', drawClassIndex: 0 }, () => {})
    expect(host.children).toHaveLength(1)
    expect(barOf().tagName).toBe('div')
  })

  it('shows one button per control the current mode offers, in table order', () => {
    createControlBar(asHost(host), { mode: 'draw', drawClassIndex: 0 }, () => {})
    const labels = barOf().children.map((b) => b.textContent)
    expect(labels).toEqual([
      'Mode: Draw',
      ...ROAD_CLASS_ORDER,
      'Undo',
      'Cancel',
      'Build',
    ])
    expect(labels).toHaveLength(controlsForMode('draw').length)
  })

  it('builds buttons, not divs', () => {
    createControlBar(asHost(host), { mode: 'draw', drawClassIndex: 0 }, () => {})
    for (const button of barOf().children) {
      expect(button.tagName).toBe('button')
      // Without this a button inside a form would submit it. There is no form
      // here today; there is no reason to depend on that staying true.
      expect(button.type).toBe('button')
    }
  })

  it('gives every button at least the minimum touch target, both ways', () => {
    createControlBar(asHost(host), { mode: 'draw', drawClassIndex: 0 }, () => {})
    for (const button of barOf().children) {
      expect(button.style['minWidth']).toBe(`${MIN_TOUCH_TARGET_PX}px`)
      expect(button.style['minHeight']).toBe(`${MIN_TOUCH_TARGET_PX}px`)
    }
  })

  it('lets the canvas have every pointer event the buttons do not want', () => {
    // The bar spans the full width of the host, so without this it would eat
    // every drag and tap across the bottom of the canvas — including the ones
    // that place road points.
    createControlBar(asHost(host), { mode: 'draw', drawClassIndex: 0 }, () => {})
    expect(barOf().style['pointerEvents']).toBe('none')
    for (const button of barOf().children) {
      expect(button.style['pointerEvents']).toBe('auto')
    }
  })

  it('keeps every button out of the tab order', () => {
    // Desktop safety, not decoration. A button focused by a click would
    // receive the browser's own Space-activates-the-focused-button handling,
    // and `roadScene.ts` does not bind Space and so does not suppress it — a
    // desktop player who clicked "Build" and later pressed Space would build
    // a second road. See `controlBar.ts`'s note on `tabIndex`.
    createControlBar(asHost(host), { mode: 'draw', drawClassIndex: 0 }, () => {})
    for (const button of barOf().children) {
      expect(button.tabIndex).toBe(-1)
    }
  })

  it('describes every button for a screen reader and for a hover', () => {
    createControlBar(asHost(host), { mode: 'draw', drawClassIndex: 0 }, () => {})
    for (const button of barOf().children) {
      expect(button.attributes['aria-label']!.length).toBeGreaterThan(0)
      expect(button.title).toBe(button.attributes['aria-label'])
    }
  })
})

describe('showing state rather than only setting it', () => {
  it('marks the armed class and only the armed class', () => {
    createControlBar(asHost(host), { mode: 'draw', drawClassIndex: 2 }, () => {})
    const pressed = barOf().children.filter((b) => b.attributes['aria-pressed'] === 'true')
    expect(pressed).toHaveLength(1)
    expect(pressed[0]!.textContent).toBe(ROAD_CLASS_ORDER[2])
  })

  it('gives the armed class a visibly different fill, not just an attribute', () => {
    createControlBar(asHost(host), { mode: 'draw', drawClassIndex: 1 }, () => {})
    const armed = barOf().children.find((b) => b.textContent === ROAD_CLASS_ORDER[1])!
    const other = barOf().children.find((b) => b.textContent === ROAD_CLASS_ORDER[0])!
    expect(armed.style['background']).not.toBe(other.style['background'])
    expect(armed.style['color']).not.toBe(other.style['color'])
  })

  it('names the mode it is in on the mode button', () => {
    const bar = createControlBar(asHost(host), { mode: 'draw', drawClassIndex: 0 }, () => {})
    expect(barOf().children[0]!.textContent).toBe('Mode: Draw')
    bar.setState({ mode: 'select', drawClassIndex: 0 })
    expect(barOf().children[0]!.textContent).toBe('Mode: Select')
  })

  it('swaps to the other mode\'s controls on a state change, replacing not appending', () => {
    const bar = createControlBar(asHost(host), { mode: 'draw', drawClassIndex: 0 }, () => {})
    bar.setState({ mode: 'select', drawClassIndex: 0 })
    const labels = barOf().children.map((b) => b.textContent)
    expect(labels).toEqual(['Mode: Select', 'Deselect', 'Delete', 'Split', 'Downgrade', 'Upgrade'])
    expect(barOf().children).toHaveLength(controlsForMode('select').length)
  })

  it('follows the armed class as it changes', () => {
    const bar = createControlBar(asHost(host), { mode: 'draw', drawClassIndex: 0 }, () => {})
    ROAD_CLASS_ORDER.forEach((name, index) => {
      bar.setState({ mode: 'draw', drawClassIndex: index })
      const pressed = barOf().children.filter((b) => b.attributes['aria-pressed'] === 'true')
      expect(pressed).toHaveLength(1)
      expect(pressed[0]!.textContent).toBe(name)
    })
  })
})

describe('dispatch — a button names an action and does nothing else', () => {
  it('reports exactly the action of the button clicked', () => {
    const fired: SceneAction[] = []
    createControlBar(asHost(host), { mode: 'draw', drawClassIndex: 0 }, (a) => fired.push(a))

    const build = barOf().children.find((b) => b.textContent === 'Build')!
    build.click()
    expect(fired).toEqual([{ kind: 'commit' }])
  })

  it('dispatches the right class index for each class button', () => {
    const fired: SceneAction[] = []
    createControlBar(asHost(host), { mode: 'draw', drawClassIndex: 0 }, (a) => fired.push(a))
    for (const name of ROAD_CLASS_ORDER) {
      barOf().children.find((b) => b.textContent === name)!.click()
    }
    expect(fired).toEqual(
      ROAD_CLASS_ORDER.map((_, index) => ({ kind: 'setDrawClass', index })),
    )
  })

  it('every button in every mode dispatches its own binding, one action per click', () => {
    for (const mode of ['draw', 'select'] as const) {
      host = createStubElement('div')
      const fired: SceneAction[] = []
      createControlBar(asHost(host), { mode, drawClassIndex: 0 }, (a) => fired.push(a))
      const expected = controlsForMode(mode).map((b) => b.action)
      for (const button of barOf().children) button.click()
      expect(fired).toEqual(expected)
    }
  })

  it('drops focus on activation', () => {
    // The other half of the Space hazard: some browsers focus a
    // `tabindex="-1"` element on click regardless.
    createControlBar(asHost(host), { mode: 'draw', drawClassIndex: 0 }, () => {})
    const button = barOf().children[0]!
    button.click()
    expect(button.blurCount).toBe(1)
  })

  it('a re-render does not leave old buttons still wired up', () => {
    const fired: SceneAction[] = []
    const bar = createControlBar(asHost(host), { mode: 'draw', drawClassIndex: 0 }, (a) =>
      fired.push(a),
    )
    const staleBuild = barOf().children.find((b) => b.textContent === 'Build')!
    bar.setState({ mode: 'select', drawClassIndex: 0 })
    // The element is gone from the tree; nothing can click it any more.
    expect(barOf().children).not.toContain(staleBuild)
    expect(staleBuild.parent).toBeUndefined()
    expect(fired).toEqual([])
  })
})

describe('dispose', () => {
  it('takes the bar back off a host it does not own', () => {
    const bar = createControlBar(asHost(host), { mode: 'draw', drawClassIndex: 0 }, () => {})
    expect(host.children).toHaveLength(1)
    bar.dispose()
    expect(host.children).toHaveLength(0)
  })
})
