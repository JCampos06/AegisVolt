import { useQuery } from '@apollo/client/react';
import { useEffect, useState, type ReactNode } from 'react';
import { AppContext, useApp, type ViewHash } from './app-context';
import { ENVIRONMENT, WALLET } from './graphql';
import { FLEETS, cop } from './labels';
import { Cargar } from './views/Cargar';
import { Estaciones } from './views/Estaciones';
import { Flags } from './views/Flags';
import { Historial } from './views/Historial';

const VIEWS: { hash: ViewHash; label: string; render: () => ReactNode }[] = [
  { hash: 'estaciones', label: 'Estaciones', render: () => <Estaciones /> },
  { hash: 'cargar', label: 'Cargar', render: () => <Cargar /> },
  { hash: 'flags', label: 'Flags', render: () => <Flags /> },
  { hash: 'historial', label: 'Historial', render: () => <Historial /> },
];

const readHash = (): ViewHash => {
  const h = window.location.hash.slice(1);
  return VIEWS.find((v) => v.hash === h)?.hash ?? 'estaciones';
};

const FLEET_KEY = 'aegisvolt.fleet';
const loadFleet = () => {
  try {
    const v = localStorage.getItem(FLEET_KEY);
    if (v && FLEETS.some((f) => f.id === v)) return v;
  } catch {
    /* almacenamiento bloqueado: se usa la flota por defecto */
  }
  return FLEETS[0].id;
};

export function App() {
  const [view, setView] = useState<ViewHash>(readHash);
  const [fleetId, setFleet] = useState(loadFleet);
  const envQuery = useQuery(ENVIRONMENT);
  const env = envQuery.data?.environment;

  useEffect(() => {
    const onHash = () => setView(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    document.title = env ? `AegisVolt · ${env}` : 'AegisVolt';
  }, [env]);

  const setFleetId = (id: string) => {
    setFleet(id);
    try {
      localStorage.setItem(FLEET_KEY, id);
    } catch {
      /* sin almacenamiento: solo dura esta visita */
    }
  };
  const go = (hash: ViewHash) => {
    window.location.hash = hash;
  };

  const current = VIEWS.find((v) => v.hash === view) ?? VIEWS[0]!;

  return (
    <AppContext.Provider value={{ env, fleetId, setFleetId, go }}>
      <EnvBand env={env} error={!!envQuery.error && !env} />
      <div className="grid min-h-[calc(100dvh-40px)] grid-cols-1 md:grid-cols-[220px_minmax(0,1fr)]">
        <Sidebar view={view} />
        <main className="grid min-w-0 max-w-[1180px] content-start gap-7 px-4 pb-28 pt-7 md:px-8 md:pb-12">{current.render()}</main>
      </div>
    </AppContext.Provider>
  );
}

const ENV_BG: Record<string, string> = { dev: 'bg-env-dev', test: 'bg-env-test', prod: 'bg-env-prod' };

function EnvBand({ env, error }: { env: string | undefined; error: boolean }) {
  const version = import.meta.env.VITE_APP_VERSION;
  let text: ReactNode = 'Conectando con el gateway…';
  if (env) text = <>Estás en {env}</>;
  if (error) text = 'Sin conexión con el gateway en /graphql. Revisa que el ambiente esté desplegado.';
  return (
    <div role="status" data-testid="env-band" data-env={env ?? ''} className={`env-band text-white ${env ? (ENV_BG[env] ?? 'bg-tinta') : error ? 'bg-falla' : 'bg-tinta-suave'}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 md:px-6">
        <strong className="font-display text-base font-semibold">{text}</strong>
        {version && <span className="text-[13px] opacity-85">UI {version}</span>}
      </div>
    </div>
  );
}

function Sidebar({ view }: { view: ViewHash }) {
  const { fleetId } = useApp();
  const wallet = useQuery(WALLET, { variables: { fleetId }, pollInterval: 10_000 });
  const fleet = FLEETS.find((f) => f.id === fleetId);
  return (
    <aside className="fixed inset-x-0 bottom-0 z-10 flex bg-tinta px-2 pb-[calc(6px+env(safe-area-inset-bottom,0px))] pt-1.5 text-[#dce3ea] md:static md:flex-col md:gap-7 md:px-[18px] md:py-[22px]">
      <div className="hidden items-center gap-2.5 font-display text-[22px] font-bold text-white md:flex">
        <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
          <rect x="1" y="1" width="24" height="24" rx="3" fill="none" stroke="var(--color-energia)" strokeWidth="2" />
          <path d="M14.5 4 7 14.5h5L11 22l8-11h-5z" fill="var(--color-energia)" />
        </svg>
        AegisVolt
      </div>
      <nav aria-label="Vistas" className="w-full">
        <ul className="m-0 flex list-none justify-around gap-0.5 p-0 md:flex-col">
          {VIEWS.map((v) => {
            const active = v.hash === view;
            return (
              <li key={v.hash}>
                <a
                  href={`#${v.hash}`}
                  aria-current={active ? 'page' : undefined}
                  className={`flex flex-col items-center gap-1 rounded-[3px] px-2 py-1.5 font-display text-[13px] font-medium no-underline md:flex-row md:gap-3 md:px-2.5 md:py-2 md:text-base ${active ? 'bg-energia/12 text-white' : 'text-inherit hover:bg-white/6'}`}
                >
                  <span className={`size-2.5 flex-none rounded-full border-2 ${active ? 'border-energia bg-energia' : 'border-[#8c9aab]'}`} />
                  {v.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="mt-auto hidden gap-1 border-t border-white/12 pt-4 md:grid" aria-live="polite">
        <span className="text-[13px] text-[#9fb0c2]">{fleet?.name ?? fleetId}</span>
        <span className="font-display text-[22px] font-semibold text-white tabular" data-testid="sidebar-balance">
          {wallet.data?.wallet ? cop(wallet.data.wallet.balance) : '—'}
        </span>
        <span className="text-[13px] text-[#9fb0c2]">disponibles</span>
      </div>
    </aside>
  );
}
