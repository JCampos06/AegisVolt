import { timingSafeEqual } from 'node:crypto';
import { ApolloServer, type GraphQLRequestContext } from '@apollo/server';
import { unwrapResolverError } from '@apollo/server/errors';
import fastifyApollo, { fastifyApolloDrainPlugin } from '@as-integrations/fastify';
import cors from '@fastify/cors';
import { makeExecutableSchema } from '@graphql-tools/schema';
import type { FastifyInstance } from 'fastify';
import type { GraphQLFormattedError } from 'graphql';
import { useServer } from 'graphql-ws/use/ws';
import { WebSocketServer } from 'ws';
import {
  DomainError,
  HttpError,
  createServiceApp,
  resolveCorrelationId,
  type Logger,
  type ServiceConfig,
} from '@aegisvolt/shared';
import { buildResolvers, type GatewayContext, type ResolverDeps } from './resolvers.js';
import { typeDefs } from './schema.js';

export const SERVICE = 'graphql-gateway';

export interface GatewayAppDeps extends ResolverDeps {
  config: ServiceConfig;
  logger: Logger;
  adminToken?: string;
  corsOrigins?: string[];
  healthCheck?: () => Promise<Record<string, unknown>>;
  /** false en pruebas con inject (no hay servidor HTTP escuchando). */
  websockets?: boolean;
}

/**
 * Fastify + Apollo Server (HTTP POST /graphql) + graphql-ws (WebSocket /graphql)
 * para las Subscriptions. Errores de los servicios se exponen con su código
 * estable en `extensions.code` (INSUFFICIENT_FUNDS, CONNECTOR_UNAVAILABLE, ...).
 */
export async function buildGatewayApp(deps: GatewayAppDeps): Promise<FastifyInstance> {
  const { config, logger } = deps;
  const app = createServiceApp({ config, logger, healthCheck: deps.healthCheck });
  await app.register(cors, { origin: deps.corsOrigins?.length ? deps.corsOrigins : true });

  const schema = makeExecutableSchema({ typeDefs, resolvers: buildResolvers(deps) });
  const isAdmin = (token: unknown) => checkToken(deps.adminToken, token);

  let wsCleanup: { dispose: () => void | Promise<void> } | undefined;
  if (deps.websockets !== false) {
    const wss = new WebSocketServer({ server: app.server, path: '/graphql' });
    wsCleanup = useServer<Record<string, unknown>>(
      {
        schema,
        context: (ctx): GatewayContext => ({
          correlationId: resolveCorrelationId(undefined),
          isAdmin: isAdmin(ctx.connectionParams?.adminToken),
        }),
      },
      wss,
    );
  }

  const apollo = new ApolloServer<GatewayContext>({
    schema,
    introspection: config.env !== 'prod',
    formatError,
    plugins: [
      fastifyApolloDrainPlugin(app),
      { async serverWillStart() { return { async drainServer() { await wsCleanup?.dispose(); } }; } },
      {
        async requestDidStart({ request, contextValue }: GraphQLRequestContext<GatewayContext>) {
          return {
            async didEncounterErrors({ errors }) {
              for (const e of errors) {
                const original = unwrapResolverError(e);
                if (!(original instanceof DomainError) && !(original instanceof HttpError) && !e.extensions?.code) {
                  logger.error({ correlation_id: contextValue.correlationId, operation: request.operationName, error: original }, 'error GraphQL');
                }
              }
            },
          };
        },
      },
    ],
  });
  await apollo.start();

  await app.register(fastifyApollo(apollo), {
    context: async (req) => ({ correlationId: req.id, isAdmin: isAdmin(req.headers['x-admin-token']) }),
  });

  return app;
}

function checkToken(expected: string | undefined, received: unknown): boolean {
  if (!expected || typeof received !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

function formatError(formatted: GraphQLFormattedError, error: unknown): GraphQLFormattedError {
  const original = unwrapResolverError(error);
  if (original instanceof DomainError) {
    return { ...formatted, message: original.message, extensions: { code: original.code, httpStatus: original.statusCode, details: original.details } };
  }
  if (original instanceof HttpError) {
    return { ...formatted, message: original.message, extensions: { code: original.code, httpStatus: original.status } };
  }
  return formatted;
}
