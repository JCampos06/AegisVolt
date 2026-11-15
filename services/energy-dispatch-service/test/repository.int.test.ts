import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEphemeralTable, flociAvailable, type EphemeralTable } from '@aegisvolt/shared/testing';
import { DynamoDispatchRepository, type NewSession } from '../src/repository.js';
import { simulateTelemetry } from '../src/telemetry.js';

const up = await flociAvailable();

describe.skipIf(!up)('energy-dispatch-service + DynamoDB (Floci)', () => {
  let t: EphemeralTable;
  let repo: DynamoDispatchRepository;

  beforeAll(async () => {
    t = await createEphemeralTable('dispatch');
    repo = new DynamoDispatchRepository(t.doc, t.tableName);
  });
  afterAll(async () => t?.drop());

  const session = (sagaId: string, status: NewSession['status'] = 'ACTIVE'): NewSession => ({
    sagaId,
    stationId: 'BOG-01',
    connectorId: 'C1',
    fleetId: 'F1',
    powerKw: 50,
    kwhTarget: 20,
    status,
  });

  it('activaciones concurrentes de la misma saga crean una sola sesión', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => repo.createSession(session('saga-1'))));
    expect(results.filter((r) => !r.alreadyApplied)).toHaveLength(1);
    expect((await repo.getSession('saga-1'))?.status).toBe('ACTIVE');
  });

  it('un resultado FAILED queda registrado y el reintento no lo convierte en ACTIVE', async () => {
    await repo.createSession(session('saga-2', 'FAILED'));
    const retry = await repo.createSession(session('saga-2', 'ACTIVE'));
    expect(retry).toMatchObject({ alreadyApplied: true, session: { status: 'FAILED' } });
  });

  it('guarda y consulta la telemetría ordenada por tiempo', async () => {
    await repo.createSession(session('saga-3'));
    await repo.writeTelemetry('saga-3', simulateTelemetry(50, 20, new Date('2026-11-15T10:00:00Z')));
    const points = await repo.getTelemetry('saga-3');
    expect(points).toHaveLength(5);
    expect(points[0]!.ts < points[4]!.ts).toBe(true);
  });

  it('detener dos veces es idempotente; detener una sesión FAILED es conflicto', async () => {
    await repo.createSession(session('saga-4'));
    expect((await repo.stopSession('saga-4')).alreadyApplied).toBe(false);
    expect((await repo.stopSession('saga-4')).alreadyApplied).toBe(true);
    await expect(repo.stopSession('saga-2')).rejects.toMatchObject({ statusCode: 409 });
    await expect(repo.stopSession('no-existe')).rejects.toMatchObject({ statusCode: 404 });
  });
});
