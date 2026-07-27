import { defineConfig } from 'vitest/config'

export default defineConfig({
  base: '/chainage/',
  resolve: {
    // Without this, `three/examples/jsm/postprocessing/*.js`'s own internal
    // `import ... from 'three'` can resolve to a second copy of the module
    // separate from this project's own `import * as THREE from 'three'` —
    // Vite's dev-time pre-bundling and the addon's deep import path don't
    // always agree on one instance. Three warns loudly when this happens
    // ("Multiple instances of Three.js being imported"), and depth-texture
    // interop between the two copies is exactly the kind of thing that would
    // fail silently instead.
    dedupe: ['three'],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
