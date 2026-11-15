import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Logger } from 'pino';

/**
 * Feature flags por ambiente (tabla aegisvolt-flags-<env>).
 * Caché TTL de 5 s: un cambio en DynamoDB (toggle-flag.sh o mutation
 * setFeatureFlag) se refleja en ≤ 5 s sin redeploy.
 */
export const FLAGS = {
  DYNAMIC_SURGE_PRICING: 'ENABLE_DYNAMIC_SURGE_PRICING',
  FAST_CHARGE_BOOST: 'ENABLE_FAST_CHARGE_BOOST',
  CHARGER_HARDWARE_FAULT: 'SIMULATE_CHARGER_HARDWARE_FAULT',
} as const;
export type FlagName = (typeof FLAGS)[keyof typeof FLAGS];

export interface FeatureFlag {
  name: string;
  enabled: boolean;
  description?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface FlagSource {
  getAll(): Promise<FeatureFlag[]>;
}

export class DynamoFlagSource implements FlagSource {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async getAll(): Promise<FeatureFlag[]> {
    const out = await this.doc.send(new ScanCommand({ TableName: this.tableName, ConsistentRead: true }));
    return (out.Items ?? [])
      .filter((i) => typeof i.PK === 'string' && i.PK.startsWith('FLAG#'))
      .map((i) => ({
        name: String(i.name ?? String(i.PK).slice(5)),
        enabled: i.enabled === true,
        description: i.description as string | undefined,
        updatedAt: i.updatedAt as string | undefined,
        updatedBy: i.updatedBy as string | undefined,
      }));
  }
}

/** Fuente fija para pruebas unitarias y desarrollo sin DynamoDB. */
export class StaticFlagSource implements FlagSource {
  constructor(public values: Record<string, boolean> = {}) {}
  async getAll(): Promise<FeatureFlag[]> {
    return Object.entries(this.values).map(([name, enabled]) => ({ name, enabled }));
  }
}

export class FeatureFlags {
  private cache: { at: number; flags: Map<string, FeatureFlag> } | undefined;
  private inflight: Promise<Map<string, FeatureFlag>> | undefined;

  constructor(
    private readonly source: FlagSource,
    private readonly ttlMs = 5000,
    private readonly logger?: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Si DynamoDB falla: usa el último valor conocido; sin caché, `defaultValue` (apagado = seguro). */
  async isEnabled(name: FlagName | string, defaultValue = false): Promise<boolean> {
    const flags = await this.load();
    return flags?.get(name)?.enabled ?? defaultValue;
  }

  async list(): Promise<FeatureFlag[]> {
    return [...((await this.load())?.values() ?? [])];
  }

  invalidate(): void {
    this.cache = undefined;
  }

  private async load(): Promise<Map<string, FeatureFlag> | undefined> {
    if (this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache.flags;
    this.inflight ??= this.source
      .getAll()
      .then((list) => {
        const flags = new Map(list.map((f) => [f.name, f]));
        this.cache = { at: this.now(), flags };
        return flags;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    try {
      return await this.inflight;
    } catch (err) {
      this.logger?.warn({ error: err }, 'no se pudieron leer las feature flags; se usa el último valor conocido');
      return this.cache?.flags;
    }
  }
}
