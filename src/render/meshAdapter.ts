import * as THREE from 'three'
import type { MeshData } from '../mesh/ribbon'

/**
 * Wrap renderer-agnostic mesh data as a three.js geometry.
 *
 * The game's plan coordinates are `(x, y)` with `y` north and `z` up;
 * three.js wants `+Y` up. The mapping is `(x, y, z) -> (x, z, -y)`, which
 * preserves winding order and therefore face orientation.
 *
 * This conversion happens only inside `src/render/` (here, and again in
 * `src/render/terrainMesh.ts`, which writes `(gx, z, -gy)` directly for the
 * same reason) and in the debug scene, which hand-converts its orbit centre
 * in `src/debug/roadScene.ts`. It is not applied anywhere upstream — never in
 * `src/mesh/`, `src/terrain/`, or `src/geometry/`, which know nothing of
 * three.js or of this handedness flip.
 */
export const toBufferGeometry = (mesh: MeshData): THREE.BufferGeometry => {
  const geometry = new THREE.BufferGeometry()

  const positions = new Float32Array(mesh.vertexCount * 3)
  const normals = new Float32Array(mesh.vertexCount * 3)

  for (let i = 0; i < mesh.vertexCount; i++) {
    positions[i * 3] = mesh.positions[i * 3]!
    positions[i * 3 + 1] = mesh.positions[i * 3 + 2]!
    positions[i * 3 + 2] = -mesh.positions[i * 3 + 1]!

    normals[i * 3] = mesh.normals[i * 3]!
    normals[i * 3 + 1] = mesh.normals[i * 3 + 2]!
    normals[i * 3 + 2] = -mesh.normals[i * 3 + 1]!
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(mesh.uvs), 2))
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1))

  return geometry
}
