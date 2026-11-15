import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  FeatureFlags,
  StaticFlagSource,
  assertIdempotencyKey,
  backoffDelay,
  badRequest,
  createLogger,
  createServiceApp,
  loadConfig,
  requestJson,
  resolveCorrelationId,
  DEFAULT_RETRY,
  HttpError,
  type FlagSource,
} from '../src/index.js';

function memoryLogger() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      for (const l of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(l));
      cb();
    },
  });
  const logger = createLogger({ service: 'svc', env: 'test', version: '1.2.3', level: 'debug', destination });
  return { logger, lines };
}

describe('config', () => {
  it('deriva nombres de tablas y log group del ambiente', () => {
    const c = loadConfig('billing-wallet-service', 4002, { APP_ENV: 'test' });
    expect(c.tables.billing).toBe('aegisvolt-billing-test');
    expect(c.tables.flags).toBe('aegisvolt-flags-test');
    expect(c.cloudwatch.logGroupName).toBe('/aegisvolt/test/billing-wallet-service');
    expect(c.port).toBe(4002);
  });

  it('rechaza ambientes desconocidos', () => {
    expect(() => loadConfig('x', 1, { APP_ENV: 'staging' })).toThrow(/APP_ENV inválido/);
  });
});

describe('correlation e idempotencia', () => {
  it('conserva un correlation id válido y genera uno si falta o es inválido', () => {
    expect(resolveCorrelationId('saga-1234-abcd')).toBe('saga-1234-abcd');
    expect(resolveCorrelationId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveCorrelationId('<script>')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('exige Idempotency-Key = <sagaId>:<step>', () => {
    expect(assertIdempotencyKey({ 'idempotency-key': 's1:refund' }, 's1', 'refund')).toBe('s1:refund');
    expect(() => assertIdempotencyKey({}, 's1', 'refund')).toThrow(/Falta el header/);
    expect(() => assertIdempotencyKey({ 'idempotency-key': 's2:refund' }, 's1', 'refund')).toThrow(/no corresponde/);
  });
});

describe('FeatureFlags', () => {
  it('cachea 5 s y refleja el cambio después del TTL (sin redeploy)', async () => {
    let now = 0;
    const source = new StaticFlagSource({ ENABLE_DYNAMIC_SURGE_PRICING: false });
    const spy = vi.spyOn(source, 'getAll');
    const flags = new FeatureFlags(source, 5000, undefined, () => now);

    expect(await flags.isEnabled('ENABLE_DYNAMIC_SURGE_PRICING')).toBe(false);
    source.values.ENABLE_DYNAMIC_SURGE_PRICING = true;
    now = 4999;
    expect(await flags.isEnabled('ENABLE_DYNAMIC_SURGE_PRICING')).toBe(false);
    now = 5000;
    expect(await flags.isEnabled('ENABLE_DYNAMIC_SURGE_PRICING')).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('si DynamoDB falla usa el último valor conocido, y sin caché el valor por defecto', async () => {
    let now = 0;
    let fail = false;
    const source: FlagSource = {
      getAll: async () => {
        if (fail) throw new Error('dynamodb caído');
        return [{ name: 'ENABLE_FAST_CHARGE_BOOST', enabled: true }];
      },
    };
    const flags = new FeatureFlags(source, 5000, undefined, () => now);
    expect(await flags.isEnabled('ENABLE_FAST_CHARGE_BOOST')).toBe(true);
    fail = true;
    now = 10_000;
    expect(await flags.isEnabled('ENABLE_FAST_CHARGE_BOOST')).toBe(true);

    const cold = new FeatureFlags(source, 5000);
    expect(await cold.isEnabled('ENABLE_FAST_CHARGE_BOOST')).toBe(false);
  });
});

describe('http-client: retry con backoff exponencial + jitter', () => {
  const noSleep = async () => {};

  it('el backoff crece exponencialmente y respeta el tope', () => {
    const p = { ...DEFAULT_RETRY, baseDelayMs: 100, maxDelayMs: 1000 };
    expect(backoffDelay(1, p, () => 0.999)).toBe(199);
    expect(backoffDelay(2, p, () => 0.999)).toBe(399);
    expect(backoffDelay(10, p, () => 0.999)).toBe(999);
    expect(backoffDelay(3, p, () => 0)).toBe(0);
  });

  it('reintenta 503 y propaga correlation id e Idempotency-Key en cada intento', async () => {
    const calls: Headers[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(new Headers(init?.headers));
      return calls.length < 3
        ? new Response(JSON.stringify({ error: { code: 'UNAVAILABLE' } }), { status: 503 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const retries: number[] = [];
    const out = await requestJson('http://svc/x', {
      method: 'POST',
      body: {},
      correlationId: 'corr-12345678',
      idempotencyKey: 's1:hold',
      fetchImpl: fetchImpl as typeof fetch,
      sleep: noSleep,
      onRetry: ({ attempt }) => retries.push(attempt),
    });
    expect(out).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(retries).toEqual([1, 2]);
    for (const h of calls) {
      expect(h.get('x-correlation-id')).toBe('corr-12345678');
      expect(h.get('idempotency-key')).toBe('s1:hold');
    }
  });

  it('no reintenta errores de negocio (4xx)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'INSUFFICIENT_FUNDS', message: 'sin saldo' } }), { status: 402 }),
    );
    const err = await requestJson('http://svc/x', { fetchImpl: fetchImpl as typeof fetch, sleep: noSleep }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('INSUFFICIENT_FUNDS');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('agota los intentos ante errores de red y reporta el último', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const err = (await requestJson('http://svc/x', { fetchImpl: fetchImpl as typeof fetch, sleep: noSleep }).catch(
      (e: unknown) => e,
    )) as HttpError;
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.attempts).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('createServiceApp', () => {
  const config = loadConfig('svc', 0, { APP_ENV: 'test', APP_VERSION: '1.2.3' });

  it('devuelve el correlation id y lo escribe en el log del request con statusCode', async () => {
    const { logger, lines } = memoryLogger();
    const app = createServiceApp({ config, logger });
    app.get('/ping', async () => ({ pong: true }));
    const res = await app.inject({ url: '/ping', headers: { 'x-correlation-id': 'corr-abcdef12' } });
    expect(res.headers['x-correlation-id']).toBe('corr-abcdef12');
    const log = lines.find((l) => l.message === 'request completed');
    expect(log).toMatchObject({
      level: 'info',
      env: 'test',
      service: 'svc',
      version: '1.2.3',
      correlation_id: 'corr-abcdef12',
      statusCode: 200,
    });
    expect(typeof log?.timestamp).toBe('string');
  });

  it('formatea errores de dominio y de validación', async () => {
    const { logger } = memoryLogger();
    const app = createServiceApp({ config, logger });
    app.get('/boom', async () => {
      throw badRequest('BAD_THING', 'algo salió mal');
    });
    app.post('/v', { schema: { body: { type: 'object', required: ['a'] } } }, async () => ({}));
    expect((await app.inject({ url: '/boom' })).json()).toEqual({
      error: { code: 'BAD_THING', message: 'algo salió mal' },
    });
    const v = await app.inject({ method: 'POST', url: '/v', payload: {} });
    expect(v.statusCode).toBe(400);
    expect(v.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('health responde 503 si la dependencia falla', async () => {
    const { logger } = memoryLogger();
    const app = createServiceApp({
      config,
      logger,
      healthCheck: async () => {
        throw new Error('tabla no existe');
      },
    });
    const res = await app.inject({ url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'degraded', service: 'svc', env: 'test' });
  });

  it('FAULTY_VERSION devuelve 500 en parte del tráfico, nunca en /health, y se ve en /metrics.json', async () => {
    const { logger } = memoryLogger();
    const seq = [0.1, 0.9, 0.2, 0.95];
    let i = 0;
    const app = createServiceApp({
      config: { ...config, faultyVersion: true },
      logger,
      random: () => seq[i++ % seq.length]!,
    });
    app.get('/ping', async () => ({ pong: true }));
    const codes = [];
    for (let n = 0; n < 4; n++) codes.push((await app.inject({ url: '/ping' })).statusCode);
    expect(codes).toEqual([500, 200, 500, 200]);
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/metrics.json' })).json()).toEqual({ total: 4, errors5xx: 2, successRate: 0.5 });
  });
});
