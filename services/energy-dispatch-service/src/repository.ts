import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { conflict, isConditionalFailure, notFound } from '@aegisvolt/shared';
import type { TelemetryPoint } from './telemetry.js';

/**
 * Tabla aegisvolt-dispatch-<env>:
 *   PK=SESSION#<sagaId>  SK=META      -> status (ACTIVE|FAILED|STOPPED), estación, conector
 *   PK=SESSION#<sagaId>  SK=TS#<iso>  -> kw, kwh, voltage (expiresAt: TTL 24 h)
 *
 * Idempotencia: la sesión se crea con attribute_not_exists(PK). El resultado
 * del paso (ACTIVE o FAILED) queda registrado y un reintento recibe el mismo
 * resultado; nunca se activa el cargador dos veces.
 */
export type SessionStatus = 'ACTIVE' | 'FAILED' | 'STOPPED';

export interface Session {
  sagaId: string;
  stationId: string;
  connectorId: string;
  fleetId: string;
  powerKw: number;
  kwhTarget: number;
  status: SessionStatus;
  failureReason?: string;
  startedAt: string;
  stoppedAt?: string;
}

export type NewSession = Omit<Session, 'startedAt' | 'stoppedAt'>;

export interface DispatchRepository {
  getSession(sagaId: string): Promise<Session | undefined>;
  createSession(session: NewSession): Promise<{ session: Session; alreadyApplied: boolean }>;
  stopSession(sagaId: string): Promise<{ session: Session; alreadyApplied: boolean }>;
  writeTelemetry(sagaId: string, points: TelemetryPoint[]): Promise<void>;
  getTelemetry(sagaId: string): Promise<TelemetryPoint[]>;
}

const sessionKey = (sagaId: string) => ({ PK: `SESSION#${sagaId}`, SK: 'META' });
const TELEMETRY_TTL_SEC = 24 * 3600;

export class DynamoDispatchRepository implements DispatchRepository {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getSession(sagaId: string): Promise<Session | undefined> {
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: sessionKey(sagaId), ConsistentRead: true }));
    return out.Item ? toSession(out.Item) : undefined;
  }

  async createSession(input: NewSession) {
    const session: Session = { ...input, startedAt: this.now().toISOString() };
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { ...sessionKey(input.sagaId), ...session },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      return { session, alreadyApplied: false };
    } catch (err) {
      if (!isConditionalFailure(err)) throw err;
      return { session: (await this.getSession(input.sagaId))!, alreadyApplied: true };
    }
  }

  async stopSession(sagaId: string) {
    try {
      const out = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: sessionKey(sagaId),
          UpdateExpression: 'SET #status = :stopped, stoppedAt = :now',
          ConditionExpression: '#status = :active',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':stopped': 'STOPPED', ':active': 'ACTIVE', ':now': this.now().toISOString() },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return { session: toSession(out.Attributes!), alreadyApplied: false };
    } catch (err) {
      if (!isConditionalFailure(err)) throw err;
      const current = await this.getSession(sagaId);
      if (!current) throw notFound('SESSION_NOT_FOUND', `No existe la sesión ${sagaId}`);
      if (current.status === 'STOPPED') return { session: current, alreadyApplied: true };
      throw conflict('SESSION_NOT_ACTIVE', `La sesión ${sagaId} está en estado ${current.status}`);
    }
  }

  async writeTelemetry(sagaId: string, points: TelemetryPoint[]): Promise<void> {
    const expiresAt = Math.floor(this.now().getTime() / 1000) + TELEMETRY_TTL_SEC;
    for (let i = 0; i < points.length; i += 25) {
      await this.doc.send(
        new BatchWriteCommand({
          RequestItems: {
            [this.table]: points.slice(i, i + 25).map((p) => ({
              PutRequest: { Item: { PK: `SESSION#${sagaId}`, SK: `TS#${p.ts}`, ...p, expiresAt } },
            })),
          },
        }),
      );
    }
  }

  async getTelemetry(sagaId: string): Promise<TelemetryPoint[]> {
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :ts)',
        ExpressionAttributeValues: { ':pk': `SESSION#${sagaId}`, ':ts': 'TS#' },
      }),
    );
    return (out.Items ?? []).map((i) => ({
      ts: String(i.ts),
      kw: Number(i.kw),
      kwh: Number(i.kwh),
      voltage: Number(i.voltage),
    }));
  }
}

function toSession(item: Record<string, unknown>): Session {
  return {
    sagaId: String(item.sagaId),
    stationId: String(item.stationId),
    connectorId: String(item.connectorId),
    fleetId: String(item.fleetId),
    powerKw: Number(item.powerKw),
    kwhTarget: Number(item.kwhTarget),
    status: item.status as SessionStatus,
    ...(item.failureReason ? { failureReason: String(item.failureReason) } : {}),
    startedAt: String(item.startedAt),
    ...(item.stoppedAt ? { stoppedAt: String(item.stoppedAt) } : {}),
  };
}
