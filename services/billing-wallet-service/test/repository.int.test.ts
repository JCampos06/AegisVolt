import { Writable } from 'node:stream';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FeatureFlags, StaticFlagSource, createLogger, loadConfig } from '@aegisvolt/shared';
import { createEphemeralTable, flociAvailable, type EphemeralTable } from '@aegisvolt/shared/testing';
import { buildApp } from '../src/app.js';
import { DynamoBillingRepository } from '../src/repository.js';

/**
 * Idempotencia probada contra DynamoDB (Floci): las garantías viven en las
 * ConditionExpression y transacciones, no en memoria del proceso.
 */
const up = await flociAvailable();

describe.skipIf(!up)('billing-wallet-service + DynamoDB (Floci)', () => {
  let t: EphemeralTable;
  let repo: DynamoBillingRepository;
  let fleetId: string;
  let n = 0;

  beforeAll(async () => {
    t = await createEphemeralTable('billing');
    repo = new DynamoBillingRepository(t.doc, t.tableName);
  });
  afterAll(async () => t?.drop());

  beforeEach(async () => {
    fleetId = `FLEET-${++n}`;
    await t.doc.send(
      new PutCommand({
        TableName: t.tableName,
        Item: { PK: `WALLET#${fleetId}`, SK: 'META', name: 'Flota test', balance: 100_000, currency: 'COP', version: 0 },
      }),
    );
  });

  const balance = async () => (await repo.getWallet(fleetId))!.balance;

  it('refund doble = un solo reembolso', async () => {
    await repo.placeHold({ sagaId: 'saga-a', fleetId, amount: 30_000 });
    expect(await balance()).toBe(70_000);

    const first = await repo.refundHold(fleetId, 'saga-a');
    const second = await repo.refundHold(fleetId, 'saga-a');

    expect(first).toMatchObject({ outcome: 'REFUNDED', alreadyApplied: false });
    expect(second).toMatchObject({ outcome: 'ALREADY_REFUNDED', alreadyApplied: true });
    expect(await balance()).toBe(100_000);
  });

  it('5 reembolsos concurrentes de la misma saga devuelven el dinero una sola vez', async () => {
    await repo.placeHold({ sagaId: 'saga-b', fleetId, amount: 40_000 });
    const results = await Promise.all(Array.from({ length: 5 }, () => repo.refundHold(fleetId, 'saga-b')));
    expect(results.filter((r) => r.outcome === 'REFUNDED')).toHaveLength(1);
    expect(await balance()).toBe(100_000);
  });

  it('retención repetida (reintento de la saga) descuenta una sola vez', async () => {
    const r1 = await repo.placeHold({ sagaId: 'saga-c', fleetId, amount: 25_000 });
    const r2 = await repo.placeHold({ sagaId: 'saga-c', fleetId, amount: 25_000 });
    expect(r1.alreadyApplied).toBe(false);
    expect(r2.alreadyApplied).toBe(true);
    expect(await balance()).toBe(75_000);

    // Carrera real: 5 intentos simultáneos de otra saga, ninguno ve el registro previo.
    const concurrent = await Promise.allSettled(
      Array.from({ length: 5 }, () => repo.placeHold({ sagaId: 'saga-c2', fleetId, amount: 25_000 })),
    );
    const applied = concurrent.filter((r) => r.status === 'fulfilled' && !r.value.alreadyApplied);
    expect(applied).toHaveLength(1);
    expect(await balance()).toBe(50_000);
  });

  it('fondos insuficientes -> 402 y no queda ninguna retención', async () => {
    await expect(repo.placeHold({ sagaId: 'saga-d', fleetId, amount: 999_999 })).rejects.toMatchObject({
      statusCode: 402,
      code: 'INSUFFICIENT_FUNDS',
    });
    expect(await repo.getHold(fleetId, 'saga-d')).toBeUndefined();
    expect(await balance()).toBe(100_000);
  });

  it('compensación antes que la retención: deja marca y la retención tardía se rechaza', async () => {
    const early = await repo.refundHold(fleetId, 'saga-e');
    expect(early.outcome).toBe('NOTHING_TO_REFUND');
    await expect(repo.placeHold({ sagaId: 'saga-e', fleetId, amount: 10_000 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'HOLD_ALREADY_COMPENSATED',
    });
    expect(await balance()).toBe(100_000);
  });

  it('vía HTTP: dos POST /refund con la misma Idempotency-Key -> saldo restaurado una vez', async () => {
    const logger = createLogger({
      service: 'billing-wallet-service',
      env: 'test',
      version: 'it',
      destination: new Writable({ write: (_c, _e, cb) => cb() }),
    });
    const app = buildApp({
      config: loadConfig('billing-wallet-service', 0, { APP_ENV: 'test' }),
      logger,
      repo,
      flags: new FeatureFlags(new StaticFlagSource({ ENABLE_DYNAMIC_SURGE_PRICING: false }), 0),
    });

    const hold = await app.inject({
      method: 'POST',
      url: '/holds',
      headers: { 'idempotency-key': 'saga-f:hold' },
      payload: { sagaId: 'saga-f', fleetId, kwh: 10, powerKw: 50 },
    });
    expect(hold.statusCode).toBe(201);
    expect(await balance()).toBe(85_000);

    const refund = () =>
      app.inject({
        method: 'POST',
        url: '/holds/saga-f/refund',
        headers: { 'idempotency-key': 'saga-f:refund' },
        payload: { fleetId },
      });
    expect((await refund()).json().outcome).toBe('REFUNDED');
    expect((await refund()).json().outcome).toBe('ALREADY_REFUNDED');
    expect(await balance()).toBe(100_000);
    await app.close();
  });
});
