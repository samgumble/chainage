import type { Heightmap, TerrainSampler } from '../terrain/heightmap'
import type { Vec3 } from './cameraRig'

/**
 * Where a camera points and how far a shadow frustum has to reach, derived
 * from the terrain rather than picked by eye.
 *
 * No three.js: both functions here are arithmetic over a heightmap, and the
 * whole point of them living outside `debug/roadScene.ts` is that they can be
 * unit tested without a renderer, a canvas or a GPU. `render/` rather than
 * `terrain/` because neither answers a question about the ground — they answer
 * questions about how the ground is looked at.
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
 * Where the camera rig starts looking: the middle of the terrain's footprint,
 * standing ON the ground there.
 *
 * The scene used to aim at `JUNCTION`, the hardcoded point the demo network's
 * three arms were built around. With the game now opening on bare terrain
 * there is no junction, and a coordinate that used to mean something is worse
 * than one that never did — it frames a spot for a reason that no longer
 * exists.
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
