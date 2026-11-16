import Fastify, { LogController, type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ServiceConfig } from './config.js';
import { CORRELATION_HEADER, resolveCorrelationId } from './correlation.js';
import { DomainError } from './errors.js';

/**
 * Esqueleto común de los microservicios (Fastify):
 *   - correlation_id: se toma de x-correlation-id (o se genera), se devuelve en
 *     la respuesta y va como campo `correlation_id` en todos los logs del request
 *   - un log por request con statusCode (el metric filter Http5xx de CloudWatch lo cuenta)
 *   - errores uniformes: { error: { code, message, details? } }
 *   - /health (readiness, revisa DynamoDB), /health/live (liveness), /metrics
 *   - FAULTY_VERSION=true: ~30% de 500 para la demo de rollback del canary
 */
export interface ServiceAppOptions {
  config: ServiceConfig;
  logger: Logger;
  healthCheck?: () => Promise<Record<string, unknown>>;
  random?: () => number;
}

const OPS_ROUTES = new Set(['/health', '/health/live', '/metrics', '/metrics.json']);
const FAULT_RATE = 0.3;

export function createServiceApp(opts: ServiceAppOptions): FastifyInstance {
  const { config } = opts;
  const random = opts.random ?? Math.random;
  const metrics = new RequestMetrics();
  const startedAt = Date.now();

  const app = Fastify({
    loggerInstance: opts.logger as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'correlation_id' }),
    requestIdHeader: false,
    genReqId: (req) => resolveCorrelationId(req.headers[CORRELATION_HEADER]),
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header(CORRELATION_HEADER, req.id);
    if (config.faultyVersion && !OPS_ROUTES.has(req.url.split('?')[0]!) && random() < FAULT_RATE) {
      return reply.code(500).send({ error: { code: 'FAULTY_VERSION', message: 'Fallo inyectado (FAULTY_VERSION=true)' } });
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    const statusCode = reply.statusCode;
    const fields = {
      method: req.method,
      route,
      url: req.url,
      statusCode,
      responseTimeMs: Math.round(reply.elapsedTime),
    };
    if (OPS_ROUTES.has(route)) {
      req.log.debug(fields, 'request completed');
      return;
    }
    metrics.record(route, statusCode);
    if (statusCode >= 500) req.log.error(fields, 'request completed');
    else if (statusCode >= 400) req.log.warn(fields, 'request completed');
    else req.log.info(fields, 'request completed');
  });

  app.setErrorHandler((err: FastifyError | DomainError, req, reply) => {
    if (err instanceof DomainError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.validation) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: err.code ?? 'BAD_REQUEST', message: err.message } });
    }
    req.log.error({ error: err }, 'error no controlado');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Error interno' } });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: { code: 'ROUTE_NOT_FOUND', message: `${req.method} ${req.url} no existe` } }),
  );

  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health', async (req, reply) => {
    const base = {
      service: config.service,
      env: config.env,
      version: config.version,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    };
    try {
      const checks = (await opts.healthCheck?.()) ?? {};
      return { status: 'ok', ...base, checks };
    } catch (err) {
      req.log.warn({ error: err }, 'health check falló');
      return reply.code(503).send({ status: 'degraded', ...base, error: (err as Error).message });
    }
  });

  app.get('/metrics', async (_req, reply) =>
    reply.type('text/plain; version=0.0.4').send(metrics.prometheus(config)),
  );
  app.get('/metrics.json', async () => metrics.summary());

  return app;
}

/** Readiness: la tabla propia del servicio responde. */
export function dynamoHealthCheck(doc: DynamoDBDocumentClient, tableName: string) {
  return async () => {
    const out = await doc.send(new DescribeTableCommand({ TableName: tableName }));
    return { dynamodb: { table: tableName, status: out.Table?.TableStatus ?? 'UNKNOWN' } };
  };
}

/** Contadores de respuestas para el AnalysisTemplate del canary (success-rate). */
export class RequestMetrics {
  private counts = new Map<string, number>();

  record(route: string, status: number): void {
    const key = `${route}|${status}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  summary() {
    let total = 0;
    let errors5xx = 0;
    for (const [key, n] of this.counts) {
      total += n;
      if (Number(key.split('|')[1]) >= 500) errors5xx += n;
    }
    return { total, errors5xx, successRate: total === 0 ? 1 : (total - errors5xx) / total };
  }

  prometheus(config: Pick<ServiceConfig, 'service' | 'env' | 'version'>): string {
    const lines = [
      '# HELP http_requests_total Respuestas HTTP por ruta y código',
      '# TYPE http_requests_total counter',
    ];
    for (const [key, n] of this.counts) {
      const [route, status] = key.split('|');
      lines.push(
        `http_requests_total{service="${config.service}",env="${config.env}",version="${config.version}",route="${route}",status="${status}"} ${n}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }
}
