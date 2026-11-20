import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Setup loads the whole SDK; a busy machine can take longer than the
    // default, and a timed out setup skips the tests instead of failing.
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      // Tests run without the React Native runtime.
      'react-native': path.resolve(__dirname, 'test/rn-stub.ts'),
    },
  },
});
