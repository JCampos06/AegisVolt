import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { DomainError, isConditionalFailure } from '@aegisvolt/shared';
import type { Saga, SagaStatus } from './model.js';

/**
 * Log persistente de sagas (tabla aegisvolt-sagas-<env>):
 *   PK=SAGA#<correlationId>  SK=META  -> status, steps[], version, updatedAt
 *   GSI status-updatedAt-index        -> Prefect busca sagas huérfanas sin Scan
 *
 * Escritura write-ahead: cada transición se guarda ANTES de llamar al siguiente
 * servicio. Bloqueo optimista con `version`: dos orquestadores nunca avanzan
 * la misma saga.
 */
export interface SagaStore {
  /** Crea la saga; si ya existe (mismo correlationId) devuelve la existente. */
  create(saga: Saga): Promise<{ saga: Saga; created: boolean }>;
  /** Guarda con condición version = saga.version y devuelve la saga con version + 1. */
  save(saga: Saga): Promise<Saga>;
  get(correlationId: string): Promise<Saga | undefined>;
  list(filter: { status?: SagaStatus; limit: number }): Promise<Saga[]>;
}

const key = (id: string) => ({ PK: `SAGA#${id}`, SK: 'META' });

export class DynamoSagaStore implements SagaStore {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async create(saga: Saga) {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { ...key(saga.correlationId), ...saga },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      return { saga, created: true };
    } catch (err) {
      if (!isConditionalFailure(err)) throw err;
      return { saga: (await this.get(saga.correlationId))!, created: false };
    }
  }

  async save(saga: Saga): Promise<Saga> {
    const next = { ...saga, version: saga.version + 1 };
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { ...key(saga.correlationId), ...next },
          ConditionExpression: 'version = :v',
          ExpressionAttributeValues: { ':v': saga.version },
        }),
      );
    } catch (err) {
      if (isConditionalFailure(err)) {
        throw new DomainError(409, 'SAGA_VERSION_CONFLICT', `La saga ${saga.correlationId} fue modificada por otro proceso`);
      }
      throw err;
    }
    return next;
  }

  async get(correlationId: string): Promise<Saga | undefined> {
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: key(correlationId), ConsistentRead: true }));
    return out.Item ? toSaga(out.Item) : undefined;
  }

  async list({ status, limit }: { status?: SagaStatus; limit: number }): Promise<Saga[]> {
    if (status) {
      const out = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          IndexName: 'status-updatedAt-index',
          KeyConditionExpression: '#status = :s',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':s': status },
          ScanIndexForward: false,
          Limit: limit,
        }),
      );
      return (out.Items ?? []).map(toSaga);
    }
    const items: Record<string, unknown>[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const out = await this.doc.send(new ScanCommand({ TableName: this.table, ExclusiveStartKey }));
      items.push(...(out.Items ?? []));
      ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items
      .map(toSaga)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }
}

/** Implementación en memoria (pruebas unitarias). Misma semántica de versión. */
export class InMemorySagaStore implements SagaStore {
  readonly items = new Map<string, Saga>();

  async create(saga: Saga) {
    const existing = this.items.get(saga.correlationId);
    if (existing) return { saga: structuredClone(existing), created: false };
    this.items.set(saga.correlationId, structuredClone(saga));
    return { saga, created: true };
  }

  async save(saga: Saga) {
    const current = this.items.get(saga.correlationId);
    if (!current || current.version !== saga.version) {
      throw new DomainError(409, 'SAGA_VERSION_CONFLICT', `La saga ${saga.correlationId} fue modificada por otro proceso`);
    }
    const next = { ...saga, version: saga.version + 1 };
    this.items.set(saga.correlationId, structuredClone(next));
    return next;
  }

  async get(id: string) {
    const s = this.items.get(id);
    return s ? structuredClone(s) : undefined;
  }

  async list({ status, limit }: { status?: SagaStatus; limit: number }) {
    return [...this.items.values()]
      .filter((s) => !status || s.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((s) => structuredClone(s));
  }
}

function toSaga(item: Record<string, unknown>): Saga {
  const { PK: _pk, SK: _sk, ...rest } = item;
  return rest as unknown as Saga;
}
