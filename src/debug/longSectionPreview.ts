import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { filletCorner } from '../geometry/fillet'
import { vec2, angleOf, sub, distance, type Vec2 } from '../geometry/vec2'
import { generateValley } from '../terrain/generate'
import { sampleGroundProfile } from '../terrain/groundProfile'
import { solveGradeProfile } from '../terrain/gradeSolver'
import { computeEarthworks } from '../terrain/volumes'
import type { CorridorTemplate } from '../terrain/corridor'

const SAMPLE_SPACING = 10
const MAX_GRADE = 0.07
const CURVE_RADIUS = 300

const TEMPLATE: CorridorTemplate = {
  formationHalfWidth: 5,
  cutSlope: 2,
  fillSlope: 3,
}

/** Straight, filleted corner, straight — across the valley. */
const buildAlignment = (a: Vec2, corner: Vec2, b: Vec2): Alignment | null => {
  const dIn = sub(corner, a)
  const dOut = sub(b, corner)
  const fillet = filletCorner(corner, dIn, dOut, CURVE_RADIUS)
  if (!fillet) return null

  const inLength = distance(a, fillet.tangentIn)
  const outLength = distance(fillet.tangentOut, b)
  if (inLength <= 0 || outLength <= 0) return null

  return new Alignment([
    new Line(a, angleOf(dIn), inLength),
    fillet.arc,
    new Line(fillet.tangentOut, angleOf(dOut), outLength),
  ])
}

export const drawLongSection = (canvas: HTMLCanvasElement): void => {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const terrain = generateValley({
    cols: 129, rows: 129, cellSize: 20,
    floorElevation: 100, ridgeHeight: 70, valleyHalfWidth: 400, seed: 7,
  })

  // A road climbing from the valley floor up over the northern ridge.
  const alignment = buildAlignment(
    vec2(200, 1280), vec2(1400, 1280), vec2(2200, 2200),
  )
  if (!alignment) return

  const ground = sampleGroundProfile(alignment, terrain, SAMPLE_SPACING)
  if (ground.length < 2) return

  const solution = solveGradeProfile(ground, {
    maxGrade: MAX_GRADE, maxCutDepth: 15, maxFillHeight: 12,
  })

  const pad = { left: 70, right: 30, top: 60, bottom: 50 }
  const plotW = w - pad.left - pad.right
  const plotH = h - pad.top - pad.bottom

  const design = solution.feasible ? solution.profile : []
  const allZ = [...ground.map((p) => p.z), ...design.map((p) => p.z)]
  const minZ = Math.min(...allZ) - 5
  const maxZ = Math.max(...allZ) + 5
  const totalS = ground[ground.length - 1]!.s

  const sx = (s: number) => pad.left + (s / totalS) * plotW
  const sy = (z: number) => pad.top + plotH - ((z - minZ) / (maxZ - minZ)) * plotH

  const pathThrough = (points: readonly { s: number; z: number }[]) => {
    ctx.beginPath()
    points.forEach((p, i) => {
      const x = sx(p.s)
      const y = sy(p.z)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
  }

  // Elevation grid.
  ctx.strokeStyle = '#232a33'
  ctx.fillStyle = '#5d6b7a'
  ctx.lineWidth = 1
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
  const zStep = 10
  for (let z = Math.ceil(minZ / zStep) * zStep; z < maxZ; z += zStep) {
    const y = sy(z)
    ctx.beginPath()
    ctx.moveTo(pad.left, y)
    ctx.lineTo(pad.left + plotW, y)
    ctx.stroke()
    ctx.fillText(`${z.toFixed(0)}m`, 20, y + 4)
  }

  if (design.length === ground.length) {
    // Cut and fill bands between the two lines, coloured by which dominates.
    for (let i = 1; i < ground.length; i++) {
      const g0 = ground[i - 1]!
      const g1 = ground[i]!
      const d0 = design[i - 1]!
      const d1 = design[i]!
      const isCut = (g0.z + g1.z) / 2 > (d0.z + d1.z) / 2

      ctx.beginPath()
      ctx.moveTo(sx(g0.s), sy(g0.z))
      ctx.lineTo(sx(g1.s), sy(g1.z))
      ctx.lineTo(sx(d1.s), sy(d1.z))
      ctx.lineTo(sx(d0.s), sy(d0.z))
      ctx.closePath()
      ctx.fillStyle = isCut ? 'rgba(216, 122, 84, 0.35)' : 'rgba(108, 160, 132, 0.35)'
      ctx.fill()
    }
  }

  // Natural ground.
  pathThrough(ground)
  ctx.strokeStyle = '#7d6b58'
  ctx.lineWidth = 2
  ctx.stroke()

  // Design line.
  if (design.length > 0) {
    pathThrough(design)
    ctx.strokeStyle = '#d9c89a'
    ctx.lineWidth = 3
    ctx.stroke()
  }

  // Readout.
  ctx.fillStyle = '#e8e4dc'
  ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace'

  if (!solution.feasible) {
    ctx.fillStyle = '#d87a54'
    ctx.fillText(
      `INFEASIBLE at station ${solution.failedAtStation.toFixed(0)}m ` +
      `— cannot hold ${(MAX_GRADE * 100).toFixed(0)}% grade`,
      pad.left, 30,
    )
    return
  }

  const quantities = computeEarthworks(alignment, terrain, design, TEMPLATE)

  let steepest = 0
  for (let i = 1; i < design.length; i++) {
    const g = Math.abs(
      (design[i]!.z - design[i - 1]!.z) / (design[i]!.s - design[i - 1]!.s),
    )
    if (g > steepest) steepest = g
  }

  ctx.fillText(
    `length ${totalS.toFixed(0)}m   ` +
    `max grade ${(steepest * 100).toFixed(2)}% (limit ${(MAX_GRADE * 100).toFixed(0)}%)`,
    pad.left, 26,
  )
  ctx.fillText(
    `cut ${Math.round(quantities.cutVolume).toLocaleString()} m³   ` +
    `fill ${Math.round(quantities.fillVolume).toLocaleString()} m³   ` +
    `net ${quantities.netVolume >= 0 ? '+' : ''}${Math.round(quantities.netVolume).toLocaleString()} m³` +
    `${quantities.netVolume >= 0 ? ' surplus' : ' import'}`,
    pad.left, 46,
  )

  // A truncated section reached the integration safety cap without daylighting,
  // so its quantities are an under-estimate. Say so rather than presenting the
  // number as fact — a silent under-report is the exact failure this flag exists
  // to prevent, and it would otherwise flow straight into cost and duration.
  if (quantities.truncatedStations > 0) {
    ctx.fillStyle = '#d87a54'
    ctx.fillText(
      `⚠ ${quantities.truncatedStations} of ${quantities.stations.length} sections truncated ` +
      `— quantities are an under-estimate`,
      pad.left, 66,
    )
  }

  ctx.fillStyle = '#5d6b7a'
  ctx.fillText('natural ground ——   design line ——   cut ▨   fill ▨', pad.left, h - 18)
}
