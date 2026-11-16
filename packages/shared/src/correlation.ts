import { randomUUID } from 'node:crypto';

/**
 * correlation_id: viaja en el header x-correlation-id por todas las llamadas
 * REST de una saga y aparece en cada línea de log (CloudWatch), así se puede
 * reconstruir la saga completa con `scripts/trace-saga.sh <id> <env>`.
 */
export const CORRELATION_HEADER = 'x-correlation-id';

const VALID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Usa el id entrante si es válido; si no viene (o es basura), genera uno nuevo. */
export function resolveCorrelationId(value: string | string[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value;
  return v && VALID.test(v) ? v : randomUUID();
}
