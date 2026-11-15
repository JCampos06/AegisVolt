import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { HttpError, createLogger } from '@aegisvolt/shared';
import type { SagaParticipants } from '../src/clients.js';
import { GatewayEvents } from '../src/events.js';
import { SagaOrchestrator } from '../src/saga/orchestrator.js';
import { InMemorySagaStore } from '../src/saga/store.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    service: 'graphql-gateway',
    env: 'test',
    version: 't',
    level: 'debug',
    destination: new Writable({
      write(c, _e, cb) {
        for (const l of String(c).split('\n').filter(Boolean)) lines.push(JSON.parse(l));
        cb();
      },
    }),
  });
  return { logger, lines };
}

const quote = { kwh: 10, powerKw: 50, tier: 'DC_FAST', ratePerKwh: 1500, surgeMultiplier: 1.5, amount: 22500, currency: 'COP' };
const session = { sagaId: 's', stationId: 'BOG-01', connectorId: 'C1', fleetId: 'F1', powerKw: 50, kwhTarget: 10, status: 'ACTIVE', startedAt: 'now' };

function participants(overrides: Partial<SagaParticipants> = {}): SagaParticipants {
  return {
    reserve: vi.fn(async () => ({ reservation: { powerKw: 50 }, alreadyApplied: false })),
    hold: vi.fn(async () => ({ hold: { amount: 22500 }, quote, alreadyApplied: false })),
    activate: vi.fn(async () => ({ session, alreadyApplied: false })),
    release: vi.fn(async () => ({ outcome: 'RELEASED', alreadyApplied: false })),
    refund: vi.fn(async () => ({ outcome: 'REFUNDED', alreadyApplied: false })),
    stop: vi.fn(async () => ({ session: { ...session, status: 'STOPPED' }, alreadyApplied: false })),
    ...overrides,
  };
}

function setup(p: SagaParticipants) {
  const store = new InMemorySagaStore();
  const events = new GatewayEvents();
  const published: string[] = [];
  vi.spyOn(events, 'sagaUpdated').mockImplementation((s) => void published.push(s.status));
  const { logger, lines } = capture();
  const orchestrator = new SagaOrchestrator({
    store,
    participants: p,
    events,
    logger,
    env: 'test',
    stepPolicy: { attempts: 1 },
    compensationPolicy: { attempts: 1 },
  });
  return { orchestrator, store, published, lines };
}

const input = { fleetId: 'F1', stationId: 'BOG-01', connectorId: 'C1', kwh: 10, correlationId: 'corr-0001' };
const trail = (steps: { step: string; outcome: string }[]) =>
  steps.filter((s) => s.outcome !== 'STARTED').map((s) => `${s.step}:${s.outcome}`);

