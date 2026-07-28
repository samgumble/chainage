import type { Alignment } from '../geometry/alignment'
import type { Heightmap, TerrainSampler } from '../terrain/heightmap'
import { designElevationAtStation, type ProfilePoint } from '../terrain/groundProfile'
import type { Vec3 } from './cameraRig'

/**
 * Where a camera points and how far back it has to stand, derived from the
 * terrain and from what is built on it rather than picked by eye.
 *
 * No three.js: everything here is arithmetic over a heightmap, an alignment
 * and a design profile, and the whole point of it living outside
 * `debug/roadScene.ts` is that it can be unit tested without a renderer, a
 * canvas or a GPU. `render/` rather than `terrain/` because none of it answers
 * a question about the ground — they answer questions about how the ground,
 * and the road across it, are looked at.
 */

/** A sphere in the project's own convention (`(x, y)` ground, `z` up) that
 * encloses a terrain's full footprint and elevation range. */
export type TerrainBounds = {
  readonly centerX: number
  readonly centerY: number
  readonly centerZ: number
  readonly radius: number
}

/**
 * The bounding sphere of a heightmap — its footprint (from `originX`/`originY`
 * out to `width`/`height`) and the full spread of its own elevations.
 *
 * Exists to size the sun's shadow camera (see `drawRoadScene`): a
 * `DirectionalLight`'s shadow is an orthographic camera whose default frustum
 * is a couple of units across, which on terrain at this scene's scale
 * produces either no shadows at all or a small square of them near the
 * origin. A pure function of the terrain rather than a number picked by eye,
 * so it stays correct if the terrain's footprint or relief ever changes.
 */
export const terrainBounds = (terrain: Heightmap): TerrainBounds => {
  let minZ = Infinity
  let maxZ = -Infinity
  for (const z of terrain.elevations) {
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }

  const centerX = terrain.originX + terrain.width / 2
  const centerY = terrain.originY + terrain.height / 2
  const centerZ = (minZ + maxZ) / 2
  const halfElevation = (maxZ - minZ) / 2

  return {
    centerX,
    centerY,
    centerZ,
    radius: Math.hypot(terrain.width / 2, terrain.height / 2, halfElevation),
  }
}

/**
 * Where a camera looks when there is nothing built to look at: the middle of
 * the terrain's footprint, standing ON the ground there.
 *
 * The scene used to aim at `JUNCTION`, the hardcoded point the demo network's
 * three arms were built around. That coordinate outlived its reason, and one
 * that used to mean something is worse than one that never did — it frames a
 * spot for a reason that no longer exists.
 *
 * The game now opens on a road with a bridge on it, and `frameRoadRun` aims at
 * that instead; this is what is left when a scene has no structure in it — the
 * empty network, and every state the player can delete their way back to.
 *
 * So it is derived, from the only thing left in the scene: the terrain itself.
 * The plan centre is `terrainBounds`' own `centerX`/`centerY` — read from
 * there rather than recomputed, so the camera and the shadow frustum can never
 * disagree about where the middle of the world is.
 *
 * `centerZ` is deliberately NOT reused for the elevation. That is the midpoint
 * of the heightmap's whole elevation RANGE — halfway up the ridges — and a rig
 * orbiting a point suspended tens of metres above the valley floor looks like
 * a camera bug. What is wanted is the ground under the middle of the map, so
 * the elevation is sampled there. On this scene's valley that lands on the
 * floor, a few tens of metres off the meandering axis, which is both the
 * flattest ground available and the part a first road is most likely to want.
 *
 * Takes a `TerrainSampler`, not a `Heightmap`, for the elevation: the edit
 * layer is one too, so a caller that wanted to re-aim at excavated ground
 * could, without this function having to know the difference.
 */
export const terrainFocus = (terrain: Heightmap, ground: TerrainSampler = terrain): Vec3 => {
  const { centerX, centerY } = terrainBounds(terrain)
  return { x: centerX, y: centerY, z: ground.sample(centerX, centerY) }
}

/** Where a camera stands relative to what it is looking at: a point to aim at
 * and how far back to be. Exactly `CameraRig`'s two constructor arguments, in
 * that order, so a caller never has to pair them up itself. */
export type Framing = {
  readonly target: Vec3
  readonly distance: number
}

/**
 * How far back a camera has to stand for something `extent` metres across,
 * square on to it, to exactly fill a vertical field of view.
 *
 * The frustum's half-height at distance `d` is `d * tan(fov / 2)`, so an
 * object of height `extent` fills the view when `extent = 2 d tan(fov / 2)`.
 * Solved for `d`.
 *
 * VERTICAL field of view, because that is the one a `PerspectiveCamera` is
 * given and the only one that does not move when the window is resized. The
 * horizontal field is the vertical times the aspect ratio, so on any window
 * wider than it is tall this errs toward standing too far back rather than
 * too close — which is the safe direction: a subject that overflows the frame
 * is worse than one with room around it, and the room is where the landscape
 * goes.
 */
export const distanceToFrame = (extent: number, verticalFovDegrees: number): number => {
  if (!(extent > 0)) throw new RangeError('extent must be positive')
  if (!(verticalFovDegrees > 0) || verticalFovDegrees >= 180) {
    throw new RangeError('vertical field of view must be between 0 and 180 degrees')
  }
  return extent / (2 * Math.tan((verticalFovDegrees * Math.PI) / 360))
}

/**
 * Frame a run of road between two stations: aim at the middle of it, as built,
 * and stand back far enough that it takes up `fill` of the frame's height.
 *
 * The elevation comes from the DESIGN profile, not from the ground: the run
 * this exists to frame is a bridge deck, and a camera aimed at the terrain
 * under a twenty-metre viaduct is aimed at the bottom of a ravine with the
 * subject out of shot above it.
 *
 * The distance is measured on the chord between the run's two ends in three
 * dimensions, so a deck that falls as it crosses is framed by its true length
 * rather than by its plan length. On a straight run the chord IS the run; on a
 * curved one it is shorter than the arc, which again errs toward standing back
 * rather than too close.
 *
 * `fill` is the caller's, not this function's: how much of the frame the
 * subject should occupy is a composition decision, and the one number here
 * that cannot be derived from geometry. What this owns is the trigonometry
 * that turns that decision into metres.
 */
export const frameRoadRun = (
  alignment: Alignment,
  design: readonly ProfilePoint[],
  fromStation: number,
  toStation: number,
  verticalFovDegrees: number,
  fill: number,
): Framing => {
  if (!(toStation > fromStation)) {
    throw new RangeError('toStation must be beyond fromStation')
  }
  if (!(fill > 0) || fill > 1) {
    throw new RangeError('fill must be within (0, 1]')
  }

  const at = (station: number): Vec3 => {
    const { position } = alignment.poseAt(station)
    return { x: position.x, y: position.y, z: designElevationAtStation(design, station) }
  }

  const from = at(fromStation)
  const to = at(toStation)
  const target = at((fromStation + toStation) / 2)
  const chord = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)

  return { target, distance: distanceToFrame(chord / fill, verticalFovDegrees) }
}
