import { defineConfig } from 'vitest/config';
import { sharedAlias } from '../../vitest.shared.js';

// Pruebas unitarias: sin red ni DynamoDB (repositorio simulado).
export default defineConfig({
  resolve: { alias: sharedAlias },
  test: { include: ['test/**/*.test.ts'], exclude: ['test/**/*.int.test.ts'] },
});
