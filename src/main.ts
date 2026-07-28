import { drawRoadScene } from './debug/roadScene'

const app = document.getElementById('app')

if (app) {
  const canvas = document.createElement('canvas')
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'
  // The scene handles every pointer gesture over the canvas itself — orbit,
  // pan and zoom under a mouse, and tap, drag and two-finger pan/pinch/twist
  // under a finger (see `roadScene.ts`'s touch block). `touch-action: none`
  // is what stops the browser claiming those same touches first: without it
  // a one-finger drag scrolls the document instead of panning the camera, a
  // two-finger drag pinch-zooms the PAGE instead of the scene, and a second
  // tap within the double-tap window zooms rather than closing a polyline.
  // None of it affects a mouse, so desktop is untouched.
  canvas.style.touchAction = 'none'
  app.appendChild(canvas)
  drawRoadScene(canvas)
}
