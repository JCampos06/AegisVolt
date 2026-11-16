import { Writable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createClient } from 'graphql-ws';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DynamoFlagSource, FeatureFlags, createLogger, loadConfig } from '@aegisvolt/shared';
import { createEphemeralTable, flociAvailable, type EphemeralTable } from '@aegisvolt/shared/testing';
import { buildApp as buildReservation } from '../../services/station-reservation-service/src/app.js';
import { DynamoReservationRepository } from '../../services/station-reservation-service/src/repository.js';
import { buildApp as buildBilling } from '../../services/billing-wallet-service/src/app.js';
import { DynamoBillingRepository } from '../../services/billing-wallet-service/src/repository.js';
import { buildApp as buildDispatch } from '../../services/energy-dispatch-service/src/app.js';
import { DynamoDispatchRepository } from '../../services/energy-dispatch-service/src/repository.js';
import { buildGatewayApp } from '../../services/graphql-gateway/src/app.js';
import { ServiceClients } from '../../services/graphql-gateway/src/clients.js';
import { GatewayEvents } from '../../services/graphql-gateway/src/events.js';
import { DynamoFlagWriter, FlagWatcher } from '../../services/graphql-gateway/src/flags-admin.js';
import { SagaOrchestrator } from '../../services/graphql-gateway/src/saga/orchestrator.js';
import { DynamoSagaStore } from '../../services/graphql-gateway/src/saga/store.js';

/**
 * SAGA de punta a punta: gateway GraphQL + 3 microservicios reales (HTTP en
 * puertos efímeros) + DynamoDB real (Floci) con tablas temporales.
 * Cubre las 3 rutas exigidas: éxito, fondos insuficientes y fallo físico.
 */
const up = await flociAvailable();
const silent = () =>
  createLogger({ service: 'it', env: 'test', version: 'it', destination: new Writable({ write: (_c, _e, cb) => cb() }) });

const SAGA_FIELDS = 'correlationId status amount surgeMultiplier failure { step code } steps { step action outcome }';

