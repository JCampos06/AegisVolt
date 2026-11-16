import { randomUUID } from 'node:crypto';
import { DomainError, HttpError, badRequest, conflict, notFound, type Logger, type RetryPolicy } from '@aegisvolt/shared';
import type { CallContext, SagaParticipants, SessionDto } from '../clients.js';
import type { GatewayEvents } from '../events.js';
import type { CompensateStep, Saga, SagaFailure, SagaStatus, SagaStepLog, StartSagaInput, StepName } from './model.js';
import type { SagaStore } from './store.js';

/**
 * Orquestador de la SAGA "Reservar y Activar Carga".
 *
 * Reglas:
 *  - write-ahead: el paso se registra como STARTED en DynamoDB antes de llamarlo
 *  - pasos: 3 intentos con backoff exponencial + jitter; solo fallos transitorios
 *  - error de negocio (4xx) = resultado definitivo: se compensa sin reintentar
 *  - fallo transitorio agotado = resultado DESCONOCIDO: también se compensa el
 *    propio paso (los servicios dejan una marca si el efecto nunca ocurrió)
 *  - compensaciones: 6 intentos; si se agotan, la saga queda COMPENSATING
 */
export const STEP_POLICY: Partial<RetryPolicy> = { attempts: 3, baseDelayMs: 100, maxDelayMs: 1000, timeoutMs: 2000 };
export const COMPENSATION_POLICY: Partial<RetryPolicy> = { attempts: 6, baseDelayMs: 200, maxDelayMs: 3000, timeoutMs: 3000 };

export interface OrchestratorDeps {
  store: SagaStore;
  participants: SagaParticipants;
  events: GatewayEvents;
  logger: Logger;
  env: string;
  now?: () => Date;
  stepPolicy?: Partial<RetryPolicy>;
  compensationPolicy?: Partial<RetryPolicy>;
}

type StepResult<T> = { ok: true; value: T | undefined } | { ok: false; error: HttpError; definitive: boolean };

const ID = /^[A-Za-z0-9._:-]{1,128}$/;

export class SagaOrchestrator {
  private readonly now: () => Date;

  constructor(private readonly deps: OrchestratorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async start(input: StartSagaInput): Promise<Saga> {
    validate(input);
    const correlationId = input.correlationId ?? randomUUID();
    const at = this.now().toISOString();
    const draft: Saga = {
      correlationId,
      env: this.deps.env,
      status: 'PENDING',
      fleetId: input.fleetId,
      stationId: input.stationId,
      connectorId: input.connectorId,
      kwh: input.kwh,
      steps: [],
      version: 0,
      createdAt: at,
      updatedAt: at,
    };

    const { saga, created } = await this.deps.store.create(draft);
    const log = this.deps.logger.child({ correlation_id: correlationId });
    if (!created) {
      // Mutation repetida con el mismo correlationId: no se vuelve a ejecutar nada.
      log.info({ saga_status: saga.status }, 'saga ya existente (mutation idempotente)');
      return saga;
    }
    this.deps.events.sagaUpdated(saga);
    log.info(
      { saga_status: 'PENDING', fleetId: input.fleetId, stationId: input.stationId, connectorId: input.connectorId, kwh: input.kwh },
      'saga iniciada',
    );
    return new SagaRun(saga, this.deps, this.now, log).execute();
  }

  /** Fin normal de la carga: detiene la sesión y libera el conector. */
  async stopCharging(sagaId: string): Promise<SessionDto> {
    const saga = await this.deps.store.get(sagaId);
    if (!saga) throw notFound('SAGA_NOT_FOUND', `No existe la saga ${sagaId}`);
    if (saga.status !== 'COMPLETED') {
      throw conflict('SESSION_NOT_ACTIVE', `La saga ${sagaId} está en ${saga.status}; solo se detienen sesiones COMPLETED`);
    }
    const log = this.deps.logger.child({ correlation_id: sagaId });
    const ctx: CallContext = { correlationId: sagaId, policy: this.deps.compensationPolicy ?? COMPENSATION_POLICY };
    const { session } = await this.deps.participants.stop(sagaId, ctx);
    await this.deps.participants.release(sagaId, ctx);
    this.deps.events.connectorChanged({ stationId: saga.stationId, connectorId: saga.connectorId, status: 'AVAILABLE' });
    log.info({ saga_step: 'stop', sessionStatus: session.status }, 'sesión de carga finalizada y conector liberado');
    return session;
  }
}

class SagaRun {
  constructor(
    private saga: Saga,
    private readonly deps: OrchestratorDeps,
    private readonly now: () => Date,
    private readonly log: Logger,
  ) {}

