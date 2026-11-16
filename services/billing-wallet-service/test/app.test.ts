import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { DomainError, FeatureFlags, StaticFlagSource, createLogger, loadConfig } from '@aegisvolt/shared';
import { buildApp } from '../src/app.js';
import { quote } from '../src/pricing.js';
import type { BillingRepository, Hold } from '../src/repository.js';

const silent = createLogger({
  service: 'billing-wallet-service',
  env: 'test',
  version: 't',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const config = loadConfig('billing-wallet-service', 0, { APP_ENV: 'test' });

function setup(flagValues: Record<string, boolean> = {}, overrides: Partial<BillingRepository> = {}) {
  const held: Hold = { sagaId: 's1', fleetId: 'F1', amount: 15000, status: 'HELD', createdAt: 'now' };
  const repo: BillingRepository = {
    getWallet: vi.fn(async (fleetId) => ({ fleetId, name: 'F', balance: 1000, currency: 'COP', version: 0 })),
    topUp: vi.fn(),
    getHold: vi.fn(async () => undefined),
    placeHold: vi.fn(async ({ amount }) => ({ hold: { ...held, amount }, alreadyApplied: false })),
    refundHold: vi.fn(async () => ({ outcome: 'REFUNDED' as const, hold: { ...held, status: 'REFUNDED' as const }, alreadyApplied: false })),
    ...overrides,
  };
  const flags = new FeatureFlags(new StaticFlagSource(flagValues), 0);
  return { app: buildApp({ config, logger: silent, repo, flags }), repo };
}

describe('pricing', () => {
  it('aplica la tarifa por potencia y el recargo x1.5 solo con la flag', () => {
    expect(quote(10, 22, false)).toMatchObject({ tier: 'AC', amount: 11000 });
    expect(quote(10, 50, false)).toMatchObject({ tier: 'DC_FAST', amount: 15000 });
    expect(quote(10, 150, false)).toMatchObject({ tier: 'ULTRA', amount: 21000 });
    expect(quote(10, 50, true)).toMatchObject({ surgeMultiplier: 1.5, amount: 22500 });
    expect(() => quote(0, 50, false)).toThrow(RangeError);
  });
});

describe('billing-wallet-service HTTP', () => {
  const holdBody = { sagaId: 's1', fleetId: 'F1', kwh: 10, powerKw: 50 };

  it('GET /quote refleja ENABLE_DYNAMIC_SURGE_PRICING', async () => {
    const off = setup({ ENABLE_DYNAMIC_SURGE_PRICING: false }).app;
    const on = setup({ ENABLE_DYNAMIC_SURGE_PRICING: true }).app;
    expect((await off.inject({ url: '/quote?kwh=10&powerKw=50' })).json().amount).toBe(15000);
    expect((await on.inject({ url: '/quote?kwh=10&powerKw=50' })).json().amount).toBe(22500);
  });

  it('POST /holds exige Idempotency-Key = <sagaId>:hold', async () => {
    const { app, repo } = setup();
    const missing = await app.inject({ method: 'POST', url: '/holds', payload: holdBody });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const wrong = await app.inject({ method: 'POST', url: '/holds', payload: holdBody, headers: { 'idempotency-key': 's1:refund' } });
    expect(wrong.json().error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
    expect(repo.placeHold).not.toHaveBeenCalled();
  });

  it('POST /holds retiene el monto con recargo y responde 201; un replay responde 200', async () => {
    const { app, repo } = setup({ ENABLE_DYNAMIC_SURGE_PRICING: true });
    const res = await app.inject({ method: 'POST', url: '/holds', payload: holdBody, headers: { 'idempotency-key': 's1:hold' } });
    expect(res.statusCode).toBe(201);
    expect(repo.placeHold).toHaveBeenCalledWith({ sagaId: 's1', fleetId: 'F1', amount: 22500 });

    vi.mocked(repo.placeHold).mockResolvedValueOnce({
      hold: { sagaId: 's1', fleetId: 'F1', amount: 22500, status: 'HELD', createdAt: 'now' },
      alreadyApplied: true,
    });
    const replay = await app.inject({ method: 'POST', url: '/holds', payload: holdBody, headers: { 'idempotency-key': 's1:hold' } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().alreadyApplied).toBe(true);
  });

  it('fondos insuficientes -> 402 INSUFFICIENT_FUNDS (el orquestador compensa sin reintentar)', async () => {
    const { app } = setup({}, {
      placeHold: vi.fn(async () => {
        throw new DomainError(402, 'INSUFFICIENT_FUNDS', 'sin saldo', { balance: 1000, required: 15000 });
      }),
    });
    const res = await app.inject({ method: 'POST', url: '/holds', payload: holdBody, headers: { 'idempotency-key': 's1:hold' } });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toMatchObject({ code: 'INSUFFICIENT_FUNDS', details: { balance: 1000, required: 15000 } });
  });

  it('POST /holds/:sagaId/refund exige la clave <sagaId>:refund y delega en el repositorio', async () => {
    const { app, repo } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/holds/s1/refund',
      payload: { fleetId: 'F1' },
      headers: { 'idempotency-key': 's1:refund' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'REFUNDED', alreadyApplied: false });
    expect(repo.refundHold).toHaveBeenCalledWith('F1', 's1');
  });

  it('valida el cuerpo (kwh negativo -> 400)', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/holds',
      payload: { ...holdBody, kwh: -1 },
      headers: { 'idempotency-key': 's1:hold' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});
