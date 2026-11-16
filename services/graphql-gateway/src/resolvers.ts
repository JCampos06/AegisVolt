import { GraphQLError } from 'graphql';
import { withFilter } from 'graphql-subscriptions';
import { HttpError, type FeatureFlags } from '@aegisvolt/shared';
import type { CallContext, ConnectorDto, ServiceClients, SessionDto, StationDto } from './clients.js';
import { TOPICS, type ConnectorEvent, type GatewayEvents } from './events.js';
import type { FlagWatcher, FlagWriter } from './flags-admin.js';
import type { SagaStatus, StartSagaInput } from './saga/model.js';
import type { SagaOrchestrator } from './saga/orchestrator.js';
import type { SagaStore } from './saga/store.js';

export interface GatewayContext {
  correlationId: string;
  /** Header x-admin-token válido. Obligatorio para cambiar flags en prod. */
  isAdmin: boolean;
}

export type GatewayQueries = Pick<ServiceClients, 'stations' | 'station' | 'wallet' | 'topUp' | 'quote' | 'session' | 'telemetry'>;

export interface ResolverDeps {
  env: string;
  clients: GatewayQueries;
  orchestrator: Pick<SagaOrchestrator, 'start' | 'stopCharging'>;
  store: SagaStore;
  flags: FeatureFlags;
  flagWriter: FlagWriter;
  flagWatcher: Pick<FlagWatcher, 'notify'>;
  events: GatewayEvents;
}

const ULTRA_FAST_KW = 150;

/** 404 de un servicio = el recurso no existe -> null en GraphQL. */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

const toStation = (s: StationDto) => ({ ...s, id: s.stationId });
const toSession = (s: SessionDto) => ({ ...s, sessionId: s.sagaId });

export function buildResolvers(d: ResolverDeps) {
  const call = (ctx: GatewayContext): CallContext => ({ correlationId: ctx.correlationId });

  return {
    Connector: {
      id: (c: ConnectorDto) => c.connectorId,
      ultraFast: (c: ConnectorDto) => c.ultraFast ?? c.powerKw >= ULTRA_FAST_KW,
      reservable: (c: ConnectorDto) => c.reservable ?? true,
    },

    Query: {
      environment: () => d.env,
      stations: async (_: unknown, a: { status?: string }, ctx: GatewayContext) =>
        (await d.clients.stations(a.status, call(ctx))).map(toStation),
      station: async (_: unknown, a: { id: string }, ctx: GatewayContext) => {
        const s = await orNull(d.clients.station(a.id, call(ctx)));
        return s && toStation(s);
      },
      wallet: (_: unknown, a: { fleetId: string }, ctx: GatewayContext) => orNull(d.clients.wallet(a.fleetId, call(ctx))),
      quote: (_: unknown, a: { kwh: number; powerKw: number }, ctx: GatewayContext) =>
        d.clients.quote(a.kwh, a.powerKw, call(ctx)),
      saga: (_: unknown, a: { correlationId: string }) => d.store.get(a.correlationId).then((s) => s ?? null),
      sagas: (_: unknown, a: { status?: SagaStatus; limit?: number }) =>
        d.store.list({ status: a.status, limit: Math.min(Math.max(a.limit ?? 20, 1), 100) }),
      session: async (_: unknown, a: { sessionId: string }, ctx: GatewayContext) => {
        const s = await orNull(d.clients.session(a.sessionId, call(ctx)));
        return s && toSession(s);
      },
      telemetry: async (_: unknown, a: { sessionId: string }, ctx: GatewayContext) =>
        (await orNull(d.clients.telemetry(a.sessionId, call(ctx))))?.points ?? [],
      featureFlags: () => d.flags.list(),
    },

    Mutation: {
      startChargingSession: (_: unknown, a: { input: StartSagaInput }) => d.orchestrator.start(a.input),
      stopChargingSession: async (_: unknown, a: { sessionId: string }) => toSession(await d.orchestrator.stopCharging(a.sessionId)),
      topUpWallet: (_: unknown, a: { fleetId: string; amount: number }, ctx: GatewayContext) => {
        if (!Number.isInteger(a.amount) || a.amount <= 0) {
          throw new GraphQLError('amount debe ser un entero positivo (COP)', { extensions: { code: 'BAD_USER_INPUT' } });
        }
        return d.clients.topUp(a.fleetId, a.amount, call(ctx));
      },
      setFeatureFlag: async (_: unknown, a: { name: string; enabled: boolean }, ctx: GatewayContext) => {
        if (d.env === 'prod' && !ctx.isAdmin) {
          throw new GraphQLError('En prod cambiar una flag requiere el header x-admin-token', {
            extensions: { code: 'FORBIDDEN', http: { status: 403 } },
          });
        }
        const flag = await d.flagWriter.set(a.name, a.enabled, ctx.isAdmin ? 'graphql-gateway:admin' : 'graphql-gateway');
        d.flagWatcher.notify(flag);
        return flag;
      },
    },

    Subscription: {
      sagaUpdated: {
        subscribe: withFilter(
          () => d.events.pubsub.asyncIterableIterator(TOPICS.SAGA_UPDATED),
          (payload, args?: { correlationId?: string }) =>
            !args?.correlationId || payload?.sagaUpdated.correlationId === args.correlationId,
        ),
      },
      flagChanged: {
        subscribe: () => d.events.pubsub.asyncIterableIterator(TOPICS.FLAG_CHANGED),
      },
      connectorStatusChanged: {
        subscribe: () => d.events.pubsub.asyncIterableIterator(TOPICS.CONNECTOR_STATUS_CHANGED),
        // El evento trae solo el cambio; se completa con el estado actual del conector.
        resolve: async (payload: { connectorStatusChanged: ConnectorEvent }) => {
          const e = payload.connectorStatusChanged;
          const station = await orNull(d.clients.station(e.stationId, { correlationId: e.sagaId ?? 'subscription-00' }));
          const current = station?.connectors.find((c) => c.connectorId === e.connectorId);
          return current ?? { connectorId: e.connectorId, stationId: e.stationId, type: 'UNKNOWN', powerKw: 0, status: e.status, sagaId: e.sagaId };
        },
      },
    },
  };
}
