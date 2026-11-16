import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { isConditionalFailure, notFound, type FeatureFlag, type FeatureFlags, type Logger } from '@aegisvolt/shared';
import type { GatewayEvents } from './events.js';

/** Escritura de flags (mutation setFeatureFlag). Solo modifica flags existentes. */
export interface FlagWriter {
  set(name: string, enabled: boolean, updatedBy: string): Promise<FeatureFlag>;
}

export class DynamoFlagWriter implements FlagWriter {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async set(name: string, enabled: boolean, updatedBy: string): Promise<FeatureFlag> {
    try {
      const out = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: `FLAG#${name}`, SK: 'META' },
          UpdateExpression: 'SET enabled = :e, updatedAt = :t, updatedBy = :u',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':e': enabled, ':t': new Date().toISOString(), ':u': updatedBy },
          ReturnValues: 'ALL_NEW',
        }),
      );
      const a = out.Attributes!;
      return {
        name: String(a.name ?? name),
        enabled: a.enabled === true,
        description: a.description as string | undefined,
        updatedAt: a.updatedAt as string | undefined,
        updatedBy: a.updatedBy as string | undefined,
      };
    } catch (err) {
      if (isConditionalFailure(err)) throw notFound('FLAG_NOT_FOUND', `No existe la flag ${name}`);
      throw err;
    }
  }
}

/**
 * Vigila la tabla de flags cada 5 s y publica `flagChanged` cuando algo cambia,
 * venga del gateway o de afuera (scripts/toggle-flag.sh). Así la UI se entera
 * de un cambio hecho por CLI sin recargar.
 */
export class FlagWatcher {
  private snapshot = new Map<string, boolean>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly flags: FeatureFlags,
    private readonly events: GatewayEvents,
    private readonly logger: Logger,
    private readonly intervalMs = 5000,
  ) {}

  async start(): Promise<void> {
    await this.poll(false);
    this.timer = setInterval(() => void this.poll(true), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Cambio hecho por el propio gateway: publicar ya, sin esperar el siguiente ciclo. */
  notify(flag: FeatureFlag): void {
    this.flags.invalidate();
    this.snapshot.set(flag.name, flag.enabled);
    this.events.flagChanged(flag);
  }

  async poll(publish: boolean): Promise<void> {
    try {
      for (const flag of await this.flags.list()) {
        const prev = this.snapshot.get(flag.name);
        this.snapshot.set(flag.name, flag.enabled);
        if (publish && prev !== undefined && prev !== flag.enabled) {
          this.logger.info({ flag: flag.name, enabled: flag.enabled, updatedBy: flag.updatedBy }, 'feature flag cambiada');
          this.events.flagChanged(flag);
        }
      }
    } catch (err) {
      this.logger.warn({ error: err }, 'no se pudieron vigilar las flags');
    }
  }
}
