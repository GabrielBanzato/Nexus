import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, Globe, Hourglass, Inbox, Keyboard, MapPin, Phone, Search, Shuffle, Star, UserRound } from 'lucide-react';
import { assignTriageLead, decideTriageLead, distributeLeads, getTriageSummary, listTriage } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useDebouncedValue, useUserDirectory } from '../lib/hooks.js';
import { OPEN_DEAL_STAGES, ROLE_META, TRIAGE_STATUS_META, formatRelative, parseMoney } from '../lib/labels.js';
import { useToast } from '../components/toast.jsx';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Modal,
  PageHeader,
  Pagination,
  SegmentedTabs,
  Select,
  Spinner,
  Textarea,
  apiErrorToForm,
  cx,
  inputClass,
} from '../components/ui.jsx';

const PAGE_SIZE = 25;
const STATUS_ORDER = ['pending', 'on_hold', 'qualified', 'discarded'];

// ---------------------------------------------------------------------------
// Decisão (qualificar / espera / descartar)
// ---------------------------------------------------------------------------

function DecisionModal({ lead, status, onClose, onDone }) {
  const { isManager } = useAuth();
  const { data: users = [] } = useUserDirectory();
  const [form, setForm] = useState({
    title: lead.name,
    value: '',
    owner_id: lead.assigned_to ?? '',
    stage: 'lead',
    expected_close_date: '',
    score: 70,
    notes: '',
    hold_until: '',
  });
  const [errors, setErrors] = useState({});

  const mutation = useMutation({
    mutationFn: (body) => decideTriageLead(lead.id, body),
    onSuccess: (result) => onDone(result, status),
    onError: (err) => {
      const { fields, message } = apiErrorToForm(err);
      setErrors(Object.keys(fields).length ? fields : { form: message });
    },
  });

  const set = (field) => (event) => setForm((f) => ({ ...f, [field]: event.target.value }));

  const submit = (event) => {
    event.preventDefault();
    const body = { status, notes: form.notes.trim() || null };
    if (status === 'qualified') {
      body.score = Number(form.score);
      body.deal = {
        title: form.title.trim() || lead.name,
        value: parseMoney(form.value),
        stage: form.stage,
        expected_close_date: form.expected_close_date || null,
      };
      if (isManager && form.owner_id) body.deal.owner_id = Number(form.owner_id);
    }
    if (status === 'on_hold') body.hold_until = form.hold_until || null;
    mutation.mutate(body);
  };

  const meta = {
    qualified: { title: 'Qualificar lead', cta: 'Qualificar e criar negócio', icon: CircleCheck, variant: 'primary' },
    on_hold: { title: 'Pôr em espera', cta: 'Pôr em espera', icon: Hourglass, variant: 'secondary' },
    discarded: { title: 'Descartar lead', cta: 'Descartar', icon: CircleX, variant: 'danger' },
  }[status];

  return (
    <Modal
      open
      onClose={onClose}
      title={meta.title}
      description={lead.name}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button type="submit" form="decision-form" variant={meta.variant} icon={meta.icon} loading={mutation.isPending}>
            {meta.cta}
          </Button>
        </>
      }
    >
      <form id="decision-form" onSubmit={submit} className="space-y-4" noValidate>
        {errors.form && <p className="rounded-xl bg-red-950/40 px-3 py-2 text-sm text-red-300">{errors.form}</p>}

        {status === 'qualified' && (
          <>
            <Field label={`Pontuação de qualificação: ${form.score}/100`} hint="Fit com o nosso serviço, interesse demonstrado e capacidade de investimento.">
              {({ id }) => (
                <input id={id} type="range" min="0" max="100" step="5" value={form.score} onChange={set('score')} className="w-full accent-red-700" />
              )}
            </Field>
            <div className="rounded-xl border border-neutral-800 p-4">
              <p className="mb-3 text-sm font-semibold text-white">Negócio no pipeline</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Título" error={errors['deal.title']} className="sm:col-span-2">
                  {({ id }) => <input id={id} value={form.title} onChange={set('title')} className={inputClass} />}
                </Field>
                <Field label="Valor estimado (R$)" error={errors['deal.value']}>
                  {({ id }) => <input id={id} inputMode="decimal" value={form.value} onChange={set('value')} placeholder="Ex: 4.500" className={inputClass} />}
                </Field>
                <Field label="Estágio inicial">
                  {({ id }) => (
                    <Select id={id} value={form.stage} onChange={set('stage')}>
                      {OPEN_DEAL_STAGES.map((s) => (
                        <option key={s.id} value={s.id}>{s.label}</option>
                      ))}
                    </Select>
                  )}
                </Field>
                {isManager && (
                  <Field label="Responsável">
                    {({ id }) => (
                      <Select id={id} value={form.owner_id} onChange={set('owner_id')}>
                        <option value="">Quem está a triar</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>{u.name}</option>
                        ))}
                      </Select>
                    )}
                  </Field>
                )}
                <Field label="Previsão de fecho">
                  {({ id }) => <input id={id} type="date" value={form.expected_close_date} onChange={set('expected_close_date')} className={inputClass} />}
                </Field>
              </div>
            </div>
          </>
        )}

        {status === 'on_hold' && (
          <Field label="Retomar em" hint="Opcional: data para voltar a contactar.">
            {({ id }) => <input id={id} type="date" value={form.hold_until} onChange={set('hold_until')} className={inputClass} />}
          </Field>
        )}

        <Field label={status === 'discarded' ? 'Motivo' : 'Notas'} error={errors.notes}>
          {({ id }) => (
            <Textarea
              id={id}
              value={form.notes}
              onChange={set('notes')}
              rows={3}
              maxLength={1000}
              placeholder={status === 'discarded' ? 'Ex: fora do perfil, fechou, sem interesse...' : 'Contexto da conversa, próximos passos...'}
            />
          )}
        </Field>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Distribuição
