import type { FastifyInstance } from 'fastify';
import {
  FLAGS,
  assertIdempotencyKey,
  createServiceApp,
  notFound,
  type FeatureFlags,
  type Logger,
  type ServiceConfig,
} from '@aegisvolt/shared';
import { quote } from './pricing.js';
import type { BillingRepository } from './repository.js';

export const SERVICE = 'billing-wallet-service';

export interface BillingAppDeps {
  config: ServiceConfig;
  logger: Logger;
  repo: BillingRepository;
  flags: FeatureFlags;
  healthCheck?: () => Promise<Record<string, unknown>>;
}

const id = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' } as const;
const positive = { type: 'number', exclusiveMinimum: 0, maximum: 1000 } as const;

export function buildApp({ config, logger, repo, flags, healthCheck }: BillingAppDeps): FastifyInstance {
  const app = createServiceApp({ config, logger, healthCheck });

  const currentQuote = async (kwh: number, powerKw: number) =>
    quote(kwh, powerKw, await flags.isEnabled(FLAGS.DYNAMIC_SURGE_PRICING));

  app.get<{ Params: { fleetId: string } }>(
    '/wallets/:fleetId',
    { schema: { params: { type: 'object', properties: { fleetId: id }, required: ['fleetId'] } } },
    async (req) => {
      const wallet = await repo.getWallet(req.params.fleetId);
      if (!wallet) throw notFound('WALLET_NOT_FOUND', `No existe la billetera ${req.params.fleetId}`);
      return wallet;
    },
  );

  app.post<{ Params: { fleetId: string }; Body: { amount: number } }>(
    '/wallets/:fleetId/topup',
    {
      schema: {
        params: { type: 'object', properties: { fleetId: id }, required: ['fleetId'] },
        body: {
          type: 'object',
          properties: { amount: { type: 'integer', minimum: 1, maximum: 100_000_000 } },
          required: ['amount'],
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const wallet = await repo.topUp(req.params.fleetId, req.body.amount);
      req.log.info({ fleetId: wallet.fleetId, amount: req.body.amount, balance: wallet.balance }, 'recarga aplicada');
      return wallet;
    },
  );

  app.get<{ Querystring: { kwh: number; powerKw: number } }>(
    '/quote',
    {
      schema: {
        querystring: { type: 'object', properties: { kwh: positive, powerKw: positive }, required: ['kwh', 'powerKw'] },
      },
    },
    async (req) => currentQuote(req.query.kwh, req.query.powerKw),
  );

  // Paso 2 de la SAGA: retener el valor estimado de la carga.
  app.post<{ Body: { sagaId: string; fleetId: string; kwh: number; powerKw: number } }>(
    '/holds',
    {
      schema: {
        body: {
          type: 'object',
          properties: { sagaId: id, fleetId: id, kwh: positive, powerKw: positive },
          required: ['sagaId', 'fleetId', 'kwh', 'powerKw'],
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const { sagaId, fleetId, kwh, powerKw } = req.body;
      assertIdempotencyKey(req.headers, sagaId, 'hold');
      const log = req.log.child({ saga_step: 'hold', sagaId, fleetId });

      const q = await currentQuote(kwh, powerKw);
      const result = await repo.placeHold({ sagaId, fleetId, amount: q.amount });
      log.info(
        { amount: result.hold.amount, surge: q.surgeMultiplier, alreadyApplied: result.alreadyApplied },
        result.alreadyApplied ? 'retención ya aplicada (reintento idempotente)' : 'saldo retenido',
      );
      return reply.code(result.alreadyApplied ? 200 : 201).send({ ...result, quote: q });
    },
  );

  app.get<{ Params: { sagaId: string }; Querystring: { fleetId: string } }>(
    '/holds/:sagaId',
    {
      schema: {
        params: { type: 'object', properties: { sagaId: id }, required: ['sagaId'] },
        querystring: { type: 'object', properties: { fleetId: id }, required: ['fleetId'] },
      },
    },
    async (req) => {
      const hold = await repo.getHold(req.query.fleetId, req.params.sagaId);
      if (!hold) throw notFound('HOLD_NOT_FOUND', `No hay retención para la saga ${req.params.sagaId}`);
      return hold;
    },
  );

  // Compensación C2: devolver la retención. Repetirla nunca devuelve dos veces.
  app.post<{ Params: { sagaId: string }; Body: { fleetId: string } }>(
    '/holds/:sagaId/refund',
    {
      schema: {
        params: { type: 'object', properties: { sagaId: id }, required: ['sagaId'] },
        body: { type: 'object', properties: { fleetId: id }, required: ['fleetId'], additionalProperties: false },
      },
    },
    async (req) => {
      const { sagaId } = req.params;
      const { fleetId } = req.body;
      assertIdempotencyKey(req.headers, sagaId, 'refund');
      const result = await repo.refundHold(fleetId, sagaId);
      req.log
        .child({ saga_step: 'refund', sagaId, fleetId })
        .info({ outcome: result.outcome, amount: result.hold.amount, alreadyApplied: result.alreadyApplied }, 'compensación de cobro');
      return result;
    },
  );

  return app;
}