  async execute(): Promise<Saga> {
    const { participants: p } = this.deps;
    const s = this.saga;
    const base = { sagaId: s.correlationId, stationId: s.stationId, connectorId: s.connectorId, fleetId: s.fleetId };

    // Paso 1: reservar el conector.
    const r1 = await this.step('reserve', (ctx) => p.reserve(base, ctx));
    if (!r1.ok) {
      return r1.definitive ? this.finish('FAILED', failure('reserve', r1.error)) : this.compensate(['release'], failure('reserve', r1.error));
    }
    await this.persist({ status: 'RESERVED', powerKw: r1.value!.reservation.powerKw });
    this.deps.events.connectorChanged({ stationId: s.stationId, connectorId: s.connectorId, status: 'RESERVED', sagaId: s.correlationId });

    // Paso 2: retener el saldo.
    const powerKw = this.saga.powerKw!;
    const r2 = await this.step('hold', (ctx) => p.hold({ sagaId: s.correlationId, fleetId: s.fleetId, kwh: s.kwh, powerKw }, ctx));
    if (!r2.ok) {
      return this.compensate(r2.definitive ? ['release'] : ['refund', 'release'], failure('hold', r2.error));
    }
    await this.persist({ status: 'CHARGED', amount: r2.value!.hold.amount, surgeMultiplier: r2.value!.quote?.surgeMultiplier });

    // Paso 3: activar el cargador.
    const r3 = await this.step('activate', (ctx) => p.activate({ ...base, kwh: s.kwh, powerKw }, ctx));
    if (!r3.ok) {
      return this.compensate(r3.definitive ? ['refund', 'release'] : ['stop', 'refund', 'release'], failure('activate', r3.error));
    }
    return this.finish('COMPLETED');
  }

  private async compensate(steps: CompensateStep[], cause: SagaFailure): Promise<Saga> {
    await this.persist({ status: 'COMPENSATING', failure: cause });
    this.log.warn({ saga_status: 'COMPENSATING', failedStep: cause.step, errorCode: cause.code, compensations: steps }, 'iniciando compensaciones');
    const { participants: p } = this.deps;
    const s = this.saga;

    for (const step of steps) {
      const result =
        step === 'stop'
          ? // Si la sesión nunca se creó (404) o ya no está activa (409), no hay nada que detener.
            await this.step(step, (ctx) => p.stop(s.correlationId, ctx), (e) => e.status === 404 || e.status === 409)
          : step === 'refund'
            ? await this.step(step, (ctx) => p.refund(s.correlationId, s.fleetId, ctx))
            : await this.step(step, (ctx) => p.release(s.correlationId, ctx));

      if (!result.ok) {
        await this.persist();
        this.log.error(
          { saga_status: 'COMPENSATING', saga_step: step, errorCode: result.error.code },
          'compensación agotada: la saga queda huérfana para revisión (Prefect)',
        );
        return this.saga;
      }
      if (step === 'release') {
        this.deps.events.connectorChanged({ stationId: s.stationId, connectorId: s.connectorId, status: 'AVAILABLE' });
      }
    }
    return this.finish('COMPENSATED');
  }

