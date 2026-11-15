import type { FastifyInstance } from 'fastify';
import {
  DomainError,
  FLAGS,
  assertIdempotencyKey,
  createServiceApp,
  notFound,
  type FeatureFlags,
  type Logger,
  type ServiceConfig,
} from '@aegisvolt/shared';
import type { DispatchRepository, Session } from './repository.js';
import { simulateTelemetry } from './telemetry.js';

export const SERVICE = 'energy-dispatch-service';

export interface DispatchAppDeps {
  config: ServiceConfig;
  logger: Logger;
  repo: DispatchRepository;
  flags: FeatureFlags;
  healthCheck?: () => Promise<Record<string, unknown>>;
  now?: () => Date;
}

const id = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' } as const;
const positive = { type: 'number', exclusiveMinimum: 0, maximum: 1000 } as const;
const sagaParams = { type: 'object', properties: { sagaId: id }, required: ['sagaId'] } as const;

/**
 * Fallo físico del cargador: es un error de negocio (422) y NO se reintenta.
 * El orquestador lo recibe y ejecuta las compensaciones C2 (refund) y C1 (release).
 */
const hardwareFault = (s: Session) =>
  new DomainError(422, 'CHARGER_HARDWARE_FAULT', `El cargador ${s.stationId}/${s.connectorId} reportó una falla de hardware`, {
    sagaId: s.sagaId,
  });

export function buildApp({ config, logger, repo, flags, healthCheck, now = () => new Date() }: DispatchAppDeps): FastifyInstance {
  const app = createServiceApp({ config, logger, healthCheck });

  // Paso 3 de la SAGA: activación física (simulada) del cargador.
  app.post<{
    Body: { sagaId: string; stationId: string; connectorId: string; fleetId: string; kwh: number; powerKw: number };
  }>(
    '/sessions',
    {
      schema: {
        body: {
          type: 'object',
          properties: { sagaId: id, stationId: id, connectorId: id, fleetId: id, kwh: positive, powerKw: positive },
          required: ['sagaId', 'stationId', 'connectorId', 'fleetId', 'kwh', 'powerKw'],
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const { sagaId, stationId, connectorId, fleetId, kwh, powerKw } = req.body;
      assertIdempotencyKey(req.headers, sagaId, 'activate');
      const log = req.log.child({ saga_step: 'activate', sagaId });

      const existing = await repo.getSession(sagaId);
      if (existing) {
        log.info({ status: existing.status }, 'activación ya registrada (reintento idempotente)');
        if (existing.status === 'FAILED') throw hardwareFault(existing);
        return reply.code(200).send({ session: existing, alreadyApplied: true });
      }

      const faulty = await flags.isEnabled(FLAGS.CHARGER_HARDWARE_FAULT);
      const base = { sagaId, stationId, connectorId, fleetId, powerKw, kwhTarget: kwh };
      const { session, alreadyApplied } = await repo.createSession(
        faulty
          ? { ...base, status: 'FAILED', failureReason: `${FLAGS.CHARGER_HARDWARE_FAULT}=true` }
          : { ...base, status: 'ACTIVE' },
      );

      if (session.status === 'FAILED') {
        log.error({ stationId, connectorId, flag: FLAGS.CHARGER_HARDWARE_FAULT }, 'falla de hardware del cargador');
        throw hardwareFault(session);
      }
      if (!alreadyApplied) await repo.writeTelemetry(sagaId, simulateTelemetry(powerKw, kwh, now()));
      log.info({ stationId, connectorId, powerKw, alreadyApplied }, 'sesión de carga activa');
      return reply.code(alreadyApplied ? 200 : 201).send({ session, alreadyApplied });
    },
  );

  app.get<{ Params: { sagaId: string } }>('/sessions/:sagaId', { schema: { params: sagaParams } }, async (req) => {
    const session = await repo.getSession(req.params.sagaId);
    if (!session) throw notFound('SESSION_NOT_FOUND', `No existe la sesión ${req.params.sagaId}`);
    return session;
  });

  app.get<{ Params: { sagaId: string } }>('/sessions/:sagaId/telemetry', { schema: { params: sagaParams } }, async (req) => {
    const session = await repo.getSession(req.params.sagaId);
    if (!session) throw notFound('SESSION_NOT_FOUND', `No existe la sesión ${req.params.sagaId}`);
    return { sagaId: session.sagaId, status: session.status, points: await repo.getTelemetry(session.sagaId) };
  });

  app.post<{ Params: { sagaId: string } }>('/sessions/:sagaId/stop', { schema: { params: sagaParams } }, async (req) => {
    const { sagaId } = req.params;
    assertIdempotencyKey(req.headers, sagaId, 'stop');
    const result = await repo.stopSession(sagaId);
    req.log.child({ saga_step: 'stop', sagaId }).info({ alreadyApplied: result.alreadyApplied }, 'sesión detenida');
    return result;
  });

  return app;
}
