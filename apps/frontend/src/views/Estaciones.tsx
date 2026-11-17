import { useQuery, useSubscription } from '@apollo/client/react';
import { ConnectorIcon, ErrorNote, Panel, ViewHeader } from '../components/bits';
import { CONNECTOR_CHANGED, STATIONS, type Connector, type ConnectorStatus } from '../graphql';
import { CONNECTOR_LABEL } from '../labels';

const LEGEND: ConnectorStatus[] = ['AVAILABLE', 'RESERVED', 'CHARGING', 'FAULT'];

const CHIP_STYLE: Record<ConnectorStatus, string> = {
  AVAILABLE: 'bg-white border-linea',
  RESERVED: 'bg-white border-linea',
  CHARGING: 'bg-energia-claro border-[#e9c766]',
  FAULT: 'bg-transparent border-linea text-tinta-suave',
};

export function Estaciones() {
  // Subscription: el cache normalizado (stationId + id) actualiza la fila sola.
  // El polling cubre cambios que no pasan por el gateway (por ejemplo, el TTL de una reserva).
  useSubscription(CONNECTOR_CHANGED);
  const { data, loading, error } = useQuery(STATIONS, { pollInterval: 15_000 });
  const stations = data?.stations ?? [];

  return (
    <>
      <ViewHeader title="Estaciones">
        Estado de cada conector de la red. Se actualiza en vivo cuando una carga reserva, activa o libera un conector.
      </ViewHeader>
      <Panel>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1.5">
          <h2 className="m-0 font-display text-xl font-semibold">Red de carga</h2>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-tinta-suave">
            {LEGEND.map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5">
                <ConnectorIcon status={s} />
                {CONNECTOR_LABEL[s][0]!.toUpperCase() + CONNECTOR_LABEL[s].slice(1)}
              </span>
            ))}
          </div>
        </div>
        {error && !data && <ErrorNote>No se pudieron cargar las estaciones: {error.message}</ErrorNote>}
        {loading && !data && <p className="text-tinta-suave">Cargando estaciones…</p>}
        {!loading && !error && stations.length === 0 && (
          <p className="text-tinta-suave">Este ambiente no tiene estaciones. Aplica Terraform para sembrarlas (infra/modules/dynamodb/seed.tf).</p>
        )}
        <div className="grid">
          {stations.map((st) => {
            const maxKw = Math.max(0, ...st.connectors.map((c) => c.powerKw));
            return (
              <div
                key={st.id}
                data-testid={`station-${st.id}`}
                className="grid grid-cols-1 items-center gap-x-5 gap-y-2.5 border-t border-linea py-3 first:border-t-0 md:grid-cols-[270px_minmax(0,1fr)]"
              >
                <div className="font-display text-lg font-semibold leading-tight">
                  {st.id}
                  <small className="mt-0.5 block font-sans text-[13px] font-normal text-tinta-suave">
                    {st.name}, {st.city}. <span className="whitespace-nowrap">Hasta {maxKw} kW</span>
                  </small>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {st.connectors.map((c) => (
                    <ConnectorChip key={c.id} c={c} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Panel>
    </>
  );
}

function ConnectorChip({ c }: { c: Connector }) {
  const locked = c.status === 'AVAILABLE' && !c.reservable;
  return (
    <span
      data-testid={`connector-${c.stationId}-${c.id}`}
      data-status={c.status}
      title={locked ? 'Ultra-carga desactivada (flag ENABLE_FAST_CHARGE_BOOST)' : undefined}
      className={`inline-flex items-center gap-1.5 rounded-[3px] border py-1 pl-2 pr-2.5 text-[14px] ${CHIP_STYLE[c.status]}`}
    >
      <ConnectorIcon status={c.status} />
      <b className="font-semibold">{c.id}</b>
      <span>
        {CONNECTOR_LABEL[c.status]}
        {locked && ', sin ultra-carga'}
      </span>
      <span className="text-[13px] text-tinta-suave">
        {c.type} {c.powerKw} kW
      </span>
    </span>
  );
}
