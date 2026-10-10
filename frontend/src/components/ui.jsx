import { useEffect, useId, useRef } from 'react';
import { Inbox, LoaderCircle, RefreshCw, TriangleAlert, X } from 'lucide-react';

export const cx = (...classes) => classes.filter(Boolean).join(' ');

// ---------------------------------------------------------------------------
// Botões
// ---------------------------------------------------------------------------

const BUTTON_VARIANTS = {
  primary:
    'bg-red-800 text-white shadow-lg shadow-red-950/40 ring-1 ring-red-600/30 hover:bg-red-700 disabled:bg-red-900/60',
  secondary: 'border border-neutral-700 text-neutral-200 hover:border-neutral-600 hover:bg-neutral-800',
  ghost: 'text-neutral-400 hover:bg-neutral-800 hover:text-white',
  danger: 'border border-red-900/70 bg-red-950/40 text-red-300 hover:bg-red-900/50 hover:text-white',
  success: 'border border-emerald-900/60 bg-emerald-950/20 text-emerald-300 hover:bg-emerald-950/50 hover:text-emerald-200',
};

const BUTTON_SIZES = {
  sm: 'h-8 gap-1.5 rounded-lg px-2.5 text-xs',
  md: 'h-10 gap-2 rounded-xl px-4 text-sm',
};

export function Button({ variant = 'primary', size = 'md', icon: Icon, loading = false, className, children, ...props }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || loading}
      className={cx(
        'inline-flex shrink-0 items-center justify-center font-semibold whitespace-nowrap transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" /> : Icon && <Icon className="size-4" />}
      {children}
    </button>
  );
}

export function IconButton({ icon: Icon, label, className, ...props }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={cx(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-neutral-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Badge e avatar
// ---------------------------------------------------------------------------

const BADGE_TONES = {
  neutral: 'bg-neutral-800 text-neutral-300 ring-neutral-700',
  red: 'bg-red-500/10 text-red-300 ring-red-500/30',
  amber: 'bg-amber-500/10 text-amber-300 ring-amber-500/30',
  emerald: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30',
  sky: 'bg-sky-500/10 text-sky-300 ring-sky-500/30',
};

const DOT_TONES = {
  neutral: 'bg-neutral-400',
  red: 'bg-red-400',
  amber: 'bg-amber-400',
  emerald: 'bg-emerald-400',
  sky: 'bg-sky-400',
};

export function Badge({ tone = 'neutral', dot = false, className, children }) {
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 whitespace-nowrap',
        BADGE_TONES[tone],
        className,
      )}
    >
      {dot && <span className={cx('size-1.5 rounded-full', DOT_TONES[tone])} />}
      {children}
    </span>
  );
}

const AVATAR_COLORS = [
  'from-red-700 to-red-900',
  'from-amber-600 to-orange-800',
  'from-emerald-600 to-teal-800',
  'from-sky-600 to-indigo-800',
  'from-fuchsia-600 to-purple-800',
  'from-neutral-500 to-neutral-700',
];

export function Avatar({ name = '?', id = 0, size = 'md', className }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
  const sizes = { xs: 'size-5 text-[9px]', sm: 'size-7 text-[11px]', md: 'size-9 text-xs', lg: 'size-11 text-sm' };

  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-linear-to-br font-bold text-white ring-2 ring-[#1a1a1a]',
        AVATAR_COLORS[Math.abs(Number(id) || 0) % AVATAR_COLORS.length],
        sizes[size],
        className,
      )}
    >
      {initials || '?'}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Formulário
// ---------------------------------------------------------------------------

export const inputClass =
  'h-10 w-full rounded-xl border border-neutral-800 bg-[#141414] px-3 text-sm text-neutral-100 placeholder:text-neutral-600 transition outline-none focus:border-red-700 focus:ring-4 focus:ring-red-900/30 disabled:opacity-60 aria-[invalid=true]:border-red-700';

