import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { vec2 } from '../geometry/vec2'
import { RoadNetwork } from '../network/graph'
import type { Heightmap } from '../terrain/heightmap'
import { buildTerrain, solveFor, solveNetwork, type SceneContent } from './roadScene'

/**
 * The three-arm demo network, as a fixture rather than as the game's starting
 * state.
 *
 * This layout used to be built by `buildSceneContent` and therefore shipped:
 * every player opened the game onto it, and every scene-level test measured
 * against it. Those two jobs pulled in opposite directions. The game wants to
 * open as a blank canvas; the tests want a network with a real junction, a
 * real bridge, real retaining walls and real traffic on it, because that is
 * the only end-to-end evidence the structures pipeline works at all.
 *
 * So the layout moved here and the game kept the terrain. Nothing about the
 * geometry changed — same junction, same bearings, same lengths, same classes,
 * same terrain (`buildTerrain`, imported rather than regenerated) — so every
 * measured number the tests pin still means what it meant.
 *
 * `.fixture.ts`, not `.ts`: vitest collects `src/**\/*.test.ts`, and nothing in
 * the app imports this file, so it is neither run as a test nor bundled into
 * the build. The suffix says which of the two it is at a glance.
 */

/**
 * Where the demo network's three arms meet — a T junction on the valley floor,
 * main road running east-west with a narrower gravel branch heading north.
 */
export const DEMO_JUNCTION = vec2(900, 1280)

/** Length of each rural arm, metres. */
export const DEMO_ARM_LENGTH = 750

/** Length of the gravel branch, metres. */
export const DEMO_BRANCH_LENGTH = 300

/**
 * A T junction on the valley floor: a main road running east-west with a
 * narrower gravel branch heading north. Three straight roads meeting at one
 * point, which is exactly what a junction needs and nothing more.
 *
 * All three alignments are built starting FROM the junction rather than
 * arriving at it. `solveGradeProfile`'s forward greedy sweep pins station 0
 * to natural ground but can drift away from it by the far end of a long
 * alignment (the terrain here is rough enough that it does): starting every
 * leg at the junction means every leg's own elevation there is natural
 * ground, so the three legs agree and the junction sits flush without
 * needing `elevationMismatches` to paper over a drifted arrival station.
 *
 * Reversing them to arrive at the junction instead has been tried and
 * reverted: it moved the legs' disagreement at the node from 0.457m to
 * 5.797m — a three-metre step at the exact point the camera used to be aimed
 * at — and did not fix the traffic problem it was aimed at either, because
 * arriving cars converge on the node exactly as spawning cars diverged from
 * it. Where traffic enters is `trafficEntryStations`' business, not the
 * alignments'.
 *
 * DO NOT reverse them.
 */
export const buildDemoNetwork = (terrain: Heightmap): RoadNetwork => {
  const network = new RoadNetwork()

  // West and east arms both start at the junction, heading opposite ways
  // along the valley; the branch starts there too, heading north.
  const westArm = new Alignment([new Line(DEMO_JUNCTION, Math.PI, DEMO_ARM_LENGTH)])
  const eastArm = new Alignment([new Line(DEMO_JUNCTION, 0, DEMO_ARM_LENGTH)])
  const branch = new Alignment([new Line(DEMO_JUNCTION, Math.PI / 2, DEMO_BRANCH_LENGTH)])

  const arms: [Alignment, 'rural' | 'gravel'][] = [
    [westArm, 'rural'], [eastArm, 'rural'], [branch, 'gravel'],
  ]

  // Only roads that grade feasibly join the network — an infeasible arm would
  // otherwise sit in it with no design profile and an empty mesh, which is not
  // what this fixed layout wants.
  for (const [alignment, className] of arms) {
    if (!solveFor(alignment, terrain).feasible) continue
    network.addRoad(alignment, className)
  }

  return network
}

/**
 * The whole demo scene — terrain, the three arms, and everything
 * `solveNetwork` derives from them.
 *
 * The exact `SceneContent` `buildSceneContent` used to return, so a test that
 * held the old starting state to account can keep doing so verbatim by
 * building it here instead of being handed it.
 *
 * NOT cheap: it grades three roads over a 257x257 terrain and excavates every
 * corridor. Call it once per test file, at module scope, and share the result.
 */
export const buildDemoSceneContent = (): SceneContent => {
  const terrain = buildTerrain()
  const network = buildDemoNetwork(terrain)

  const {
    designs, editLayer, built, spans,
    infeasibleRoads, infeasibleCrossings, shallowCrossings, unsupportedFill,
  } = solveNetwork(terrain, network)

  return {
    terrain, network, designs, editLayer, built, spans,
    infeasibleRoads, infeasibleCrossings, shallowCrossings, unsupportedFill,
  }
}
