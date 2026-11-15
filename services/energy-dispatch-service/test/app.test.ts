import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { FeatureFlags, StaticFlagSource, createLogger, loadConfig } from '@aegisvolt/shared';
import { buildApp } from '../src/app.js';
import type { DispatchRepository, Session } from '../src/repository.js';
import { simulateTelemetry } from '../src/telemetry.js';

const silent = createLogger({
  service: 'energy-dispatch-service',
  env: 'test',
  version: 't',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const config = loadConfig('energy-dispatch-service', 0, { APP_ENV: 'test' });

function setup(flagValues: Record<string, boolean> = {}, existing?: Session) {
  const repo: DispatchRepository = {
    getSession: vi.fn(async () => existing),
    createSession: vi.fn(async (s) => ({ session: { ...s, startedAt: 'now' }, alreadyApplied: false })),
    stopSession: vi.fn(),
    writeTelemetry: vi.fn(async () => {}),
    getTelemetry: vi.fn(async () => []),
  };
  const flags = new FeatureFlags(new StaticFlagSource(flagValues), 0);
  return { app: buildApp({ config, logger: silent, repo, flags }), repo };
}

const body = { sagaId: 's1', stationId: 'BOG-01', connectorId: 'C1', fleetId: 'F1', kwh: 20, powerKw: 50 };
const activate = (app: ReturnType<typeof setup>['app']) =>
  app.inject({ method: 'POST', url: '/sessions', payload: body, headers: { 'idempotency-key': 's1:activate' } });

describe('telemetría simulada', () => {
  it('rampa de potencia, energía acumulada creciente y voltaje según AC/DC', () => {
    const points = simulateTelemetry(50, 20, new Date('2026-11-15T10:00:00Z'));
    expect(points).toHaveLength(5);
    expect(points[0]).toMatchObject({ ts: '2026-11-15T10:00:00.000Z', kw: 17.5, voltage: 400 });
    expect(points.map((p) => p.kwh)).toEqual([...points.map((p) => p.kwh)].sort((a, b) => a - b));
    expect(simulateTelemetry(22, 5, new Date())[0]!.voltage).toBe(230);
  });
});

describe('energy-dispatch-service HTTP', () => {
  it('activa la sesión, guarda telemetría y responde 201', async () => {
    const { app, repo } = setup({ SIMULATE_CHARGER_HARDWARE_FAULT: false });
    const res = await activate(app);
    expect(res.statusCode).toBe(201);
    expect(res.json().session.status).toBe('ACTIVE');
    expect(repo.writeTelemetry).toHaveBeenCalledOnce();
  });

  it('SIMULATE_CHARGER_HARDWARE_FAULT -> registra FAILED y responde 422 CHARGER_HARDWARE_FAULT', async () => {
    const { app, repo } = setup({ SIMULATE_CHARGER_HARDWARE_FAULT: true });
    const res = await activate(app);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('CHARGER_HARDWARE_FAULT');
    expect(repo.createSession).toHaveBeenCalledWith(expect.objectContaining({ status: 'FAILED' }));
    expect(repo.writeTelemetry).not.toHaveBeenCalled();
  });

  it('reintento de una saga que ya falló devuelve el mismo 422 aunque la flag se haya apagado', async () => {
    const failed: Session = { ...body, kwhTarget: 20, status: 'FAILED', startedAt: 'now' };
    const { app, repo } = setup({ SIMULATE_CHARGER_HARDWARE_FAULT: false }, failed);
    const res = await activate(app);
    expect(res.statusCode).toBe(422);
    expect(repo.createSession).not.toHaveBeenCalled();
  });

  it('reintento de una sesión activa responde 200 sin reactivar el cargador', async () => {
    const active: Session = { ...body, kwhTarget: 20, status: 'ACTIVE', startedAt: 'now' };
    const { app, repo } = setup({}, active);
    const res = await activate(app);
    expect(res.statusCode).toBe(200);
    expect(res.json().alreadyApplied).toBe(true);
    expect(repo.createSession).not.toHaveBeenCalled();
  });

  it('exige Idempotency-Key <sagaId>:activate', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/sessions', payload: body });
    expect(res.statusCode).toBe(400);
  });
});