export function Field({ label, error, hint, required, children, className }) {
  const id = useId();
  const child = typeof children === 'function' ? children({ id, invalid: Boolean(error) }) : children;

  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-neutral-300">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      {child}
      {error ? (
        <p className="mt-1.5 text-xs text-red-400" role="alert">
          {error}
        </p>
      ) : (
        hint && <p className="mt-1.5 text-xs text-neutral-500">{hint}</p>
      )}
    </div>
  );
}

export function Select({ className, children, ...props }) {
  return (
    <div className="relative">
      <select {...props} className={cx(inputClass, 'cursor-pointer appearance-none pr-9', className)}>
        {children}
      </select>
      <svg
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-neutral-500"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" />
      </svg>
    </div>
  );
}

export function Textarea({ className, ...props }) {
  return <textarea {...props} className={cx(inputClass, 'h-auto min-h-24 resize-y py-2.5', className)} />;
}

/** Converte o erro da API em mensagens por campo (details do VALIDATION_ERROR) + mensagem geral. */
export function apiErrorToForm(error) {
  const fields = {};
  for (const detail of error?.body?.details ?? []) {
    if (detail.field) fields[detail.field] = detail.message;
  }
  return { fields, message: error?.message ?? 'Erro inesperado.' };
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

/** Comportamento de diálogo: Esc fecha, Tab fica preso no painel, foco inicial e retorno do foco. */
function useDialogBehavior(open, panelRef, onClose) {
  // Ref: onClose costuma ser uma arrow inline; como dependência, o efeito reexecutaria a cada
  // render e roubaria o foco do campo que o utilizador está a editar.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (event) => {
      if (event.key === 'Escape') onCloseRef.current();
      // Mantém o Tab dentro do modal.
      if (event.key === 'Tab' && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);

    // Foca o primeiro campo (ou o próprio painel).
    requestAnimationFrame(() => {
      const target = panelRef.current?.querySelector('[data-autofocus], input, select, textarea') ?? panelRef.current;
      target?.focus();
    });

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus?.();
    };
  }, [open, panelRef]);
}

export function Modal({ open, onClose, title, description, children, footer, size = 'md' }) {
  const titleId = useId();
  const panelRef = useRef(null);
  useDialogBehavior(open, panelRef, onClose);

  if (!open) return null;

  const widths = { sm: 'sm:max-w-md', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl' };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          'relative flex max-h-[92dvh] w-full flex-col rounded-t-2xl border border-neutral-800 bg-[#1a1a1a] shadow-2xl shadow-black/60 outline-none sm:rounded-2xl',
          widths[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-neutral-800 px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-white">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-sm text-neutral-400">{description}</p>}
          </div>
          <IconButton icon={X} label="Fechar" onClick={onClose} className="-mr-1" />
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-neutral-800 px-5 py-3.5">{footer}</div>
        )}
      </div>
    </div>
  );
}

/** Painel lateral (detalhe de registos longos, com histórico). Em telemóvel ocupa o ecrã. */
export function Drawer({ open, onClose, title, subtitle, actions, children, footer }) {
  const titleId = useId();
  const panelRef = useRef(null);
  useDialogBehavior(open, panelRef, onClose);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} aria-hidden="true" />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex h-full w-full flex-col border-l border-neutral-800 bg-[#1a1a1a] shadow-2xl shadow-black/60 outline-none sm:max-w-xl"
      >
        <header className="flex items-start gap-3 border-b border-neutral-800 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-base font-semibold text-white">
              {title}
            </h2>
            {subtitle && <div className="mt-1 text-sm text-neutral-400">{subtitle}</div>}
          </div>
          {actions}
          <IconButton icon={X} label="Fechar" onClick={onClose} />
        </header>
        <div className="flex-1 overflow-y-auto">{children}</div>
        {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-neutral-800 px-5 py-3.5">{footer}</footer>}
      </aside>
    </div>
  );
}

