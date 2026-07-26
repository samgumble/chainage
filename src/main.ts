import { drawLongSection } from './debug/longSectionPreview'

const app = document.getElementById('app')

if (app) {
  const canvas = document.createElement('canvas')
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'
  app.appendChild(canvas)

  const render = () => drawLongSection(canvas)
  render()
  window.addEventListener('resize', render)
}
