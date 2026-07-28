import { describe, expect, it } from 'vitest'
import { MIN_TOUCH_TARGET_PX } from './touchTarget'

describe('MIN_TOUCH_TARGET_PX', () => {
  it('is the 44 CSS px both platform guidelines converge on', () => {
    // Pinned as a literal on purpose. This is not a derived quantity that
    // could be recomputed if it drifted — it is a citation, and a test that
    // recomputed it from anything would be asserting nothing. If it ever
    // changes, that has to be a deliberate edit here as well as there.
    expect(MIN_TOUCH_TARGET_PX).toBe(44)
  })

  it('is large enough to be a fingertip and small enough to be a control', () => {
    // A fingertip's contact patch is ~10mm, which at the CSS definition of
    // 96px to the inch is ~37.8px. A minimum below that would be smaller
    // than the finger it is meant to catch; one far above it would be a
    // panel rather than a button.
    expect(MIN_TOUCH_TARGET_PX).toBeGreaterThanOrEqual(38)
    expect(MIN_TOUCH_TARGET_PX).toBeLessThanOrEqual(48)
  })
})
