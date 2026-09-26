import { defineConfig } from 'vitest/config'

export default defineConfig({
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    testTimeout: 15_000,
    restoreMocks: true,
  },
})
