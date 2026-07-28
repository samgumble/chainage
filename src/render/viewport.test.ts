import { describe, expect, it } from 'vitest'
import {
  MAX_RENDER_PIXEL_RATIO,
  OVERLAY_EDGE_INSET_PX,
  renderPixelRatio,
  viewportMetrics,
} from './viewport'

describe('OVERLAY_EDGE_INSET_PX', () => {
  // Pinned as a literal, like `MAX_RENDER_PIXEL_RATIO` above and for the same
  // reason: it is the number itself that both overlays have to agree on, and
  // nothing derived from it would notice if it changed.
  it('is 12', () => {
    expect(OVERLAY_EDGE_INSET_PX).toBe(12)
  })

  // The message line computes its wrapping budget as the host width less this
  // inset on BOTH sides. If it were ever zero or negative, that budget would
  // be the full width or more and the text would run off the edge again —
  // which is the defect the constant is load-bearing for.
  it('is a positive margin, so an overlay never sits flush against the edge', () => {
    expect(OVERLAY_EDGE_INSET_PX).toBeGreaterThan(0)
  })
})

describe('MAX_RENDER_PIXEL_RATIO', () => {
  // Pinned directly rather than through a derived value. `renderPixelRatio`
  // clamps to it, so a test that only ever checked "a DPR of 3 comes back
  // smaller than 3" would pass for a cap of 1 as readily as for a cap of 2 —
  // and a cap of 1 is the soft-on-a-phone failure this constant exists to
  // avoid. The number itself is the decision; see the constant's own doc for
  // the measurement behind it.
  it('is 2', () => {
    expect(MAX_RENDER_PIXEL_RATIO).toBe(2)
  })
})

describe('renderPixelRatio', () => {
  it('passes an ordinary desktop 1x display through unchanged', () => {
    expect(renderPixelRatio(1)).toBe(1)
  })

  it('passes a retina 2x display through unchanged', () => {
    // The value every retina desktop screen reports, and the whole reason the
    // cap is 2: this must be a no-op, or the cap is a desktop change.
    expect(renderPixelRatio(2)).toBe(2)
  })

  it('caps a 3x phone display at the maximum', () => {
    expect(renderPixelRatio(3)).toBe(MAX_RENDER_PIXEL_RATIO)
  })

  it('caps a 4x display at the maximum', () => {
    expect(renderPixelRatio(4)).toBe(2)
  })

  it('caps rather than floors: a ratio just above the maximum comes back at it', () => {
    expect(renderPixelRatio(2.0000001)).toBe(2)
  })

  it('leaves a fractional ratio below the cap alone', () => {
    // A 1.5x Android screen, or a desktop at 150% OS scaling. Rounding this
    // up to 2 would render more pixels than the screen has; rounding it down
    // to 1 would be visibly soft.
    expect(renderPixelRatio(1.5)).toBe(1.5)
  })

  it('does not floor a zoomed-out desktop below 1', () => {
    // A browser zoomed out reports a DPR under 1, and those really are all
    // the device pixels the canvas occupies. Clamping up to 1 would cost fill
    // rate for nothing and would change existing desktop behaviour.
    expect(renderPixelRatio(0.5)).toBe(0.5)
  })

  it('falls back to 1 when there is no window to report a ratio', () => {
    expect(renderPixelRatio(undefined)).toBe(1)
  })

  it('falls back to 1 rather than propagating NaN', () => {
    // `Math.min(NaN, 2)` is NaN, and a NaN pixel ratio multiplied into
    // `setSize` gives a zero-sized drawing buffer — a black screen with no
    // error attached to it.
    expect(renderPixelRatio(NaN)).toBe(1)
  })

  it('falls back to 1 for a non-finite ratio', () => {
    expect(renderPixelRatio(Infinity)).toBe(1)
    expect(renderPixelRatio(-Infinity)).toBe(1)
  })

  it('falls back to 1 for a zero or negative ratio', () => {
    expect(renderPixelRatio(0)).toBe(1)
    expect(renderPixelRatio(-2)).toBe(1)
  })
})

