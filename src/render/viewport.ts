/**
 * The arithmetic of fitting the renderer — and the overlays drawn on top of
 * it — to the box they share.
 *
 * Three separate things have to move together every time the canvas changes
 * size — the renderer's drawing buffer, the camera's aspect ratio, and the
 * post-processing composer's render targets (and the texel size the tilt-shift
 * shader samples with). `debug/roadScene.ts` owns the calls that apply them,
 * because only it holds the three.js objects; what it must NOT own is the
 * arithmetic behind them. A composer left at the old size is the classic
 * source of a scene that renders at the wrong scale, and a `1 / width` that
 * forgot the pixel ratio is a blur that is silently wrong by a factor of two
 * on every retina screen. Neither failure raises anything — they are both
 * "looks a bit off", which is exactly the class of defect this project keeps
 * out of `roadScene.ts` by moving the numbers somewhere they can be tested.
 *
 * ## Three.js
 *
 * None, and deliberately so despite living in `src/render/` — the same
 * position `render/controlBar.ts` takes. Everything here is arithmetic over
 * plain numbers the caller already has (a CSS width, a CSS height, a pixel
 * ratio), so it is exercisable in this project's node-environment test suite
 * without a renderer, a canvas, or a DOM.
 */

/**
 * How far every screen-edge overlay sits from the edge of the canvas, CSS
 * pixels, before any safe-area inset is added on top.
 *
 * One constant for both overlays, in one place they can both import, because
 * they are inset from OPPOSITE corners: the message line from the top-left,
 * the control bar from the bottom. Two overlays inset by different amounts
 * from opposite corners read as an accident rather than a margin, and nothing
 * would fail if they drifted apart — `controlBar.ts` used to say "matches the
 * message line's own 12px offset" in prose while `roadScene.ts` wrote its own
 * 12 independently, which is exactly the pairing this project has already had
 * go quietly wrong once (see `tool/snapRadius.ts`). Now the claim is the code.
 *
 * It is also the budget the message line's `max-width` is computed from — the
 * host's width less this inset on each side — which is what gives generated
 * text something to wrap AT instead of running off the side of a phone.
 */
export const OVERLAY_EDGE_INSET_PX = 12

/**
 * The largest device pixel ratio the renderer will draw at.
 *
 * ### Why there is a cap at all
 *
 * Measured, not assumed. With this scene's post-processing chain (a
 * `RenderPass` into a `HalfFloatType` target carrying a depth texture, the
 * depth-sampling tilt-shift `ShaderPass`, then `OutputPass`) the GPU cost is
 * dominated by full-screen fill rate, so it scales with the DRAWING BUFFER's
 * pixel count, which is the square of the pixel ratio.
 *
 * On an Apple M1 Pro, at a 375x812 CSS viewport with this cap in force — a
 * 750x1624 buffer, 1.22 megapixels — `EXT_disjoint_timer_query_webgl2`
 * reports a median GPU time of 5.4ms per frame (n=89, p90 13.7ms). That is
 * already about two thirds of a 120Hz frame budget on a laptop GPU
 * substantially faster than any phone's.
 *
 * Uncapped, a modern phone reporting `devicePixelRatio` 3 at a 390x844 screen
 * would ask for a 1170x2532 buffer — 2.96 megapixels, 2.25x the pixels and so
 * roughly 2.25x that fill-rate cost, on weaker hardware. That is not a frame
 * rate this scene would hold. The cap is the difference between a diorama
 * that moves and one that stutters.
 *
 * ### Why the cap is 2 and not lower
 *
 * Two is where sharpness stops being the problem. The failure this cap must
 * not cause is the one at the other end — a phone at ratio 3 rendered at
 * ratio 1 is a third of the linear resolution and reads as visibly soft. At
 * 2 a DPR-3 screen is downsampling by a factor of 1.5, which the display's
 * own filtering absorbs; there is no comparable softness to see.
 *
 * It is also, and not incidentally, the value this project already shipped.
 * Every retina desktop screen this game has ever been played on has a DPR of
 * exactly 2, so a cap of 2 is a no-op there and a cap of anything lower would
 * be an unrequested change to how desktop looks, made in passing during a
 * mobile task. Lowering it specifically for touch devices is a real option
 * and a real tuning decision, and it is deliberately not taken here: it needs
 * a phone to judge, and it would put a device-class branch — a second code
 * path, exercised by nobody — in front of the one thing on screen.
 */
export const MAX_RENDER_PIXEL_RATIO = 2

