/**
 * Configuración común por variables de entorno. El ambiente (APP_ENV) decide
 * los nombres de tablas y log groups: aegisvolt-<tabla>-<env>, /aegisvolt/<env>/<servicio>.
 * Es el mismo criterio que usa Terraform con `terraform.workspace`.
 */
export const APP_ENVS = ['dev', 'test', 'prod'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export const TABLES = ['reservations', 'billing', 'dispatch', 'sagas', 'flags'] as const;
export type TableName = (typeof TABLES)[number];

export interface ServiceConfig {
  service: string;
  env: AppEnv;
  version: string;
  port: number;
  logLevel: string;
  aws: {
    region: string;
    /** Endpoint de Floci (http://localhost:4566). Vacío = AWS real. */
    endpoint?: string;
  };
  tables: Record<TableName, string>;
  cloudwatch: {
    enabled: boolean;
    logGroupName: string;
    flushIntervalMs: number;
  };
  flagsCacheTtlMs: number;
  /** Demo de canary: la versión "defectuosa" responde 500 en ~30% de las peticiones. */
  faultyVersion: boolean;
}

type Env = Record<string, string | undefined>;

export function parseEnv(value: string | undefined): AppEnv {
  const env = (value ?? 'dev').toLowerCase();
  if (!(APP_ENVS as readonly string[]).includes(env)) {
    throw new Error(`APP_ENV inválido: "${value}". Valores permitidos: ${APP_ENVS.join(', ')}`);
  }
  return env as AppEnv;
}

export function loadConfig(service: string, defaultPort: number, env: Env = process.env): ServiceConfig {
  const appEnv = parseEnv(env.APP_ENV);
  const prefix = env.NAME_PREFIX ?? 'aegisvolt';

  const tables = Object.fromEntries(
    TABLES.map((t) => [t, env[`TABLE_${t.toUpperCase()}`] ?? `${prefix}-${t}-${appEnv}`]),
  ) as Record<TableName, string>;

  return {
    service,
    env: appEnv,
    version: env.APP_VERSION ?? '0.0.0-local',
    port: Number(env.PORT ?? defaultPort),
    logLevel: env.LOG_LEVEL ?? 'info',
    aws: {
      region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'us-east-1',
      endpoint: env.AWS_ENDPOINT_URL || undefined,
    },
    tables,
    cloudwatch: {
      enabled: env.CLOUDWATCH_LOGS_ENABLED === 'true',
      logGroupName: `/${prefix}/${appEnv}/${service}`,
      flushIntervalMs: Number(env.CLOUDWATCH_FLUSH_MS ?? 2000),
    },
    flagsCacheTtlMs: Number(env.FLAGS_CACHE_TTL_MS ?? 5000),
    faultyVersion: env.FAULTY_VERSION === 'true',
  };
}