/** Abas simples (sublinhado vermelho). options: [{ value, label, count? }] */
export function Tabs({ value, onChange, options, className }) {
  return (
    <div role="tablist" className={cx('flex gap-1 border-b border-neutral-800', className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cx(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition',
              active ? 'border-red-600 text-white' : 'border-transparent text-neutral-400 hover:text-neutral-200',
            )}
          >
            {option.label}
            {option.count !== undefined && <span className="ml-1.5 text-xs text-neutral-500 tabular-nums">{option.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function ConfirmDialog({ open, title, description, confirmLabel = 'Confirmar', tone = 'danger', loading, onConfirm, onClose }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            Cancelar
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={loading} data-autofocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-neutral-300">{description}</p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Layout e estados
// ---------------------------------------------------------------------------

export function PageHeader({ title, description, actions }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-white sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-neutral-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ className, children }) {
  return <div className={cx('rounded-2xl border border-neutral-800 bg-[#1a1a1a]', className)}>{children}</div>;
}

export function StatCard({ label, value, icon: Icon, tone = 'neutral', loading }) {
  const iconTones = {
    neutral: 'bg-neutral-800 text-neutral-300',
    red: 'bg-red-950/60 text-red-400',
    amber: 'bg-amber-950/50 text-amber-400',
    emerald: 'bg-emerald-950/50 text-emerald-400',
    sky: 'bg-sky-950/50 text-sky-400',
  };
  return (
    <Card className="flex items-center gap-3 p-4">
      {Icon && (
        <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-xl', iconTones[tone])}>
          <Icon className="size-5" />
        </span>
      )}
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-neutral-500">{label}</p>
        {loading ? (
          <span className="mt-1 block h-6 w-10 animate-pulse rounded bg-neutral-800" />
        ) : (
          <p className="truncate text-xl font-bold text-white">{value}</p>
        )}
      </div>
    </Card>
  );
}

/** Abas segmentadas para filtros de estado. options: [{ value, label, count? }] */
export function SegmentedTabs({ options, value, onChange, label }) {
  return (
    <div role="tablist" aria-label={label} className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-neutral-800 bg-[#141414] p-1">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cx(
              'inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition',
              active ? 'bg-neutral-800 text-white shadow-sm' : 'text-neutral-400 hover:text-neutral-200',
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span className={cx('rounded-md px-1.5 text-xs tabular-nums', active ? 'bg-red-900/60 text-red-200' : 'bg-neutral-800 text-neutral-500')}>
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function Spinner({ label = 'Carregando...' }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-neutral-500" role="status">
      <LoaderCircle className="size-5 animate-spin text-red-500" />
      {label}
    </div>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, description, action }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-neutral-800 px-6 py-14 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-neutral-800 text-neutral-400">
        <Icon className="size-6" />
      </span>
      <h3 className="mt-4 text-sm font-semibold text-white">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-neutral-500">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-red-900/40 bg-red-950/10 px-6 py-12 text-center">
      <TriangleAlert className="size-6 text-red-400" />
      <p className="mt-3 text-sm font-semibold text-white">Não foi possível carregar os dados</p>
      <p className="mt-1 text-sm text-neutral-400">{error?.message}</p>
      {onRetry && (
        <Button variant="secondary" icon={RefreshCw} className="mt-4" onClick={onRetry}>
          Tentar novamente
        </Button>
      )}
    </div>
  );
}

export function Pagination({ meta, onChange }) {
  if (!meta || meta.total <= meta.limit) return null;
  const page = Math.floor(meta.offset / meta.limit) + 1;
  const pages = Math.ceil(meta.total / meta.limit);

  return (
    <div className="flex items-center justify-between gap-3 text-sm text-neutral-400">
      <span>
        {meta.offset + 1}–{Math.min(meta.offset + meta.limit, meta.total)} de {meta.total}
      </span>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onChange(meta.offset - meta.limit)}>
          Anterior
        </Button>
        <span className="tabular-nums">
          {page}/{pages}
        </span>
        <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => onChange(meta.offset + meta.limit)}>
          Seguinte
        </Button>
      </div>
    </div>
  );
}
