import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { conflict, isConditionalFailure, notFound } from '@aegisvolt/shared';

/**
 * Tabla aegisvolt-reservations-<env> (single-table):
 *   PK=STATION#<id>      SK=META            -> name, city, lat, lon
 *   PK=STATION#<id>      SK=CONNECTOR#<id>  -> type, power_kw, status, sagaId, reservedBy, version
 *   PK=RESERVATION#<sagaId> SK=META         -> stationId, connectorId, fleetId, status (RESERVED|RELEASED)
 *
 * Reservar = una transacción: conector AVAILABLE -> RESERVED (condición) + registro
 * RESERVATION#<sagaId> (attribute_not_exists). Dos sagas nunca obtienen el mismo
 * conector y un reintento de la misma saga no reserva dos veces.
 */
export type ConnectorStatus = 'AVAILABLE' | 'RESERVED' | 'CHARGING' | 'FAULT';

export interface Connector {
  stationId: string;
  connectorId: string;
  type: string;
  powerKw: number;
  status: ConnectorStatus;
  sagaId?: string;
  reservedBy?: string;
  version: number;
  updatedAt?: string;
}

export interface Station {
  stationId: string;
  name: string;
  city: string;
  lat: number;
  lon: number;
  connectors: Connector[];
}

export interface Reservation {
  sagaId: string;
  stationId: string;
  connectorId: string;
  fleetId: string;
  powerKw: number;
  status: 'RESERVED' | 'RELEASED';
  createdAt: string;
  releasedAt?: string;
  tombstone?: boolean;
}

export type ReleaseOutcome = 'RELEASED' | 'ALREADY_RELEASED' | 'NOTHING_TO_RELEASE';

export interface ReserveInput {
  sagaId: string;
  stationId: string;
  connectorId: string;
  fleetId: string;
}

export interface ReservationRepository {
  listStations(): Promise<Station[]>;
  getStation(stationId: string): Promise<Station | undefined>;
  getConnector(stationId: string, connectorId: string): Promise<Connector | undefined>;
  getReservation(sagaId: string): Promise<Reservation | undefined>;
  /** `guard` valida reglas de negocio (p. ej. flags) solo cuando es una reserva nueva. */
  reserve(
    input: ReserveInput,
    guard?: (connector: Connector) => Promise<void> | void,
  ): Promise<{ reservation: Reservation; alreadyApplied: boolean }>;
  release(sagaId: string): Promise<{ outcome: ReleaseOutcome; reservation: Reservation; alreadyApplied: boolean }>;
}

const connectorKey = (stationId: string, connectorId: string) => ({
  PK: `STATION#${stationId}`,
  SK: `CONNECTOR#${connectorId}`,
});
const reservationKey = (sagaId: string) => ({ PK: `RESERVATION#${sagaId}`, SK: 'META' });

export class DynamoReservationRepository implements ReservationRepository {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listStations(): Promise<Station[]> {
    const items: Record<string, unknown>[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const out = await this.doc.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: 'begins_with(PK, :p)',
          ExpressionAttributeValues: { ':p': 'STATION#' },
          ExclusiveStartKey,
        }),
      );
      items.push(...(out.Items ?? []));
      ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return groupStations(items).sort((a, b) => a.stationId.localeCompare(b.stationId));
  }

  async getStation(stationId: string): Promise<Station | undefined> {
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `STATION#${stationId}` },
        ConsistentRead: true,
      }),
    );
    return groupStations(out.Items ?? [])[0];
  }

  async getConnector(stationId: string, connectorId: string): Promise<Connector | undefined> {
    const out = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: connectorKey(stationId, connectorId), ConsistentRead: true }),
    );
    return out.Item ? toConnector(out.Item) : undefined;
  }

  async getReservation(sagaId: string): Promise<Reservation | undefined> {
    const out = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: reservationKey(sagaId), ConsistentRead: true }),
    );
    return out.Item ? toReservation(out.Item) : undefined;
  }

  async reserve(input: ReserveInput, guard?: (connector: Connector) => Promise<void> | void) {
    const existing = await this.getReservation(input.sagaId);
    if (existing) return replay(existing, input);

    const connector = await this.getConnector(input.stationId, input.connectorId);
    if (!connector) throw connectorNotFound(input);
    await guard?.(connector);

    const now = this.now().toISOString();
    const reservation: Reservation = { ...input, powerKw: connector.powerKw, status: 'RESERVED', createdAt: now };
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: connectorKey(input.stationId, input.connectorId),
                UpdateExpression:
                  'SET #status = :reserved, sagaId = :saga, reservedBy = :fleet, version = version + :one, updatedAt = :now',
                ConditionExpression: 'attribute_exists(PK) AND #status = :available',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':reserved': 'RESERVED',
                  ':available': 'AVAILABLE',
                  ':saga': input.sagaId,
                  ':fleet': input.fleetId,
                  ':one': 1,
                  ':now': now,
                },
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { ...reservationKey(input.sagaId), ...reservation },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
      );
    } catch (err) {
      if (!isConditionalFailure(err)) throw err;
      const raced = await this.getReservation(input.sagaId);
      if (raced) return replay(raced, input);
      const current = await this.getConnector(input.stationId, input.connectorId);
      throw conflict('CONNECTOR_UNAVAILABLE', `El conector ${input.stationId}/${input.connectorId} no está disponible`, {
        status: current?.status,
      });
    }
    return { reservation, alreadyApplied: false };
  }

  async release(sagaId: string): Promise<{ outcome: ReleaseOutcome; reservation: Reservation; alreadyApplied: boolean }> {
    const reservation = await this.getReservation(sagaId);
    const now = this.now().toISOString();

    if (!reservation) {
      // Compensación sin reserva previa: se deja la marca RELEASED para que una
      // reserva tardía de esta saga sea rechazada (no queda un conector bloqueado).
      const tombstone: Reservation = {
        sagaId,
        stationId: '-',
        connectorId: '-',
        fleetId: '-',
        powerKw: 0,
        status: 'RELEASED',
        createdAt: now,
        releasedAt: now,
        tombstone: true,
      };
      try {
        await this.doc.send(
          new PutCommand({
            TableName: this.table,
            Item: { ...reservationKey(sagaId), ...tombstone },
            ConditionExpression: 'attribute_not_exists(PK)',
          }),
        );
        return { outcome: 'NOTHING_TO_RELEASE', reservation: tombstone, alreadyApplied: false };
      } catch (err) {
        if (!isConditionalFailure(err)) throw err;
        return this.release(sagaId);
      }
    }

    if (reservation.status === 'RELEASED') return { outcome: 'ALREADY_RELEASED', reservation, alreadyApplied: true };

    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: connectorKey(reservation.stationId, reservation.connectorId),
                UpdateExpression:
                  'SET #status = :available, version = version + :one, updatedAt = :now REMOVE sagaId, reservedBy',
                ConditionExpression: 'sagaId = :saga AND #status = :reserved',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':available': 'AVAILABLE',
                  ':reserved': 'RESERVED',
                  ':saga': sagaId,
                  ':one': 1,
                  ':now': now,
                },
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: reservationKey(sagaId),
                UpdateExpression: 'SET #status = :released, releasedAt = :now',
                ConditionExpression: '#status = :reserved',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':released': 'RELEASED', ':reserved': 'RESERVED', ':now': now },
              },
            },
          ],
        }),
      );
    } catch (err) {
      if (!isConditionalFailure(err)) throw err;
      const current = await this.getReservation(sagaId);
      if (current?.status === 'RELEASED') return { outcome: 'ALREADY_RELEASED', reservation: current, alreadyApplied: true };
      throw conflict('RELEASE_CONFLICT', `El conector de la saga ${sagaId} ya no está reservado por ella`);
    }
    return {
      outcome: 'RELEASED',
      reservation: { ...reservation, status: 'RELEASED', releasedAt: now },
      alreadyApplied: false,
    };
  }
}

