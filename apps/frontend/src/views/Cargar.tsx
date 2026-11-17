import { useMutation, useQuery, useSubscription } from '@apollo/client/react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useApp } from '../app-context';
import { ConnectorIcon, CopyId, ErrorNote, Panel, SagaStatusChip, ViewHeader } from '../components/bits';
import { Unifilar } from '../components/Unifilar';
import { FLAGS, QUOTE, SAGA_UPDATED, START_CHARGING, STATIONS, STOP_CHARGING, type Saga } from '../graphql';
import { CONNECTOR_LABEL, FLEETS, STEP_LABEL, clock, cop, failureText, multiplier } from '../labels';
import { deriveDiagram, latest, partialSaga } from '../saga-view';

const STEP_MS = 420;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const newId = () => `ui-${crypto.randomUUID().slice(0, 8)}`;

export function Cargar() {
  const { fleetId, setFleetId, go } = useApp();
  const stationsQ = useQuery(STATIONS);
  const flagsQ = useQuery(FLAGS);
  const stations = stationsQ.data?.stations ?? [];

  const [stationId, setStationId] = useState('');
  const [connectorId, setConnectorId] = useState('');
  const [kwh, setKwh] = useState('10');

  const station = stations.find((s) => s.id === stationId) ?? stations[0];
  const connector = station?.connectors.find((c) => c.id === connectorId);
  const kwhNum = Number(kwh);
  const kwhValid = Number.isFinite(kwhNum) && kwhNum >= 1 && kwhNum <= 200;

  // Al cambiar de estación (o si el conector elegido deja de estar libre), elegir el primero disponible.
  useEffect(() => {
    if (!station) return;
    const current = station.connectors.find((c) => c.id === connectorId);
    if (!current || current.status !== 'AVAILABLE' || !current.reservable) {
      const free = station.connectors.find((c) => c.status === 'AVAILABLE' && c.reservable);
      setConnectorId(free?.id ?? '');
    }
  }, [station, connectorId]);

  const quoteQ = useQuery(QUOTE, {
    variables: { kwh: kwhNum, powerKw: connector?.powerKw ?? 0 },
    skip: !connector || !kwhValid,
  });

  // --- Ejecución de la saga ---------------------------------------------------
  const [runId, setRunId] = useState<string>();
  const [result, setResult] = useState<Saga>();
  const [runError, setRunError] = useState<string>();
  const [shown, setShown] = useState(0);
  const [stopped, setStopped] = useState(false);

  const sub = useSubscription(SAGA_UPDATED, { variables: { correlationId: runId }, skip: !runId });
  const pushed = sub.data?.sagaUpdated;
  const live = pushed && pushed.correlationId === runId ? pushed : undefined;
  const saga = latest(result, live);

  const [start, startState] = useMutation(START_CHARGING, { refetchQueries: ['Stations', 'Wallet'] });
  const [stop, stopState] = useMutation(STOP_CHARGING, { refetchQueries: ['Stations', 'Wallet'] });

  // Muestra el log de a un paso para que se vea el avance (la saga dura milisegundos).
  useEffect(() => {
    if (!saga || shown >= saga.steps.length) return;
    const t = setTimeout(() => setShown((n) => n + 1), reducedMotion() ? 0 : STEP_MS);
    return () => clearTimeout(t);
  }, [saga, shown]);

  const view = saga ? partialSaga(saga, shown) : undefined;
  const diagram = useMemo(() => deriveDiagram(view?.steps ?? [], view?.status ?? 'RUNNING'), [view?.steps, view?.status]);
  const running = startState.loading || (!!saga && !view?.done);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!station || !connector || !kwhValid) return;
    const correlationId = newId();
    setRunId(correlationId);
    setResult(undefined);
    setRunError(undefined);
    setShown(0);
    setStopped(false);
    try {
      const { data } = await start({
        variables: { input: { fleetId, stationId: station.id, connectorId: connector.id, kwh: kwhNum, correlationId } },
      });
      setResult(data?.startChargingSession);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onStop() {
    if (!saga) return;
    try {
      await stop({ variables: { sessionId: saga.correlationId } });
      setStopped(true);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    }
  }

  const faultFlag = flagsQ.data?.featureFlags.find((f) => f.name === 'SIMULATE_CHARGER_HARDWARE_FAULT')?.enabled;
  const quote = quoteQ.data?.quote;
  const failure = saga && view?.done ? failureText(saga) : null;

  return (
    <>
      <ViewHeader title="Reservar y cargar">
        Elige estación y conector. Al iniciar, el sistema reserva el conector, retiene el saldo de la flota y activa la carga. Si
        un paso falla, deshace los anteriores.
      </ViewHeader>

      <div className="grid items-start gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Panel>
          <form className="grid gap-4" onSubmit={onSubmit} aria-label="Iniciar carga">
            <div className="grid gap-1">
              <label htmlFor="fleet" className="text-[14px] font-medium text-tinta-suave">Flota</label>
              <select id="fleet" className="field" value={fleetId} onChange={(e) => setFleetId(e.target.value)}>
                {FLEETS.map((f) => (
                  <option key={f.id} value={f.id}>{f.id}</option>
                ))}
              </select>
            </div>

            <div className="grid gap-1">
              <label htmlFor="station" className="text-[14px] font-medium text-tinta-suave">Estación</label>
              <select id="station" className="field" value={station?.id ?? ''} onChange={(e) => setStationId(e.target.value)} disabled={!stations.length}>
                {stations.map((s) => (
                  <option key={s.id} value={s.id}>{s.id}, {s.city}</option>
                ))}
              </select>
            </div>

            <fieldset className="m-0 grid gap-1 border-0 p-0">
              <legend className="mb-1 p-0 text-[14px] font-medium text-tinta-suave">Conector</legend>
              <div className="flex flex-wrap gap-1.5">
                {station?.connectors.map((c) => {
                  const free = c.status === 'AVAILABLE' && c.reservable;
                  const selected = c.id === connector?.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      disabled={!free || running}
                      aria-pressed={selected}
                      onClick={() => setConnectorId(c.id)}
                      className={`inline-flex items-center gap-1.5 rounded-[3px] border px-2.5 py-1.5 text-[14px] font-medium ${
                        selected ? 'border-tinta bg-white shadow-[inset_0_0_0_1px_var(--color-tinta)]' : 'border-linea bg-white'
                      } disabled:cursor-not-allowed disabled:bg-transparent disabled:text-tinta-suave`}
                    >
                      <ConnectorIcon status={c.status} />
                      {c.id} {c.powerKw} kW
                      {!free && <span className="font-normal">{c.status === 'AVAILABLE' ? 'sin ultra-carga' : CONNECTOR_LABEL[c.status]}</span>}
                    </button>
                  );
                })}
              </div>
              {station && !station.connectors.some((c) => c.status === 'AVAILABLE' && c.reservable) && (
                <p className="m-0 mt-1 text-[13px] text-tinta-suave">No hay conectores libres en {station.id}. Elige otra estación.</p>
              )}
            </fieldset>

            <div className="grid gap-1">
              <label htmlFor="kwh" className="text-[14px] font-medium text-tinta-suave">Energía a cargar (kWh)</label>
              <input id="kwh" className="field" type="number" min={1} max={200} step={1} value={kwh} onChange={(e) => setKwh(e.target.value)} />
              {!kwhValid && <span className="text-[13px] text-falla">Escribe un valor entre 1 y 200 kWh.</span>}
            </div>

            <div className="flex items-baseline justify-between gap-2 border-t border-dashed border-linea pt-3.5">
              <span className="whitespace-nowrap font-display text-[26px] font-bold leading-none tabular" data-testid="quote">{quote ? cop(quote.amount) : '—'}</span>
              <span className="text-right text-[13px] text-tinta-suave">
                Precio estimado
                <br />
                {quote && quote.surgeMultiplier > 1 ? `recargo por demanda ${multiplier(quote.surgeMultiplier)}` : 'sin recargo'}
              </span>
            </div>

            {faultFlag && (
              <p className="m-0 rounded-[3px] bg-falla-claro px-3 py-2 text-[14px] text-falla">
                La falla simulada de cargador está activa: el paso Activar cargador fallará.{' '}
                <a href="#flags" className="font-semibold text-falla">Cambiar en Flags</a>
              </p>
            )}

            <button
              type="submit"
              disabled={running || !connector || !kwhValid}
              className="cursor-pointer rounded-[3px] border-0 bg-energia px-4 py-3 font-display text-[17px] font-semibold text-tinta hover:bg-[#ffc61a] disabled:cursor-not-allowed disabled:opacity-55"
            >
              {running ? 'Cargando…' : 'Iniciar carga'}
            </button>
          </form>
        </Panel>

        <Panel>
          <div aria-live="polite">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
              <h2 className="m-0 font-display text-xl font-semibold">Saga de la carga</h2>
              {view ? <SagaStatusChip status={view.status} /> : <span className="rounded-[3px] bg-gabinete px-2.5 py-0.5 font-display text-[15px] font-semibold text-tinta-suave">Sin iniciar</span>}
            </div>
            <div className="mb-1 text-[13px] text-tinta-suave">
              {runId ? <>correlationId <CopyId value={runId} /></> : 'El correlationId aparece al iniciar. Sirve para rastrear la carga en CloudWatch.'}
            </div>
          </div>
          <div className="overflow-x-auto">
            <Unifilar diagram={diagram} label="Diagrama de la saga: reservar conector, retener saldo y activar cargador" />
          </div>

          <ol className="m-0 mt-3.5 grid min-h-10 list-none gap-1.5 border-t border-linea p-0 pt-3.5" data-testid="saga-log">
            {!view && <li className="text-tinta-suave">Inicia una carga para ver cada paso aquí.</li>}
            {view?.steps
              .filter((s) => s.outcome !== 'STARTED')
              .map((s, i) => {
                const back = s.action === 'COMPENSATE';
                const bad = s.outcome === 'FAILED';
                return (
                  <li key={`${s.step}-${s.action}-${i}`} className="grid grid-cols-[64px_18px_minmax(0,1fr)] items-baseline gap-2 text-[14px]">
                    <time className="text-[13px] text-tinta-suave tabular">{clock(s.at)}</time>
                    <span className={`text-center font-semibold ${bad ? 'text-falla' : back ? 'text-acero' : 'text-ok'}`} aria-hidden="true">
                      {bad ? '✕' : back ? '↩' : '✓'}
                    </span>
                    <span>
                      {STEP_LABEL[s.step]}
                      {bad ? `: falló${s.errorCode ? ` (${s.errorCode})` : ''}` : back ? ': hecho' : ''}
                    </span>
                  </li>
                );
              })}
          </ol>

          {runError && <div className="mt-3"><ErrorNote>{runError}</ErrorNote></div>}
          {failure && <div className="mt-3"><ErrorNote>{failure}</ErrorNote></div>}

          {saga && view?.done && saga.status === 'COMPLETED' && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[3px] bg-energia-claro px-4 py-3">
              <span className="text-[15px]">
                {stopped ? 'Carga detenida. El conector quedó libre.' : <>Cargando {saga.kwh} kWh en {saga.stationId}/{saga.connectorId}. Cobro retenido: <b className="tabular">{cop(saga.amount)}</b></>}
              </span>
              {!stopped && (
                <button
                  type="button"
                  onClick={onStop}
                  disabled={stopState.loading}
                  className="cursor-pointer rounded-[3px] border border-tinta bg-white px-3.5 py-2 font-display text-[15px] font-semibold disabled:opacity-55"
                >
                  {stopState.loading ? 'Deteniendo…' : 'Detener carga'}
                </button>
              )}
            </div>
          )}
          {saga && view?.done && (
            <p className="mb-0 mt-3 text-[14px]">
              <a href="#historial" onClick={(e) => { e.preventDefault(); go('historial'); }} className="font-semibold text-acero">
                Ver en el historial
              </a>
            </p>
          )}
        </Panel>
      </div>
    </>
  );
}
