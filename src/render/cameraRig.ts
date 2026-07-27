export type Vec3 = {
  readonly x: number
  readonly y: number
  readonly z: number
}

/**
 * Elevation bounds, radians above the horizontal.
 *
 * Not quite vertical, because at exactly vertical the azimuth stops meaning
 * anything and the view spins on the spot. Not quite horizontal, because
 * below that the camera is underground.
 */
export const MAX_ELEVATION = Math.PI / 2 - 0.05
export const MIN_ELEVATION = 0.1

export const MIN_DISTANCE = 40
export const MAX_DISTANCE = 6000

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value

/**
 * An orbiting camera, as numbers.
 *
 * Deliberately free of three.js: the arithmetic that decides where the camera
 * is belongs to the game, and keeping it here means it can be tested without
 * a renderer, a canvas or a DOM. `render/` converts the result into three.js's
 * handedness at the point of use — this class speaks the project's own
 * convention throughout, `(x, y)` on the ground with `z` up.
 */
export class CameraRig {
  private targetPosition: Vec3
  azimuth = Math.PI / 4
  elevation = Math.PI / 5
  distance: number

  constructor(target: Vec3, distance: number) {
    if (!(distance > 0)) {
      throw new RangeError('camera distance must be positive')
    }
    this.targetPosition = { ...target }
    this.distance = clamp(distance, MIN_DISTANCE, MAX_DISTANCE)
  }

  get target(): Vec3 {
    return { ...this.targetPosition }
  }

  get position(): Vec3 {
    const horizontal = this.distance * Math.cos(this.elevation)
    return {
      x: this.targetPosition.x + horizontal * Math.cos(this.azimuth),
      y: this.targetPosition.y + horizontal * Math.sin(this.azimuth),
      z: this.targetPosition.z + this.distance * Math.sin(this.elevation),
    }
  }

  orbit(dAzimuth: number, dElevation: number): void {
    this.azimuth += dAzimuth
    this.elevation = clamp(this.elevation + dElevation, MIN_ELEVATION, MAX_ELEVATION)
  }

  /**
   * Slide the target across the ground.
   *
   * `forward` is the camera's heading projected onto the ground, not its true
   * view direction — otherwise panning would drive the target into the terrain
   * as the view steepened, which is not what dragging a map should do.
   */
  pan(dRight: number, dForward: number): void {
    // The camera looks from its position back toward the target, so its
    // ground-plane forward is the opposite of the direction it sits in.
    const forwardX = -Math.cos(this.azimuth)
    const forwardY = -Math.sin(this.azimuth)
    // Right is forward turned ninety degrees clockwise on the ground.
    const rightX = forwardY
    const rightY = -forwardX

    this.targetPosition = {
      x: this.targetPosition.x + rightX * dRight + forwardX * dForward,
      y: this.targetPosition.y + rightY * dRight + forwardY * dForward,
      z: this.targetPosition.z,
    }
  }

  zoom(factor: number): void {
    if (!(factor > 0)) {
      throw new RangeError('zoom factor must be positive')
    }
    this.distance = clamp(this.distance * factor, MIN_DISTANCE, MAX_DISTANCE)
  }
}
