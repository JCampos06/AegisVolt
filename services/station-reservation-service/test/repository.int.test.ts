import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEphemeralTable, flociAvailable, type EphemeralTable } from '@aegisvolt/shared/testing';
import { DynamoReservationRepository } from '../src/repository.js';

const up = await flociAvailable();

describe.skipIf(!up)('station-reservation-service + DynamoDB (Floci)', () => {
  let t: EphemeralTable;
  let repo: DynamoReservationRepository;
  let stationId: string;
  let n = 0;

  beforeAll(async () => {
    t = await createEphemeralTable('reservations');
    repo = new DynamoReservationRepository(t.doc, t.tableName);
  });
  afterAll(async () => t?.drop());

  beforeEach(async () => {
    stationId = `ST-${++n}`;
    const put = (Item: Record<string, unknown>) => t.doc.send(new PutCommand({ TableName: t.tableName, Item }));
    await put({ PK: `STATION#${stationId}`, SK: 'META', name: 'Estación test', city: 'Bogotá', lat: 4.6, lon: -74.1 });
    await put({ PK: `STATION#${stationId}`, SK: 'CONNECTOR#C1', type: 'CCS2', power_kw: 50, status: 'AVAILABLE', version: 0 });
  });

  const reserveInput = (sagaId: string) => ({ sagaId, stationId, connectorId: 'C1', fleetId: 'F1' });
  const connector = async () => (await repo.getConnector(stationId, 'C1'))!;

  it('reserva y la repite (mismo sagaId): un solo bloqueo, el reintento es idempotente', async () => {
    const r1 = await repo.reserve(reserveInput('saga-1'));
    const r2 = await repo.reserve(reserveInput('saga-1'));
    expect(r1.alreadyApplied).toBe(false);
    expect(r2.alreadyApplied).toBe(true);
    expect(await connector()).toMatchObject({ status: 'RESERVED', sagaId: 'saga-1', version: 1 });
  });

  it('dos sagas compiten por el mismo conector: solo una gana, la otra recibe 409', async () => {
    const results = await Promise.allSettled([
      repo.reserve(reserveInput('saga-a')),
      repo.reserve(reserveInput('saga-b')),
      repo.reserve(reserveInput('saga-c')),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);
    for (const l of lost) expect(l.reason).toMatchObject({ statusCode: 409, code: 'CONNECTOR_UNAVAILABLE' });
  });

  it('liberar dos veces deja el conector AVAILABLE y no falla (compensación idempotente)', async () => {
    await repo.reserve(reserveInput('saga-2'));
    const first = await repo.release('saga-2');
    const second = await repo.release('saga-2');
    expect(first.outcome).toBe('RELEASED');
    expect(second).toMatchObject({ outcome: 'ALREADY_RELEASED', alreadyApplied: true });
    const c = await connector();
    expect(c.status).toBe('AVAILABLE');
    expect(c.sagaId).toBeUndefined();
  });

  it('el release de una saga no libera el conector de otra saga', async () => {
    await repo.reserve(reserveInput('saga-3'));
    const other = await repo.release('saga-otra');
    expect(other.outcome).toBe('NOTHING_TO_RELEASE');
    expect(await connector()).toMatchObject({ status: 'RESERVED', sagaId: 'saga-3' });
  });

  it('compensación antes que la reserva: la reserva tardía se rechaza y el conector sigue libre', async () => {
    await repo.release('saga-4');
    await expect(repo.reserve(reserveInput('saga-4'))).rejects.toMatchObject({
      statusCode: 409,
      code: 'RESERVATION_ALREADY_COMPENSATED',
    });
    expect((await connector()).status).toBe('AVAILABLE');
  });

  it('agrupa estaciones con sus conectores', async () => {
    const station = await repo.getStation(stationId);
    expect(station).toMatchObject({ stationId, name: 'Estación test', connectors: [{ connectorId: 'C1', powerKw: 50 }] });
    expect((await repo.listStations()).some((s) => s.stationId === stationId)).toBe(true);
  });
});
