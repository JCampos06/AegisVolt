import { ApolloClient, ApolloLink, HttpLink, InMemoryCache } from '@apollo/client';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { getMainDefinition } from '@apollo/client/utilities';
import { createClient } from 'graphql-ws';

/**
 * La UI y el gateway comparten host (Ingress de cada ambiente: / -> frontend,
 * /graphql -> gateway), así que la misma imagen sirve en dev, test y prod sin
 * recompilar. Queries y mutations por HTTP; subscriptions por WebSocket.
 */
export function graphqlUrls(
  loc: Pick<Location, 'protocol' | 'host'> = window.location,
  configured: string | undefined = import.meta.env.VITE_GRAPHQL_URL,
) {
  const http = new URL(configured || '/graphql', `${loc.protocol}//${loc.host}`);
  const ws = new URL(http);
  ws.protocol = http.protocol === 'https:' ? 'wss:' : 'ws:';
  return { http: http.toString(), ws: ws.toString() };
}

export function createApolloClient() {
  const urls = graphqlUrls();
  const http = new HttpLink({ uri: urls.http });
  const ws = new GraphQLWsLink(createClient({ url: urls.ws, retryAttempts: Infinity, shouldRetry: () => true }));

  const link = ApolloLink.split(
    ({ query }) => {
      const def = getMainDefinition(query);
      return def.kind === 'OperationDefinition' && def.operation === 'subscription';
    },
    ws,
    http,
  );

  return new ApolloClient({
    link,
    cache: new InMemoryCache({
      typePolicies: {
        // El id de un conector (C1, C2...) se repite entre estaciones.
        Connector: { keyFields: ['stationId', 'id'] },
        Saga: { keyFields: ['correlationId'] },
        FeatureFlag: { keyFields: ['name'] },
        Wallet: { keyFields: ['fleetId'] },
        SagaStep: { keyFields: false },
        SagaFailure: { keyFields: false },
      },
    }),
  });
}
