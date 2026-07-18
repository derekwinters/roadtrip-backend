import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'threads',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          // Integration tests share one Postgres; run files serially to keep
          // event-cursor assertions deterministic.
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'scenario',
          include: ['test/scenario/**/*.test.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
})
