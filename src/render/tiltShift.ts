export type TiltShiftFocus = {
  /** Distance from the camera that is perfectly sharp, metres. */
  readonly distance: number
  /** Total depth around that distance which stays sharp, metres. */
  readonly range: number
  /** How far beyond the sharp range blur takes to reach maximum, metres. */
  readonly falloff: number
}

/** Blur radius at full strength, in pixels. */
export const MAX_BLUR_PIXELS = 6

/** Uniforms the pass supplies and the shader reads. Must agree exactly. */
export const TILT_SHIFT_UNIFORM_NAMES = [
  'tDiffuse',
  'tDepth',
  'uFocusDistance',
  'uFocusRange',
  'uFocusFalloff',
  'uNear',
  'uFar',
  'uTexelSize',
] as const

/**
 * How blurred a pixel at a given depth should be, from 0 to 1.
 *
 * Zero inside the sharp band, then rising linearly to full over `falloff`. A
 * linear ramp rather than anything smoother on purpose: the effect that makes
 * a scene read as miniature is a *narrow* sharp band with a quick transition,
 * and a gentle curve reads as haze instead.
 *
 * Symmetric about the focal distance — near and far blur alike, which is what
 * a real shallow depth of field does and what separates the look from fog.
 *
 * Mirrored by the GLSL function of the same name inside
 * `TILT_SHIFT_FRAGMENT_SHADER`, below — that shader comment points back here.
 * The two cannot be checked identical without a GL context (see this file's
 * tests), so keeping them in lock-step by hand is what this comment pair is
 * for: change one, change the other.
 */
export const blurFractionAt = (depth: number, focus: TiltShiftFocus): number => {
  if (!(focus.falloff > 0)) {
    throw new RangeError('focus falloff must be positive')
  }

  const halfRange = Math.max(0, focus.range) / 2
  const distanceFromBand = Math.abs(depth - focus.distance) - halfRange
  if (distanceFromBand <= 0) return 0

  const fraction = distanceFromBand / focus.falloff
  return fraction > 1 ? 1 : fraction
}

/**
 * Fragment shader for the tilt-shift pass.
 *
 * Reads the (non-linear) depth buffer and converts it to a view-space
 * distance in metres using the same perspective-projection inverse every
 * three.js depth pass expects: depth in [0,1] maps to normalized device Z in
 * [-1,1], and that maps to view-space Z through the standard perspective
 * formula. Getting this step right matters more than it looks — a shader
 * that blurred by raw depth-buffer value would put the focal plane somewhere
 * else entirely (the depth buffer is compressed non-linearly toward the
 * camera), and the result would still look like *some* kind of blur, just in
 * the wrong place, which is exactly the failure mode that is hard to notice
 * by eye.
 *
 * The blur-fraction arithmetic mirrors `blurFractionAt` exactly: zero inside
 * the sharp band, then a linear ramp over `uFocusFalloff`, symmetric about
 * `uFocusDistance`.
 */
export const TILT_SHIFT_FRAGMENT_SHADER = `
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform float uFocusDistance;
uniform float uFocusRange;
uniform float uFocusFalloff;
uniform float uNear;
uniform float uFar;
uniform vec2 uTexelSize;

varying vec2 vUv;

const float MAX_BLUR_PIXELS = ${MAX_BLUR_PIXELS.toFixed(1)};

// Convert a non-linear depth-buffer sample in [0, 1] to a view-space
// distance in metres, given the camera's near and far planes.
float linearizeDepth(float depthSample) {
  float ndcZ = depthSample * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - ndcZ * (uFar - uNear));
}

// Same shape as blurFractionAt: sharp inside the band around
// uFocusDistance, then a linear ramp to full over uFocusFalloff.
float blurFractionAt(float depth) {
  float halfRange = max(0.0, uFocusRange) * 0.5;
  float distanceFromBand = abs(depth - uFocusDistance) - halfRange;
  if (distanceFromBand <= 0.0) return 0.0;
  return clamp(distanceFromBand / uFocusFalloff, 0.0, 1.0);
}

void main() {
  float depthSample = texture2D(tDepth, vUv).x;
  float depth = linearizeDepth(depthSample);
  float blurFraction = blurFractionAt(depth);
  float radius = blurFraction * MAX_BLUR_PIXELS;

  vec4 colorSum = texture2D(tDiffuse, vUv);
  float sampleCount = 1.0;

  const int RING_SAMPLES = 8;
  for (int i = 0; i < RING_SAMPLES; i++) {
    float angle = (float(i) / float(RING_SAMPLES)) * 6.28318530718;
    vec2 offset = vec2(cos(angle), sin(angle)) * radius * uTexelSize;
    colorSum += texture2D(tDiffuse, vUv + offset);
    sampleCount += 1.0;

    vec2 innerOffset = offset * 0.5;
    colorSum += texture2D(tDiffuse, vUv + innerOffset);
    sampleCount += 1.0;
  }

  gl_FragColor = colorSum / sampleCount;
}
`

