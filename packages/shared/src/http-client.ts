import { CORRELATION_HEADER } from './correlation.js';
import { IDEMPOTENCY_HEADER } from './idempotency.js';

/**
 * Cliente HTTP para las llamadas REST internas (gateway -> microservicios).
 *   - timeout por intento (AbortSignal.timeout)
 *   - reintentos solo en fallos transitorios: red, timeout, 429 y 5xx
 *   - backoff exponencial con *full jitter* para no sincronizar a los clientes
 *   - propaga x-correlation-id e Idempotency-Key (reintentar es seguro porque
 *     los servicios son idempotentes por esa clave)
 */
export interface RetryPolicy {
  /** Intentos totales (1 = sin reintentos). */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 100, maxDelayMs: 2000, timeoutMs: 2000 };

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: unknown,
    readonly attempts = 1,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  /** status 0 = sin respuesta (red o timeout). */
  get retryable(): boolean {
    return isRetryableStatus(this.status);
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

/** delay = random(0, min(max, base * 2^intento)) */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.floor(random() * cap);
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  correlationId?: string;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  policy?: Partial<RetryPolicy>;
  onRetry?: (info: { attempt: number; delayMs: number; error: HttpError }) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function requestJson<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
  const policy = { ...DEFAULT_RETRY, ...opts.policy };
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.correlationId) headers[CORRELATION_HEADER] = opts.correlationId;
  if (opts.idempotencyKey) headers[IDEMPOTENCY_HEADER] = opts.idempotencyKey;

  let lastError: HttpError | undefined;
  for (let attempt = 0; attempt < policy.attempts; attempt++) {
    if (attempt > 0 && lastError) {
      const delayMs = backoffDelay(attempt, policy, opts.random);
      opts.onRetry?.({ attempt, delayMs, error: lastError });
      await sleep(delayMs);
    }
    try {
      const res = await doFetch(url, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(policy.timeoutMs),
      });
      const text = await res.text();
      const data: unknown = text ? safeJson(text) : undefined;
      if (res.ok) return data as T;
      const err = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
      lastError = new HttpError(
        res.status,
        err?.code ?? `HTTP_${res.status}`,
        err?.message ?? res.statusText,
        data,
        attempt + 1,
      );
    } catch (e) {
      const name = (e as Error).name;
      const code = name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR';
      lastError = new HttpError(0, code, (e as Error).message, undefined, attempt + 1);
    }
    if (!lastError.retryable) throw lastError;
  }
  throw lastError!;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