  private async finish(status: SagaStatus, cause?: SagaFailure): Promise<Saga> {
    await this.persist({ status, ...(cause ? { failure: cause } : {}) });
    const fields = { saga_status: status, amount: this.saga.amount, failure: this.saga.failure };
    if (status === 'COMPLETED') this.log.info(fields, 'saga finalizada');
    else this.log.warn(fields, 'saga finalizada');
    return this.saga;
  }

  private async step<T extends { alreadyApplied?: boolean }>(
    step: StepName,
    fn: (ctx: CallContext) => Promise<T>,
    acceptError?: (e: HttpError) => boolean,
  ): Promise<StepResult<T>> {
    const action: SagaStepLog['action'] = step === 'reserve' || step === 'hold' || step === 'activate' ? 'EXECUTE' : 'COMPENSATE';
    this.saga.steps.push({ step, action, outcome: 'STARTED', at: this.now().toISOString() });
    await this.persist(); // write-ahead

    let attempts = 1;
    const ctx: CallContext = {
      correlationId: this.saga.correlationId,
      policy: action === 'EXECUTE' ? (this.deps.stepPolicy ?? STEP_POLICY) : (this.deps.compensationPolicy ?? COMPENSATION_POLICY),
      onRetry: ({ attempt, delayMs, error }) => {
        attempts = attempt + 1;
        this.log.warn({ saga_step: step, attempt: attempts, delayMs, httpStatus: error.status, errorCode: error.code }, 'reintentando llamada');
      },
    };

    try {
      const value = await fn(ctx);
      this.record(step, action, 'SUCCEEDED', { attempts, alreadyApplied: value?.alreadyApplied ?? false });
      this.log.info({ saga_step: step, action, attempts, alreadyApplied: value?.alreadyApplied ?? false }, 'paso completado');
      return { ok: true, value };
    } catch (e) {
      const error = toHttpError(e);
      if (acceptError?.(error)) {
        this.record(step, action, 'SUCCEEDED', { attempts: error.attempts, httpStatus: error.status, errorCode: error.code });
        this.log.info({ saga_step: step, action, httpStatus: error.status, errorCode: error.code }, 'paso sin efecto pendiente');
        return { ok: true, value: undefined };
      }
      this.record(step, action, 'FAILED', {
        attempts: error.attempts,
        httpStatus: error.status,
        errorCode: error.code,
        error: error.message,
      });
      const definitive = !error.retryable;
      (definitive ? this.log.warn : this.log.error).call(
        this.log,
        { saga_step: step, action, attempts: error.attempts, httpStatus: error.status, errorCode: error.code, definitive },
        'paso fallido',
      );
      return { ok: false, error, definitive };
    }
  }

  private record(step: StepName, action: SagaStepLog['action'], outcome: SagaStepLog['outcome'], extra: Partial<SagaStepLog>) {
    this.saga.steps.push({ step, action, outcome, at: this.now().toISOString(), ...extra });
  }

  private async persist(patch: Partial<Saga> = {}): Promise<void> {
    const next = { ...this.saga, ...patch, updatedAt: this.now().toISOString() };
    this.saga = await this.deps.store.save(next);
    this.deps.events.sagaUpdated(this.saga);
  }
}

function failure(step: StepName, e: HttpError): SagaFailure {
  return { step, code: e.code, message: e.message };
}

function toHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof DomainError) return new HttpError(e.statusCode, e.code, e.message);
  return new HttpError(0, 'INTERNAL', (e as Error)?.message ?? String(e));
}

function validate(input: StartSagaInput): void {
  for (const field of ['fleetId', 'stationId', 'connectorId'] as const) {
    if (!ID.test(input[field])) throw badRequest('INVALID_INPUT', `${field} inválido`);
  }
  if (input.correlationId !== undefined && !/^[A-Za-z0-9._:-]{8,128}$/.test(input.correlationId)) {
    throw badRequest('INVALID_INPUT', 'correlationId inválido (8-128 caracteres [A-Za-z0-9._:-])');
  }
  if (!(input.kwh > 0 && input.kwh <= 1000)) throw badRequest('INVALID_INPUT', 'kwh debe estar entre 0 y 1000');
}
