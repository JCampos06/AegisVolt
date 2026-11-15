import { defineConfig } from 'vitest/config';
import { sharedAlias } from '../../vitest.shared.js';

// Pruebas de integración: DynamoDB real (Floci en AWS_ENDPOINT_URL, por defecto localhost:4566).
export default defineConfig({
  resolve: { alias: sharedAlias },
  test: { include: ['test/**/*.int.test.ts'], testTimeout: 20_000, hookTimeout: 30_000 },
});