/**
 * The pixel ratio the renderer should draw at, given what the display
 * reports.
 *
 * `Math.min` against `MAX_RENDER_PIXEL_RATIO` (see above for the measurement
 * behind that number), with a guard for a `devicePixelRatio` that is not a
 * usable number at all. The guard is not hypothetical hand-wringing about
 * browsers: `window.devicePixelRatio` is `undefined` in any environment
 * without a window, and `Math.min(undefined, 2)` is `NaN` — which
 * `WebGLRenderer.setSize` would then multiply the canvas dimensions by,
 * producing a zero-sized drawing buffer and a black screen rather than an
 * error anyone could trace back to here.
 *
 * No LOWER bound, on purpose. A ratio below 1 is what a desktop browser
 * reports when the page is zoomed out, and drawing at it is correct — those
 * really are all the device pixels the canvas occupies. Flooring it at 1
 * would render more pixels than the screen can show, which costs fill rate to
 * buy nothing, and would change existing desktop behaviour, which this task
 * may not do.
 */
export const renderPixelRatio = (devicePixelRatio: number | undefined): number => {
  if (typeof devicePixelRatio !== 'number' || !Number.isFinite(devicePixelRatio)) return 1
  if (devicePixelRatio <= 0) return 1
  return Math.min(devicePixelRatio, MAX_RENDER_PIXEL_RATIO)
}

/**
 * Everything that has to be recomputed when the canvas's box changes size.
 *
 * One value object rather than several loose returns, so that a caller cannot
 * apply the new size to the renderer and forget the aspect ratio or the texel
 * size — the fields arrive together or not at all.
 */
export type ViewportMetrics = {
  /** CSS pixels, as handed in — the size to give `WebGLRenderer.setSize` and
   * `EffectComposer.setSize`, both of which apply the pixel ratio themselves. */
  readonly width: number
  readonly height: number
  /** `PerspectiveCamera.aspect`. */
  readonly aspect: number
  /** The DRAWING BUFFER's size, device pixels — CSS size times pixel ratio,
   * rounded the way `WebGLRenderer.setSize` rounds it (`Math.floor`), so a
   * render target constructed from these dimensions matches the one the
   * renderer sizes itself to instead of being off by a pixel on a fractional
   * layout. Needed only where a buffer has to be allocated by hand — the
   * composer's explicit `WebGLRenderTarget` — because `setSize` on the
   * renderer and on the composer both apply the ratio themselves. */
  readonly bufferWidth: number
  readonly bufferHeight: number
  /** One over the DRAWING BUFFER's width and height — the step, in UV space,
   * from one texel to the next in the render target the tilt-shift pass
   * samples. The pixel ratio belongs in here precisely because the render
   * target is sized in device pixels while `width`/`height` above are CSS
   * pixels; a texel size computed from the CSS size alone under-samples the
   * blur kernel by exactly the pixel ratio. */
  readonly texelWidth: number
  readonly texelHeight: number
}

/**
 * `ViewportMetrics` for a canvas of `width` x `height` CSS pixels drawn at
 * `pixelRatio` device pixels each, or `null` if that box is not something a
 * scene can be rendered into.
 *
 * `null` rather than a throw, and rather than clamping to some minimum. This
 * is called from a `ResizeObserver` callback and from every animation frame,
 * on a canvas that is legitimately zero-sized for a moment whenever it is
 * detached, hidden behind a `display: none`, or observed before first layout.
 * A zero size is a normal transient here, not an error to report and not a
 * size to substitute a fake 1x1 for — the only correct response is to leave
 * the renderer at whatever it was and try again next frame, and a `null` the
 * caller must handle says exactly that.
 */
export const viewportMetrics = (
  width: number,
  height: number,
  pixelRatio: number,
): ViewportMetrics | null => {
  if (!Number.isFinite(width) || width <= 0) return null
  if (!Number.isFinite(height) || height <= 0) return null
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) return null

  // Floored, matching `WebGLRenderer.setSize`, so a render target built from
  // these dimensions is exactly the buffer the renderer sizes itself to; then
  // held at a minimum of one, because a sub-pixel canvas floors to zero and a
  // zero-dimension `WebGLRenderTarget` is not an allocatable texture.
  const bufferWidth = Math.max(1, Math.floor(width * pixelRatio))
  const bufferHeight = Math.max(1, Math.floor(height * pixelRatio))

  return {
    width,
    height,
    aspect: width / height,
    bufferWidth,
    bufferHeight,
    texelWidth: 1 / (width * pixelRatio),
    texelHeight: 1 / (height * pixelRatio),
  }
}
