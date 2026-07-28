/**
 * How big a control has to be before a finger can hit it reliably.
 *
 * One constant, in its own module, because two unrelated parts of this
 * codebase need the same number for the same reason and must not each pick
 * their own: `render/controlBar.ts` sizes every on-screen button from it, and
 * `tool/snapRadius.ts` derives its fingertip snap tolerance as half of it.
 * That module's `FINGERTIP_SNAP_RADIUS_PX` used to restate the 44 in prose
 * while writing 22 in code — true at the time and exactly the kind of pairing
 * that goes quietly wrong the first time either number is retuned.
 *
 * No imports at all, deliberately. This is a fact about hands, not about
 * roads, cameras or the graph, and anything it imported would end up in the
 * module graph of both of its consumers — one of which (`src/tool/`) is
 * forbidden to reach three.js and one of which (`src/render/`) is full of it.
 */

/**
 * The smallest square a control may occupy and still be comfortably tappable,
 * CSS pixels.
 *
 * Forty-four. Apple's Human Interface Guidelines give 44x44pt as the minimum
 * hit target; Android's Material guidance gives 48x48dp with 44 as the floor
 * for a dense layout. The two platforms are not quoting each other — they are
 * both measuring the same thing, which is that a fingertip's contact patch is
 * roughly 10mm across and a person cannot aim it to better than a few
 * millimetres. Where those two agree is a stronger figure than anything this
 * project could pick on its own, so this takes the number both converge on
 * rather than a rounder one.
 *
 * CSS pixels rather than device pixels, for the reason `gestures.ts` gives
 * for `TAP_SLOP`: CSS pixels are already normalised for display density
 * (96 to the inch by definition), so 44 of them is about the same physical
 * 11.6mm on a phone as on a desktop monitor. A device-pixel figure would
 * shrink to nothing on a 3x screen.
 *
 * A MINIMUM, not a size. `controlBar.ts` applies it as `min-width`/
 * `min-height` and lets a button with a longer label grow past it; a control
 * that is too big is merely ungainly, and one that is too small is unusable.
 */
export const MIN_TOUCH_TARGET_PX = 44
