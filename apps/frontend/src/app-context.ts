import { createContext, useContext } from 'react';

export type ViewHash = 'estaciones' | 'cargar' | 'flags' | 'historial';

export interface AppCtx {
  /** Ambiente que reporta el gateway (dev | test | prod); undefined mientras conecta. */
  env: string | undefined;
  fleetId: string;
  setFleetId: (id: string) => void;
  go: (hash: ViewHash) => void;
}

export const AppContext = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp fuera de <App>');
  return ctx;
}
