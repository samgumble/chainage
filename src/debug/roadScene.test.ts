import { describe, it, expect } from 'vitest'
import { buildSceneContent } from './roadScene'
import { buildNetworkMesh } from '../mesh/networkMesh'

/**
 * The demo scene is the only end-to-end evidence the structures pipeline
 * works, so its parameters are asserted rather than eyeballed. Both triggers
 * shipped unreachable once — a grade solver bounded to ground + fill
 * allowance can never produce a structure station, and a corridor template
 * with no `maxBatterWidth` can never produce a wall — and neither failure is
 * visible in a screenshot of a scene that renders perfectly well without them.
 *
 * The scene is built once: it grades three roads over a 257x257 terrain and
 * excavates every corridor, which is not cheap.
 */
const content = buildSceneContent()

/** Total structure vertices across every road. */
const structureVertices = (built: { structures: ReadonlyMap<number, { vertexCount: number }> }) => {
  let total = 0
  for (const [, mesh] of built.structures) total += mesh.vertexCount
  return total
}

describe('the demo scene', () => {
  it('grades all three roads', () => {
    expect(content.designs.size).toBe(3)
  })

  it('produces at least one bridge', () => {
    // Rebuilt with no corridor template, so walls are off and every vertex
    // left is a bridge. A count taken from the full scene could not tell the
    // two structure types apart.
    const bridgesOnly = buildNetworkMesh(content.network, content.designs, {
      spacing: 4,
      terrain: content.terrain,
      maxFillHeight: 10,
    })
    expect(structureVertices(bridgesOnly)).toBeGreaterThan(0)
  })

  it('produces retaining walls as well as bridges', () => {
    // Same scene minus the batter limit: no wall can be built without one, so
    // whatever the full scene has beyond this is wall.
    const bridgesOnly = buildNetworkMesh(content.network, content.designs, {
      spacing: 4,
      terrain: content.terrain,
      maxFillHeight: 10,
    })
    expect(structureVertices(content.built)).toBeGreaterThan(structureVertices(bridgesOnly))
  })

  it('leaves the ground unexcavated where a bridge carries the road', () => {
    // The bridge spans a valley the earthworks would otherwise fill in. If
    // the excavation ran through the span, the deck would be buried in its
    // own embankment: somewhere under a bridge the edit layer must still
    // read as natural ground.
    const bridgesOnly = buildNetworkMesh(content.network, content.designs, {
      spacing: 4,
      terrain: content.terrain,
      maxFillHeight: 10,
    })

    let sampled = 0
    let untouched = 0
    for (const [, mesh] of bridgesOnly.structures) {
      for (let i = 0; i < mesh.vertexCount; i++) {
        const x = mesh.positions[i * 3]!
        const y = mesh.positions[i * 3 + 1]!
        sampled++
        if (content.editLayer.sample(x, y) === content.terrain.sample(x, y)) untouched++
      }
    }
    expect(sampled).toBeGreaterThan(0)
    expect(untouched).toBeGreaterThan(0)
  })
})
