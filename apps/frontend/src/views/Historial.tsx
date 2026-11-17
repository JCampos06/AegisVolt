import { useQuery, useSubscription } from '@apollo/client/react';
import { Fragment, useState } from 'react';
import { useApp } from '../app-context';
import { CopyId, ErrorNote, Panel, SagaStatusChip, ViewHeader } from '../components/bits';
import { Unifilar } from '../components/Unifilar';
import { SAGAS, SAGA_UPDATED, type Saga, type SagaStatus } from '../graphql';
import { SAGA_LABEL, STEP_LABEL, clock, cop, failureText } from '../labels';
import { deriveDiagram } from '../saga-view';

const FILTERS: (SagaStatus | '')[] = ['', 'COMPLETED', 'COMPENSATED', 'COMPENSATING', 'FAILED', 'PENDING'];

export function Historial() {
  const { env } = useApp();
  const [status, setStatus] = useState<SagaStatus | ''>('');
  const [open, setOpen] = useState<string>();
  const { data, loading, error, refetch } = useQuery(SAGAS, { variables: { status: status || null, limit: 50 }, pollInterval: 20_000 });
  // Una saga nueva o que cambia de estado refresca la tabla.
  useSubscription(SAGA_UPDATED, { variables: {}, onData: () => void refetch() });

  const sagas = [...(data?.sagas ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <>
      <ViewHeader title="Historial de sagas">
        Cada carga es una saga con su correlationId. Cópialo para rastrear la carga en CloudWatch con scripts/trace-saga.sh.
      </ViewHeader>
      <Panel>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="m-0 font-display text-xl font-semibold">Últimas sagas en {env ?? 'el ambiente'}</h2>
          <label className="flex items-center gap-2 text-[14px] text-tinta-suave">
            Estado
            <select id="saga-filter" className="field w-auto" value={status} onChange={(e) => setStatus(e.target.value as SagaStatus | '')}>
              {FILTERS.map((f) => (
                <option key={f} value={f}>{f ? SAGA_LABEL[f] : 'Todos'}</option>
              ))}
            </select>
          </label>
        </div>

        {error && !data && <ErrorNote>No se pudo leer el historial: {error.message}</ErrorNote>}
        {loading && !data && <p className="text-tinta-suave">Leyendo sagas…</p>}
        {data && sagas.length === 0 && (
          <p className="text-tinta-suave">
            Aún no hay sagas{status ? ` en estado ${SAGA_LABEL[status].toLowerCase()}` : ''} en {env ?? 'este ambiente'}.{' '}
            <a href="#cargar" className="font-semibold text-acero">Inicia una carga</a>.
          </p>
        )}

        {sagas.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left text-[14px] tabular">
              <thead>
                <tr className="border-b border-tinta text-[13px] text-tinta-suave">
                  <th className="py-2 pr-3 font-medium">Hora</th>
                  <th className="py-2 pr-3 font-medium">Flota</th>
                  <th className="py-2 pr-3 font-medium">Conector</th>
                  <th className="py-2 pr-3 text-right font-medium">kWh</th>
                  <th className="py-2 pr-3 text-right font-medium">Monto</th>
                  <th className="py-2 pr-3 font-medium">Estado</th>
                  <th className="py-2 font-medium">correlationId</th>
                </tr>
              </thead>
              <tbody>
                {sagas.map((s) => {
                  const expanded = open === s.correlationId;
                  return (
                    <Fragment key={s.correlationId}>
                      <tr
                        data-testid={`saga-row-${s.correlationId}`}
                        className="cursor-pointer border-b border-linea align-middle hover:bg-white"
                        onClick={() => setOpen(expanded ? undefined : s.correlationId)}
                      >
                        <td className="py-2.5 pr-3">
                          <button
                            type="button"
                            aria-expanded={expanded}
                            aria-label={`Ver pasos de ${s.correlationId}`}
                            className="mr-1.5 cursor-pointer border-0 bg-transparent p-0 text-tinta-suave"
                            onClick={(e) => { e.stopPropagation(); setOpen(expanded ? undefined : s.correlationId); }}
                          >
                            {expanded ? '▾' : '▸'}
                          </button>
                          {clock(s.createdAt)}
                        </td>
                        <td className="py-2.5 pr-3">{s.fleetId}</td>
                        <td className="py-2.5 pr-3">{s.stationId}/{s.connectorId}</td>
                        <td className="py-2.5 pr-3 text-right">{s.kwh}</td>
                        <td className="py-2.5 pr-3 text-right">{cop(s.amount)}</td>
                        <td className="py-2.5 pr-3"><SagaStatusChip status={s.status} /></td>
                        <td className="py-2.5"><CopyId value={s.correlationId} /></td>
                      </tr>
                      {expanded && (
                        <tr className="border-b border-linea bg-white">
                          <td colSpan={7} className="px-2 py-3">
                            <SagaDetail saga={s} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

function SagaDetail({ saga }: { saga: Saga }) {
  const failure = failureText(saga);
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="max-w-[640px]">
        <Unifilar diagram={deriveDiagram(saga.steps, saga.status)} label={`Pasos de la saga ${saga.correlationId}`} />
      </div>
      <div className="grid content-start gap-2">
        {failure && <ErrorNote>{failure}</ErrorNote>}
        <ol className="m-0 grid list-none gap-1 p-0">
          {saga.steps
            .filter((st) => st.outcome !== 'STARTED')
            .map((st, i) => (
              <li key={i} className="grid grid-cols-[64px_18px_minmax(0,1fr)] gap-2">
                <time className="text-[13px] text-tinta-suave">{clock(st.at)}</time>
                <span aria-hidden="true" className={st.outcome === 'FAILED' ? 'text-falla' : st.action === 'COMPENSATE' ? 'text-acero' : 'text-ok'}>
                  {st.outcome === 'FAILED' ? '✕' : st.action === 'COMPENSATE' ? '↩' : '✓'}
                </span>
                <span>
                  {STEP_LABEL[st.step]}
                  {st.action === 'COMPENSATE' ? ' (compensación)' : ''}
                  {st.httpStatus ? `, HTTP ${st.httpStatus}` : ''}
                  {st.errorCode ? `, ${st.errorCode}` : ''}
                </span>
              </li>
            ))}
        </ol>
      </div>
    </div>
  );
}