describe('viewportMetrics', () => {
  it('reports the CSS size it was given, unscaled', () => {
    // `WebGLRenderer.setSize` and `EffectComposer.setSize` both apply the
    // pixel ratio themselves, so pre-multiplying here would square it.
    const metrics = viewportMetrics(375, 812, 2)
    expect(metrics?.width).toBe(375)
    expect(metrics?.height).toBe(812)
  })

  it('computes aspect as width over height', () => {
    // Portrait, so an inverted aspect is not merely a different number but a
    // number on the other side of 1 — which is the whole point of testing a
    // phone-shaped viewport rather than a square one.
    const metrics = viewportMetrics(375, 812, 2)
    expect(metrics?.aspect).toBeCloseTo(375 / 812, 12)
    expect(metrics?.aspect).toBeLessThan(1)
  })

  it('computes aspect greater than 1 for a landscape viewport', () => {
    expect(viewportMetrics(1280, 800, 1)?.aspect).toBeCloseTo(1.6, 12)
  })

  it('scales the drawing buffer by the pixel ratio', () => {
    const metrics = viewportMetrics(375, 812, 2)
    expect(metrics?.bufferWidth).toBe(750)
    expect(metrics?.bufferHeight).toBe(1624)
  })

  it('leaves the drawing buffer equal to the CSS box at ratio 1', () => {
    const metrics = viewportMetrics(375, 812, 1)
    expect(metrics?.bufferWidth).toBe(375)
    expect(metrics?.bufferHeight).toBe(812)
  })

  it('floors a fractional drawing buffer, as WebGLRenderer.setSize does', () => {
    // 374.3 * 2 = 748.6 -> 748; 811.5 * 3 = 2434.5 -> 2434. A render target
    // that rounded the other way would be a pixel wider than the buffer the
    // renderer sizes itself to.
    //
    // Both products have to land BETWEEN two integers for this to say
    // anything. Written first with 374.5 x 2, which is exactly 749 either
    // way — mutation testing found that a floor-to-ceil change passed it
    // untouched, which is the whole reason the width factor is 374.3 now.
    expect(viewportMetrics(374.3, 811.5, 2)?.bufferWidth).toBe(748)
    expect(viewportMetrics(374.3, 811.5, 3)?.bufferHeight).toBe(2434)
  })

  it('keeps the drawing buffer at least one pixel for a sub-pixel canvas', () => {
    // Flooring alone would give 0 here, and a zero-dimension WebGLRenderTarget
    // is not an allocatable texture.
    const metrics = viewportMetrics(0.4, 0.4, 1)
    expect(metrics?.bufferWidth).toBeGreaterThanOrEqual(1)
    expect(metrics?.bufferHeight).toBeGreaterThanOrEqual(1)
  })

  it('computes texel size from the drawing buffer, not the CSS box', () => {
    // A 375x812 CSS canvas at ratio 2 is a 750x1624 buffer. Dropping the
    // ratio here would make the blur kernel step two device pixels at a time
    // on every retina screen.
    const metrics = viewportMetrics(375, 812, 2)
    expect(metrics?.texelWidth).toBeCloseTo(1 / 750, 12)
    expect(metrics?.texelHeight).toBeCloseTo(1 / 1624, 12)
  })

  it('gives width and height their own texel sizes', () => {
    // Not one shared value: a non-square viewport has a different texel step
    // horizontally than vertically, and using one for both skews the blur.
    const metrics = viewportMetrics(400, 200, 1)
    expect(metrics?.texelWidth).toBeCloseTo(1 / 400, 12)
    expect(metrics?.texelHeight).toBeCloseTo(1 / 200, 12)
    expect(metrics?.texelWidth).not.toBeCloseTo(metrics?.texelHeight ?? 0, 12)
  })

  it('halves the texel size when the pixel ratio doubles', () => {
    const atOne = viewportMetrics(375, 812, 1)
    const atTwo = viewportMetrics(375, 812, 2)
    expect(atTwo?.texelWidth).toBeCloseTo((atOne?.texelWidth ?? 0) / 2, 12)
    expect(atTwo?.texelHeight).toBeCloseTo((atOne?.texelHeight ?? 0) / 2, 12)
  })

  it('leaves the CSS size untouched when the pixel ratio changes', () => {
    expect(viewportMetrics(375, 812, 3)?.width).toBe(375)
    expect(viewportMetrics(375, 812, 3)?.height).toBe(812)
  })

  it('leaves the aspect ratio untouched when the pixel ratio changes', () => {
    expect(viewportMetrics(375, 812, 1)?.aspect).toBe(viewportMetrics(375, 812, 3)?.aspect)
  })

  it('returns null for a zero width', () => {
    // The normal transient for a canvas observed before first layout, or
    // hidden. Not an error, and not a size to substitute a fake 1x1 for.
    expect(viewportMetrics(0, 812, 2)).toBeNull()
  })

  it('returns null for a zero height', () => {
    expect(viewportMetrics(375, 0, 2)).toBeNull()
  })

  it('returns null for a negative width or height', () => {
    expect(viewportMetrics(-375, 812, 2)).toBeNull()
    expect(viewportMetrics(375, -812, 2)).toBeNull()
  })

  it('returns null for a zero or negative pixel ratio', () => {
    // A zero ratio would give an infinite texel size rather than a number
    // any shader could use.
    expect(viewportMetrics(375, 812, 0)).toBeNull()
    expect(viewportMetrics(375, 812, -1)).toBeNull()
  })

  it('returns null rather than propagating a non-finite input', () => {
    expect(viewportMetrics(NaN, 812, 2)).toBeNull()
    expect(viewportMetrics(375, NaN, 2)).toBeNull()
    expect(viewportMetrics(375, 812, NaN)).toBeNull()
    expect(viewportMetrics(Infinity, 812, 2)).toBeNull()
    expect(viewportMetrics(375, Infinity, 2)).toBeNull()
    expect(viewportMetrics(375, 812, Infinity)).toBeNull()
  })

  it('accepts the fractional sizes a ResizeObserver really reports', () => {
    // Content-box sizes are not integers; a guard written as an integer check
    // would reject every real callback.
    const metrics = viewportMetrics(374.5, 811.5, 2)
    expect(metrics).not.toBeNull()
    expect(metrics?.aspect).toBeCloseTo(374.5 / 811.5, 12)
  })
})
