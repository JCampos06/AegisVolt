import { useId } from 'react';
import type { Diagram } from '../saga-view';

/**
 * Diagrama unifilar de la SAGA. Cada paso es un interruptor: cerrado deja pasar
 * la corriente (amarillo); en falla queda abierto en rojo; la compensación se
 * dibuja como un camino de retorno punteado hacia la izquierda.
 */
const SWITCHES = [
  { x: 150, name: 'Reservar', desc: 'conector' },
  { x: 320, name: 'Retener', desc: 'saldo' },
  { x: 490, name: 'Activar', desc: 'cargador' },
] as const;
const SEGMENTS = ['M58 80 H150', 'M210 80 H320', 'M380 80 H490', 'M550 80 H676'] as const;
// El retorno pasa por debajo de los rótulos de cada interruptor (y > 150).
const REFUND = 'M520 152 V182 H350 V154';
const RELEASE = 'M350 182 H180 V154';

export function Unifilar({ diagram, label }: { diagram: Diagram; label: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className="block h-auto w-full min-w-[620px]" viewBox="0 0 760 230" role="img" aria-label={label}>
      <defs>
        <mask id={`${id}-refund`} maskUnits="userSpaceOnUse">
          <path className="u-mask" pathLength={1} d={REFUND} data-on={diagram.refund} />
        </mask>
        <mask id={`${id}-release`} maskUnits="userSpaceOnUse">
          <path className="u-mask" pathLength={1} d={RELEASE} data-on={diagram.release} />
        </mask>
      </defs>

      <path className="u-wire" d={SEGMENTS.join(' ')} />
      {SEGMENTS.map((d, i) => (
        <path key={d} className="u-live" pathLength={1} d={d} data-on={diagram.live[i]} />
      ))}

      <circle className="u-src" cx={38} cy={80} r={20} />
      <path d="M27 80 q5.5 -9 11 0 t11 0" fill="none" stroke="var(--color-tinta)" strokeWidth={2.5} />
      <text className="u-desc" x={38} y={126} textAnchor="middle">Red</text>

      {SWITCHES.map((s, i) => {
        const state = diagram.switches[i];
        const mid = s.x + 30;
        return (
          <g key={s.name} data-testid={`switch-${i}`} data-state={state}>
            <line
              className="u-blade"
              data-s={state}
              x1={s.x}
              y1={80}
              x2={s.x + 60}
              y2={80}
              style={{ transformOrigin: `${s.x}px 80px` }}
            />
            <circle className="u-term" cx={s.x} cy={80} r={5} />
            <circle className="u-term" cx={s.x + 60} cy={80} r={5} />
            <path className="u-x" data-on={state === 'fault'} d={`M${s.x + 46} 46 l14 14 M${s.x + 60} 46 l-14 14`} />
            <text className="u-name" x={mid} y={122} textAnchor="middle">{s.name}</text>
            <text className="u-desc" x={mid} y={140} textAnchor="middle">{s.desc}</text>
            <text className="u-state" data-s={state} x={mid} y={40} textAnchor="middle">{diagram.switchText[i]}</text>
          </g>
        );
      })}

      <rect className="u-load" data-on={diagram.load} x={676} y={58} width={44} height={44} rx={4} />
      <path className="u-glyph" d="M701 64 692 82h7l-2 14 10-19h-7z" />
      <text className="u-desc" x={698} y={126} textAnchor="middle">Vehículo</text>

      <path className="u-ret" mask={`url(#${id}-refund)`} d={REFUND} />
      <path className="u-ret" mask={`url(#${id}-release)`} d={RELEASE} />
      <path className="u-arrow" data-on={diagram.refund} d="M344 162 350 152 356 162" />
      <path className="u-arrow" data-on={diagram.release} d="M174 162 180 152 186 162" />
      <text className="u-ret-lbl" data-on={diagram.refund} x={435} y={204} textAnchor="middle">Devolver saldo</text>
      <text className="u-ret-lbl" data-on={diagram.release} x={265} y={204} textAnchor="middle">Liberar conector</text>
    </svg>
  );
}
