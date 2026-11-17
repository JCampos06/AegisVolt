import { gql, type TypedDocumentNode } from '@apollo/client';

export type ConnectorStatus = 'AVAILABLE' | 'RESERVED' | 'CHARGING' | 'FAULT';
export type SagaStatus = 'PENDING' | 'RESERVED' | 'CHARGED' | 'COMPLETED' | 'COMPENSATING' | 'COMPENSATED' | 'FAILED';
export type StepName = 'reserve' | 'hold' | 'activate' | 'stop' | 'refund' | 'release';

export interface Connector {
  id: string;
  stationId: string;
  type: string;
  powerKw: number;
  status: ConnectorStatus;
  ultraFast: boolean;
  reservable: boolean;
  sagaId?: string | null;
}
export interface Station {
  id: string;
  name: string;
  city: string;
  connectors: Connector[];
}
export interface Wallet {
  fleetId: string;
  name: string;
  balance: number;
  currency: string;
}
export interface Quote {
  amount: number;
  surgeMultiplier: number;
  ratePerKwh: number;
  tier: string;
  currency: string;
}
export interface SagaStep {
  step: StepName;
  action: 'EXECUTE' | 'COMPENSATE';
  outcome: 'STARTED' | 'SUCCEEDED' | 'FAILED';
  at: string;
  httpStatus?: number | null;
  errorCode?: string | null;
}
export interface SagaFailure {
  step: StepName;
  code: string;
  message: string;
}
export interface Saga {
  correlationId: string;
  env: string;
  status: SagaStatus;
  fleetId: string;
  stationId: string;
  connectorId: string;
  kwh: number;
  amount?: number | null;
  surgeMultiplier?: number | null;
  failure?: SagaFailure | null;
  steps: SagaStep[];
  createdAt: string;
  updatedAt: string;
}
export interface FeatureFlag {
  name: string;
  enabled: boolean;
  description?: string | null;
  updatedAt?: string | null;
  updatedBy?: string | null;
}

const CONNECTOR = 'id stationId type powerKw status ultraFast reservable sagaId';
const SAGA = `correlationId env status fleetId stationId connectorId kwh amount surgeMultiplier
  failure { step code message } steps { step action outcome at httpStatus errorCode } createdAt updatedAt`;
const FLAG = 'name enabled description updatedAt updatedBy';

export const ENVIRONMENT: TypedDocumentNode<{ environment: string }> = gql`
  query Environment {
    environment
  }
`;

export const STATIONS: TypedDocumentNode<{ stations: Station[] }> = gql`
  query Stations {
    stations { id name city connectors { ${CONNECTOR} } }
  }
`;

export const CONNECTOR_CHANGED: TypedDocumentNode<{ connectorStatusChanged: Connector }> = gql`
  subscription ConnectorChanged {
    connectorStatusChanged { ${CONNECTOR} }
  }
`;

export const WALLET: TypedDocumentNode<{ wallet: Wallet | null }, { fleetId: string }> = gql`
  query Wallet($fleetId: ID!) {
    wallet(fleetId: $fleetId) { fleetId name balance currency }
  }
`;

export const QUOTE: TypedDocumentNode<{ quote: Quote }, { kwh: number; powerKw: number }> = gql`
  query Quote($kwh: Float!, $powerKw: Float!) {
    quote(kwh: $kwh, powerKw: $powerKw) { amount surgeMultiplier ratePerKwh tier currency }
  }
`;

export interface StartChargingInput {
  fleetId: string;
  stationId: string;
  connectorId: string;
  kwh: number;
  correlationId: string;
}

export const START_CHARGING: TypedDocumentNode<{ startChargingSession: Saga }, { input: StartChargingInput }> = gql`
  mutation StartCharging($input: StartChargingInput!) {
    startChargingSession(input: $input) { ${SAGA} }
  }
`;

export const STOP_CHARGING: TypedDocumentNode<
  { stopChargingSession: { sessionId: string; status: string } },
  { sessionId: string }
> = gql`
  mutation StopCharging($sessionId: ID!) {
    stopChargingSession(sessionId: $sessionId) { sessionId status }
  }
`;

export const SAGA_UPDATED: TypedDocumentNode<{ sagaUpdated: Saga }, { correlationId?: string }> = gql`
  subscription SagaUpdated($correlationId: ID) {
    sagaUpdated(correlationId: $correlationId) { ${SAGA} }
  }
`;

export const SAGAS: TypedDocumentNode<{ sagas: Saga[] }, { status?: SagaStatus | null; limit?: number }> = gql`
  query Sagas($status: SagaStatus, $limit: Int) {
    sagas(status: $status, limit: $limit) { ${SAGA} }
  }
`;

export const FLAGS: TypedDocumentNode<{ featureFlags: FeatureFlag[] }> = gql`
  query Flags {
    featureFlags { ${FLAG} }
  }
`;

export const FLAG_CHANGED: TypedDocumentNode<{ flagChanged: FeatureFlag }> = gql`
  subscription FlagChanged {
    flagChanged { ${FLAG} }
  }
`;

export const SET_FLAG: TypedDocumentNode<{ setFeatureFlag: FeatureFlag }, { name: string; enabled: boolean }> = gql`
  mutation SetFlag($name: String!, $enabled: Boolean!) {
    setFeatureFlag(name: $name, enabled: $enabled) { ${FLAG} }
  }
`;
