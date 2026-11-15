import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { FeatureFlags, HttpError, StaticFlagSource, createLogger, loadConfig } from '@aegisvolt/shared';
import { buildGatewayApp } from '../src/app.js';
import type { GatewayQueries } from '../src/resolvers.js';
import { GatewayEvents } from '../src/events.js';
import { InMemorySagaStore } from '../src/saga/store.js';

const logger = createLogger({
  service: 'graphql-gateway',
  env: 'test',
  version: 't',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

async function setup(env: 'dev' | 'prod' = 'dev') {
  const clients = {
    stations: vi.fn(async () => [
      {
        stationId: 'BOG-01',
        name: 'Calle 80',
        city: 'Bogotá',
        lat: 4.69,
        lon: -74.08,
        connectors: [{ stationId: 'BOG-01', connectorId: 'C2', type: 'CCS2', powerKw: 150, status: 'AVAILABLE', reservable: false }],
      },
    ]),
    station: vi.fn(),
    wallet: vi.fn(async () => {
      throw new HttpError(404, 'WALLET_NOT_FOUND', 'no existe');
    }),
    topUp: vi.fn(),
    quote: vi.fn(),
    session: vi.fn(),
    telemetry: vi.fn(),
  } as unknown as GatewayQueries;
  const orchestrator = {
    start: vi.fn(async () => {
      throw new HttpError(409, 'CONNECTOR_UNAVAILABLE', 'ocupado');
    }),
    stopCharging: vi.fn(),
  };
  const flagWriter = { set: vi.fn(async (name: string, enabled: boolean) => ({ name, enabled })) };
  const flagWatcher = { notify: vi.fn() };
  const app = await buildGatewayApp({
    config: loadConfig('graphql-gateway', 0, { APP_ENV: env }),
    logger,
    env,
    clients,
    orchestrator,
    store: new InMemorySagaStore(),
    flags: new FeatureFlags(new StaticFlagSource({ ENABLE_FAST_CHARGE_BOOST: false }), 0),
    flagWriter,
    flagWatcher,
    events: new GatewayEvents(),
    adminToken: 'secreto-admin',
    websockets: false,
  });
  const gql = (query: string, variables?: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/graphql', payload: { query, variables }, headers: { 'content-type': 'application/json', ...headers } });
  return { app, gql, flagWriter, flagWatcher };
}

describe('graphql-gateway', () => {
  it('resuelve stations, environment y featureFlags', async () => {
    const { gql } = await setup();
    const res = await gql('{ environment stations { id connectors { id powerKw ultraFast reservable } } featureFlags { name enabled } }');
    expect(res.json()).toEqual({
      data: {
        environment: 'dev',
        stations: [{ id: 'BOG-01', connectors: [{ id: 'C2', powerKw: 150, ultraFast: true, reservable: false }] }],
        featureFlags: [{ name: 'ENABLE_FAST_CHARGE_BOOST', enabled: false }],
      },
    });
  });

  it('un 404 del servicio se devuelve como null; los errores de negocio llevan su código', async () => {
    const { gql } = await setup();
    expect((await gql('{ wallet(fleetId: "NOPE") { balance } }')).json()).toEqual({ data: { wallet: null } });

    const res = await gql(
      'mutation { startChargingSession(input: { fleetId: "F1", stationId: "BOG-01", connectorId: "C1", kwh: 10 }) { status } }',
    );
    expect(res.json().errors[0].extensions).toMatchObject({ code: 'CONNECTOR_UNAVAILABLE', httpStatus: 409 });
  });

  it('setFeatureFlag en dev funciona y notifica a los suscriptores', async () => {
    const { gql, flagWriter, flagWatcher } = await setup('dev');
    const res = await gql('mutation { setFeatureFlag(name: "ENABLE_DYNAMIC_SURGE_PRICING", enabled: false) { name enabled } }');
    expect(res.json().data.setFeatureFlag).toEqual({ name: 'ENABLE_DYNAMIC_SURGE_PRICING', enabled: false });
    expect(flagWriter.set).toHaveBeenCalledWith('ENABLE_DYNAMIC_SURGE_PRICING', false, 'graphql-gateway');
    expect(flagWatcher.notify).toHaveBeenCalledOnce();
  });

  it('setFeatureFlag en prod exige x-admin-token válido', async () => {
    const { gql, flagWriter } = await setup('prod');
    const m = 'mutation { setFeatureFlag(name: "SIMULATE_CHARGER_HARDWARE_FAULT", enabled: true) { enabled } }';
    expect((await gql(m)).json().errors[0].extensions.code).toBe('FORBIDDEN');
    expect((await gql(m, undefined, { 'x-admin-token': 'otro' })).json().errors[0].extensions.code).toBe('FORBIDDEN');
    expect(flagWriter.set).not.toHaveBeenCalled();
    expect((await gql(m, undefined, { 'x-admin-token': 'secreto-admin' })).json().data.setFeatureFlag.enabled).toBe(true);
  });

  it('devuelve el x-correlation-id y conserva /health', async () => {
    const { app, gql } = await setup();
    const res = await gql('{ environment }', undefined, { 'x-correlation-id': 'corr-gql-0001' });
    expect(res.headers['x-correlation-id']).toBe('corr-gql-0001');
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
  });
});