describe('SagaOrchestrator', () => {
  it('ruta feliz: reserve -> hold -> activate = COMPLETED', async () => {
    const p = participants();
    const { orchestrator, published, lines } = setup(p);
    const saga = await orchestrator.start(input);

    expect(saga).toMatchObject({ status: 'COMPLETED', powerKw: 50, amount: 22500, surgeMultiplier: 1.5 });
    expect(trail(saga.steps)).toEqual(['reserve:SUCCEEDED', 'hold:SUCCEEDED', 'activate:SUCCEEDED']);
    expect(published).toContain('RESERVED');
    expect(published).toContain('CHARGED');
    expect(published.at(-1)).toBe('COMPLETED');
    expect(p.release).not.toHaveBeenCalled();
    // todos los logs de la saga llevan el correlation_id
    const sagaLogs = lines.filter((l) => l.saga_step || l.saga_status);
    expect(sagaLogs.length).toBeGreaterThan(0);
    expect(sagaLogs.every((l) => l.correlation_id === 'corr-0001')).toBe(true);
  });

  it('fondos insuficientes (402): libera el conector, no reembolsa, COMPENSATED', async () => {
    const p = participants({
      hold: vi.fn(async () => {
        throw new HttpError(402, 'INSUFFICIENT_FUNDS', 'sin saldo');
      }),
    });
    const { orchestrator, lines } = setup(p);
    const saga = await orchestrator.start(input);

    expect(saga.status).toBe('COMPENSATED');
    expect(saga.failure).toMatchObject({ step: 'hold', code: 'INSUFFICIENT_FUNDS' });
    expect(trail(saga.steps)).toEqual(['reserve:SUCCEEDED', 'hold:FAILED', 'release:SUCCEEDED']);
    expect(p.refund).not.toHaveBeenCalled();
    expect(p.activate).not.toHaveBeenCalled();
    expect(lines.some((l) => l.saga_status === 'COMPENSATED')).toBe(true);
  });

  it('fallo físico del cargador (422): C2 refund y luego C1 release, COMPENSATED', async () => {
    const p = participants({
      activate: vi.fn(async () => {
        throw new HttpError(422, 'CHARGER_HARDWARE_FAULT', 'falla');
      }),
    });
    const { orchestrator } = setup(p);
    const saga = await orchestrator.start(input);

    expect(saga.status).toBe('COMPENSATED');
    expect(trail(saga.steps)).toEqual([
      'reserve:SUCCEEDED',
      'hold:SUCCEEDED',
      'activate:FAILED',
      'refund:SUCCEEDED',
      'release:SUCCEEDED',
    ]);
    expect(p.stop).not.toHaveBeenCalled();
    const refundOrder = vi.mocked(p.refund).mock.invocationCallOrder[0]!;
    const releaseOrder = vi.mocked(p.release).mock.invocationCallOrder[0]!;
    expect(refundOrder).toBeLessThan(releaseOrder);
  });

  it('conector ocupado (409 en el paso 1): FAILED sin compensaciones', async () => {
    const p = participants({
      reserve: vi.fn(async () => {
        throw new HttpError(409, 'CONNECTOR_UNAVAILABLE', 'ocupado');
      }),
    });
    const saga = await setup(p).orchestrator.start(input);
    expect(saga.status).toBe('FAILED');
    expect(p.release).not.toHaveBeenCalled();
    expect(p.hold).not.toHaveBeenCalled();
  });

  it('timeout en activate (resultado desconocido): también detiene la sesión antes de compensar', async () => {
    const p = participants({
      activate: vi.fn(async () => {
        throw new HttpError(0, 'TIMEOUT', 'timeout', undefined, 3);
      }),
      stop: vi.fn(async () => {
        throw new HttpError(404, 'SESSION_NOT_FOUND', 'no existe');
      }),
    });
    const saga = await setup(p).orchestrator.start(input);
    expect(saga.status).toBe('COMPENSATED');
    expect(trail(saga.steps)).toEqual([
      'reserve:SUCCEEDED',
      'hold:SUCCEEDED',
      'activate:FAILED',
      'stop:SUCCEEDED',
      'refund:SUCCEEDED',
      'release:SUCCEEDED',
    ]);
  });

  it('si una compensación se agota, la saga queda COMPENSATING (huérfana para Prefect)', async () => {
    const p = participants({
      activate: vi.fn(async () => {
        throw new HttpError(422, 'CHARGER_HARDWARE_FAULT', 'falla');
      }),
      refund: vi.fn(async () => {
        throw new HttpError(503, 'UNAVAILABLE', 'billing caído', undefined, 6);
      }),
    });
    const { orchestrator, store, lines } = setup(p);
    const saga = await orchestrator.start(input);
    expect(saga.status).toBe('COMPENSATING');
    expect((await store.get('corr-0001'))?.status).toBe('COMPENSATING');
    expect(p.release).not.toHaveBeenCalled();
    expect(lines.some((l) => l.level === 'error' && String(l.message).includes('huérfana'))).toBe(true);
  });

  it('write-ahead: el paso queda STARTED en el store antes de llamar al servicio', async () => {
    let seen: string | undefined;
    const holder: { store?: InMemorySagaStore } = {};
    const p = participants({
      hold: vi.fn(async () => {
        const s = await holder.store!.get('corr-0001');
        seen = `${s?.status}/${s?.steps.at(-1)?.step}:${s?.steps.at(-1)?.outcome}`;
        return { hold: { amount: 22500 }, quote, alreadyApplied: false };
      }),
    });
    const ctx = setup(p);
    holder.store = ctx.store;
    await ctx.orchestrator.start(input);
    expect(seen).toBe('RESERVED/hold:STARTED');
  });

  it('mutation repetida con el mismo correlationId devuelve la saga existente sin volver a ejecutarla', async () => {
    const p = participants();
    const { orchestrator } = setup(p);
    const first = await orchestrator.start(input);
    const second = await orchestrator.start(input);
    expect(second.status).toBe(first.status);
    expect(p.reserve).toHaveBeenCalledTimes(1);
  });

  it('valida la entrada antes de crear la saga', async () => {
    const { orchestrator, store } = setup(participants());
    await expect(orchestrator.start({ ...input, kwh: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(orchestrator.start({ ...input, fleetId: 'x y' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(store.items.size).toBe(0);
  });

  it('stopChargingSession detiene la sesión y libera el conector de una saga COMPLETED', async () => {
    const p = participants();
    const { orchestrator } = setup(p);
    await orchestrator.start(input);
    const s = await orchestrator.stopCharging('corr-0001');
    expect(s.status).toBe('STOPPED');
    expect(p.release).toHaveBeenCalledOnce();
  });
});
