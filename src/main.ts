import { drawAlignmentPreview } from './debug/alignmentPreview'

const app = document.getElementById('app')

if (app) {
  const canvas = document.createElement('canvas')
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'
  app.appendChild(canvas)

  const render = () => drawAlignmentPreview(canvas)
  render()
  window.addEventListener('resize', render)
}
