import { Alignment } from '../geometry/alignment'
import { Line } from '../geometry/primitives'
import { filletCorner } from '../geometry/fillet'
import { designSpeedForRadius } from '../geometry/designSpeed'
import { vec2, angleOf, distance, sub, type Vec2 } from '../geometry/vec2'

const RADIUS = 120
const SAMPLE_SPACING = 4

/** Straight, filleted corner, straight — the canonical alignment. */
const buildAlignment = (a: Vec2, corner: Vec2, b: Vec2): Alignment | null => {
  const dIn = sub(corner, a)
  const dOut = sub(b, corner)
  const fillet = filletCorner(corner, dIn, dOut, RADIUS)
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

export const drawAlignmentPreview = (canvas: HTMLCanvasElement): void => {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  ctx.clearRect(0, 0, w, h)

  const a = vec2(80, 80)
  const corner = vec2(w - 120, 90)
  const b = vec2(w - 140, h - 90)

  const alignment = buildAlignment(a, corner, b)
  if (!alignment) return

  // World y is north; canvas y grows downward. Flip at the draw boundary.
  const toScreen = (p: Vec2) => ({ x: p.x, y: h - p.y })

  // Construction lines through the corner.
  ctx.strokeStyle = '#3a4652'
  ctx.setLineDash([5, 6])
  ctx.lineWidth = 1
  ctx.beginPath()
  for (const [from, to] of [[a, corner], [corner, b]] as const) {
    const s = toScreen(from)
    const e = toScreen(to)
    ctx.moveTo(s.x, s.y)
    ctx.lineTo(e.x, e.y)
  }
  ctx.stroke()
  ctx.setLineDash([])

  // The alignment itself.
  const poses = alignment.sample(SAMPLE_SPACING)
  ctx.strokeStyle = '#d9c89a'
  ctx.lineWidth = 8
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  poses.forEach((pose, i) => {
    const p = toScreen(pose.position)
    if (i === 0) ctx.moveTo(p.x, p.y)
    else ctx.lineTo(p.x, p.y)
  })
  ctx.stroke()

  // Centre stripe.
  ctx.strokeStyle = '#14181d'
  ctx.lineWidth = 1
  ctx.setLineDash([10, 12])
  ctx.stroke()
  ctx.setLineDash([])

  // Readout.
  const speed = designSpeedForRadius(RADIUS)
  ctx.fillStyle = '#e8e4dc'
  ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.fillText(`R ${RADIUS} m`, 24, 28)
  ctx.fillText(`design speed ${speed.toFixed(0)} km/h`, 24, 48)
  ctx.fillText(`length ${alignment.length.toFixed(1)} m`, 24, 68)
}
