import * as THREE from 'three'
import type { MeshData } from '../mesh/ribbon'

/**
 * Wrap renderer-agnostic mesh data as a three.js geometry.
 *
 * This is the single place the handedness conversion happens. The game's plan
 * coordinates are `(x, y)` with `y` north and `z` up; three.js wants `+Y` up.
 * The mapping is `(x, y, z) -> (x, z, -y)`, which preserves winding order and
 * therefore face orientation. Nothing upstream of this file knows three.js
 * exists, and nothing downstream should re-apply the conversion.
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
