import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { DomainError, conflict, isConditionalFailure, notFound } from '@aegisvolt/shared';

/**
 * Tabla aegisvolt-billing-<env> (single-table):
 *   PK=WALLET#<fleetId>  SK=META        -> balance, version
 *   PK=WALLET#<fleetId>  SK=TX#<sagaId> -> type=HOLD, amount, status (HELD|REFUNDED)
 *
 * Idempotencia: el registro TX#<sagaId> es único por saga. La retención y el
 * reembolso mueven saldo y cambian el TX en UNA transacción con condiciones,
 * así un reintento o un duplicado nunca descuenta ni devuelve dos veces.
 */
export interface Wallet {
  fleetId: string;
  name: string;
  balance: number;
  currency: string;
  version: number;
}

export type HoldStatus = 'HELD' | 'REFUNDED';

export interface Hold {
  sagaId: string;
  fleetId: string;
  amount: number;
  status: HoldStatus;
  createdAt: string;
  refundedAt?: string;
  /** Marca de compensación: el reembolso llegó antes que la retención (nunca hubo cobro). */
  tombstone?: boolean;
}

export type RefundOutcome = 'REFUNDED' | 'ALREADY_REFUNDED' | 'NOTHING_TO_REFUND';

export interface BillingRepository {
  getWallet(fleetId: string): Promise<Wallet | undefined>;
  topUp(fleetId: string, amount: number): Promise<Wallet>;
  getHold(fleetId: string, sagaId: string): Promise<Hold | undefined>;
  placeHold(input: { sagaId: string; fleetId: string; amount: number }): Promise<{ hold: Hold; alreadyApplied: boolean }>;
  refundHold(fleetId: string, sagaId: string): Promise<{ outcome: RefundOutcome; hold: Hold; alreadyApplied: boolean }>;
}

const walletKey = (fleetId: string) => ({ PK: `WALLET#${fleetId}`, SK: 'META' });
const txKey = (fleetId: string, sagaId: string) => ({ PK: `WALLET#${fleetId}`, SK: `TX#${sagaId}` });

