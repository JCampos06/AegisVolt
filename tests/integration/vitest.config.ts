import { defineConfig } from 'vitest/config';
import { sharedAlias } from '../../vitest.shared.js';

// SAGA de punta a punta contra Floci (AWS_ENDPOINT_URL, por defecto localhost:4566).
export default defineConfig({
  resolve: { alias: sharedAlias },
  test: { include: ['*.int.test.ts'], testTimeout: 30_000, hookTimeout: 60_000 },
});
