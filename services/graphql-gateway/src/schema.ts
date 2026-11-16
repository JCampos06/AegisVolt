/**
 * Esquema unificado (BFF). Los clientes solo hablan GraphQL; el gateway
 * traduce a REST interno hacia cada bounded context.
 */
export const typeDefs = /* GraphQL */ `
  enum ConnectorStatus {
    AVAILABLE
    RESERVED
    CHARGING
    FAULT
  }

  enum SagaStatus {
    PENDING
    RESERVED
    CHARGED
    COMPLETED
    COMPENSATING
    COMPENSATED
    FAILED
  }

  type Connector {
    id: ID!
    stationId: ID!
    type: String!
    powerKw: Float!
    status: ConnectorStatus!
    "true si es de ultra-carga (>= 150 kW)"
    ultraFast: Boolean!
    "false si es ultra-carga y ENABLE_FAST_CHARGE_BOOST está apagada"
    reservable: Boolean!
    sagaId: ID
  }

  type Station {
    id: ID!
    name: String!
    city: String!
    lat: Float!
    lon: Float!
    connectors: [Connector!]!
  }

  type Wallet {
    fleetId: ID!
    name: String!
    balance: Float!
    currency: String!
  }

  type Quote {
    kwh: Float!
    powerKw: Float!
    tier: String!
    ratePerKwh: Float!
    surgeMultiplier: Float!
    amount: Float!
    currency: String!
  }

  type SagaStep {
    step: String!
    action: String!
    outcome: String!
    at: String!
    attempts: Int
    httpStatus: Int
    errorCode: String
    error: String
    alreadyApplied: Boolean
  }

  type SagaFailure {
    step: String!
    code: String!
    message: String!
  }

  type Saga {
    correlationId: ID!
    env: String!
    status: SagaStatus!
    fleetId: ID!
    stationId: ID!
    connectorId: ID!
    kwh: Float!
    powerKw: Float
    amount: Float
    surgeMultiplier: Float
    failure: SagaFailure
    steps: [SagaStep!]!
    createdAt: String!
    updatedAt: String!
  }

  type ChargingSession {
    sessionId: ID!
    stationId: ID!
    connectorId: ID!
    fleetId: ID!
    powerKw: Float!
    kwhTarget: Float!
    status: String!
    startedAt: String!
    stoppedAt: String
    failureReason: String
  }

  type TelemetryPoint {
    ts: String!
    kw: Float!
    kwh: Float!
    voltage: Float!
  }

  type FeatureFlag {
    name: String!
    enabled: Boolean!
    description: String
    updatedAt: String
    updatedBy: String
  }

  input StartChargingInput {
    fleetId: ID!
    stationId: ID!
    connectorId: ID!
    kwh: Float!
    "Opcional. Reenviar la mutation con el mismo id no crea otra saga."
    correlationId: ID
  }

  type Query {
    stations(status: ConnectorStatus): [Station!]!
    station(id: ID!): Station
    wallet(fleetId: ID!): Wallet
    quote(kwh: Float!, powerKw: Float!): Quote!
    saga(correlationId: ID!): Saga
    sagas(status: SagaStatus, limit: Int = 20): [Saga!]!
    session(sessionId: ID!): ChargingSession
    telemetry(sessionId: ID!): [TelemetryPoint!]!
    featureFlags: [FeatureFlag!]!
    environment: String!
  }

  type Mutation {
    startChargingSession(input: StartChargingInput!): Saga!
    stopChargingSession(sessionId: ID!): ChargingSession!
    setFeatureFlag(name: String!, enabled: Boolean!): FeatureFlag!
    topUpWallet(fleetId: ID!, amount: Float!): Wallet!
  }

  type Subscription {
    connectorStatusChanged: Connector!
    sagaUpdated(correlationId: ID): Saga!
    flagChanged: FeatureFlag!
  }
`;
