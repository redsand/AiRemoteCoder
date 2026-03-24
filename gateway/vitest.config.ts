import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    hookTimeout: 30000,
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/', 'dist/'],
    coverage: {
      reporter: ['text', 'html'],
      exclude: ['node_modules/', 'dist/']
    }
  }
});
