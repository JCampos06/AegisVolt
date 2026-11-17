import type { ConnectorStatus, Saga, SagaStatus, StepName } from './graphql';

/** Flotas sembradas por Terraform (infra/modules/dynamodb/seed.tf). */
export const FLEETS = [
  { id: 'FLEET-NORTE-EV', name: 'Flota Reparto Urbano Norte' },
  { id: 'FLEET-ANDES-EV', name: 'Logística Andes Eléctrica' },
  { id: 'FLEET-LOWFUNDS', name: 'Flota Saldo Bajo (demo)' },
] as const;

export const CONNECTOR_LABEL: Record<ConnectorStatus, string> = {
  AVAILABLE: 'disponible',
  RESERVED: 'reservado',
  CHARGING: 'cargando',
  FAULT: 'fuera de servicio',
};

export const SAGA_LABEL: Record<SagaStatus, string> = {
  PENDING: 'Iniciada',
  RESERVED: 'Conector reservado',
  CHARGED: 'Saldo retenido',
  COMPLETED: 'Completada',
  COMPENSATING: 'Deshaciendo',
  COMPENSATED: 'Compensada',
  FAILED: 'Fallida',
};

export const STEP_LABEL: Record<StepName, string> = {
  reserve: 'Reservar conector',
  hold: 'Retener saldo',
  activate: 'Activar cargador',
  stop: 'Detener sesión',
  refund: 'Devolver saldo',
  release: 'Liberar conector',
};

export const FLAG_HELP: Record<string, { title: string; help: string }> = {
  ENABLE_DYNAMIC_SURGE_PRICING: {
    title: 'Recargo por demanda',
    help: 'Aplica un multiplicador al precio por kWh en horas de alta demanda.',
  },
  ENABLE_FAST_CHARGE_BOOST: {
    title: 'Ultra-carga',
    help: 'Permite reservar conectores de 150 kW o más. Apagada, esos conectores no se pueden reservar.',
  },
  SIMULATE_CHARGER_HARDWARE_FAULT: {
    title: 'Simular falla de cargador',
    help: 'El paso Activar cargador fallará y la saga devolverá el saldo y liberará el conector.',
  },
};

export const cop = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n).toLocaleString('es-CO')} COP`);

export const multiplier = (n: number | null | undefined) =>
  `x${(n ?? 1).toLocaleString('es-CO', { maximumFractionDigits: 2 })}`;

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** Qué pasó, en palabras del operador, y qué hacer. */
export function failureText(saga: Pick<Saga, 'failure' | 'fleetId' | 'stationId' | 'connectorId' | 'status'>): string | null {
  const f = saga.failure;
  if (!f) return null;
  const undone = saga.status === 'COMPENSATED' ? ' Se deshicieron los pasos anteriores.' : '';
  switch (f.code) {
    case 'INSUFFICIENT_FUNDS':
      return `Saldo insuficiente en ${saga.fleetId}. Recarga la billetera o elige otra flota.${undone}`;
    case 'CHARGER_HARDWARE_FAULT':
      return `El cargador ${saga.stationId}/${saga.connectorId} reportó una falla de hardware.${undone}`;
    case 'CONNECTOR_UNAVAILABLE':
      return `El conector ${saga.stationId}/${saga.connectorId} ya no está disponible. Elige otro.`;
    default:
      return `${f.message.replace(/\.$/, '')}.${undone}`;
  }
}
