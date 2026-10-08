import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Check, ChevronDown, ChevronLeft, ChevronRight, CircleDollarSign, Gift, Hourglass, Pencil, Plus, Repeat, Save, Target, Trophy, Users, Wallet } from 'lucide-react';
import { archiveGoal, createGoal, getCommissions, listContracts, listGoals, listSubscriptions, markPaid, saveContract, unmarkPaid, updateDeal, updateGoal } from '../lib/api.js';
import { GOAL_METRICS, GOAL_SCOPES, formatGoalValue, formatPeriod, goalTimeLabel } from '../lib/goals.js';
import { useUserDirectory } from '../lib/hooks.js';
import { ROLE_META, formatCurrency, parseMoney } from '../lib/labels.js';
import { useToast } from '../components/toast.jsx';
import {
  Avatar,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Modal,
  PageHeader,
  Select,
  Spinner,
  StatCard,
  Tabs,
  Textarea,
  apiErrorToForm,
  cx,
  inputClass,
} from '../components/ui.jsx';

// ---------------------------------------------------------------------------
// Mês (no fuso de quem vê; o servidor fecha o mês no fuso da empresa)
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const shiftMonth = (ym, delta) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const monthLabel = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  const text = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const pct = (n) => `${Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;

function MonthPicker({ value, onChange }) {
  return (
    <div className="flex items-center gap-1 rounded-xl border border-neutral-800 bg-[#141414] p-1">
      <button type="button" onClick={() => onChange(shiftMonth(value, -1))} aria-label="Mês anterior" className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-white">
        <ChevronLeft className="size-4" />
      </button>
      <span className="min-w-36 text-center text-sm font-semibold text-white tabular-nums">{monthLabel(value)}</span>
      <button type="button" onClick={() => onChange(shiftMonth(value, 1))} aria-label="Mês seguinte" className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-white">
        <ChevronRight className="size-4" />
      </button>
      {value !== thisMonth() && (
        <button type="button" onClick={() => onChange(thisMonth())} className="rounded-lg px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-white">
          Hoje
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pagamentos do mês
// ---------------------------------------------------------------------------

function PersonRow({ row }) {
  const [open, setOpen] = useState(false);
  const { user, contract, totals } = row;
  const hasItems = row.closings.length + row.monthly.length > 0;
  return (
    <Card className="overflow-hidden">
      <button type="button" onClick={() => setOpen((o) => !o)} disabled={!hasItems} className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 p-4 text-left transition enabled:hover:bg-neutral-900/50">
        <span className="flex min-w-0 flex-1 items-center gap-3">
          <Avatar name={user.name} id={user.id} size="sm" />
          <span className="min-w-0">
            <span className="block truncate font-semibold text-white">{user.name}</span>
            <span className="text-xs text-neutral-500">
              {contract.configured ? `${pct(contract.closing_rate)} por venda · ${pct(contract.monthly_rate)} por mensalidade` : 'Sem contrato definido'}
            </span>
          </span>
        </span>
        <span className="grid grid-cols-3 gap-4 text-right text-xs sm:w-auto">
          <span>
            <span className="block text-neutral-500">Fechos</span>
            <span className="font-semibold text-neutral-200 tabular-nums">{formatCurrency(totals.closing)}</span>
          </span>
          <span>
            <span className="block text-neutral-500">Mensalidades</span>
            <span className="font-semibold text-neutral-200 tabular-nums">{formatCurrency(totals.monthly_paid)}</span>
            {totals.monthly_pending > 0 && <span className="block text-[11px] text-amber-400/80 tabular-nums">+{formatCurrency(totals.monthly_pending)} previsto</span>}
          </span>
          <span>
            <span className="block text-neutral-500">A pagar</span>
            <span className="text-base font-bold text-emerald-400 tabular-nums">{formatCurrency(totals.to_pay)}</span>
          </span>
        </span>
        {hasItems && <ChevronDown className={cx('size-4 shrink-0 text-neutral-500 transition', open && 'rotate-180')} />}
      </button>
      {open && (
        <div className="space-y-3 border-t border-neutral-800 bg-neutral-950/40 p-4 text-sm">
          {row.closings.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-semibold tracking-wide text-neutral-500 uppercase">Vendas fechadas no mês</p>
              {row.closings.map((d) => (
                <p key={d.deal_id} className="flex justify-between gap-3 py-1">
                  <span className="truncate text-neutral-300">{d.company || d.title}</span>
                  <span className="shrink-0 text-neutral-500 tabular-nums">
                    {formatCurrency(d.value)} × {pct(d.rate)} = <span className="font-semibold text-neutral-200">{formatCurrency(d.commission)}</span>
                  </span>
                </p>
              ))}
            </div>
          )}
          {row.monthly.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-semibold tracking-wide text-neutral-500 uppercase">Mensalidades do mês</p>
              {row.monthly.map((m) => (
                <p key={m.deal_id} className="flex justify-between gap-3 py-1">
                  <span className="flex min-w-0 items-center gap-2 truncate text-neutral-300">
                    {m.paid ? <Check className="size-3.5 shrink-0 text-emerald-400" /> : <Hourglass className="size-3.5 shrink-0 text-amber-400" />}
                    <span className="truncate">{m.company || m.title}</span>
                    {m.month_number && <span className="text-xs text-neutral-600">{m.month_number}.º mês</span>}
                  </span>
                  <span className="shrink-0 text-neutral-500 tabular-nums">
                    {m.eligible ? (
                      <>
                        {formatCurrency(m.amount)} × {pct(m.rate)} = <span className={cx('font-semibold', m.paid ? 'text-neutral-200' : 'text-amber-300/80')}>{formatCurrency(m.commission)}</span>
                        {!m.paid && ' (se pagar)'}
                      </>
                    ) : (
                      'fora do período de comissão'
                    )}
                  </span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function CommissionsTab({ month }) {
  const { data, isLoading, isError, error, refetch } = useQuery({ queryKey: ['commissions', month], queryFn: () => getCommissions(month) });
  if (isError) return <ErrorState error={error} onRetry={refetch} />;
  const t = data?.totals;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="A pagar à equipe" value={formatCurrency(t?.to_pay)} icon={Wallet} tone="emerald" loading={isLoading} />
        <StatCard label="Comissões de fechos" value={formatCurrency(t?.closing)} icon={Trophy} tone="amber" loading={isLoading} />
        <StatCard label="Comissões de mensalidades" value={formatCurrency(t?.monthly_paid)} icon={Repeat} tone="sky" loading={isLoading} />
        <StatCard label="Previsto (mensalidades por pagar)" value={formatCurrency(t?.monthly_pending)} icon={Hourglass} loading={isLoading} />
      </div>
      {t && (
        <p className="text-xs text-neutral-500">
          Vendido no mês: <span className="text-neutral-300">{formatCurrency(t.sold)}</span> · Mensalidades recebidas:{' '}
          <span className="text-neutral-300">{formatCurrency(t.subscriptions_received)}</span> de {formatCurrency(t.subscriptions_expected)}. Comissão de mensalidade só conta
          depois de marcar a mensalidade como paga.
        </p>
      )}
      {isLoading ? (
        <Spinner />
      ) : data.people.length === 0 ? (
        <EmptyState icon={Users} title="Ninguém na equipe ainda" />
      ) : (
        <div className="space-y-2">{data.people.map((row) => <PersonRow key={row.user.id} row={row} />)}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mensalidades
// ---------------------------------------------------------------------------

function SubscriptionsTab({ month }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [ending, setEnding] = useState(null);
  const { data = [], isLoading, isError, error, refetch } = useQuery({ queryKey: ['subscriptions', month], queryFn: () => listSubscriptions(month) });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
    queryClient.invalidateQueries({ queryKey: ['commissions'] });
  };
  const toggle = useMutation({
    mutationFn: (s) => (s.paid ? unmarkPaid(s.deal_id, month) : markPaid(s.deal_id, month)),
    onSuccess: (_, s) => {
      toast.success(s.paid ? 'Pagamento desmarcado' : 'Mensalidade paga ✓', s.company || s.title);
      invalidate();
    },
    onError: (err) => toast.error('Não foi possível atualizar', err.message),
  });
  const end = useMutation({
    mutationFn: (s) => updateDeal(s.deal_id, { monthly_end: `${month}-01` }),
    onSuccess: (_, s) => {
      setEnding(null);
      toast.success('Mensalidade terminada', `${s.company || s.title}: último mês ${monthLabel(month)}.`);
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['deals'] });
    },
    onError: (err) => toast.error('Não foi possível terminar', err.message),
  });

  if (isError) return <ErrorState error={error} onRetry={refetch} />;
  if (isLoading) return <Spinner />;
  if (!data.length) {
    return <EmptyState icon={Repeat} title="Sem mensalidades neste mês" description="Quando um negócio fechar com mensalidade (pop-up de Cliente Fechado), aparece aqui a partir do 1.º mês." />;
  }
  const paid = data.filter((s) => s.paid);
  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-400">
        {paid.length} de {data.length} pagas · {formatCurrency(paid.reduce((n, s) => n + Number(s.paid_amount), 0))} de {formatCurrency(data.reduce((n, s) => n + Number(s.paid ? s.paid_amount : s.monthly_value), 0))}
      </p>
      <Card className="divide-y divide-neutral-800">
        {data.map((s) => (
          <div key={s.deal_id} className="flex flex-wrap items-center gap-3 p-3.5">
            <button
              type="button"
              onClick={() => toggle.mutate(s)}
              disabled={toggle.isPending}
              aria-pressed={s.paid}
              className={cx(
                'flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold ring-1 transition',
                s.paid ? 'bg-emerald-600/20 text-emerald-300 ring-emerald-700/60 hover:bg-emerald-600/30' : 'text-neutral-300 ring-neutral-700 hover:bg-neutral-800',
              )}
            >
              {s.paid ? <Check className="size-4" /> : <CircleDollarSign className="size-4" />}
              {s.paid ? 'Pago' : 'Marcar pago'}
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-white">{s.company || s.title}</p>
              <p className="text-xs text-neutral-500">
                {s.owner_name ?? 'Sem vendedor'} · {s.month_number ? `${s.month_number}.º mês` : ''}
                {s.monthly_end && ` · termina em ${s.monthly_end.slice(5, 7)}/${s.monthly_end.slice(0, 4)}`}
                {s.stage !== 'won' && ' · negócio reaberto'}
              </p>
            </div>
            <span className="font-semibold text-neutral-100 tabular-nums">{formatCurrency(s.paid ? s.paid_amount : s.monthly_value)}</span>
            {s.stage === 'won' && !s.monthly_end && (
              <button type="button" onClick={() => setEnding(s)} className="text-xs text-neutral-500 transition hover:text-red-400">
                Terminar
              </button>
            )}
          </div>
        ))}
      </Card>
      <ConfirmDialog
        open={Boolean(ending)}
        title="Terminar a mensalidade?"
        description={ending ? `${ending.company || ending.title} deixa de pagar depois de ${monthLabel(month)} (este fica como o último mês).` : ''}
        confirmLabel="Terminar"
        loading={end.isPending}
        onConfirm={() => end.mutate(ending)}
        onClose={() => setEnding(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------

function ContractCard({ contract }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const initial = () => ({
    closing_rate: String(contract.closing_rate ?? 0).replace('.', ','),
    monthly_rate: String(contract.monthly_rate ?? 0).replace('.', ','),
    monthly_months: contract.monthly_months ? String(contract.monthly_months) : '',
    notes: contract.notes ?? '',
  });
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const dirty = JSON.stringify(form) !== JSON.stringify(initial());

  const save = useMutation({
    mutationFn: (body) => saveContract(contract.user_id, body),
    onSuccess: () => {
      toast.success('Contrato guardado', contract.name);
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      queryClient.invalidateQueries({ queryKey: ['commissions'] });
    },
    onError: (err) => setErrors({ form: apiErrorToForm(err).message }),
  });

  const set = (field) => (e) => {
    setForm((f) => ({ ...f, [field]: e.target.value }));
    setErrors({});
  };
  const submit = (e) => {
    e.preventDefault();
    const closing = parseMoney(form.closing_rate);
    const monthly = parseMoney(form.monthly_rate);
    const months = form.monthly_months.trim() ? Number(form.monthly_months) : null;
    const errs = {};
    if (closing < 0 || closing > 100) errs.closing_rate = 'Entre 0 e 100.';
    if (monthly < 0 || monthly > 100) errs.monthly_rate = 'Entre 0 e 100.';
    if (months !== null && (!Number.isInteger(months) || months < 1)) errs.monthly_months = 'Número de meses inteiro (ou vazio).';
    if (Object.keys(errs).length) return setErrors(errs);
    save.mutate({ closing_rate: closing, monthly_rate: monthly, monthly_months: months, notes: form.notes.trim() || null });
  };

  return (
    <Card className={cx('p-4', !contract.is_active && 'opacity-60')}>
      <form onSubmit={submit} noValidate>
        <div className="mb-3 flex items-center gap-3">
          <Avatar name={contract.name} id={contract.user_id} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-white">{contract.name}</p>
            <div className="flex items-center gap-1.5">
              {contract.role && <Badge tone={ROLE_META[contract.role]?.tone}>{ROLE_META[contract.role]?.label}</Badge>}
              {!contract.is_active && <Badge>Desativado</Badge>}
              {!contract.configured && <span className="text-xs text-amber-400/80">sem contrato</span>}
            </div>
          </div>
        </div>
        {errors.form && <p className="mb-3 rounded-lg bg-red-950/40 px-3 py-2 text-xs text-red-300">{errors.form}</p>}
        <div className="grid grid-cols-3 gap-3">
          <Field label="% por venda" error={errors.closing_rate}>
            {({ id }) => <input id={id} inputMode="decimal" value={form.closing_rate} onChange={set('closing_rate')} className={inputClass} />}
          </Field>
          <Field label="% mensalidade" error={errors.monthly_rate}>
            {({ id }) => <input id={id} inputMode="decimal" value={form.monthly_rate} onChange={set('monthly_rate')} className={inputClass} />}
          </Field>
          <Field label="Por quantos meses" error={errors.monthly_months}>
            {({ id }) => <input id={id} inputMode="numeric" value={form.monthly_months} onChange={set('monthly_months')} placeholder="Sempre" className={inputClass} />}
          </Field>
        </div>
        <Field label="Notas do contrato" className="mt-3">
          {({ id }) => <Textarea id={id} rows={2} maxLength={500} value={form.notes} onChange={set('notes')} placeholder="Ex: fixo de R$ 500 + comissões; pagamento até dia 10" className="min-h-14" />}
        </Field>
        <div className="mt-3 flex justify-end">
          <Button type="submit" size="sm" icon={Save} loading={save.isPending} disabled={!dirty && contract.configured}>
            Guardar
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ContractsTab() {
  const { data = [], isLoading, isError, error, refetch } = useQuery({ queryKey: ['contracts'], queryFn: listContracts });
  if (isError) return <ErrorState error={error} onRetry={refetch} />;
  if (isLoading) return <Spinner />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-400">
        A % por venda fica fixada em cada negócio quando fecha, e a % da mensalidade quando marca o pagamento: mudar aqui não altera o que já foi fechado ou pago.
        &quot;Por quantos meses&quot; vazio = enquanto o cliente pagar.
      </p>
      <div className="grid gap-3 lg:grid-cols-2">
        {data.map((c) => (
          <ContractCard key={`${c.user_id}-${c.updated_at ?? 'new'}`} contract={c} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metas
// ---------------------------------------------------------------------------

const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const PERIOD_PRESETS = [
  {
    label: 'Esta semana',
    range: () => {
      const d = new Date();
      const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
      return [ymd(monday), ymd(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6))];
    },
  },
  {
    label: 'Este mês',
    range: () => {
      const d = new Date();
      return [ymd(new Date(d.getFullYear(), d.getMonth(), 1)), ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0))];
    },
  },
  {
    label: 'Próximos 30 dias',
    range: () => {
      const d = new Date();
      return [ymd(d), ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 29))];
    },
  },
  {
    label: 'Este trimestre',
    range: () => {
      const d = new Date();
      const q = Math.floor(d.getMonth() / 3) * 3;
      return [ymd(new Date(d.getFullYear(), q, 1)), ymd(new Date(d.getFullYear(), q + 3, 0))];
    },
  },
];

function GoalModal({ goal, onClose }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: users = [] } = useUserDirectory();
  const isEdit = Boolean(goal);
  const [defaultStart, defaultEnd] = PERIOD_PRESETS[1].range();
  const [form, setForm] = useState({
    title: goal?.title ?? '',
    metric: goal?.metric ?? 'won_value',
    target: goal ? String(goal.target).replace('.', ',') : '',
    scope: goal?.scope ?? 'individual',
    starts_on: goal?.starts_on ?? defaultStart,
    ends_on: goal?.ends_on ?? defaultEnd,
    reward: goal?.reward ?? '',
    member_ids: goal?.members.map((m) => m.user_id) ?? [],
  });
  const [errors, setErrors] = useState({});

  const mutation = useMutation({
    mutationFn: (body) => (isEdit ? updateGoal(goal.id, body) : createGoal(body)),
    onSuccess: (saved) => {
      toast.success(isEdit ? 'Meta atualizada' : 'Meta criada 🎯', saved.title);
      queryClient.invalidateQueries({ queryKey: ['goals'] });
      onClose();
    },
    onError: (err) => setErrors({ form: apiErrorToForm(err).message }),
  });

  const set = (field) => (e) => {
    setForm((f) => ({ ...f, [field]: e.target.value }));
    setErrors((x) => ({ ...x, [field]: undefined, form: undefined }));
  };
  const toggleMember = (id) =>
    setForm((f) => ({ ...f, member_ids: f.member_ids.includes(id) ? f.member_ids.filter((x) => x !== id) : [...f.member_ids, id] }));

  const submit = (e) => {
    e.preventDefault();
    const target = GOAL_METRICS[form.metric].money ? parseMoney(form.target) : Number(String(form.target).replace(',', '.'));
    const errs = {};
    if (form.title.trim().length < 2) errs.title = 'Dê um nome à meta.';
    if (!(target > 0)) errs.target = 'Indique o alvo.';
    if (!form.starts_on || !form.ends_on) errs.period = 'Indique o período.';
    else if (form.ends_on < form.starts_on) errs.period = 'A data final tem de ser depois da inicial.';
    if (!form.member_ids.length) errs.members = 'Escolha pelo menos uma pessoa.';
    if (Object.keys(errs).length) return setErrors(errs);
    mutation.mutate({
      title: form.title.trim(),
      metric: form.metric,
      target,
      scope: form.scope,
      starts_on: form.starts_on,
      ends_on: form.ends_on,
      reward: form.reward.trim() || null,
      member_ids: form.member_ids,
    });
  };

  const allSelected = users.length > 0 && users.every((u) => form.member_ids.includes(u.id));
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={isEdit ? 'Editar meta' : 'Nova meta'}
      description="Aparece no Piso de quem participa, com o progresso em tempo real."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button type="submit" form="goal-form" icon={Target} loading={mutation.isPending}>{isEdit ? 'Guardar' : 'Criar meta'}</Button>
        </>
      }
    >
      <form id="goal-form" onSubmit={submit} className="space-y-4" noValidate>
        {errors.form && <p className="rounded-xl bg-red-950/40 px-3 py-2 text-sm text-red-300">{errors.form}</p>}
        <Field label="Nome da meta" required error={errors.title}>
          {({ id, invalid }) => <input id={id} aria-invalid={invalid} value={form.title} onChange={set('title')} className={inputClass} placeholder="Ex: Corrida de outubro" data-autofocus />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="O que conta">
            {({ id }) => (
              <Select id={id} value={form.metric} onChange={set('metric')}>
                {Object.entries(GOAL_METRICS).map(([key, m]) => (
                  <option key={key} value={key}>{m.label}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={GOAL_METRICS[form.metric].money ? 'Alvo (R$)' : 'Alvo (quantidade)'} required error={errors.target}>
            {({ id, invalid }) => <input id={id} inputMode="decimal" aria-invalid={invalid} value={form.target} onChange={set('target')} className={inputClass} placeholder={GOAL_METRICS[form.metric].money ? 'Ex: 30.000' : 'Ex: 10'} />}
          </Field>
        </div>

        <div>
          <p className="mb-1.5 text-sm font-medium text-neutral-300">Tipo</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {Object.entries(GOAL_SCOPES).map(([key, s]) => (
              <label key={key} className={cx('flex cursor-pointer gap-3 rounded-xl border p-3 transition', form.scope === key ? 'border-red-800 bg-red-950/20' : 'border-neutral-800 hover:border-neutral-700')}>
                <input type="radio" name="scope" value={key} checked={form.scope === key} onChange={set('scope')} className="mt-0.5 accent-red-700" />
                <span>
                  <span className="block text-sm font-medium text-white">{s.label}</span>
                  <span className="text-xs text-neutral-500">{s.description}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Começa em" required>
              {({ id }) => <input id={id} type="date" value={form.starts_on} onChange={set('starts_on')} className={inputClass} />}
            </Field>
            <Field label="Termina em" required>
              {({ id }) => <input id={id} type="date" value={form.ends_on} min={form.starts_on} onChange={set('ends_on')} className={inputClass} />}
            </Field>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {PERIOD_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  const [a, b] = p.range();
                  setForm((f) => ({ ...f, starts_on: a, ends_on: b }));
                  setErrors((x) => ({ ...x, period: undefined }));
                }}
                className="rounded-lg px-2 py-1 text-xs text-neutral-400 ring-1 ring-neutral-800 transition hover:bg-neutral-800 hover:text-white"
              >
                {p.label}
              </button>
            ))}
          </div>
          {errors.period && <p className="mt-1.5 text-xs text-red-400">{errors.period}</p>}
        </div>

        <Field label="Recompensa" hint="Opcional. Aparece no topo do Piso.">
          {({ id }) => <input id={id} value={form.reward} onChange={set('reward')} maxLength={500} className={inputClass} placeholder="Ex: R$ 500 de bônus + jantar por conta da casa" />}
        </Field>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-sm font-medium text-neutral-300">
              Quem participa<span className="ml-0.5 text-red-500">*</span>
            </p>
            <button
              type="button"
              onClick={() => setForm((f) => ({ ...f, member_ids: allSelected ? [] : users.map((u) => u.id) }))}
              className="text-xs text-neutral-400 hover:text-white"
            >
              {allSelected ? 'Limpar' : 'Toda a equipe'}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {users.map((u) => {
              const on = form.member_ids.includes(u.id);
              return (
                <button
                  key={u.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    toggleMember(u.id);
                    setErrors((x) => ({ ...x, members: undefined }));
                  }}
                  className={cx('flex items-center gap-2 rounded-full py-1 pr-3 pl-1 text-sm ring-1 transition', on ? 'bg-red-950/40 text-white ring-red-800' : 'text-neutral-400 ring-neutral-800 hover:ring-neutral-700')}
                >
                  <Avatar name={u.name} id={u.id} size="xs" />
                  {u.name}
                  {on && <Check className="size-3.5 text-red-400" />}
                </button>
              );
            })}
          </div>
          {errors.members && <p className="mt-1.5 text-xs text-red-400">{errors.members}</p>}
        </div>
      </form>
    </Modal>
  );
}

function GoalsTab() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(null); // null | 'new' | goal
  const [archiving, setArchiving] = useState(null);
  const [include, setInclude] = useState('current');
  const { data = [], isLoading, isError, error, refetch } = useQuery({ queryKey: ['goals', include], queryFn: () => listGoals({ include }) });

  const archive = useMutation({
    mutationFn: (goal) => archiveGoal(goal.id),
    onSuccess: (_, goal) => {
      setArchiving(null);
      toast.success('Meta arquivada', goal.title);
      queryClient.invalidateQueries({ queryKey: ['goals'] });
    },
    onError: (err) => toast.error('Não foi possível arquivar', err.message),
  });

  if (isError) return <ErrorState error={error} onRetry={refetch} />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select value={include} onChange={(e) => setInclude(e.target.value)} className="w-56" aria-label="Que metas mostrar">
          <option value="current">A decorrer e próximas</option>
          <option value="all">Todas (inclui antigas)</option>
        </Select>
        <Button icon={Plus} onClick={() => setEditing('new')}>Nova meta</Button>
      </div>
      {isLoading ? (
        <Spinner />
      ) : !data.length ? (
        <EmptyState icon={Target} title="Nenhuma meta ainda" description="Crie uma meta com período e recompensa: a equipe acompanha no Piso." action={<Button icon={Plus} onClick={() => setEditing('new')}>Nova meta</Button>} />
      ) : (
        <Card className="divide-y divide-neutral-800">
          {data.map((g) => (
            <div key={g.id} className="flex flex-wrap items-center gap-3 p-3.5">
              <span className={cx('flex size-9 shrink-0 items-center justify-center rounded-xl', g.reached ? 'bg-emerald-950/60 text-emerald-400' : 'bg-neutral-800 text-neutral-300')}>
                {g.reached ? <Trophy className="size-4" /> : <Target className="size-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-white">{g.title}</p>
                <p className="text-xs text-neutral-500">
                  {GOAL_METRICS[g.metric].label} · alvo {formatGoalValue(g.metric, g.target)} · {GOAL_SCOPES[g.scope].label.toLowerCase()} · {formatPeriod(g)} · {goalTimeLabel(g)}
                </p>
                <p className="text-xs text-neutral-500">
                  {g.members.map((m) => m.name.split(' ')[0]).join(', ')}
                  {g.reward && (
                    <span className="ml-1.5 text-amber-300/80">
                      <Gift className="mr-0.5 inline size-3" />
                      {g.reward}
                    </span>
                  )}
                </p>
              </div>
              <span className="text-sm font-semibold text-neutral-200 tabular-nums">{Math.round((g.scope === 'group' ? g.total_pct : Math.max(0, ...g.members.map((m) => m.pct))) * 100)}%</span>
              <button type="button" onClick={() => setEditing(g)} className="rounded-lg p-2 text-neutral-400 hover:bg-neutral-800 hover:text-white" aria-label={`Editar ${g.title}`}>
                <Pencil className="size-4" />
              </button>
              <button type="button" onClick={() => setArchiving(g)} className="rounded-lg p-2 text-neutral-400 hover:bg-neutral-800 hover:text-red-400" aria-label={`Arquivar ${g.title}`}>
                <Archive className="size-4" />
              </button>
            </div>
          ))}
        </Card>
      )}
      {editing && <GoalModal goal={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={Boolean(archiving)}
        title="Arquivar meta?"
        description={archiving ? `"${archiving.title}" sai do Piso de todos.` : ''}
        confirmLabel="Arquivar"
        loading={archive.isPending}
        onConfirm={() => archive.mutate(archiving)}
        onClose={() => setArchiving(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default function ContractsPage() {
  const [tab, setTab] = useState('commissions');
  const [month, setMonth] = useState(thisMonth);
  const monthly = tab === 'commissions' || tab === 'subscriptions';
  return (
    <div className="space-y-5">
      <PageHeader
        title="Contratos e metas"
        description="Só você vê esta página: comissões de cada um, mensalidades dos clientes e as metas do Piso."
        actions={monthly && <MonthPicker value={month} onChange={setMonth} />}
      />
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'commissions', label: 'A pagar no mês' },
          { value: 'subscriptions', label: 'Mensalidades' },
          { value: 'contracts', label: 'Contratos' },
          { value: 'goals', label: 'Metas' },
        ]}
      />
      {tab === 'commissions' && <CommissionsTab month={month} />}
      {tab === 'subscriptions' && <SubscriptionsTab month={month} />}
      {tab === 'contracts' && <ContractsTab />}
      {tab === 'goals' && <GoalsTab />}
    </div>
  );
}