function replay(existing: Reservation, input: ReserveInput) {
  if (existing.status === 'RELEASED') {
    throw conflict('RESERVATION_ALREADY_COMPENSATED', `La saga ${existing.sagaId} ya fue compensada; no se vuelve a reservar`);
  }
  if (existing.stationId !== input.stationId || existing.connectorId !== input.connectorId) {
    throw conflict('IDEMPOTENCY_CONFLICT', `La saga ${existing.sagaId} ya reservó otro conector`, {
      stationId: existing.stationId,
      connectorId: existing.connectorId,
    });
  }
  return { reservation: existing, alreadyApplied: true };
}

const connectorNotFound = (i: { stationId: string; connectorId: string }) =>
  notFound('CONNECTOR_NOT_FOUND', `No existe el conector ${i.stationId}/${i.connectorId}`);

function groupStations(items: Record<string, unknown>[]): Station[] {
  const stations = new Map<string, Station>();
  const get = (stationId: string) => {
    let s = stations.get(stationId);
    if (!s) {
      s = { stationId, name: stationId, city: '', lat: 0, lon: 0, connectors: [] };
      stations.set(stationId, s);
    }
    return s;
  };
  for (const item of items) {
    const stationId = String(item.PK).slice('STATION#'.length);
    const s = get(stationId);
    if (item.SK === 'META') {
      Object.assign(s, { name: String(item.name), city: String(item.city), lat: Number(item.lat), lon: Number(item.lon) });
    } else if (String(item.SK).startsWith('CONNECTOR#')) {
      s.connectors.push(toConnector(item));
    }
  }
  for (const s of stations.values()) s.connectors.sort((a, b) => a.connectorId.localeCompare(b.connectorId));
  return [...stations.values()];
}

function toConnector(item: Record<string, unknown>): Connector {
  return {
    stationId: String(item.PK).slice('STATION#'.length),
    connectorId: String(item.SK).slice('CONNECTOR#'.length),
    type: String(item.type),
    powerKw: Number(item.power_kw),
    status: item.status as ConnectorStatus,
    ...(item.sagaId ? { sagaId: String(item.sagaId) } : {}),
    ...(item.reservedBy ? { reservedBy: String(item.reservedBy) } : {}),
    version: Number(item.version ?? 0),
    ...(item.updatedAt ? { updatedAt: String(item.updatedAt) } : {}),
  };
}

function toReservation(item: Record<string, unknown>): Reservation {
  return {
    sagaId: String(item.sagaId),
    stationId: String(item.stationId),
    connectorId: String(item.connectorId),
    fleetId: String(item.fleetId),
    powerKw: Number(item.powerKw ?? 0),
    status: item.status as Reservation['status'],
    createdAt: String(item.createdAt),
    ...(item.releasedAt ? { releasedAt: String(item.releasedAt) } : {}),
    ...(item.tombstone ? { tombstone: true } : {}),
  };
}
