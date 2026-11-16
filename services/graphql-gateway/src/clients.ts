import { buildIdempotencyKey, requestJson, type RequestOptions, type RetryPolicy } from '@aegisvolt/shared';

/**
 * Clientes REST internos hacia los microservicios (Service ClusterIP en k8s).
 * Cada llamada lleva x-correlation-id; los pasos y compensaciones además la
 * Idempotency-Key <sagaId>:<step>, lo que hace seguro reintentar.
 */
export interface ServiceUrls {
  reservation: string;
  billing: string;
  dispatch: string;
}

export interface CallContext {
  correlationId: string;
  policy?: Partial<RetryPolicy>;
  onRetry?: RequestOptions['onRetry'];
}

export interface ConnectorDto {
  stationId: string;
  connectorId: string;
  type: string;
  powerKw: number;
  status: string;
  sagaId?: string;
  ultraFast?: boolean;
  reservable?: boolean;
}
export interface StationDto {
  stationId: string;
  name: string;
  city: string;
  lat: number;
  lon: number;
  connectors: ConnectorDto[];
}
export interface WalletDto {
  fleetId: string;
  name: string;
  balance: number;
  currency: string;
}
export interface QuoteDto {
  kwh: number;
  powerKw: number;
  tier: string;
  ratePerKwh: number;
  surgeMultiplier: number;
  amount: number;
  currency: string;
}
export interface SessionDto {
  sagaId: string;
  stationId: string;
  connectorId: string;
  fleetId: string;
  powerKw: number;
  kwhTarget: number;
  status: string;
  startedAt: string;
  stoppedAt?: string;
  failureReason?: string;
}
export interface TelemetryPointDto {
  ts: string;
  kw: number;
  kwh: number;
  voltage: number;
}

/** Operaciones que el orquestador usa (los pasos de la saga y sus compensaciones). */
export interface SagaParticipants {
  reserve(
    input: { sagaId: string; stationId: string; connectorId: string; fleetId: string },
    ctx: CallContext,
  ): Promise<{ reservation: { powerKw: number }; alreadyApplied: boolean }>;
  release(sagaId: string, ctx: CallContext): Promise<{ outcome: string; alreadyApplied: boolean }>;
  hold(
    input: { sagaId: string; fleetId: string; kwh: number; powerKw: number },
    ctx: CallContext,
  ): Promise<{ hold: { amount: number }; quote: QuoteDto; alreadyApplied: boolean }>;
  refund(sagaId: string, fleetId: string, ctx: CallContext): Promise<{ outcome: string; alreadyApplied: boolean }>;
  activate(
    input: { sagaId: string; stationId: string; connectorId: string; fleetId: string; kwh: number; powerKw: number },
    ctx: CallContext,
  ): Promise<{ session: SessionDto; alreadyApplied: boolean }>;
  stop(sagaId: string, ctx: CallContext): Promise<{ session: SessionDto; alreadyApplied: boolean }>;
}

export class ServiceClients implements SagaParticipants {
  constructor(
    private readonly urls: ServiceUrls,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  private call<T>(base: string, path: string, ctx: CallContext, opts: Partial<RequestOptions> = {}) {
    return requestJson<T>(`${base}${path}`, {
      correlationId: ctx.correlationId,
      policy: ctx.policy,
      onRetry: ctx.onRetry,
      fetchImpl: this.fetchImpl,
      ...opts,
    });
  }

  // ---- Pasos SAGA ----
  reserve(input: Parameters<SagaParticipants['reserve']>[0], ctx: CallContext) {
    return this.call<Awaited<ReturnType<SagaParticipants['reserve']>>>(this.urls.reservation, '/reservations', ctx, {
      method: 'POST',
      body: input,
      idempotencyKey: buildIdempotencyKey(input.sagaId, 'reserve'),
    });
  }

  release(sagaId: string, ctx: CallContext) {
    return this.call<{ outcome: string; alreadyApplied: boolean }>(
      this.urls.reservation,
      `/reservations/${encodeURIComponent(sagaId)}/release`,
      ctx,
      { method: 'POST', idempotencyKey: buildIdempotencyKey(sagaId, 'release') },
    );
  }

  hold(input: Parameters<SagaParticipants['hold']>[0], ctx: CallContext) {
    return this.call<Awaited<ReturnType<SagaParticipants['hold']>>>(this.urls.billing, '/holds', ctx, {
      method: 'POST',
      body: input,
      idempotencyKey: buildIdempotencyKey(input.sagaId, 'hold'),
    });
  }

  refund(sagaId: string, fleetId: string, ctx: CallContext) {
    return this.call<{ outcome: string; alreadyApplied: boolean }>(
      this.urls.billing,
      `/holds/${encodeURIComponent(sagaId)}/refund`,
      ctx,
      { method: 'POST', body: { fleetId }, idempotencyKey: buildIdempotencyKey(sagaId, 'refund') },
    );
  }

  activate(input: Parameters<SagaParticipants['activate']>[0], ctx: CallContext) {
    return this.call<{ session: SessionDto; alreadyApplied: boolean }>(this.urls.dispatch, '/sessions', ctx, {
      method: 'POST',
      body: input,
      idempotencyKey: buildIdempotencyKey(input.sagaId, 'activate'),
    });
  }

  stop(sagaId: string, ctx: CallContext) {
    return this.call<{ session: SessionDto; alreadyApplied: boolean }>(
      this.urls.dispatch,
      `/sessions/${encodeURIComponent(sagaId)}/stop`,
      ctx,
      { method: 'POST', idempotencyKey: buildIdempotencyKey(sagaId, 'stop') },
    );
  }

  // ---- Consultas (BFF) ----
  stations(status: string | undefined, ctx: CallContext) {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.call<StationDto[]>(this.urls.reservation, `/stations${qs}`, ctx);
  }

  station(id: string, ctx: CallContext) {
    return this.call<StationDto>(this.urls.reservation, `/stations/${encodeURIComponent(id)}`, ctx);
  }

  wallet(fleetId: string, ctx: CallContext) {
    return this.call<WalletDto>(this.urls.billing, `/wallets/${encodeURIComponent(fleetId)}`, ctx);
  }

  topUp(fleetId: string, amount: number, ctx: CallContext) {
    // Sin reintentos: una recarga no lleva clave de idempotencia.
    return this.call<WalletDto>(this.urls.billing, `/wallets/${encodeURIComponent(fleetId)}/topup`, ctx, {
      method: 'POST',
      body: { amount },
      policy: { attempts: 1 },
    });
  }

  quote(kwh: number, powerKw: number, ctx: CallContext) {
    return this.call<QuoteDto>(this.urls.billing, `/quote?kwh=${kwh}&powerKw=${powerKw}`, ctx);
  }

  session(sagaId: string, ctx: CallContext) {
    return this.call<SessionDto>(this.urls.dispatch, `/sessions/${encodeURIComponent(sagaId)}`, ctx);
  }

  telemetry(sagaId: string, ctx: CallContext) {
    return this.call<{ points: TelemetryPointDto[] }>(
      this.urls.dispatch,
      `/sessions/${encodeURIComponent(sagaId)}/telemetry`,
      ctx,
    );
  }
}