// ---------------------------------------------------------------------------

function DistributeModal({ open, onClose, workload, unassigned }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const eligible = (workload ?? []).filter((w) => w.role !== 'admin');
  const [selected, setSelected] = useState(() => new Set(eligible.filter((w) => w.role === 'agent').map((w) => w.id)));
  const [limit, setLimit] = useState(Math.min(50, unassigned || 50));
  const [strategy, setStrategy] = useState('balanced');
  const [grupo, setGrupo] = useState('');
  const [nicho, setNicho] = useState('');

  const mutation = useMutation({
    mutationFn: distributeLeads,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['triage'] });
      if (!result.assigned) toast.info('Nenhum lead para distribuir', 'Não há leads na fila sem responsável com estes filtros.');
      else toast.success(`${result.assigned} leads distribuídos`, Object.entries(result.perUser).map(([id, n]) => `${workload.find((w) => w.id === Number(id))?.name}: ${n}`).join(' · '));
      onClose();
    },
    onError: (err) => toast.error('Não foi possível distribuir', err.message),
  });

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = (event) => {
    event.preventDefault();
    mutation.mutate({ user_ids: [...selected], limit: Number(limit), strategy, grupo: grupo || undefined, nicho: nicho.trim() || undefined });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Distribuir leads"
      description={`${unassigned} lead(s) na fila sem responsável.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button type="submit" form="distribute-form" icon={Shuffle} loading={mutation.isPending} disabled={!selected.size || !unassigned}>
            Distribuir
          </Button>
        </>
      }
    >
      <form id="distribute-form" onSubmit={submit} className="space-y-5">
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-neutral-300">Membros que recebem leads</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {eligible.map((member) => (
              <label
                key={member.id}
                className={cx(
                  'flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition',
                  selected.has(member.id) ? 'border-red-800 bg-red-950/20' : 'border-neutral-800 hover:border-neutral-700',
                )}
              >
                <input type="checkbox" checked={selected.has(member.id)} onChange={() => toggle(member.id)} className="size-4 accent-red-700" />
                <Avatar name={member.name} id={member.id} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-white">{member.name}</span>
                  <span className="text-xs text-neutral-500">{ROLE_META[member.role]?.label} · {member.open} na fila</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Quantidade de leads">
            {({ id }) => <input id={id} type="number" min="1" max="500" value={limit} onChange={(e) => setLimit(e.target.value)} className={inputClass} />}
          </Field>
          <Field label="Critério" hint={strategy === 'balanced' ? 'Quem tem menos leads em aberto recebe primeiro.' : 'Alterna entre os membros, ignorando a carga atual.'}>
            {({ id }) => (
              <Select id={id} value={strategy} onChange={(e) => setStrategy(e.target.value)}>
                <option value="balanced">Equilibrar carga</option>
                <option value="round_robin">Rodízio</option>
              </Select>
            )}
          </Field>
          <Field label="Só leads" hint="Opcional">
            {({ id }) => (
              <Select id={id} value={grupo} onChange={(e) => setGrupo(e.target.value)}>
                <option value="">Com e sem site</option>
                <option value="SEM_SITE">Sem site</option>
                <option value="COM_SITE">Com site</option>
              </Select>
            )}
          </Field>
          <Field label="Nicho" hint="Opcional, ex: Pizzaria">
            {({ id }) => <input id={id} value={nicho} onChange={(e) => setNicho(e.target.value)} className={inputClass} />}
          </Field>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Linha da fila
// ---------------------------------------------------------------------------

function LeadRow({ lead, status, isManager, users, onDecide, onAssign }) {
  const actionable = status === 'pending' || status === 'on_hold';
  const city = (lead.address ?? '').replace(/,?\s*\d{5}-?\d{3}\s*$/, '').split(',').slice(-1)[0]?.trim();

  return (
    <li
      tabIndex={0}
      aria-label={`${lead.name}. Atalhos: Q qualificar, E em espera, D descartar.`}
      onKeyDown={(event) => {
        if (!actionable || event.target !== event.currentTarget) return;
        const key = event.key.toLowerCase();
        if (key === 'q') onDecide(lead, 'qualified');
        if (key === 'e' && status !== 'on_hold') onDecide(lead, 'on_hold');
        if (key === 'd') onDecide(lead, 'discarded');
        if (key === 'arrowdown') event.currentTarget.nextElementSibling?.focus();
        if (key === 'arrowup') event.currentTarget.previousElementSibling?.focus();
      }}
      className="group flex flex-col gap-3 px-4 py-3.5 outline-none focus-visible:bg-neutral-800/40 focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-inset lg:flex-row lg:items-center"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate font-semibold text-white">{lead.name}</p>
          {lead.lead_group === 'SEM_SITE' ? (
            <Badge tone="red">Sem site</Badge>
          ) : (
            <Badge tone="emerald"><Globe className="size-3" />Com site</Badge>
          )}
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
          {lead.category && <span>{lead.category}</span>}
          {city && <span className="flex items-center gap-1"><MapPin className="size-3" />{city}</span>}
          {lead.rating && <span className="flex items-center gap-1"><Star className="size-3 fill-amber-400 text-amber-400" />{String(lead.rating).replace('.', ',')} ({lead.reviews_count ?? 0})</span>}
          {lead.phone && <span className="flex items-center gap-1"><Phone className="size-3" />{lead.phone}</span>}
          {status !== 'pending' && lead.triaged_at && (
            <span>{TRIAGE_STATUS_META[status].label} por {lead.triaged_by_name ?? '—'} {formatRelative(lead.triaged_at)}</span>
          )}
          {status === 'on_hold' && lead.hold_until && <span className="text-amber-300">Retomar em {new Date(`${lead.hold_until}T12:00:00`).toLocaleDateString('pt-PT')}</span>}
        </p>
        {lead.notes && status !== 'pending' && <p className="mt-1.5 line-clamp-2 text-sm text-neutral-400">“{lead.notes}”</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {isManager ? (
          <Select
            aria-label={`Responsável por ${lead.name}`}
            value={lead.assigned_to ?? ''}
            onChange={(e) => onAssign(lead, e.target.value ? Number(e.target.value) : null)}
            disabled={!actionable}
            className="h-8 w-40 text-xs"
          >
            <option value="">Sem responsável</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </Select>
        ) : (
          lead.assigned_to && (
            <span className="flex items-center gap-1.5 text-xs text-neutral-400">
              <Avatar name={lead.assigned_to_name ?? '?'} id={lead.assigned_to} size="xs" />
              {lead.assigned_to_name}
            </span>
          )
        )}

        {actionable && (
          <>
            <Button size="sm" icon={CircleCheck} onClick={() => onDecide(lead, 'qualified')} title="Qualificar (Q)">Qualificar</Button>
            {status !== 'on_hold' && (
              <Button size="sm" variant="secondary" icon={Hourglass} onClick={() => onDecide(lead, 'on_hold')} title="Em espera (E)">Espera</Button>
            )}
            <Button size="sm" variant="ghost" icon={CircleX} onClick={() => onDecide(lead, 'discarded')} title="Descartar (D)">Descartar</Button>
          </>
        )}
        {status === 'qualified' && <Badge tone="emerald" dot>No pipeline</Badge>}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default function TriagePage({ navigate }) {
  const { isManager } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: users = [] } = useUserDirectory();
  const [status, setStatus] = useState('pending');
  const [assignee, setAssignee] = useState(''); // '' = todos, 'none' = sem responsável, id
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [decision, setDecision] = useState(null); // { lead, status }
  const [distributing, setDistributing] = useState(false);
  const q = useDebouncedValue(search.trim());
  const refocusQueue = useRef(false);

  const params = { status, assigned_to: assignee || undefined, q, limit: PAGE_SIZE, offset };
  const list = useQuery({ queryKey: ['triage', 'list', params], queryFn: () => listTriage(params), placeholderData: keepPreviousData });
  const summary = useQuery({ queryKey: ['triage', 'summary'], queryFn: getTriageSummary });

  const assignMutation = useMutation({
    mutationFn: ({ lead, userId }) => assignTriageLead(lead.id, userId),
    onSuccess: (triage) => {
      queryClient.invalidateQueries({ queryKey: ['triage'] });
      toast.success('Responsável atualizado', `${triage.name} → ${triage.assigned_to_name ?? 'sem responsável'}`);
    },
    onError: (err) => toast.error('Não foi possível atribuir', err.message),
  });

  const handleDone = (result, decided) => {
    setDecision(null);
    queryClient.invalidateQueries({ queryKey: ['triage'] });
    if (decided === 'qualified') {
      queryClient.invalidateQueries({ queryKey: ['deals'] });
      toast.success('Lead qualificado', `Negócio "${result.deal.title}" criado no pipeline.`);
    } else {
      toast.success(decided === 'on_hold' ? 'Lead em espera' : 'Lead descartado', result.triage.name);
    }
    // Fluxo de teclado: foca o próximo lead quando a lista (já sem este) chegar.
    refocusQueue.current = true;
  };

  const changeFilter = (setter) => (value) => {
    setter(value);
    setOffset(0);
  };

  useEffect(() => {
    if (!refocusQueue.current || list.isFetching) return;
    refocusQueue.current = false;
    document.querySelector('[data-triage-list] li')?.focus();
  }, [list.data, list.isFetching]);

  const counts = summary.data?.counts;
  const leads = list.data?.data ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Triagem de leads"
        description="Qualifique os leads da prospecção: os qualificados entram no pipeline como negócio."
        actions={
          isManager && (
            <Button icon={Shuffle} onClick={() => setDistributing(true)} disabled={!summary.data}>
              Distribuir leads
              {summary.data?.unassigned > 0 && <span className="rounded-md bg-red-950/70 px-1.5 text-xs tabular-nums">{summary.data.unassigned}</span>}
            </Button>
          )
        }
      />

      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <SegmentedTabs
          label="Estado da triagem"
          value={status}
          onChange={changeFilter(setStatus)}
          options={STATUS_ORDER.map((s) => ({ value: s, label: TRIAGE_STATUS_META[s].label, count: counts?.[s] }))}
        />
        <div className="flex flex-wrap items-center gap-2">
          {isManager && (
            <Select aria-label="Filtrar por responsável" value={assignee} onChange={(e) => changeFilter(setAssignee)(e.target.value)} className="w-48">
              <option value="">Toda a equipa</option>
              <option value="none">Sem responsável</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </Select>
          )}
          <label className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
            <span className="sr-only">Pesquisar leads</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-neutral-500" />
            <input type="search" value={search} onChange={(e) => changeFilter(setSearch)(e.target.value)} placeholder="Nome, endereço, telefone" className={cx(inputClass, 'pl-9')} />
          </label>
        </div>
      </div>

      {isManager && summary.data?.workload && (
        <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Carga por membro">
          {summary.data.workload
            .filter((w) => w.open > 0 || w.role !== 'admin')
            .map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => changeFilter(setAssignee)(assignee === String(w.id) ? '' : String(w.id))}
                className={cx(
                  'flex shrink-0 items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-xs transition',
                  assignee === String(w.id) ? 'border-red-800 bg-red-950/30 text-white' : 'border-neutral-800 text-neutral-400 hover:border-neutral-700',
                )}
              >
                <Avatar name={w.name} id={w.id} size="xs" />
                {w.name.split(' ')[0]}
                <span className="font-semibold text-neutral-200 tabular-nums">{w.open}</span>
              </button>
            ))}
        </div>
      )}

      {list.isError ? (
        <ErrorState error={list.error} onRetry={list.refetch} />
      ) : list.isLoading ? (
        <Spinner />
      ) : leads.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={status === 'pending' ? 'Fila vazia' : `Nenhum lead ${TRIAGE_STATUS_META[status].label.toLowerCase()}`}
          description={
            status === 'pending'
              ? isManager
                ? 'Não há leads à espera de triagem com estes filtros. Rode o Radar de Busca ou distribua leads sem responsável.'
                : 'Não há leads atribuídos a si. Assim que um gestor distribuir leads, eles aparecem aqui.'
              : 'Ajuste os filtros para ver outros leads.'
          }
          action={status === 'pending' && isManager && <Button variant="secondary" onClick={() => navigate('prospeccao')}>Ir para a Prospecção</Button>}
        />
      ) : (
        <Card className={cx('overflow-hidden transition-opacity', list.isFetching && 'opacity-70')}>
          <ul data-triage-list className="divide-y divide-neutral-800">
            {leads.map((lead) => (
              <LeadRow
                key={lead.id}
                lead={lead}
                status={lead.triage_status}
                isManager={isManager}
                users={users}
                onDecide={(l, s) => setDecision({ lead: l, status: s })}
                onAssign={(l, userId) => assignMutation.mutate({ lead: l, userId })}
              />
            ))}
          </ul>
          {list.data.meta.total > PAGE_SIZE && (
            <div className="border-t border-neutral-800 px-4 py-3">
              <Pagination meta={list.data.meta} onChange={setOffset} />
            </div>
          )}
        </Card>
      )}

      {(status === 'pending' || status === 'on_hold') && leads.length > 0 && (
        <p className="hidden items-center gap-1.5 text-xs text-neutral-600 sm:flex">
          <Keyboard className="size-3.5" />
          Triagem rápida: foque um lead (Tab ou ↑/↓) e use Q para qualificar, E para pôr em espera, D para descartar.
        </p>
      )}

      {decision && (
        <DecisionModal
          key={`${decision.lead.id}-${decision.status}`}
          lead={decision.lead}
          status={decision.status}
          onClose={() => setDecision(null)}
          onDone={handleDone}
        />
      )}

      {distributing && summary.data && (
        <DistributeModal
          open
          onClose={() => setDistributing(false)}
          workload={summary.data.workload}
          unassigned={summary.data.unassigned}
        />
      )}

      {!isManager && counts && (
        <p className="flex items-center gap-1.5 text-xs text-neutral-500">
          <UserRound className="size-3.5" />
          Está a ver a sua fila: {counts.pending} por triar, {counts.on_hold} em espera.
        </p>
      )}
    </div>
  );
}