export class DynamoBillingRepository implements BillingRepository {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getWallet(fleetId: string): Promise<Wallet | undefined> {
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: walletKey(fleetId), ConsistentRead: true }));
    return out.Item ? toWallet(fleetId, out.Item) : undefined;
  }

  async topUp(fleetId: string, amount: number): Promise<Wallet> {
    try {
      const out = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: walletKey(fleetId),
          UpdateExpression: 'SET balance = balance + :amt, version = version + :one, updatedAt = :now',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':amt': amount, ':one': 1, ':now': this.now().toISOString() },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return toWallet(fleetId, out.Attributes!);
    } catch (err) {
      if (isConditionalFailure(err)) throw walletNotFound(fleetId);
      throw err;
    }
  }

  async getHold(fleetId: string, sagaId: string): Promise<Hold | undefined> {
    const out = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: txKey(fleetId, sagaId), ConsistentRead: true }),
    );
    return out.Item ? toHold(fleetId, sagaId, out.Item) : undefined;
  }

  async placeHold({ sagaId, fleetId, amount }: { sagaId: string; fleetId: string; amount: number }) {
    const existing = await this.getHold(fleetId, sagaId);
    if (existing) return this.replayHold(existing);

    const now = this.now().toISOString();
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: walletKey(fleetId),
                UpdateExpression: 'SET balance = balance - :amt, version = version + :one, updatedAt = :now',
                ConditionExpression: 'attribute_exists(PK) AND balance >= :amt',
                ExpressionAttributeValues: { ':amt': amount, ':one': 1, ':now': now },
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { ...txKey(fleetId, sagaId), type: 'HOLD', sagaId, amount, status: 'HELD', createdAt: now },
                ConditionExpression: 'attribute_not_exists(SK)',
              },
            },
          ],
        }),
      );
    } catch (err) {
      if (!isConditionalFailure(err)) throw err;
      // ¿Por qué se canceló? Otro intento de la misma saga ganó la carrera, no
      // existe la billetera o no alcanza el saldo.
      const raced = await this.getHold(fleetId, sagaId);
      if (raced) return this.replayHold(raced);
      const wallet = await this.getWallet(fleetId);
      if (!wallet) throw walletNotFound(fleetId);
      throw new DomainError(402, 'INSUFFICIENT_FUNDS', `Saldo insuficiente en ${fleetId}`, {
        balance: wallet.balance,
        required: amount,
      });
    }
    return {
      hold: { sagaId, fleetId, amount, status: 'HELD' as const, createdAt: now },
      alreadyApplied: false,
    };
  }

  async refundHold(
    fleetId: string,
    sagaId: string,
  ): Promise<{ outcome: RefundOutcome; hold: Hold; alreadyApplied: boolean }> {
    const hold = await this.getHold(fleetId, sagaId);

    if (!hold) {
      // La compensación llegó y no hay retención (falló o nunca llegó). Se deja
      // una marca REFUNDED: si la retención llega tarde, su Put condicional
      // falla y nunca se cobra una saga ya compensada.
      const now = this.now().toISOString();
      const tombstone: Hold = { sagaId, fleetId, amount: 0, status: 'REFUNDED', createdAt: now, refundedAt: now, tombstone: true };
      try {
        await this.doc.send(
          new PutCommand({
            TableName: this.table,
            Item: { ...txKey(fleetId, sagaId), type: 'HOLD', ...tombstone },
            ConditionExpression: 'attribute_not_exists(SK)',
          }),
        );
        return { outcome: 'NOTHING_TO_REFUND' as const, hold: tombstone, alreadyApplied: false };
      } catch (err) {
        if (!isConditionalFailure(err)) throw err;
        return this.refundHold(fleetId, sagaId);
      }
    }

    if (hold.status === 'REFUNDED') return { outcome: 'ALREADY_REFUNDED' as const, hold, alreadyApplied: true };

    const now = this.now().toISOString();
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: txKey(fleetId, sagaId),
                UpdateExpression: 'SET #status = :refunded, refundedAt = :now',
                ConditionExpression: '#status = :held',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':refunded': 'REFUNDED', ':held': 'HELD', ':now': now },
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: walletKey(fleetId),
                UpdateExpression: 'SET balance = balance + :amt, version = version + :one, updatedAt = :now',
                ConditionExpression: 'attribute_exists(PK)',
                ExpressionAttributeValues: { ':amt': hold.amount, ':one': 1, ':now': now },
              },
            },
          ],
        }),
      );
    } catch (err) {
      if (!isConditionalFailure(err)) throw err;
      // Un reembolso concurrente de la misma saga ya lo aplicó.
      const current = await this.getHold(fleetId, sagaId);
      if (current?.status === 'REFUNDED') return { outcome: 'ALREADY_REFUNDED' as const, hold: current, alreadyApplied: true };
      throw err;
    }
    return { outcome: 'REFUNDED' as const, hold: { ...hold, status: 'REFUNDED' as const, refundedAt: now }, alreadyApplied: false };
  }

  private replayHold(existing: Hold) {
    if (existing.status === 'REFUNDED') {
      throw conflict('HOLD_ALREADY_COMPENSATED', `La saga ${existing.sagaId} ya fue compensada; no se vuelve a retener`);
    }
    return { hold: existing, alreadyApplied: true };
  }
}

const walletNotFound = (fleetId: string) => notFound('WALLET_NOT_FOUND', `No existe la billetera ${fleetId}`);

function toWallet(fleetId: string, item: Record<string, unknown>): Wallet {
  return {
    fleetId,
    name: String(item.name ?? fleetId),
    balance: Number(item.balance ?? 0),
    currency: String(item.currency ?? 'COP'),
    version: Number(item.version ?? 0),
  };
}

function toHold(fleetId: string, sagaId: string, item: Record<string, unknown>): Hold {
  return {
    sagaId,
    fleetId,
    amount: Number(item.amount ?? 0),
    status: item.status as HoldStatus,
    createdAt: String(item.createdAt),
    ...(item.refundedAt ? { refundedAt: String(item.refundedAt) } : {}),
    ...(item.tombstone ? { tombstone: true } : {}),
  };
}