describe.skipIf(!up)('SAGA Reservar y Activar Carga (gateway + servicios + Floci)', () => {
  const t: Record<'reservations' | 'billing' | 'dispatch' | 'sagas' | 'flags', EphemeralTable> = {} as never;
  const apps: { close(): Promise<unknown> }[] = [];
  let gatewayUrl = '';

  const config = (service: string) => loadConfig(service, 0, { APP_ENV: 'test' });
  const listen = async (app: Awaited<ReturnType<typeof buildGatewayApp>>) => {
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  };
  const put = (table: EphemeralTable, Item: Record<string, unknown>) =>
    table.doc.send(new PutCommand({ TableName: table.tableName, Item }));
  const get = async (table: EphemeralTable, PK: string, SK: string) =>
    (await table.doc.send(new GetCommand({ TableName: table.tableName, Key: { PK, SK } }))).Item;

  const gql = async (query: string, variables?: Record<string, unknown>) => {
    const res = await fetch(`${gatewayUrl}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    return (await res.json()) as { data?: Record<string, any>; errors?: { extensions?: Record<string, unknown> }[] };
  };
  const start = (fleetId: string, connectorId: string, correlationId?: string) =>
    gql(
      `mutation($i: StartChargingInput!) { startChargingSession(input: $i) { ${SAGA_FIELDS} } }`,
      { i: { fleetId, stationId: 'ST-1', connectorId, kwh: 10, ...(correlationId ? { correlationId } : {}) } },
    ).then((r) => r.data!.startChargingSession);
  const balance = async (fleetId: string) => Number((await get(t.billing, `WALLET#${fleetId}`, 'META'))!.balance);
  const connector = async (id: string) => (await get(t.reservations, 'STATION#ST-1', `CONNECTOR#${id}`))!;

  beforeAll(async () => {
    for (const name of ['reservations', 'billing', 'dispatch', 'flags'] as const) t[name] = await createEphemeralTable(name);
    t.sagas = await createEphemeralTable('sagas', { statusIndex: true });

    // Datos semilla (equivalentes a infra/modules/dynamodb/seed.tf)
    await put(t.reservations, { PK: 'STATION#ST-1', SK: 'META', name: 'Estación IT', city: 'Bogotá', lat: 4.6, lon: -74.1 });
    for (const c of ['C1', 'C2', 'C3']) {
      await put(t.reservations, { PK: 'STATION#ST-1', SK: `CONNECTOR#${c}`, type: 'CCS2', power_kw: 50, status: 'AVAILABLE', version: 0 });
    }
    await put(t.billing, { PK: 'WALLET#FLEET-OK', SK: 'META', name: 'Flota OK', balance: 500_000, currency: 'COP', version: 0 });
    await put(t.billing, { PK: 'WALLET#FLEET-LOW', SK: 'META', name: 'Flota sin saldo', balance: 1_000, currency: 'COP', version: 0 });
    for (const [name, enabled] of [
      ['ENABLE_DYNAMIC_SURGE_PRICING', true],
      ['ENABLE_FAST_CHARGE_BOOST', false],
      ['SIMULATE_CHARGER_HARDWARE_FAULT', false],
    ] as const) {
      await put(t.flags, { PK: `FLAG#${name}`, SK: 'META', name, enabled });
    }

    // TTL 0: los servicios leen la flag en cada request (en producción es 5 s).
    const flagsFor = () => new FeatureFlags(new DynamoFlagSource(t.flags.doc, t.flags.tableName), 0);
    const reservation = await listen(
      buildReservation({ config: config('station-reservation-service'), logger: silent(), flags: flagsFor(), repo: new DynamoReservationRepository(t.reservations.doc, t.reservations.tableName) }),
    );
    const billing = await listen(
      buildBilling({ config: config('billing-wallet-service'), logger: silent(), flags: flagsFor(), repo: new DynamoBillingRepository(t.billing.doc, t.billing.tableName) }),
    );
    const dispatch = await listen(
      buildDispatch({ config: config('energy-dispatch-service'), logger: silent(), flags: flagsFor(), repo: new DynamoDispatchRepository(t.dispatch.doc, t.dispatch.tableName) }),
    );

    const clients = new ServiceClients({ reservation, billing, dispatch });
    const events = new GatewayEvents();
    const store = new DynamoSagaStore(t.sagas.doc, t.sagas.tableName);
    const flags = flagsFor();
    const logger = silent();
    gatewayUrl = await listen(
      await buildGatewayApp({
        config: config('graphql-gateway'),
        logger,
        env: 'test',
        clients,
        orchestrator: new SagaOrchestrator({ store, participants: clients, events, logger, env: 'test' }),
        store,
        flags,
        flagWriter: new DynamoFlagWriter(t.flags.doc, t.flags.tableName),
        flagWatcher: new FlagWatcher(flags, events, logger),
        events,
      }),
    );
  });

  afterAll(async () => {
    for (const app of apps.reverse()) await app.close();
    await Promise.all(Object.values(t).map((table) => table?.drop()));
  });

  it('ruta 1 — éxito: COMPLETED, saldo retenido con recargo y conector RESERVED', async () => {
    const saga = await start('FLEET-OK', 'C1');
    expect(saga).toMatchObject({ status: 'COMPLETED', amount: 22_500, surgeMultiplier: 1.5 });
    expect(await balance('FLEET-OK')).toBe(477_500);
    expect(await connector('C1')).toMatchObject({ status: 'RESERVED', sagaId: saga.correlationId });

    const stopped = await gql(`mutation { stopChargingSession(sessionId: "${saga.correlationId}") { status } }`);
    expect(stopped.data!.stopChargingSession.status).toBe('STOPPED');
    expect((await connector('C1')).status).toBe('AVAILABLE');
  });

  it('ruta 2 — fondos insuficientes: hold 402 -> release -> COMPENSATED, sin cobro', async () => {
    const saga = await start('FLEET-LOW', 'C2');
    expect(saga.status).toBe('COMPENSATED');
    expect(saga.failure).toEqual({ step: 'hold', code: 'INSUFFICIENT_FUNDS' });
    expect(await balance('FLEET-LOW')).toBe(1_000);
    expect((await connector('C2')).status).toBe('AVAILABLE');
    expect(await get(t.billing, 'WALLET#FLEET-LOW', `TX#${saga.correlationId}`)).toBeUndefined();
  });

  it('ruta 3 — fallo físico (flag en caliente vía GraphQL): refund -> release -> COMPENSATED', async () => {
    await gql('mutation { setFeatureFlag(name: "SIMULATE_CHARGER_HARDWARE_FAULT", enabled: true) { enabled } }');
    try {
      const before = await balance('FLEET-OK');
      const saga = await start('FLEET-OK', 'C3');
      expect(saga.status).toBe('COMPENSATED');
      expect(saga.failure).toEqual({ step: 'activate', code: 'CHARGER_HARDWARE_FAULT' });
      expect(saga.steps.filter((s: { outcome: string }) => s.outcome !== 'STARTED').map((s: { step: string }) => s.step)).toEqual([
        'reserve',
        'hold',
        'activate',
        'refund',
        'release',
      ]);
      expect(await balance('FLEET-OK')).toBe(before);
      expect((await get(t.billing, 'WALLET#FLEET-OK', `TX#${saga.correlationId}`))!.status).toBe('REFUNDED');
      expect((await connector('C3')).status).toBe('AVAILABLE');

      const listed = await gql('{ sagas(status: COMPENSATED) { correlationId } }');
      expect(listed.data!.sagas.map((s: { correlationId: string }) => s.correlationId)).toContain(saga.correlationId);
    } finally {
      await gql('mutation { setFeatureFlag(name: "SIMULATE_CHARGER_HARDWARE_FAULT", enabled: false) { enabled } }');
    }
  });

  it('reenviar la mutation con el mismo correlationId no crea otra saga ni cobra dos veces', async () => {
    const id = 'it-idempotent-0001';
    const before = await balance('FLEET-OK');
    const first = await start('FLEET-OK', 'C2', id);
    const second = await start('FLEET-OK', 'C2', id);
    expect(first.status).toBe('COMPLETED');
    expect(second.status).toBe('COMPLETED');
    expect(await balance('FLEET-OK')).toBe(before - 22_500);
    await gql(`mutation { stopChargingSession(sessionId: "${id}") { status } }`);
  });

  it('subscription sagaUpdated (WebSocket) emite cada transición de la saga', async () => {
    const id = 'it-subscription-0001';
    const client = createClient({ url: gatewayUrl.replace('http', 'ws') + '/graphql', webSocketImpl: WebSocket, lazy: false });
    const statuses: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      client.subscribe(
        { query: `subscription { sagaUpdated(correlationId: "${id}") { status } }` },
        {
          next: (msg) => {
            const status = (msg.data as { sagaUpdated: { status: string } }).sagaUpdated.status;
            if (statuses.at(-1) !== status) statuses.push(status);
            if (status === 'COMPLETED') resolve();
          },
          error: reject,
          complete: () => resolve(),
        },
      );
    });
    await new Promise((r) => setTimeout(r, 300)); // da tiempo a registrar la suscripción
    await start('FLEET-OK', 'C1', id);
    await done;
    await client.dispose();
    expect(statuses).toEqual(['PENDING', 'RESERVED', 'CHARGED', 'COMPLETED']);
    await gql(`mutation { stopChargingSession(sessionId: "${id}") { status } }`);
  });
});
