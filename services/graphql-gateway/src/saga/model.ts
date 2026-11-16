/**
 * SAGA "Reservar y Activar Carga" (orquestada).
 *
 *   PENDING ─reserve─► RESERVED ─hold─► CHARGED ─activate─► COMPLETED
 *      │                  │                 │
 *      ▼ (4xx)            ▼ (402/5xx)       ▼ (422/5xx)
 *    FAILED          COMPENSATING ──C1 release──► COMPENSATED
 *                    COMPENSATING ──C2 refund ─► C1 release ─► COMPENSATED
 *
 * Si una compensación agota sus reintentos, la saga queda en COMPENSATING
 * (huérfana) y el flow de Prefect la detecta para intervención.
 */
export const SAGA_STATUSES = [
  'PENDING',
  'RESERVED',
  'CHARGED',
  'COMPLETED',
  'COMPENSATING',
  'COMPENSATED',
  'FAILED',
] as const;
export type SagaStatus = (typeof SAGA_STATUSES)[number];

export type ExecuteStep = 'reserve' | 'hold' | 'activate';
export type CompensateStep = 'stop' | 'refund' | 'release';
export type StepName = ExecuteStep | CompensateStep;

export interface SagaStepLog {
  step: StepName;
  action: 'EXECUTE' | 'COMPENSATE';
  outcome: 'STARTED' | 'SUCCEEDED' | 'FAILED';
  at: string;
  attempts?: number;
  httpStatus?: number;
  errorCode?: string;
  error?: string;
  /** El servicio reconoció un reintento/duplicado y no volvió a aplicar el efecto. */
  alreadyApplied?: boolean;
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
  powerKw?: number;
  amount?: number;
  surgeMultiplier?: number;
  failure?: SagaFailure;
  steps: SagaStepLog[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface StartSagaInput {
  fleetId: string;
  stationId: string;
  connectorId: string;
  kwh: number;
  /** Opcional: el cliente puede fijarlo para suscribirse antes y para reintentar la mutation sin duplicar. */
  correlationId?: string;
}

export const TERMINAL: ReadonlySet<SagaStatus> = new Set(['COMPLETED', 'COMPENSATED', 'FAILED']);
