import * as THREE from 'three'
import type { Heightmap } from '../terrain/heightmap'

/**
 * A three.js geometry for a heightmap.
 *
 * `step` skips grid points to keep the vertex count sane on a large map; a
 * step of 2 samples every other row and column. Deliberately simple — proper
 * terrain LOD belongs with the renderer work, not here.
 */
export const terrainGeometry = (
  terrain: Heightmap,
  step: number = 1,
): THREE.BufferGeometry => {
  if (step < 1 || !Number.isInteger(step)) {
    throw new RangeError('step must be a positive integer')
  }

  const cols = Math.floor((terrain.cols - 1) / step) + 1
  const rows = Math.floor((terrain.rows - 1) / step) + 1

  const positions = new Float32Array(cols * rows * 3)
  const indices: number[] = []

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const gx = terrain.originX + c * step * terrain.cellSize
      const gy = terrain.originY + r * step * terrain.cellSize
      const z = terrain.sample(gx, gy)

      const i = (r * cols + c) * 3
      positions[i] = gx
      positions[i + 1] = z
      positions[i + 2] = -gy
    }
  }

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c
      const b = a + 1
      const d = a + cols
      const e = d + 1
      indices.push(a, d, b, b, d, e)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}
