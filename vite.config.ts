import { defineConfig } from 'vitest/config'

export default defineConfig({
  base: '/chainage/',
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
