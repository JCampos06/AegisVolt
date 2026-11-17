import { expect, test, type Page } from '@playwright/test';

/**
 * Recorre la UI como un operador: las 3 rutas de la SAGA (éxito, fondos
 * insuficientes y falla de hardware con compensación) más las vistas de
 * estaciones, flags e historial.
 */
const ENV = process.env.E2E_ENV ?? 'dev';
const FAULT = 'SIMULATE_CHARGER_HARDWARE_FAULT';

/** GraphQL desde el navegador (mismo origen que la UI; sirve también para *.localhost en Windows). */
async function gql<T = unknown>(page: Page, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(
    async ([q, v]) => {
      const res = await fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q, variables: v }) });
      const json = await res.json();
      if (json.errors) throw new Error(JSON.stringify(json.errors));
      return json.data;
    },
    [query, variables] as const,
  ) as Promise<T>;
}

const setFault = (page: Page, enabled: boolean) =>
  gql(page, 'mutation($n: String!, $e: Boolean!) { setFeatureFlag(name: $n, enabled: $e) { enabled } }', { n: FAULT, e: enabled });

async function startCharge(page: Page, fleet: string, station: string) {
  await page.goto('/#cargar');
  await page.getByLabel('Flota').selectOption(fleet);
  await page.getByLabel('Estación').selectOption(station);
  await expect(page.getByRole('button', { name: /^C\d/, pressed: true })).toBeVisible();
  await page.getByLabel('Energía a cargar (kWh)').fill('10');
  await expect(page.getByTestId('quote')).toContainText('COP');
  await page.getByRole('button', { name: 'Iniciar carga' }).click();
  const id = (await page.locator('code[id^="cid-ui-"]').first().textContent())?.trim();
  expect(id).toMatch(/^ui-[0-9a-f]{8}$/);
  return id!;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('env-band')).toHaveText(new RegExp(`Estás en ${ENV}`));
});

test('la franja muestra el ambiente y las estaciones listan sus conectores', async ({ page }) => {
  await expect(page.getByTestId('env-band')).toHaveAttribute('data-env', ENV);
  await expect(page.getByRole('heading', { name: 'Estaciones', level: 1 })).toBeVisible();
  for (const st of ['BOG-01', 'BOG-02', 'MDE-01']) {
    await expect(page.getByTestId(`station-${st}`)).toBeVisible();
  }
  await expect(page.getByTestId('connector-BOG-01-C1')).toBeVisible();
});

test('carga exitosa: la saga completa los 3 pasos y luego se detiene', async ({ page }) => {
  const id = await startCharge(page, 'FLEET-NORTE-EV', 'BOG-01');

  await expect(page.getByTestId('saga-status')).toHaveAttribute('data-status', 'COMPLETED');
  for (const i of [0, 1, 2]) await expect(page.getByTestId(`switch-${i}`)).toHaveAttribute('data-state', 'closed');
  await expect(page.getByTestId('saga-log')).toContainText('Activar cargador');

  await page.getByRole('button', { name: 'Detener carga' }).click();
  await expect(page.getByText('Carga detenida. El conector quedó libre.')).toBeVisible();

  await page.getByRole('link', { name: 'Ver en el historial' }).click();
  const row = page.getByTestId(`saga-row-${id}`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId('saga-status')).toHaveAttribute('data-status', 'COMPLETED');
});

test('fondos insuficientes: falla el paso de saldo y se libera el conector', async ({ page }) => {
  await startCharge(page, 'FLEET-LOWFUNDS', 'BOG-02');

  await expect(page.getByTestId('saga-status')).toHaveAttribute('data-status', 'COMPENSATED');
  await expect(page.getByTestId('switch-1')).toHaveAttribute('data-state', 'fault');
  await expect(page.getByTestId('switch-0')).toHaveAttribute('data-state', 'undone');
  await expect(page.getByRole('alert')).toContainText('Saldo insuficiente en FLEET-LOWFUNDS');
});

test.describe('falla de hardware simulada', () => {
  test.skip(ENV === 'prod', 'En prod las flags no se cambian desde la UI');
  test.afterEach(async ({ page }) => {
    await setFault(page, false);
  });

  test('la flag se activa desde la UI y la saga compensa: devuelve saldo y libera conector', async ({ page }) => {
    await page.goto('/#flags');
    const toggle = page.getByRole('switch', { name: 'Simular falla de cargador' });
    if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('status').filter({ hasText: 'Simular falla de cargador activada' })).toBeVisible();
    // Los servicios cachean las flags 5 s.
    await page.waitForTimeout(6_000);

    await startCharge(page, 'FLEET-ANDES-EV', 'MDE-01');
    await expect(page.getByTestId('saga-status')).toHaveAttribute('data-status', 'COMPENSATED');
    await expect(page.getByTestId('switch-2')).toHaveAttribute('data-state', 'fault');
    await expect(page.getByTestId('switch-1')).toHaveAttribute('data-state', 'undone');
    await expect(page.getByTestId('switch-0')).toHaveAttribute('data-state', 'undone');
    await expect(page.getByTestId('saga-log')).toContainText('Devolver saldo');
    await expect(page.getByTestId('saga-log')).toContainText('Liberar conector');
    await expect(page.getByRole('alert')).toContainText('falla de hardware');
  });
});
