import { describe, expect, it } from 'vitest';
import type { Saga, SagaStep } from '../src/graphql';
import { deriveDiagram, latest, partialSaga } from '../src/saga-view';
import { failureText } from '../src/labels';

const at = '2026-11-17T12:00:00.000Z';
const step = (step: SagaStep['step'], action: SagaStep['action'], outcome: SagaStep['outcome']): SagaStep => ({ step, action, outcome, at });
const ok = (s: SagaStep['step']) => [step(s, 'EXECUTE', 'STARTED'), step(s, 'EXECUTE', 'SUCCEEDED')];

const saga = (status: Saga['status'], steps: SagaStep[], extra: Partial<Saga> = {}): Saga => ({
  correlationId: 'ui-1',
  env: 'dev',
  status,
  fleetId: 'FLEET-NORTE-EV',
  stationId: 'BOG-01',
  connectorId: 'C1',
  kwh: 10,
  steps,
  createdAt: at,
  updatedAt: at,
  ...extra,
});

describe('deriveDiagram', () => {
  it('saga completada: los 3 interruptores cerrados y el vehículo energizado', () => {
    const d = deriveDiagram([...ok('reserve'), ...ok('hold'), ...ok('activate')], 'COMPLETED');
    expect(d.switches).toEqual(['closed', 'closed', 'closed']);
    expect(d.live).toEqual([true, true, true, true]);
    expect(d.load).toBe(true);
    expect(d.refund || d.release).toBe(false);
  });

  it('paso en curso: el tramo hasta el interruptor queda energizado', () => {
    const d = deriveDiagram([...ok('reserve'), step('hold', 'EXECUTE', 'STARTED')], 'RUNNING');
    expect(d.switches).toEqual(['closed', 'running', 'open']);
    expect(d.live).toEqual([true, true, false, false]);
    expect(d.switchText[1]).toBe('en curso');
  });

  it('falla de hardware en activate: devuelve saldo y libera conector', () => {
    const steps = [
      ...ok('reserve'),
      ...ok('hold'),
      step('activate', 'EXECUTE', 'STARTED'),
      step('activate', 'EXECUTE', 'FAILED'),
      step('refund', 'COMPENSATE', 'STARTED'),
      step('refund', 'COMPENSATE', 'SUCCEEDED'),
      step('release', 'COMPENSATE', 'STARTED'),
      step('release', 'COMPENSATE', 'SUCCEEDED'),
    ];
    const d = deriveDiagram(steps, 'COMPENSATED');
    expect(d.switches).toEqual(['undone', 'undone', 'fault']);
    expect(d.switchText).toEqual(['liberado', 'devuelto', 'falla']);
    expect(d.refund && d.release).toBe(true);
    expect(d.live).toEqual([false, false, false, false]);
    expect(d.load).toBe(false);
  });

  it('saldo insuficiente en hold: solo se libera el conector', () => {
    const steps = [...ok('reserve'), step('hold', 'EXECUTE', 'STARTED'), step('hold', 'EXECUTE', 'FAILED'), step('release', 'COMPENSATE', 'SUCCEEDED')];
    const d = deriveDiagram(steps, 'COMPENSATED');
    expect(d.switches).toEqual(['undone', 'fault', 'open']);
    expect(d.refund).toBe(false);
    expect(d.release).toBe(true);
  });

  it('mientras compensa, la corriente se retira de derecha a izquierda', () => {
    const steps = [...ok('reserve'), ...ok('hold'), step('activate', 'EXECUTE', 'FAILED'), step('refund', 'COMPENSATE', 'SUCCEEDED')];
    const d = deriveDiagram(steps, 'COMPENSATING');
    expect(d.switches).toEqual(['closed', 'undone', 'fault']);
    expect(d.live).toEqual([true, false, false, false]);
  });
});

describe('partialSaga', () => {
  const full = saga('COMPLETED', [...ok('reserve'), ...ok('hold'), ...ok('activate')]);

  it('mientras faltan pasos por mostrar, el estado es RUNNING', () => {
    expect(partialSaga(full, 2)).toMatchObject({ status: 'RUNNING', done: false });
    expect(partialSaga(full, 2).steps).toHaveLength(2);
  });

  it('con todos los pasos mostrados, el estado es el de la saga', () => {
    expect(partialSaga(full, 99)).toMatchObject({ status: 'COMPLETED', done: true });
  });

  it('si ya hay un fallo visible, el estado es COMPENSATING', () => {
    const s = saga('COMPENSATED', [...ok('reserve'), step('hold', 'EXECUTE', 'FAILED'), step('release', 'COMPENSATE', 'SUCCEEDED')]);
    expect(partialSaga(s, 3).status).toBe('COMPENSATING');
  });
});

describe('latest', () => {
  it('prefiere la versión con más pasos registrados', () => {
    const a = saga('RESERVED', ok('reserve'));
    const b = saga('COMPLETED', [...ok('reserve'), ...ok('hold'), ...ok('activate')]);
    expect(latest(a, b)).toBe(b);
    expect(latest(b, a)).toBe(b);
    expect(latest(undefined, a)).toBe(a);
  });
});

describe('failureText', () => {
  it('explica el saldo insuficiente y qué hacer', () => {
    const s = saga('COMPENSATED', [], { fleetId: 'FLEET-LOWFUNDS', failure: { step: 'hold', code: 'INSUFFICIENT_FUNDS', message: 'x' } });
    expect(failureText(s)).toBe('Saldo insuficiente en FLEET-LOWFUNDS. Recarga la billetera o elige otra flota. Se deshicieron los pasos anteriores.');
  });

  it('sin fallo no hay mensaje', () => {
    expect(failureText(saga('COMPLETED', []))).toBeNull();
  });
});
