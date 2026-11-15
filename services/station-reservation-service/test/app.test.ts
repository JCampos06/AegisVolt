import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { FeatureFlags, StaticFlagSource, createLogger, loadConfig } from '@aegisvolt/shared';
import { buildApp } from '../src/app.js';
import type { Connector, ReservationRepository } from '../src/repository.js';

const silent = createLogger({
  service: 'station-reservation-service',
  env: 'test',
  version: 't',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const config = loadConfig('station-reservation-service', 0, { APP_ENV: 'test' });

const c50: Connector = { stationId: 'BOG-01', connectorId: 'C1', type: 'CCS2', powerKw: 50, status: 'AVAILABLE', version: 0 };
const c150: Connector = { ...c50, connectorId: 'C2', powerKw: 150, status: 'RESERVED' };

function setup(flagValues: Record<string, boolean> = {}) {
  const repo: ReservationRepository = {
    listStations: vi.fn(async () => [
      { stationId: 'BOG-01', name: 'Calle 80', city: 'Bogotá', lat: 0, lon: 0, connectors: [c50, c150] },
    ]),
    getStation: vi.fn(async () => undefined),
    getConnector: vi.fn(),
    getReservation: vi.fn(),
    // Simula el repositorio real: ejecuta el guard con el conector pedido.
    reserve: vi.fn(async (input, guard) => {
      const connector = input.connectorId === 'C2' ? c150 : c50;
      await guard?.(connector);
      return { reservation: { ...input, powerKw: connector.powerKw, status: 'RESERVED' as const, createdAt: 'now' }, alreadyApplied: false };
    }),
    release: vi.fn(),
  };
  const flags = new FeatureFlags(new StaticFlagSource(flagValues), 0);
  return { app: buildApp({ config, logger: silent, repo, flags }), repo };
}

const body = (connectorId: string) => ({ sagaId: 's1', stationId: 'BOG-01', connectorId, fleetId: 'F1' });

describe('station-reservation-service HTTP', () => {
  it('GET /stations filtra por estado y marca los conectores ultra-rápidos', async () => {
    const { app } = setup({ ENABLE_FAST_CHARGE_BOOST: false });
    const all = (await app.inject({ url: '/stations' })).json();
    expect(all[0].connectors.map((c: { connectorId: string; reservable: boolean }) => [c.connectorId, c.reservable])).toEqual([
      ['C1', true],
      ['C2', false],
    ]);
    const available = (await app.inject({ url: '/stations?status=AVAILABLE' })).json();
    expect(available[0].connectors).toHaveLength(1);
    expect((await app.inject({ url: '/stations?status=BROKEN' })).statusCode).toBe(400);
  });

  it('conector >= 150 kW sin ENABLE_FAST_CHARGE_BOOST -> 403 FAST_CHARGE_DISABLED', async () => {
    const { app } = setup({ ENABLE_FAST_CHARGE_BOOST: false });
    const res = await app.inject({
      method: 'POST',
      url: '/reservations',
      payload: body('C2'),
      headers: { 'idempotency-key': 's1:reserve' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FAST_CHARGE_DISABLED');
  });

  it('con ENABLE_FAST_CHARGE_BOOST el conector ultra-rápido se puede reservar', async () => {
    const { app } = setup({ ENABLE_FAST_CHARGE_BOOST: true });
    const res = await app.inject({
      method: 'POST',
      url: '/reservations',
      payload: body('C2'),
      headers: { 'idempotency-key': 's1:reserve' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().reservation).toMatchObject({ connectorId: 'C2', status: 'RESERVED' });
  });

  it('exige Idempotency-Key en reserva y liberación', async () => {
    const { app, repo } = setup();
    expect((await app.inject({ method: 'POST', url: '/reservations', payload: body('C1') })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/reservations/s1/release' })).statusCode).toBe(400);
    expect(repo.reserve).not.toHaveBeenCalled();
    expect(repo.release).not.toHaveBeenCalled();
  });
});
