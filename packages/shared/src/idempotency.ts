import { badRequest } from './errors.js';

/**
 * Cada paso y cada compensación de la SAGA viaja con
 *   Idempotency-Key: <sagaId>:<step>
 * El servicio exige el header y que coincida con el sagaId del cuerpo: así un
 * reintento de la misma saga es reconocible y nunca se aplica dos veces.
 * La garantía real está en DynamoDB (ConditionExpression), no en memoria.
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

export type SagaStep = 'reserve' | 'release' | 'hold' | 'refund' | 'activate' | 'stop';

export function buildIdempotencyKey(sagaId: string, step: SagaStep): string {
  return `${sagaId}:${step}`;
}

export function assertIdempotencyKey(
  headers: Record<string, string | string[] | undefined>,
  sagaId: string,
  step: SagaStep,
): string {
  const raw = headers[IDEMPOTENCY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const expected = buildIdempotencyKey(sagaId, step);
  if (!value) {
    throw badRequest('IDEMPOTENCY_KEY_REQUIRED', `Falta el header Idempotency-Key (esperado "${expected}")`);
  }
  if (value !== expected) {
    throw badRequest('IDEMPOTENCY_KEY_MISMATCH', `Idempotency-Key "${value}" no corresponde a "${expected}"`);
  }
  return value;
}
