import { useMutation, useQuery, useSubscription } from '@apollo/client/react';
import { useState } from 'react';
import { useApp } from '../app-context';
import { ErrorNote, Panel, ViewHeader } from '../components/bits';
import { FLAGS, FLAG_CHANGED, SET_FLAG, type FeatureFlag } from '../graphql';
import { FLAG_HELP, clock } from '../labels';

export function Flags() {
  const { env } = useApp();
  // flagChanged llega también cuando la flag se cambia por CLI (scripts/toggle-flag.sh).
  useSubscription(FLAG_CHANGED);
  const { data, loading, error } = useQuery(FLAGS);
  const [setFlag, setState] = useMutation(SET_FLAG);
  const [notice, setNotice] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const readOnly = env === 'prod';

  async function toggle(flag: FeatureFlag) {
    setNotice(undefined);
    setFailure(undefined);
    try {
      const { data: d } = await setFlag({ variables: { name: flag.name, enabled: !flag.enabled } });
      const f = d?.setFeatureFlag;
      if (f) setNotice(`${FLAG_HELP[f.name]?.title ?? f.name} ${f.enabled ? 'activada' : 'desactivada'}. Los servicios aplican el cambio en unos 5 segundos.`);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <ViewHeader title="Feature flags">
        Interruptores de comportamiento del ambiente {env ?? ''}. Cada ambiente tiene los suyos: cambiar una flag aquí no afecta a los
        otros.
      </ViewHeader>
      <Panel>
        {readOnly && (
          <p className="m-0 mb-4 rounded-[3px] bg-falla-claro px-3 py-2 text-[14px] text-falla">
            En producción las flags son de solo lectura desde la UI. Cambiarlas requiere el token de administrador (header x-admin-token).
          </p>
        )}
        {error && !data && <ErrorNote>No se pudieron leer las flags: {error.message}</ErrorNote>}
        {loading && !data && <p className="text-tinta-suave">Leyendo flags…</p>}
        <ul className="m-0 grid list-none p-0">
          {data?.featureFlags.map((f) => {
            const help = FLAG_HELP[f.name];
            const id = `flag-${f.name}`;
            return (
              <li key={f.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-t border-linea py-4 first:border-t-0 first:pt-0">
                <div className="min-w-0">
                  <label htmlFor={id} className="font-display text-lg font-semibold">{help?.title ?? f.name}</label>
                  <p className="m-0 mt-0.5 max-w-[60ch] text-[14px] text-tinta-suave">{help?.help ?? f.description}</p>
                  <p className="m-0 mt-1 text-[13px] text-tinta-suave">
                    <code className="font-mono">{f.name}</code>
                    {f.updatedAt && <>, cambiada a las {clock(f.updatedAt)} por {f.updatedBy ?? 'desconocido'}</>}
                  </p>
                </div>
                <button
                  id={id}
                  type="button"
                  role="switch"
                  aria-checked={f.enabled}
                  disabled={readOnly || setState.loading}
                  onClick={() => toggle(f)}
                  className={`relative h-8 w-[74px] flex-none cursor-pointer rounded-[3px] border-2 font-display text-[14px] font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${
                    f.enabled ? 'border-energia-osc bg-energia text-tinta' : 'border-tinta-suave bg-white text-tinta-suave'
                  }`}
                >
                  {f.enabled ? 'Activa' : 'Apagada'}
                </button>
              </li>
            );
          })}
        </ul>
        {notice && <p role="status" className="m-0 mt-3 rounded-[3px] bg-ok-claro px-3 py-2 text-[14px] text-ok">{notice}</p>}
        {failure && <div className="mt-3"><ErrorNote>{failure}</ErrorNote></div>}
      </Panel>
    </>
  );
}
