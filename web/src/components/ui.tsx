/**
 * Shared UI kit. Every page builds from these so the app reads as one system:
 * graphite neutrals, one indigo accent, Inter for text, JetBrains Mono for
 * figures and IDs, sentence case everywhere, 4px spacing grid.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Check, ChevronLeft, ChevronRight, Inbox, Loader2, Search, X } from 'lucide-react';
import type { PageMeta } from '../lib/api';
import { initials, label as toLabel } from '../lib/format';
import { Illustration } from '../illustrations/Illustration';
import type { IllustrationName } from '../illustrations/registry';

export const ICON = { size: 16, strokeWidth: 1.5 } as const;

/* ------------------------------------------------------------------ */
/* Page structure                                                       */
/* ------------------------------------------------------------------ */

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  back,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** link target for a back arrow above the title */
  back?: { to: string; label: string };
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {back && (
          <Link to={back.to} className="mb-2 inline-flex items-center gap-1 text-sm text-ink-3 transition-colors hover:text-ink">
            <ArrowLeft size={14} strokeWidth={1.5} /> {back.label}
          </Link>
        )}
        {eyebrow && !back && <p className="mb-1 text-sm text-ink-3">{eyebrow}</p>}
        <h1 className="text-[28px] font-medium leading-tight tracking-[-0.01em]">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function CardHead({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="card-head">
      <div className="min-w-0">
        <p className="card-title">{title}</p>
        {meta && <p className="text-xs text-ink-3">{meta}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A stat card: label, figure, and what the figure compares to. Numbers only. */
export function Stat({ label, value, note, accent }: { label: string; value: ReactNode; note?: ReactNode; accent?: boolean }) {
  return (
    <div className="card p-5">
      <p className="text-sm text-ink-2">{label}</p>
      <p className={`num mt-3 text-[28px] font-medium leading-none ${accent ? 'text-brand' : ''}`}>{value}</p>
      {note && <p className="mt-3 text-xs text-ink-3">{note}</p>}
    </div>
  );
}

/** Key/value grid for profile pages. */
export function DetailList({ items, cols = 2 }: { items: Array<{ label: string; value: ReactNode; mono?: boolean }>; cols?: 2 | 3 }) {
  return (
    <dl className={`grid gap-x-8 gap-y-4 ${cols === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <dt className="text-xs text-ink-3">{it.label}</dt>
          <dd className={`mt-1 truncate text-sm ${it.mono ? 'num' : ''}`}>{it.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------ */
/* Small pieces                                                         */
/* ------------------------------------------------------------------ */

/** The SIP ID: the one key a person carries through payroll and leave. */
export function SipId({ id, to }: { id: string; to?: string }) {
  const cls = 'num inline-flex h-5 items-center rounded border border-line bg-raised px-1.5 text-xs text-ink-2';
  return to ? (
    <Link to={to} className={`${cls} transition-colors hover:text-ink`}>
      {id}
    </Link>
  ) : (
    <span className={cls}>{id}</span>
  );
}

const TONES = {
  neutral: 'bg-raised text-ink-2',
  brand: 'bg-brand-soft text-brand',
  good: 'bg-good-soft text-good',
  bad: 'bg-bad-soft text-bad',
  warn: 'bg-warn-soft text-warn',
} as const;
export type Tone = keyof typeof TONES;

export function Tag({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex h-6 items-center whitespace-nowrap rounded-md px-2 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}

/** Status values across modules mapped to one tone each. */
const STATUS_TONES: Record<string, Tone> = {
  active: 'good',
  pending: 'warn',
  inactive: 'neutral',
  disabled: 'neutral',
  draft: 'warn',
  approved: 'good',
  paid: 'brand',
  rejected: 'bad',
  cancelled: 'neutral',
  hired: 'good',
  offered: 'brand',
  interviewed: 'neutral',
  screening: 'neutral',
  probation: 'warn',
  contractual: 'neutral',
  permanent: 'good',
  positive: 'good',
  neutral: 'neutral',
  negative: 'bad',
};

/**
 * The normal, expected states read as plain text so a long list stays calm;
 * tags are kept for states that ask for attention (pending, draft, rejected …).
 */
const QUIET_STATUSES = new Set(['permanent', 'contractual', 'probation', 'interviewed', 'screening', 'neutral', 'approved', 'paid']);

export function StatusTag({ value, text }: { value: string; text?: string }) {
  const content = text ?? toLabel(value);
  if (value === 'active') {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-ink-2">
        <span className="h-1.5 w-1.5 rounded-full bg-good" aria-hidden />
        {content}
      </span>
    );
  }
  if (QUIET_STATUSES.has(value)) return <span className="whitespace-nowrap text-sm text-ink-2">{content}</span>;
  return <Tag tone={STATUS_TONES[value] ?? 'neutral'}>{content}</Tag>;
}

export function Avatar({ name, size = 32 }: { name: string; size?: 24 | 32 | 40 | 56 }) {
  const text = size >= 40 ? 'text-sm' : 'text-xs';
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full bg-raised font-medium text-ink-2 ${text}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {initials(name) || '?'}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="num rounded border border-line bg-raised px-1.5 text-xs text-ink-3">{children}</kbd>;
}

/** Thin proportional bar for ranked lists. */
export function Bar({ value, max, accent }: { value: number; max: number; accent?: boolean }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="h-1 rounded-full bg-raised">
      <div className={`h-1 rounded-full ${accent ? 'bg-brand' : 'bg-ink/30'}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* States                                                               */
/* ------------------------------------------------------------------ */

export function Loading({ label = 'Loading', inline }: { label?: string; inline?: boolean }) {
  const body = (
    <span className="inline-flex items-center gap-2 text-sm text-ink-3">
      <Loader2 size={16} strokeWidth={1.5} className="animate-spin" /> {label}
    </span>
  );
  return inline ? body : <div className="card grid place-items-center p-12">{body}</div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card flex flex-col items-center gap-2 p-12 text-center">
      <AlertTriangle size={20} strokeWidth={1.5} className="text-bad" />
      <p className="text-sm text-ink-2">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="btn-secondary btn-sm mt-2">
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
  bare,
  illustration,
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  bare?: boolean;
  /** a drawing from src/illustrations, for first-run states only; filtered lists keep the icon */
  illustration?: IllustrationName;
}) {
  return (
    <div className={`flex flex-col items-center gap-1 px-6 text-center ${illustration ? 'py-10' : 'py-12'} ${bare ? '' : 'card'}`}>
      {illustration ? (
        <Illustration name={illustration} width={illustration === 'employees.empty' ? 136 : 208} className="mb-4" />
      ) : (
        <Inbox size={20} strokeWidth={1.5} className="mb-1 text-ink-3" />
      )}
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="max-w-sm text-sm text-ink-3">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Pagination({ meta, onPage }: { meta: PageMeta; onPage: (page: number) => void }) {
  if (meta.total === 0) return null;
  const from = (meta.page - 1) * meta.pageSize + 1;
  const to = Math.min(meta.page * meta.pageSize, meta.total);
  return (
    <div className="flex items-center justify-between border-t border-line px-5 py-3 text-sm text-ink-3">
      <span className="num text-xs">
        {from}–{to} of {meta.total.toLocaleString()}
      </span>
      <div className="flex gap-1">
        <button className="btn-secondary btn-sm px-2" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)} aria-label="Previous page">
          <ChevronLeft {...ICON} />
        </button>
        <button
          className="btn-secondary btn-sm px-2"
          disabled={meta.page >= meta.totalPages}
          onClick={() => onPage(meta.page + 1)}
          aria-label="Next page"
        >
          <ChevronRight {...ICON} />
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Forms                                                                */
/* ------------------------------------------------------------------ */

export function Field({
  label,
  children,
  hint,
  error,
  required,
  className = '',
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-sm text-ink-2">
        {label}
        {required && <span className="ml-0.5 text-ink-3">*</span>}
      </span>
      {children}
      {error ? <span className="mt-1 block text-xs text-bad">{error}</span> : hint ? <span className="mt-1 block text-xs text-ink-3">{hint}</span> : null}
    </label>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search',
  className = '',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <Search size={16} strokeWidth={1.5} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
      <input className="input pl-9" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
    </div>
  );
}

/** Debounced value for search boxes. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{message}</p>;
}

/* ------------------------------------------------------------------ */
/* Overlays                                                             */
/* ------------------------------------------------------------------ */

/**
 * Open dialogs, newest last. Only the top one answers Escape and owns the
 * scroll lock, so a confirm opened over a form closes on its own.
 */
const modalStack: number[] = [];
let modalSeq = 0;

export function Modal({
  title,
  description,
  open,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  /** one quiet line under the title */
  description?: ReactNode;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const id = ++modalSeq;
    modalStack.push(id);
    const returnFocus = document.activeElement as HTMLElement | null;

    // lock the page behind; keep its width so nothing shifts when the scrollbar hides
    const body = document.body;
    const prevOverflow = body.style.overflow;
    const prevPadding = body.style.paddingRight;
    if (modalStack.length === 1) {
      const scrollbar = window.innerWidth - document.documentElement.clientWidth;
      body.style.overflow = 'hidden';
      if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;
    }

    // focus the first field, or the dialog itself
    const t = setTimeout(() => {
      const panel = panelRef.current;
      const first = panel?.querySelector<HTMLElement>('[data-autofocus], input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])');
      (first ?? panel)?.focus({ preventScroll: true });
    }, 30);

    const onKey = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== id) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      }
      // keep Tab inside the dialog
      if (e.key === 'Tab' && panelRef.current) {
        const items = [...panelRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
        if (items.length === 0) return;
        const firstEl = items[0];
        const lastEl = items[items.length - 1];
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
      modalStack.splice(modalStack.indexOf(id), 1);
      if (modalStack.length === 0) {
        body.style.overflow = prevOverflow;
        body.style.paddingRight = prevPadding;
      }
      returnFocus?.focus?.({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  // Rendered at the end of <body> so the backdrop covers the whole window,
  // sidebar and top bar included, whatever the page's own layout does.
  return createPortal(
    <div className="fixed inset-0 z-50" role="presentation">
      <div className="modal-scrim absolute inset-0 bg-[rgba(17,17,19,0.32)]" aria-hidden />
      <div
        className="absolute inset-0 flex items-end justify-center p-0 sm:items-center sm:p-6"
        onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      >
        <div
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className={`modal-panel flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-surface shadow-[0_24px_64px_-12px_rgba(0,0,0,0.22),0_2px_6px_rgba(0,0,0,0.04)] outline-none sm:max-h-[min(860px,calc(100vh-48px))] sm:rounded-2xl ${
            wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'
          }`}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 px-6 pb-4 pt-5">
            <div className="min-w-0">
              <h2 className="text-base font-medium leading-6">{title}</h2>
              {description && <p className="mt-0.5 text-sm text-ink-3">{description}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="-mr-2 -mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-raised hover:text-ink"
              aria-label="Close"
            >
              <X {...ICON} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6">{children}</div>
          {footer && <div className="flex shrink-0 justify-end gap-2 border-t border-line bg-bg px-6 py-3">{footer}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={onConfirm} disabled={busy}>
            {busy && <Loader2 size={16} strokeWidth={1.5} className="animate-spin" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      {body && <div className="text-sm text-ink-2">{body}</div>}
      {children}
    </Modal>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ value: T; label: string; count?: number }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="mb-6 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={`-mb-px flex h-10 items-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm transition-colors ${
            value === t.value ? 'border-brand font-medium text-ink' : 'border-transparent text-ink-2 hover:text-ink'
          }`}
        >
          {t.label}
          {t.count !== undefined && <span className="num text-xs text-ink-3">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Segmented filter for a few status values. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex h-9 max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-line bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`h-full shrink-0 whitespace-nowrap rounded-md px-3 text-sm transition-colors ${
            value === o.value ? 'bg-raised font-medium text-ink shadow-[inset_0_0_0_1px_rgba(23,23,23,0.06)]' : 'text-ink-2 hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toasts                                                               */
/* ------------------------------------------------------------------ */

type ToastItem = { id: number; message: string; tone: 'good' | 'bad' };
let toastId = 0;
const listeners = new Set<(t: ToastItem) => void>();

/** Short confirmation after an action: toast('Leave approved'). */
export function toast(message: string, tone: 'good' | 'bad' = 'good'): void {
  const t = { id: ++toastId, message, tone };
  listeners.forEach((l) => l(t));
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const add = (t: ToastItem) => {
      setItems((xs) => [...xs, t]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 3500);
    };
    listeners.add(add);
    return () => {
      listeners.delete(add);
    };
  }, []);
  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-[60] flex flex-col items-end gap-2">
      {items.map((t) => (
        <div key={t.id} className="pop pointer-events-auto flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3 text-sm shadow-float">
          {t.tone === 'good' ? (
            <Check size={16} strokeWidth={1.5} className="text-good" />
          ) : (
            <AlertTriangle size={16} strokeWidth={1.5} className="text-bad" />
          )}
          {t.message}
        </div>
      ))}
    </div>
  );
}
