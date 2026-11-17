import { defineConfig, devices } from '@playwright/test';

/**
 * E2E contra la UI real.
 *   CI (job e2e-tests):  docker compose -> http://localhost:8081
 *   kind:                E2E_BASE_URL=http://dev.aegisvolt.localhost:8080 E2E_ENV=dev
 *
 * Un solo worker: las pruebas comparten las tablas del ambiente y una de ellas
 * enciende la flag de falla simulada (afectaría a las demás en paralelo).
 */
export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8081',
    locale: 'es-CO',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