/** The uniform names as a type, derived from `TILT_SHIFT_UNIFORM_NAMES`
 * itself so the two can never quietly drift apart. */
type TiltShiftUniformName = (typeof TILT_SHIFT_UNIFORM_NAMES)[number]

/**
 * The value type each uniform holds, one entry per name above.
 *
 * The loosest shape this module can name without importing three.js: numbers
 * for every scalar uniform, a plain `{x, y}` pair for the one vec2 (three's
 * own `WebGLUniforms` vec2 setter reads `.x`/`.y` off whatever object it is
 * given — it does not require an actual `THREE.Vector2`), and `unknown` for
 * the two textures, which this module never constructs and a caller must
 * supply.
 */
type TiltShiftUniformValue = {
  readonly tDiffuse: unknown
  readonly tDepth: unknown
  readonly uFocusDistance: number
  readonly uFocusRange: number
  readonly uFocusFalloff: number
  readonly uNear: number
  readonly uFar: number
  readonly uTexelSize: { readonly x: number; readonly y: number }
}

/**
 * The uniform object shape `ShaderPass` needs to run `TILT_SHIFT_FRAGMENT_SHADER`.
 *
 * Mapped from `TiltShiftUniformName` rather than written out as a second,
 * independent object type — so a name added to or removed from
 * `TILT_SHIFT_UNIFORM_NAMES` without a matching change to `TiltShiftUniformValue`
 * is a type error at `createTiltShiftUniforms`'s return statement, not a
 * silent no-op. `_TiltShiftUniformKeysMatch` below closes the other
 * direction: a key in `TiltShiftUniformValue` that is not in
 * `TILT_SHIFT_UNIFORM_NAMES`.
 */
export type TiltShiftUniforms = {
  readonly [K in TiltShiftUniformName]: { readonly value: TiltShiftUniformValue[K] }
}

type AssertSameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

/**
 * Compile-time check that `TiltShiftUniformValue` names exactly the same
 * uniforms as `TILT_SHIFT_UNIFORM_NAMES` — no more, no fewer. If the two
 * ever disagree, `_TiltShiftUniformKeysMatch`'s type becomes `never`, and
 * assigning `true` to it fails to compile. Never read at runtime; exists
 * purely to make a name added on one side and forgotten on the other a type
 * error.
 */
type _TiltShiftUniformKeysMatch = AssertSameKeys<keyof TiltShiftUniformValue, TiltShiftUniformName>
const _tiltShiftUniformKeysMatch: _TiltShiftUniformKeysMatch = true

/** What a caller supplies to build the pass's uniforms; everything that
 * varies per frame or per resize. Deliberately not three.js types — see this
 * module's own ban on importing three. */
export type TiltShiftUniformInputs = {
  readonly focusDistance: number
  readonly focusRange: number
  readonly focusFalloff: number
  readonly near: number
  readonly far: number
  readonly texelWidth: number
  readonly texelHeight: number
}

/**
 * Build the uniform object `ShaderPass` expects for
 * `TILT_SHIFT_FRAGMENT_SHADER`, keyed off `TILT_SHIFT_UNIFORM_NAMES` rather
 * than hand-typed again at the call site.
 *
 * Before this factory existed, `roadScene.ts` wrote the uniforms object
 * literal by hand, so `TILT_SHIFT_UNIFORM_NAMES` — the only guard against the
 * "uniforms never reached the shader" bug already fixed once on this branch
 * (`908fe00`) — was never actually checked against what the pass constructed:
 * the list and the literal could silently drift apart again with nothing to
 * catch it. Routing construction through here, whose return type is derived
 * from that same list (see `TiltShiftUniforms`, above), makes that drift a
 * type error instead of a silent no-op.
 *
 * `tDiffuse` and `tDepth` start `null`: both are textures the render pipeline
 * supplies after construction (`tDiffuse` every frame, from whichever buffer
 * the previous pass wrote; `tDepth` once the composer's own depth texture
 * exists), not something this three-free module can produce itself.
 */
export const createTiltShiftUniforms = (inputs: TiltShiftUniformInputs): TiltShiftUniforms => ({
  tDiffuse: { value: null },
  tDepth: { value: null },
  uFocusDistance: { value: inputs.focusDistance },
  uFocusRange: { value: inputs.focusRange },
  uFocusFalloff: { value: inputs.focusFalloff },
  uNear: { value: inputs.near },
  uFar: { value: inputs.far },
  uTexelSize: { value: { x: inputs.texelWidth, y: inputs.texelHeight } },
})
