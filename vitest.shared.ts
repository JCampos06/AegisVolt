import { fileURLToPath } from 'node:url';

/** Las pruebas usan el código fuente de @aegisvolt/shared (no hace falta compilarlo antes). */
export const sharedAlias = [
  { find: /^@aegisvolt\/shared\/testing$/, replacement: fileURLToPath(new URL('./packages/shared/src/testing.ts', import.meta.url)) },
  { find: /^@aegisvolt\/shared$/, replacement: fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)) },
];
