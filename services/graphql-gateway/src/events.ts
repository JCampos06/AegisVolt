import { PubSub } from 'graphql-subscriptions';
import type { FeatureFlag } from '@aegisvolt/shared';
import type { Saga } from './saga/model.js';

/**
 * Eventos que alimentan las Subscriptions GraphQL (WebSocket).
 * PubSub en memoria: alcanza para una réplica del gateway. Con varias réplicas
 * se reemplazaría por un bus compartido (Redis, EventBridge, DynamoDB Streams).
 */
export interface ConnectorEvent {
  stationId: string;
  connectorId: string;
  status: string;
  sagaId?: string;
}

export const TOPICS = {
  SAGA_UPDATED: 'SAGA_UPDATED',
  CONNECTOR_STATUS_CHANGED: 'CONNECTOR_STATUS_CHANGED',
  FLAG_CHANGED: 'FLAG_CHANGED',
} as const;

type Payloads = {
  SAGA_UPDATED: { sagaUpdated: Saga };
  CONNECTOR_STATUS_CHANGED: { connectorStatusChanged: ConnectorEvent };
  FLAG_CHANGED: { flagChanged: FeatureFlag };
};

export class GatewayEvents {
  readonly pubsub = new PubSub<Payloads>();

  sagaUpdated(saga: Saga): void {
    void this.pubsub.publish(TOPICS.SAGA_UPDATED, { sagaUpdated: saga });
  }

  connectorChanged(event: ConnectorEvent): void {
    void this.pubsub.publish(TOPICS.CONNECTOR_STATUS_CHANGED, { connectorStatusChanged: event });
  }

  flagChanged(flag: FeatureFlag): void {
    void this.pubsub.publish(TOPICS.FLAG_CHANGED, { flagChanged: flag });
  }
}
