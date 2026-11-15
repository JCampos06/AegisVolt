import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createDocClient, createLogsClient } from './aws.js';
import { loadConfig, type ServiceConfig } from './config.js';
import { DynamoFlagSource, FeatureFlags } from './flags.js';
import { CloudWatchSink, createLogger } from './logger.js';

export interface ServiceDeps {
  config: ServiceConfig;
  logger: Logger;
  doc: DynamoDBDocumentClient;
  flags: FeatureFlags;
}

/**
 * Arranque estándar de un servicio: config -> logger (stdout + CloudWatch) ->
 * DynamoDB -> flags -> app. Apagado ordenado en SIGTERM (Kubernetes) / SIGINT:
 * deja de aceptar tráfico y vacía el buffer de logs a CloudWatch.
 */
export async function runService(
  service: string,
  defaultPort: number,
  build: (deps: ServiceDeps) => FastifyInstance | Promise<FastifyInstance>,
): Promise<void> {
  const config = loadConfig(service, defaultPort);
  const sink = config.cloudwatch.enabled
    ? new CloudWatchSink(createLogsClient(config.aws), config.cloudwatch.logGroupName, config.cloudwatch.flushIntervalMs)
    : undefined;
  const logger = createLogger({
    service,
    env: config.env,
    version: config.version,
    level: config.logLevel,
    cloudwatch: sink,
  });
  const doc = createDocClient(config.aws);
  const flags = new FeatureFlags(new DynamoFlagSource(doc, config.tables.flags), config.flagsCacheTtlMs, logger);
  const app = await build({ config, logger, doc, flags });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'apagando servicio');
    try {
      await app.close();
    } finally {
      await sink?.close();
      process.exit(0);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port: config.port });
  logger.info(
    { port: config.port, tables: config.tables, cloudwatch: sink ? config.cloudwatch.logGroupName : 'deshabilitado' },
    'servicio iniciado',
  );
}
