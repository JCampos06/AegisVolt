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
import type { ConnectorStatus, ReservationRepository } from './repository.js';

export const SERVICE = 'station-reservation-service';

/** Conectores de ultra-carga: solo reservables con ENABLE_FAST_CHARGE_BOOST. */
export const ULTRA_FAST_KW = 150;

export interface ReservationAppDeps {
  config: ServiceConfig;
  logger: Logger;
  repo: ReservationRepository;
  flags: FeatureFlags;
  healthCheck?: () => Promise<Record<string, unknown>>;
}

const id = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' } as const;
const STATUSES: ConnectorStatus[] = ['AVAILABLE', 'RESERVED', 'CHARGING', 'FAULT'];

export function buildApp({ config, logger, repo, flags, healthCheck }: ReservationAppDeps): FastifyInstance {
  const app = createServiceApp({ config, logger, healthCheck });

  app.get<{ Querystring: { status?: ConnectorStatus } }>(
    '/stations',
    { schema: { querystring: { type: 'object', properties: { status: { type: 'string', enum: STATUSES } } } } },
    async (req) => {
      const [stations, fastChargeBoost] = await Promise.all([
        repo.listStations(),
        flags.isEnabled(FLAGS.FAST_CHARGE_BOOST),
      ]);
      const { status } = req.query;
      return stations
        .map((s) => ({
          ...s,
          connectors: s.connectors
            .filter((c) => !status || c.status === status)
            .map((c) => ({ ...c, ultraFast: c.powerKw >= ULTRA_FAST_KW, reservable: c.powerKw < ULTRA_FAST_KW || fastChargeBoost })),
        }))
        .filter((s) => !status || s.connectors.length > 0);
    },
  );

  app.get<{ Params: { stationId: string } }>(
    '/stations/:stationId',
    { schema: { params: { type: 'object', properties: { stationId: id }, required: ['stationId'] } } },
    async (req) => {
      const station = await repo.getStation(req.params.stationId);
      if (!station) throw notFound('STATION_NOT_FOUND', `No existe la estación ${req.params.stationId}`);
      return station;
    },
  );

  // Paso 1 de la SAGA: bloquear el conector para la flota.
  app.post<{ Body: { sagaId: string; stationId: string; connectorId: string; fleetId: string } }>(
    '/reservations',
    {
      schema: {
        body: {
          type: 'object',
          properties: { sagaId: id, stationId: id, connectorId: id, fleetId: id },
          required: ['sagaId', 'stationId', 'connectorId', 'fleetId'],
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const { sagaId } = req.body;
      assertIdempotencyKey(req.headers, sagaId, 'reserve');
      const log = req.log.child({ saga_step: 'reserve', sagaId });

      const result = await repo.reserve(req.body, async (connector) => {
        if (connector.powerKw >= ULTRA_FAST_KW && !(await flags.isEnabled(FLAGS.FAST_CHARGE_BOOST))) {
          throw new DomainError(
            403,
            'FAST_CHARGE_DISABLED',
            `El conector ${connector.connectorId} (${connector.powerKw} kW) requiere ${FLAGS.FAST_CHARGE_BOOST}`,
          );
        }
      });
      log.info(
        { stationId: req.body.stationId, connectorId: req.body.connectorId, alreadyApplied: result.alreadyApplied },
        result.alreadyApplied ? 'reserva ya aplicada (reintento idempotente)' : 'conector reservado',
      );
      return reply.code(result.alreadyApplied ? 200 : 201).send(result);
    },
  );

  app.get<{ Params: { sagaId: string } }>(
    '/reservations/:sagaId',
    { schema: { params: { type: 'object', properties: { sagaId: id }, required: ['sagaId'] } } },
    async (req) => {
      const reservation = await repo.getReservation(req.params.sagaId);
      if (!reservation) throw notFound('RESERVATION_NOT_FOUND', `No hay reserva para la saga ${req.params.sagaId}`);
      return reservation;
    },
  );

  // Compensación C1 de la SAGA, o fin normal de la carga (stopChargingSession): liberar el conector.
  app.post<{ Params: { sagaId: string } }>(
    '/reservations/:sagaId/release',
    { schema: { params: { type: 'object', properties: { sagaId: id }, required: ['sagaId'] } } },
    async (req) => {
      const { sagaId } = req.params;
      assertIdempotencyKey(req.headers, sagaId, 'release');
      const result = await repo.release(sagaId);
      req.log
        .child({ saga_step: 'release', sagaId })
        .info({ outcome: result.outcome, alreadyApplied: result.alreadyApplied }, 'liberación de conector');
      return result;
    },
  );

  return app;
}
