import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  CircleCheck,
  CircleX,
  Globe,
  Hourglass,
  Inbox,
  Keyboard,
  LayoutGrid,
  List,
  MapPin,
  MapPinned,
  Phone,
  RefreshCw,
  Search,
  Shuffle,
  Star,
  Tag,
  UserRound,
  UserRoundCheck,
  X,
} from 'lucide-react';
import {
  archiveTriageLead,
  assignTriageLead,
  assignTriageLeads,
  checkLeadsWhatsApp,
  decideTriageLead,
  distributeLeads,
  getTriageSummary,
  listTriage,
  requalifyTriageLead,
  restoreTriageLead,
} from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useDebouncedValue, useUserDirectory } from '../lib/hooks.js';
import { ROLE_META, TRIAGE_STATUS_META, formatRelative, parseMoney } from '../lib/labels.js';
import { useToast } from '../components/toast.jsx';
import { GroupBadge, Rating, WhatsAppButton, cardClass, shortAddress } from '../components/leadVisuals.jsx';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
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

// Onde a pessoa estava na Triagem (só nesta aba do navegador): sai para a Central e volta igual.
const STATE_KEY = 'nexus:triage-state';
function readSavedState() {
  try {
    return JSON.parse(sessionStorage.getItem(STATE_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
function writeSavedState(state) {
  try {
    sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // armazenamento bloqueado: só não lembra
  }
}

// Leads por página (escolha de cada um, guardada neste navegador).
const PAGE_SIZES = [25, 50, 100];
const PAGE_SIZE_KEY = 'nexus:triage-page-size';
function readPageSize() {
  try {
    const saved = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return PAGE_SIZES.includes(saved) ? saved : PAGE_SIZES[0];
  } catch {
    return PAGE_SIZES[0];
  }
}

function PageSizeSelect({ value, onChange }) {
  return (
    <label className="flex items-center gap-2 text-sm text-neutral-400">
      Por página
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-8 cursor-pointer rounded-lg border border-neutral-800 bg-[#141414] px-2 text-sm text-neutral-200 outline-none focus:border-red-700"
      >
        {PAGE_SIZES.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
    </label>
  );
}
const STATUS_ORDER = ['pending', 'on_hold', 'qualified', 'discarded', 'archived'];
const VIEW_STORAGE_KEY = 'nexus:triageView';

const isActionable = (status) => status === 'pending' || status === 'on_hold';
/** Estado exibido: arquivado sobrepõe o estado da triagem (que fica guardado no registo). */
const viewStatusOf = (lead) => (lead.archived_at ? 'archived' : lead.triage_status);
/** Negócio vivo, aberto ou ganho: o lead já está no pipeline (ou virou cliente). */
const inPipeline = (lead) => Boolean(lead.deal_stage) && lead.deal_stage !== 'lost';
/**
 * Requalificar vale fora da fila ativa (lá o "Qualificar" já cobre) e sem negócio vivo:
 * qualificados com negócio apagado/perdido, descartados e arquivados.
 */
const canRequalify = (lead, status) => !isActionable(status) && !inPipeline(lead);
const checkboxClass = 'size-4 shrink-0 cursor-pointer accent-red-700';

// ---------------------------------------------------------------------------
// Preferência de layout (Lista / Caixas), lembrada por navegador
// ---------------------------------------------------------------------------

function useViewMode() {
  const [view, setView] = useState(() => {
    try {
      return localStorage.getItem(VIEW_STORAGE_KEY) === 'grid' ? 'grid' : 'list';
    } catch {
      return 'list';
    }
  });
  const change = (next) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // Storage indisponível: a escolha vale só nesta sessão.
    }
  };
  return [view, change];
}

function ViewToggle({ value, onChange }) {
  const options = [
    { value: 'list', label: 'Modo lista', icon: List },
    { value: 'grid', label: 'Modo caixas', icon: LayoutGrid },
  ];
  return (
    <div role="group" aria-label="Layout da triagem" className="inline-flex shrink-0 rounded-xl border border-neutral-800 p-0.5">
      {options.map(({ value: v, label, icon: Icon }) => (
        <button
          key={v}
          type="button"
          aria-label={label}
          aria-pressed={value === v}
          title={label}
          onClick={() => onChange(v)}
          className={cx(
            'inline-flex size-9 items-center justify-center rounded-[10px] transition',
            value === v ? 'bg-neutral-800 text-white' : 'text-neutral-500 hover:text-neutral-200',
          )}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Atalhos de teclado (linha ou caixa focada): Q qualificar, E espera, D descartar
// ---------------------------------------------------------------------------

function queueKeyHandler({ lead, status, onDecide }) {
  return (event) => {
    if (event.target !== event.currentTarget) return;
    const key = event.key.toLowerCase();
    if (key === 'arrowdown' || key === 'arrowright') event.currentTarget.nextElementSibling?.focus();
    if (key === 'arrowup' || key === 'arrowleft') event.currentTarget.previousElementSibling?.focus();
    if (!isActionable(status)) return;
    if (key === 'q') onDecide(lead, 'qualified');
    if (key === 'e' && status !== 'on_hold') onDecide(lead, 'on_hold');
    if (key === 'd') onDecide(lead, 'discarded');
  };
}

// ---------------------------------------------------------------------------
// Decisão (qualificar / espera / descartar)
// ---------------------------------------------------------------------------

function DecisionModal({ lead, status, onClose, onDone }) {
  const { isAdmin } = useAuth();
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
      if (isAdmin && form.owner_id) body.deal.owner_id = Number(form.owner_id);
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
                {isAdmin && (
                  <Field label="Responsável">
                    {({ id }) => (
                      <Select id={id} value={form.owner_id} onChange={set('owner_id')}>
                        <option value="">Quem está triando</option>
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
// Ações em massa (admin)
// ---------------------------------------------------------------------------

/**
 * Barra acima da lista. Sem seleção, mostra só "Selecionar todos"; com pelo menos um lead
 * selecionado, vira a Action Bar com "Atribuir a responsável".
 */
function BulkActionBar({ selectableIds, selected, onSelectAll, onClear, users, onAssign, assigning }) {
  const [target, setTarget] = useState('');
  const count = selected.size;
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const selectAllRef = useRef(null);

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = count > 0 && !allSelected;
  }, [count, allSelected]);

  const submit = (event) => {
    event.preventDefault();
    if (!target) return;
    onAssign(target === 'none' ? null : Number(target), () => setTarget(''));
  };

  return (
    <div
      role="region"
      aria-label="Ações em massa"
      className={cx(
        // Abaixo do cabeçalho fixo do AppShell no telemóvel (~62px); no desktop não há cabeçalho.
        'sticky top-18 z-30 flex lg:top-4 flex-col gap-3 rounded-xl border px-4 py-2.5 backdrop-blur transition sm:flex-row sm:items-center',
        count ? 'border-red-900/60 bg-red-950/40' : 'border-neutral-800 bg-neutral-950/60',
      )}
    >
      <label className="flex cursor-pointer items-center gap-2.5 text-sm text-neutral-300">
        <input ref={selectAllRef} type="checkbox" checked={allSelected} onChange={() => (allSelected ? onClear() : onSelectAll())} className={checkboxClass} />
        {count ? (
          <span>
            <strong className="font-semibold text-white tabular-nums">{count}</strong> {count === 1 ? 'lead selecionado' : 'leads selecionados'}
          </span>
        ) : (
          <span>Selecionar todos da página ({selectableIds.length})</span>
        )}
      </label>

      {count > 0 && (
        <form onSubmit={submit} className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <Select aria-label="Novo responsável" value={target} onChange={(e) => setTarget(e.target.value)} className="h-8 w-52 text-xs">
            <option value="" disabled>Escolher responsável…</option>
            <option value="none">Sem responsável</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </Select>
          <Button type="submit" size="sm" icon={UserRoundCheck} loading={assigning} disabled={!target}>
            Atribuir a responsável
          </Button>
          <IconButton icon={X} label="Limpar seleção" onClick={onClear} />
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Peças comuns a linha e caixa
// ---------------------------------------------------------------------------

function AssigneeControl({ lead, status, isAdmin, users, onAssign, className }) {
  if (isAdmin) {
    return (
      <Select
        aria-label={`Responsável por ${lead.name}`}
        value={lead.assigned_to ?? ''}
        onChange={(e) => onAssign(lead, e.target.value ? Number(e.target.value) : null)}
        disabled={!isActionable(status)}
        className={cx('h-8 text-xs', className)}
      >
        <option value="">Sem responsável</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>{u.name}</option>
        ))}
      </Select>
    );
  }
  if (!lead.assigned_to) return null;
  return (
    <span className="flex items-center gap-1.5 text-xs text-neutral-400">
      <Avatar name={lead.assigned_to_name ?? '?'} id={lead.assigned_to} size="xs" />
      {lead.assigned_to_name}
    </span>
  );
}

function DecisionButtons({ lead, status, onDecide, stretch = false }) {
  if (status === 'qualified') {
    if (lead.deal_stage === 'won') return <Badge tone="emerald" dot>Cliente</Badge>;
    if (inPipeline(lead)) return <Badge tone="emerald" dot>No pipeline</Badge>;
    // Qualificado mas sem negócio vivo (apagado antes da correção, ou perdido): candidato a requalificar.
    return <Badge tone="amber" dot>{lead.deal_stage === 'lost' ? 'Negócio perdido' : 'Fora do pipeline'}</Badge>;
  }
  if (!isActionable(status)) return null;
  const grow = stretch && 'flex-1';
  return (
    <>
      <Button size="sm" icon={CircleCheck} onClick={() => onDecide(lead, 'qualified')} title="Qualificar (Q)" className={grow}>Qualificar</Button>
      {status !== 'on_hold' && (
        <Button size="sm" variant="secondary" icon={Hourglass} onClick={() => onDecide(lead, 'on_hold')} title="Em espera (E)" className={grow}>Espera</Button>
      )}
      <Button size="sm" variant="ghost" icon={CircleX} onClick={() => onDecide(lead, 'discarded')} title="Descartar (D)" className={grow}>Descartar</Button>
    </>
  );
}

/** Requalificar / Arquivar (ou Restaurar, na vista de arquivados). */
function LeadActions({ lead, status, busy, onRequalify, onArchive, onRestore, stretch = false }) {
  return (
    <>
      {canRequalify(lead, status) && (
        <Button
          size="sm"
          variant="success"
          icon={RefreshCw}
          loading={busy === 'requalify'}
          disabled={Boolean(busy)}
          onClick={() => onRequalify(lead)}
          title="Requalificar: envia o lead de novo para a coluna Triagem/Novo do pipeline"
          className={stretch ? 'flex-1' : undefined}
        >
          Requalificar
        </Button>
      )}
      {status === 'archived' ? (
        <IconButton
          icon={ArchiveRestore}
          label={`Restaurar ${lead.name} na triagem`}
          disabled={Boolean(busy)}
          onClick={() => onRestore(lead)}
          className="hover:text-emerald-300"
        />
      ) : (
        <IconButton
          icon={Archive}
          label={`Arquivar ${lead.name}: sai da triagem, o registro é mantido`}
          disabled={Boolean(busy)}
          onClick={() => onArchive(lead)}
          className="hover:text-red-400"
        />
      )}
    </>
  );
}

function TriageMeta({ lead }) {
  const { triage_status: triageStatus } = lead;
  return (
    <>
      {triageStatus !== 'pending' && lead.triaged_at && (
        <span>{TRIAGE_STATUS_META[triageStatus].label} por {lead.triaged_by_name ?? '—'} {formatRelative(lead.triaged_at)}</span>
      )}
      {triageStatus === 'on_hold' && lead.hold_until && !lead.archived_at && (
        <span className="text-amber-300">Retomar em {new Date(`${lead.hold_until}T12:00:00`).toLocaleDateString('pt-PT')}</span>
      )}
      {lead.archived_at && (
        <span>Arquivado por {lead.archived_by_name ?? '—'} {formatRelative(lead.archived_at)}</span>
      )}
      {lead.contacted_at && <span className="font-medium text-emerald-400">✓ Mensagem enviada {formatRelative(lead.contacted_at)}</span>}
      {lead.wa_status === 'no' && <span className="font-medium text-amber-400">Sem WhatsApp: ligar</span>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Modo Lista
// ---------------------------------------------------------------------------

function LeadRow({ lead, status, isAdmin, users, selectable, selected, onToggleSelect, onDecide, onAssign, onContact, highlighted, ...actions }) {
  const city = (lead.address ?? '').replace(/,?\s*\d{5}-?\d{3}\s*$/, '').split(',').slice(-1)[0]?.trim();

  return (
    <li
      data-triage-item
      data-lead-id={lead.id}
      tabIndex={0}
      aria-label={`${lead.name}. Atalhos: Q qualificar, E em espera, D descartar.`}
      onKeyDown={queueKeyHandler({ lead, status, onDecide })}
      className={cx(
        'group flex flex-col gap-3 px-4 py-3.5 outline-none focus-visible:bg-neutral-800/40 focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-inset lg:flex-row lg:items-center',
        // Já recebeu mensagem: fundo verde leve e faixa à esquerda (dá para ver de longe).
        lead.contacted_at && 'border-l-2 border-l-emerald-600 bg-emerald-950/15',
        highlighted && 'ring-1 ring-emerald-500/70 ring-inset',
        selected && 'bg-red-950/15',
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {isAdmin && (
          <input
            type="checkbox"
            aria-label={`Selecionar ${lead.name}`}
            checked={selected}
            disabled={!selectable}
            onChange={() => onToggleSelect(lead.id)}
            className={cx(checkboxClass, 'mt-1 disabled:cursor-not-allowed disabled:opacity-30')}
          />
        )}
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
            <TriageMeta lead={lead} />
          </p>
          {lead.notes && status !== 'pending' && <p className="mt-1.5 line-clamp-2 text-sm text-neutral-400">“{lead.notes}”</p>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pl-7 lg:pl-0">
        <AssigneeControl lead={lead} status={status} isAdmin={isAdmin} users={users} onAssign={onAssign} className="w-40" />
        <WhatsAppButton lead={lead} variant="icon" onContact={onContact} />
        <DecisionButtons lead={lead} status={status} onDecide={onDecide} />
        <LeadActions lead={lead} status={status} {...actions} />
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Modo Caixas (mesmo visual dos cards do Painel de Prospecção)
// ---------------------------------------------------------------------------

function LeadBox({ lead, status, isAdmin, users, selectable, selected, onToggleSelect, onDecide, onAssign, onContact, highlighted, ...actions }) {
  return (
    <article
      data-triage-item
      data-lead-id={lead.id}
      tabIndex={0}
      aria-label={`${lead.name}. Atalhos: Q qualificar, E em espera, D descartar.`}
      onKeyDown={queueKeyHandler({ lead, status, onDecide })}
      className={cx(
        cardClass,
        'outline-none focus-visible:ring-2 focus-visible:ring-red-700',
        selected ? 'border-red-800 bg-red-950/10' : lead.contacted_at ? 'border-emerald-800/70 border-l-4 border-l-emerald-600 bg-emerald-950/10' : 'border-neutral-800',
        highlighted && 'ring-1 ring-emerald-500/70',
      )}
    >
      <div className="flex items-start gap-3">
        {isAdmin && (
          <input
            type="checkbox"
            aria-label={`Selecionar ${lead.name}`}
            checked={selected}
            disabled={!selectable}
            onChange={() => onToggleSelect(lead.id)}
            className={cx(checkboxClass, 'mt-1 disabled:cursor-not-allowed disabled:opacity-30')}
          />
        )}
        <h3 className="line-clamp-2 min-w-0 flex-1 text-base leading-snug font-semibold text-white" title={lead.name}>
          {lead.name}
        </h3>
        <GroupBadge group={lead.lead_group} />
      </div>

      <div className="mt-3 space-y-2">
        {lead.category && (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-neutral-800 px-2 py-0.5 text-xs font-medium text-neutral-300">
            <Tag className="size-3 text-red-500" />
            {lead.category}
          </span>
        )}
        <p className="flex items-start gap-1.5 text-sm text-neutral-400" title={lead.address || undefined}>
          <MapPin className="mt-0.5 size-4 shrink-0 text-neutral-600" />
          <span className="line-clamp-2">{shortAddress(lead.address)}</span>
        </p>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <Rating rating={lead.rating} reviewsCount={lead.reviews_count} />
        {status !== 'pending' && <Badge tone={TRIAGE_STATUS_META[status].tone}>{TRIAGE_STATUS_META[status].label}</Badge>}
      </div>

      {(lead.triaged_at || lead.hold_until || lead.archived_at || lead.contacted_at || lead.wa_status === 'no') && (
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-500">
          <TriageMeta lead={lead} />
        </p>
      )}
      {lead.notes && status !== 'pending' && <p className="mt-2 line-clamp-2 text-sm text-neutral-400">“{lead.notes}”</p>}

      <div className="mt-4 mb-1">
        <AssigneeControl lead={lead} status={status} isAdmin={isAdmin} users={users} onAssign={onAssign} className="w-full" />
      </div>

      <div className="mt-auto space-y-2 border-t border-neutral-800 pt-4">
        <WhatsAppButton lead={lead} onContact={onContact} />
        <div className="flex flex-wrap items-center gap-2">
          <DecisionButtons lead={lead} status={status} onDecide={onDecide} stretch />
          <LeadActions lead={lead} status={status} {...actions} stretch />
          {lead.maps_url && (
            <a
              href={lead.maps_url}
              target="_blank"
              rel="noopener noreferrer"
              title="Abrir no Google Maps"
              aria-label={`Abrir ${lead.name} no Google Maps`}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-neutral-800 hover:text-white"
            >
              <MapPinned className="size-4" />
            </a>
          )}
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default function TriagePage({ navigate }) {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: users = [] } = useUserDirectory();
  const [view, setView] = useViewMode();
  // Onde estava (aba, pessoa filtrada, pesquisa, página e o último lead chamado): ir à Central
  // e voltar não perde nada.
  const saved = useRef(readSavedState()).current;
  const [status, setStatus] = useState(saved.status ?? 'pending');
  const [assignee, setAssignee] = useState(saved.assignee ?? ''); // '' = todos, 'none' = sem responsável, id
  const [search, setSearch] = useState(saved.search ?? '');
  const [offset, setOffset] = useState(saved.offset ?? 0);
  const [lastContacted, setLastContacted] = useState(saved.lastLeadId ?? null);
  useEffect(() => {
    writeSavedState({ status, assignee, search, offset, lastLeadId: lastContacted });
  }, [status, assignee, search, offset, lastContacted]);
  const [pageSize, setPageSize] = useState(readPageSize);
  const [decision, setDecision] = useState(null); // { lead, status }
  const [distributing, setDistributing] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const q = useDebouncedValue(search.trim());
  const refocusQueue = useRef(false);

  const params = { status, assigned_to: (isAdmin && assignee) || undefined, q, limit: pageSize, offset };
  const list = useQuery({ queryKey: ['triage', 'list', params], queryFn: () => listTriage(params), placeholderData: keepPreviousData });
  const summary = useQuery({ queryKey: ['triage', 'summary'], queryFn: getTriageSummary });

  const clearSelection = () => setSelected(new Set());

  const assignMutation = useMutation({
    mutationFn: ({ lead, userId }) => assignTriageLead(lead.id, userId),
    onSuccess: (triage) => {
      queryClient.invalidateQueries({ queryKey: ['triage'] });
      toast.success('Responsável atualizado', `${triage.name} → ${triage.assigned_to_name ?? 'sem responsável'}`);
    },
    onError: (err) => toast.error('Não foi possível atribuir', err.message),
  });

  const bulkAssignMutation = useMutation({
    mutationFn: ({ leadIds, userId }) => assignTriageLeads(leadIds, userId),
    onSuccess: ({ assigned }, { leadIds, userId, onDone }) => {
      queryClient.invalidateQueries({ queryKey: ['triage'] });
      const name = userId ? users.find((u) => u.id === userId)?.name ?? 'responsável' : 'sem responsável';
      const skipped = leadIds.length - assigned;
      toast.success(
        `${assigned} ${assigned === 1 ? 'lead atribuído' : 'leads atribuídos'}`,
        `→ ${name}${skipped ? ` · ${skipped} ignorado(s): já saíram da fila` : ''}`,
      );
      clearSelection();
      onDone?.();
    },
    onError: (err) => toast.error('Não foi possível atribuir os leads', err.message),
  });

  // Erro (ex.: 409 porque alguém já mexeu no lead): recarrega para mostrar o estado real.
  const failWith = (title) => (err) => {
    queryClient.invalidateQueries({ queryKey: ['triage'] });
    toast.error(title, err.message);
  };

  const requalifyMutation = useMutation({
    mutationFn: (lead) => requalifyTriageLead(lead.id),
    onSuccess: ({ deal, reopened }) => {
      queryClient.invalidateQueries({ queryKey: ['triage'] });
      queryClient.invalidateQueries({ queryKey: ['deals'] });
      toast.success(
        'Lead requalificado',
        reopened ? `Negócio "${deal.title}" reaberto no topo de Triagem/Novo.` : `Negócio "${deal.title}" criado no topo de Triagem/Novo.`,
        { action: { label: 'Abrir pipeline', onClick: () => navigate('pipeline') } },
      );
    },
    onError: failWith('Não foi possível requalificar'),
  });

  const restoreMutation = useMutation({
    mutationFn: (lead) => restoreTriageLead(lead.id),
    onSuccess: (triage) => {
      queryClient.invalidateQueries({ queryKey: ['triage'] });
      toast.success('Lead restaurado', `"${triage.name}" voltou para ${TRIAGE_STATUS_META[triage.triage_status].label}.`);
    },
    onError: failWith('Não foi possível restaurar'),
  });

  const archiveMutation = useMutation({
    mutationFn: (lead) => archiveTriageLead(lead.id),
    onSuccess: (triage) => {
      queryClient.invalidateQueries({ queryKey: ['triage'] });
      toast.success('Lead arquivado', `"${triage.name}" saiu da triagem. O registro continua salvo em Arquivado.`, {
        action: { label: 'Desfazer', onClick: () => restoreMutation.mutate(triage) },
      });
    },
    onError: failWith('Não foi possível arquivar'),
  });

  /** Ação em curso para este lead ('requalify' | 'archive' | 'restore'), para travar os botões dele. */
  const busyFor = (lead) =>
    [
      ['requalify', requalifyMutation],
      ['archive', archiveMutation],
      ['restore', restoreMutation],
    ].find(([, m]) => m.isPending && m.variables?.id === lead.id)?.[0] ?? null;

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

  // Trocar filtro ou página muda os leads visíveis: a seleção deixa de fazer sentido.
  const changeFilter = (setter) => (value) => {
    setter(value);
    setOffset(0);
    clearSelection();
  };
  const changePage = (next) => {
    setOffset(next);
    clearSelection();
  };
  const changePageSize = (size) => {
    setPageSize(size);
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(size));
    } catch {
      // modo privado: vale só nesta visita
    }
    changePage(0);
  };

  const toggleSelect = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  useEffect(() => {
    if (!refocusQueue.current || list.isFetching) return;
    refocusQueue.current = false;
    document.querySelector('[data-triage-list] [data-triage-item]')?.focus();
  }, [list.data, list.isFetching]);

  const counts = summary.data?.counts;
  const leads = list.data?.data ?? [];

  // De volta da Central: rola até o último lead chamado (uma vez por visita).
  const scrolledBack = useRef(false);
  useEffect(() => {
    if (scrolledBack.current || !lastContacted || !list.data) return;
    scrolledBack.current = true;
    document.querySelector(`[data-lead-id="${lastContacted}"]`)?.scrollIntoView({ block: 'center' });
  }, [list.data, lastContacted]);

  // "Tem WhatsApp?": checa no WhatsApp os leads da página que ainda não se sabe, aos poucos
  // (lotes de 10, uma consulta de cada vez no servidor), e o ícone muda conforme chegam.
  const waAsked = useRef(new Set());
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
  }, []);
  useEffect(() => {
    const ids = leads.filter((l) => l.phone && !l.wa_status && !waAsked.current.has(l.id)).map((l) => l.id);
    if (!ids.length) return;
    ids.forEach((id) => waAsked.current.add(id));
    (async () => {
      for (let i = 0; i < ids.length && mounted.current; i += 10) {
        const result = await checkLeadsWhatsApp(ids.slice(i, i + 10)).catch(() => null);
        if (!result || result.skipped) return; // WhatsApp desligado: tenta de novo noutra visita
        const found = new Map(result.results.filter((r) => r.wa_status).map((r) => [r.id, r.wa_status]));
        queryClient.setQueriesData({ queryKey: ['triage', 'list'] }, (old) =>
          old?.data ? { ...old, data: old.data.map((l) => (found.has(l.id) ? { ...l, wa_status: found.get(l.id) } : l)) } : old,
        );
      }
    })();
  }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // Só leads ainda na fila (pendente/em espera, não arquivados) podem ser reatribuídos.
  const selectableIds = leads.filter((l) => isActionable(viewStatusOf(l))).map((l) => l.id);
  // Ignora ids que saíram da página (ex.: decididos ou arquivados, inclusive por outra pessoa).
  const visibleSelection = new Set(selectableIds.filter((id) => selected.has(id)));

  const itemProps = (lead) => ({
    lead,
    status: viewStatusOf(lead),
    isAdmin,
    users,
    selectable: isActionable(viewStatusOf(lead)),
    selected: visibleSelection.has(lead.id),
    onToggleSelect: toggleSelect,
    onDecide: (l, s) => setDecision({ lead: l, status: s }),
    onAssign: (l, userId) => assignMutation.mutate({ lead: l, userId }),
    busy: busyFor(lead),
    onRequalify: (l) => requalifyMutation.mutate(l),
    onArchive: (l) => archiveMutation.mutate(l),
    onRestore: (l) => restoreMutation.mutate(l),
    // Grava já (e não só no efeito): o clique leva à Central e a página desmonta antes do efeito.
    onContact: (l) => {
      setLastContacted(l.id);
      writeSavedState({ status, assignee, search, offset, lastLeadId: l.id });
    },
    highlighted: lead.id === lastContacted,
  });

  // Rodapé: quantos por página (sempre) e as páginas (quando há mais de uma).
  const pagination = list.data && (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <PageSizeSelect value={pageSize} onChange={changePageSize} />
      <div className="min-w-0 flex-1">
        <Pagination meta={list.data.meta} onChange={changePage} />
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Triagem de leads"
        description="Qualifique os leads da prospecção: os qualificados entram no pipeline como negócio."
        actions={
          isAdmin && (
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
          {/* "Toda a equipe" é visão exclusiva do admin; os demais só veem a própria fila. */}
          {isAdmin && (
            <Select aria-label="Filtrar por responsável" value={assignee} onChange={(e) => changeFilter(setAssignee)(e.target.value)} className="w-48">
              <option value="">Toda a equipe</option>
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
          <ViewToggle value={view} onChange={setView} />
        </div>
      </div>

      {isAdmin && summary.data?.workload && (
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

      {isAdmin && selectableIds.length > 0 && (
        <BulkActionBar
          selectableIds={selectableIds}
          selected={visibleSelection}
          onSelectAll={() => setSelected(new Set(selectableIds))}
          onClear={clearSelection}
          users={users}
          assigning={bulkAssignMutation.isPending}
          onAssign={(userId, onDone) => bulkAssignMutation.mutate({ leadIds: [...visibleSelection], userId, onDone })}
        />
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
              ? isAdmin
                ? 'Não há leads à espera de triagem com estes filtros. Rode o Radar de Busca ou distribua leads sem responsável.'
                : 'Não há leads atribuídos a si. Assim que o admin distribuir leads, eles aparecem aqui.'
              : status === 'archived'
                ? 'Leads arquivados (ícone da caixa) ficam aqui, com todo o histórico, e podem ser restaurados ou requalificados.'
                : 'Ajuste os filtros para ver outros leads.'
          }
          action={status === 'pending' && isAdmin && <Button variant="secondary" onClick={() => navigate('prospeccao')}>Ir para a Prospecção</Button>}
        />
      ) : view === 'grid' ? (
        <div className={cx('space-y-4 transition-opacity', list.isFetching && 'opacity-70')}>
          <div data-triage-list className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {leads.map((lead) => (
              <LeadBox key={lead.id} {...itemProps(lead)} />
            ))}
          </div>
          {pagination}
        </div>
      ) : (
        <Card className={cx('overflow-hidden transition-opacity', list.isFetching && 'opacity-70')}>
          <ul data-triage-list className="divide-y divide-neutral-800">
            {leads.map((lead) => (
              <LeadRow key={lead.id} {...itemProps(lead)} />
            ))}
          </ul>
          {pagination && <div className="border-t border-neutral-800 px-4 py-3">{pagination}</div>}
        </Card>
      )}

      {isActionable(status) && leads.length > 0 && (
        <p className="hidden items-center gap-1.5 text-xs text-neutral-600 sm:flex">
          <Keyboard className="size-3.5" />
          Triagem rápida: foque um lead (Tab ou setas) e use Q para qualificar, E para pôr em espera, D para descartar.
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

      {!isAdmin && counts && (
        <p className="flex items-center gap-1.5 text-xs text-neutral-500">
          <UserRound className="size-3.5" />
          Está vendo sua fila: {counts.pending} por triar, {counts.on_hold} em espera.
        </p>
      )}
    </div>
  );
}
