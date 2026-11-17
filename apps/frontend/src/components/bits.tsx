import { useState, type ReactNode } from 'react';
import type { ConnectorStatus } from '../graphql';
import { SAGA_LABEL } from '../labels';
import type { DisplayStatus } from '../saga-view';

/** Estado del conector: forma + color + texto (nunca solo color). */
export function ConnectorIcon({ status, className = 'size-3.5' }: { status: ConnectorStatus; className?: string }) {
  const common = { className: `${className} flex-none`, viewBox: '0 0 14 14', 'aria-hidden': true } as const;
  switch (status) {
    case 'AVAILABLE':
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="5" fill="none" stroke="var(--color-ok)" strokeWidth="2" />
        </svg>
      );
    case 'RESERVED':
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="5" fill="none" stroke="var(--color-reservado)" strokeWidth="2" />
          <circle cx="7" cy="7" r="2" fill="var(--color-reservado)" />
        </svg>
      );
    case 'CHARGING':
      return (
        <svg {...common}>
          <path d="M8 1 3 8h3.5L5.5 13 11 6H7.5z" fill="var(--color-energia)" stroke="var(--color-energia-osc)" strokeLinejoin="round" />
        </svg>
      );
    case 'FAULT':
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="5" fill="none" stroke="var(--color-falla)" strokeWidth="2" />
          <path d="M3.5 10.5l7-7" stroke="var(--color-falla)" strokeWidth="2" />
        </svg>
      );
  }
}

const STATUS_STYLE: Record<DisplayStatus, string> = {
  RUNNING: 'bg-energia-claro text-energia-osc',
  PENDING: 'bg-energia-claro text-energia-osc',
  RESERVED: 'bg-energia-claro text-energia-osc',
  CHARGED: 'bg-energia-claro text-energia-osc',
  COMPENSATING: 'bg-energia-claro text-energia-osc',
  COMPLETED: 'bg-ok-claro text-ok',
  COMPENSATED: 'bg-falla-claro text-falla',
  FAILED: 'bg-falla-claro text-falla',
};

export function SagaStatusChip({ status }: { status: DisplayStatus }) {
  const label = status === 'RUNNING' ? 'En curso' : SAGA_LABEL[status];
  return (
    <span data-testid="saga-status" data-status={status} className={`rounded-[3px] px-2.5 py-0.5 font-display text-[15px] font-semibold ${STATUS_STYLE[status]}`}>
      {label}
    </span>
  );
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`min-w-0 rounded-[4px] border border-linea bg-papel p-5 ${className}`}>{children}</section>;
}

export function ViewHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header>
      <h1 className="m-0 font-display text-[28px] font-bold leading-tight md:text-[34px]">{title}</h1>
      {children && <p className="mt-1.5 max-w-[62ch] text-tinta-suave">{children}</p>}
    </header>
  );
}

/** Copiar al portapapeles con respaldo: si el navegador lo niega, selecciona el texto. */
export function CopyId({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <code className="break-all font-mono text-[13px]" id={`cid-${value}`}>{value}</code>
      <button
        type="button"
        className="rounded-[3px] border border-linea bg-white px-2 py-0.5 text-[13px] font-medium hover:border-tinta"
        onClick={async (e) => {
          e.stopPropagation();
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            const el = document.getElementById(`cid-${value}`);
            if (el) window.getSelection()?.selectAllChildren(el);
          }
        }}
      >
        {copied ? 'Copiado' : 'Copiar'}
      </button>
    </span>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <p role="alert" className="m-0 rounded-[3px] bg-falla-claro px-3 py-2 text-[14px] text-falla">{children}</p>;
}
