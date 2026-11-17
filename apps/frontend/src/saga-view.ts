import type { Saga, SagaStatus, SagaStep } from './graphql';

/**
 * Traduce el log de pasos de una saga al estado del diagrama unifilar.
 *
 *   Red ━━┥reserve┝━━┥hold┝━━┥activate┝━━ Vehículo
 *              ↖ release ┄┄ ↖ refund ┄┄┘   (compensación)
 *
 * Un interruptor cerrado deja pasar la corriente (amarillo) al siguiente tramo.
 * Las compensaciones abren los interruptores de derecha a izquierda.
 */
export type SwitchState = 'open' | 'running' | 'closed' | 'fault' | 'undone';
export type DisplayStatus = SagaStatus | 'RUNNING';

export const EXECUTE_STEPS = ['reserve', 'hold', 'activate'] as const;
const UNDO_OF = { release: 'reserve', refund: 'hold', stop: 'activate' } as const;
const UNDONE_TEXT = { reserve: 'liberado', hold: 'devuelto', activate: 'detenido' } as const;
const STATE_TEXT: Record<Exclude<SwitchState, 'undone'>, string> = {
  open: 'abierto',
  running: 'en curso',
  closed: 'cerrado',
  fault: 'falla',
};

export interface Diagram {
  switches: [SwitchState, SwitchState, SwitchState];
  switchText: [string, string, string];
  /** Tramos energizados: red→reserve, reserve→hold, hold→activate, activate→vehículo. */
  live: [boolean, boolean, boolean, boolean];
  refund: boolean;
  release: boolean;
  load: boolean;
}

const FINAL_FAILURE: DisplayStatus[] = ['COMPENSATED', 'FAILED'];

export function deriveDiagram(steps: readonly SagaStep[], status: DisplayStatus): Diagram {
  const state: Record<(typeof EXECUTE_STEPS)[number], SwitchState> = { reserve: 'open', hold: 'open', activate: 'open' };
  let refund = false;
  let release = false;

  for (const s of steps) {
    if (s.action === 'EXECUTE' && s.step in state) {
      const key = s.step as keyof typeof state;
      state[key] = s.outcome === 'STARTED' ? 'running' : s.outcome === 'SUCCEEDED' ? 'closed' : 'fault';
    } else if (s.action === 'COMPENSATE' && s.step in UNDO_OF) {
      const target = UNDO_OF[s.step as keyof typeof UNDO_OF];
      if (s.step === 'refund') refund = true;
      if (s.step === 'release') release = true;
      if (s.outcome === 'SUCCEEDED' && state[target] === 'closed') state[target] = 'undone';
    }
  }

  const [r, h, a] = [state.reserve, state.hold, state.activate];
  const flowing = (x: SwitchState) => x === 'running' || x === 'closed' || x === 'fault';
  const off = FINAL_FAILURE.includes(status);
  const live: Diagram['live'] = off
    ? [false, false, false, false]
    : [flowing(r), r === 'closed' && flowing(h), h === 'closed' && flowing(a), a === 'closed'];

  const text = (k: (typeof EXECUTE_STEPS)[number]) => (state[k] === 'undone' ? UNDONE_TEXT[k] : STATE_TEXT[state[k] as Exclude<SwitchState, 'undone'>]);

  return {
    switches: [r, h, a],
    switchText: [text('reserve'), text('hold'), text('activate')],
    live,
    refund,
    release,
    load: status === 'COMPLETED' && a === 'closed',
  };
}

/**
 * Las sagas terminan en milisegundos; para que el operador vea el avance, la UI
 * muestra el log de a un paso. Mientras falten pasos por mostrar, el estado es
 * RUNNING (o COMPENSATING si ya hay compensaciones).
 */
export function partialSaga(saga: Saga, shown: number): { steps: SagaStep[]; status: DisplayStatus; done: boolean } {
  const steps = saga.steps.slice(0, shown);
  if (shown >= saga.steps.length) return { steps, status: saga.status, done: isFinal(saga.status) };
  const compensating = steps.some((s) => s.action === 'COMPENSATE') || steps.some((s) => s.outcome === 'FAILED');
  return { steps, status: compensating ? 'COMPENSATING' : 'RUNNING', done: false };
}

export const isFinal = (s: DisplayStatus) => s === 'COMPLETED' || s === 'COMPENSATED' || s === 'FAILED';

/** Entre dos versiones de la misma saga (subscription y respuesta de la mutation), la más avanzada. */
export function latest(a: Saga | undefined, b: Saga | undefined): Saga | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.steps.length !== b.steps.length) return a.steps.length > b.steps.length ? a : b;
  return a.updatedAt >= b.updatedAt ? a : b;
}
