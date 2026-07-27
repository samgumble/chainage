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
