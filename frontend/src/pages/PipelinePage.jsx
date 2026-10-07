import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DndContext, DragOverlay, useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Building2, CalendarCheck, CalendarClock, Check, Copy, Handshake, MessageCircle, Plus, Search, StickyNote, Target, Trash2, TrendingUp, Trophy, UserRound, Video } from 'lucide-react';
import { addNote, createDeal, deleteDeal, getDealBoard, meetingUrl, moveDeal, scheduleMeeting, updateDeal } from '../lib/api.js';
import { confirmationPreview, greetingName } from '../lib/meetingTexts.js';
import { useAuth } from '../lib/auth.jsx';
import { useDebouncedValue, useUserDirectory } from '../lib/hooks.js';
import {
  DEAL_STAGES,
  DEAL_STAGE_META,
  OPEN_DEAL_STAGES,
  formatCurrency,
  formatCurrencyCompact,
  formatMeetingAt,
  formatRelative,
  parseMoney,
} from '../lib/labels.js';
import { useBoardDnd } from '../lib/useBoardDnd.js';
import ActivityTimeline from '../components/ActivityTimeline.jsx';
import { useToast } from '../components/toast.jsx';
import {
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  ErrorState,
  Field,
  Modal,
  PageHeader,
  Select,
  StatCard,
  Tabs,
  apiErrorToForm,
  cx,
  inputClass,
} from '../components/ui.jsx';

const STAGE_IDS = DEAL_STAGES.map((s) => s.id);
const daysSince = (date) => Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000);

// ---------------------------------------------------------------------------
// Cartão
// ---------------------------------------------------------------------------

/** Botão dentro do cartão arrastável: não pode iniciar o arrasto nem abrir o detalhe. */
const stopCardEvents = {
  onPointerDown: (e) => e.stopPropagation(),
  onClick: (e) => e.stopPropagation(),
  onKeyDown: (e) => e.stopPropagation(),
};

function DealCard({ deal, overlay = false, onNote }) {
  const closed = deal.stage === 'won' || deal.stage === 'lost';
  const today = new Date().toISOString().slice(0, 10);
  const overdue = !closed && deal.expected_close_date && deal.expected_close_date < today;
  const idle = !closed && daysSince(deal.stage_changed_at) >= 14;

  return (
    <div
      className={cx(
        'rounded-xl border bg-[#202020] p-3 transition',
        overlay ? 'rotate-2 cursor-grabbing border-red-800/70 shadow-2xl shadow-black/70' : 'cursor-grab border-neutral-800 hover:border-neutral-700 hover:bg-[#242424]',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="line-clamp-2 text-sm leading-snug font-medium text-neutral-100">{deal.title}</p>
        <span className={cx('shrink-0 text-sm font-semibold tabular-nums', deal.stage === 'lost' ? 'text-neutral-500 line-through' : 'text-white')}>
          {formatCurrencyCompact(deal.value)}
        </span>
      </div>
      {deal.company && deal.company !== deal.title && (
        <p className="mt-1 flex items-center gap-1 truncate text-xs text-neutral-500">
          <Building2 className="size-3 shrink-0" />
          {deal.company}
        </p>
      )}
      {deal.stage === 'lost' && deal.lost_reason && <p className="mt-1.5 line-clamp-2 text-xs text-red-300/80">{deal.lost_reason}</p>}
      {deal.stage === 'meeting' && deal.meeting_at && <MeetingChip meetingAt={deal.meeting_at} code={deal.meeting_code} />}
      {deal.last_note && (
        <p className="mt-2 flex gap-1.5 rounded-lg bg-neutral-900/80 px-2 py-1.5 text-xs text-neutral-400" title={`Última nota · ${formatRelative(deal.last_note_at)}`}>
          <StickyNote className="mt-0.5 size-3 shrink-0 text-amber-400/70" />
          <span className="line-clamp-2">{deal.last_note}</span>
        </p>
      )}
      {/* Rodapé compacto: o nome do responsável tem prioridade no espaço. */}
      <div className="mt-3 flex items-center gap-1.5 text-xs">
        {deal.owner_id ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-neutral-400" title={`Responsável: ${deal.owner_name}`}>
            <Avatar name={deal.owner_name ?? '?'} id={deal.owner_id} size="xs" />
            <span className="truncate">{deal.owner_name?.split(' ')[0]}</span>
          </span>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1 text-neutral-600"><UserRound className="size-3.5 shrink-0" /><span className="truncate">Sem responsável</span></span>
        )}
        {onNote && (
          <button
            type="button"
            {...stopCardEvents}
            onClick={(e) => {
              e.stopPropagation();
              onNote(deal);
            }}
            aria-label={`Adicionar nota a ${deal.title}${deal.notes_count ? ` (${deal.notes_count} notas)` : ''}`}
            title="Adicionar nota rápida"
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-200 focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:outline-none"
          >
            <StickyNote className="size-3.5" />
            {deal.notes_count > 0 ? <span className="tabular-nums">{deal.notes_count}</span> : <Plus className="size-3" />}
          </button>
        )}
        {overdue ? (
          <span className="flex shrink-0 items-center gap-1 font-medium text-red-400" title={`Atrasado · previsão de fecho: ${deal.expected_close_date}`}>
            <CalendarClock className="size-3" />Atraso
          </span>
        ) : (
          <span
            className={cx('shrink-0 tabular-nums', idle ? 'text-amber-400' : 'text-neutral-600')}
            title={closed ? `${deal.stage === 'won' ? 'Fechado' : 'Perdido'} ${formatRelative(deal.won_at ?? deal.lost_at)}` : `${daysSince(deal.stage_changed_at)} dia(s) neste estágio`}
          >
            {closed ? new Date(deal.won_at ?? deal.lost_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : `${daysSince(deal.stage_changed_at)}d`}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Data da reunião no cartão; depois da hora marcada fica âmbar (lembra de avançar o negócio).
 * Com sala de vídeo: atalho para entrar direto (sem abrir o detalhe).
 */
function MeetingChip({ meetingAt, code }) {
  const past = new Date(meetingAt).getTime() < Date.now();
  return (
    <p
      className={cx(
        'mt-2 flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium ring-1',
        past ? 'bg-amber-500/10 text-amber-300 ring-amber-500/30' : 'bg-fuchsia-500/10 text-fuchsia-200 ring-fuchsia-500/30',
      )}
      title={past ? 'A reunião já aconteceu: mova o negócio para o próximo estágio' : 'Reunião agendada'}
    >
      <CalendarClock className="size-3.5 shrink-0" />
      <span className="truncate">{formatMeetingAt(meetingAt)}</span>
      {past && <span className="shrink-0">· realizada?</span>}
      {code && (
        <a
          href={meetingUrl(code)}
          target="_blank"
          rel="noopener noreferrer"
          {...stopCardEvents}
          onClick={(e) => e.stopPropagation()} // não abre o detalhe nem inicia o arrasto
          title="Entrar na sala de vídeo"
          aria-label="Entrar na sala de vídeo"
          className="ml-auto flex shrink-0 items-center rounded-md p-0.5 text-fuchsia-200 transition hover:bg-fuchsia-500/20 hover:text-white"
        >
          <Video className="size-3.5" />
        </a>
      )}
    </p>
  );
}

function SortableDeal({ deal, onOpen, onNote, canDrag }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: deal.id, disabled: !canDrag });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      aria-label={`Negócio: ${deal.title}, ${formatCurrency(deal.value)}. Enter para abrir${canDrag ? ', Espaço para mover' : ''}.`}
      onClick={() => onOpen(deal)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onOpen(deal);
          return;
        }
        listeners?.onKeyDown?.(event);
      }}
      // select-none + sem callout: o toque longo que inicia o arrasto não seleciona texto nem abre menu (iOS/Android).
      className={cx('touch-manipulation rounded-xl outline-none select-none [-webkit-touch-callout:none] focus-visible:ring-2 focus-visible:ring-red-600', isDragging && 'opacity-30', !canDrag && 'cursor-pointer')}
    >
      <DealCard deal={deal} onNote={onNote} />
    </div>
  );
}

const EMPTY_COLUMN_TEXT = {
  lead: 'Leads qualificados no Radar de Prospecção aparecem aqui',
  meeting: 'Arraste para aqui ao marcar uma reunião: pedimos a data e confirmamos ao cliente pelo WhatsApp',
  won: 'Arraste para aqui os clientes fechados',
  lost: 'Negócios perdidos',
};

function StageColumn({ stage, deals, totals, onOpen, onNote, canDrag, onAdd }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const closedStage = stage.id === 'won' || stage.id === 'lost';
  // "Reunião Agendada" só se alcança pelo agendamento (data/hora + confirmação), nunca criando direto.
  const canCreateHere = !closedStage && stage.id !== 'meeting';

  // Em ecrãs largos (xl) as colunas dividem a largura: todas visíveis, sem scroll ao arrastar.
  return (
    <section
      aria-label={stage.label}
      data-board-column={stage.id}
      className="flex w-[82vw] max-w-72 shrink-0 snap-start flex-col rounded-2xl border border-neutral-800 bg-[#161616] sm:w-72 xl:w-auto xl:max-w-none xl:min-w-52 xl:flex-1 xl:basis-0"
    >
      <header className="px-3 pt-3 pb-2">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-neutral-200">
            <span className={cx('size-2 rounded-full', stage.dot)} />
            {stage.label}
          </h2>
          <span className="rounded-md bg-neutral-800 px-1.5 py-0.5 text-xs font-medium text-neutral-400 tabular-nums">{totals?.count ?? 0}</span>
        </div>
        <p className="mt-1 text-xs text-neutral-500 tabular-nums">
          {formatCurrency(totals?.value ?? 0)}
          {!closedStage && <span className="text-neutral-600"> · {Math.round(stage.probability * 100)}%</span>}
        </p>
      </header>

      <SortableContext id={stage.id} items={deals.map((d) => d.id)} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className={cx('mx-2 mb-2 flex min-h-32 flex-1 flex-col gap-2 rounded-xl p-1 transition-colors', isOver && 'bg-red-950/20 ring-1 ring-red-900/50')}>
          {deals.map((deal) => (
            <SortableDeal key={deal.id} deal={deal} onOpen={onOpen} onNote={onNote} canDrag={canDrag(deal)} />
          ))}
          {deals.length === 0 && (
            <p className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-neutral-800 px-3 py-6 text-center text-xs text-neutral-600">
              {EMPTY_COLUMN_TEXT[stage.id] ?? 'Sem negócios'}
            </p>
          )}
        </div>
      </SortableContext>

      {canCreateHere && (
        <button
          type="button"
          onClick={() => onAdd(stage.id)}
          className="m-2 mt-0 flex items-center gap-1.5 rounded-lg px-2 py-2 text-sm text-neutral-500 transition hover:bg-neutral-800/70 hover:text-neutral-200"
        >
          <Plus className="size-4" />
          Novo negócio
        </button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Formulário (criar / editar)
// ---------------------------------------------------------------------------

function DealForm({ deal, stage, onSaved, formId }) {
  const { isAdmin } = useAuth();
  const { data: users = [] } = useUserDirectory({ enabled: isAdmin });
  const toast = useToast();
  const isEdit = Boolean(deal?.id);
  const [form, setForm] = useState({
    title: deal?.title ?? '',
    value: deal?.value ? String(deal.value).replace('.', ',') : '',
    company: deal?.company ?? '',
    contact_name: deal?.contact_name ?? '',
    phone: deal?.phone ?? '',
    email: deal?.email ?? '',
    owner_id: deal?.owner_id ?? '',
    expected_close_date: deal?.expected_close_date ?? '',
  });
  const [errors, setErrors] = useState({});

  const mutation = useMutation({
    mutationFn: (body) => (isEdit ? updateDeal(deal.id, body) : createDeal({ ...body, stage })),
    onSuccess: (saved) => {
      toast.success(isEdit ? 'Negócio atualizado' : 'Negócio criado', saved.title);
      onSaved(saved);
    },
    onError: (err) => {
      const { fields, message } = apiErrorToForm(err);
      setErrors(Object.keys(fields).length ? fields : { form: message });
    },
  });

  const set = (field) => (event) => {
    setForm((f) => ({ ...f, [field]: event.target.value }));
    setErrors((e) => ({ ...e, [field]: undefined, form: undefined }));
  };

  const submit = (event) => {
    event.preventDefault();
    if (form.title.trim().length < 2) return setErrors({ title: 'Indique o título do negócio.' });
    const orNull = (v) => (String(v).trim() ? String(v).trim() : null);
    const body = {
      title: form.title.trim(),
      value: parseMoney(form.value),
      company: orNull(form.company),
      contact_name: orNull(form.contact_name),
      phone: orNull(form.phone),
      email: orNull(form.email),
      expected_close_date: form.expected_close_date || null,
    };
    if (isAdmin && form.owner_id !== '') body.owner_id = Number(form.owner_id);
    mutation.mutate(body);
  };

  return (
    <form id={formId} onSubmit={submit} className="space-y-4" noValidate>
      {errors.form && <p className="rounded-xl bg-red-950/40 px-3 py-2 text-sm text-red-300">{errors.form}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Título" required error={errors.title} className="sm:col-span-2">
          {({ id, invalid }) => <input id={id} aria-invalid={invalid} value={form.title} onChange={set('title')} className={inputClass} placeholder="Ex: Site + e-commerce Pizzaria Bella" />}
        </Field>
        <Field label="Valor (R$)" error={errors.value}>
          {({ id }) => <input id={id} inputMode="decimal" value={form.value} onChange={set('value')} className={inputClass} placeholder="Ex: 12.500" />}
        </Field>
        <Field label="Previsão de fecho" error={errors.expected_close_date}>
          {({ id }) => <input id={id} type="date" value={form.expected_close_date} onChange={set('expected_close_date')} className={inputClass} />}
        </Field>
        <Field label="Empresa">{({ id }) => <input id={id} value={form.company} onChange={set('company')} className={inputClass} />}</Field>
        <Field label="Contacto">{({ id }) => <input id={id} value={form.contact_name} onChange={set('contact_name')} className={inputClass} />}</Field>
        <Field label="Telefone">{({ id }) => <input id={id} type="tel" value={form.phone} onChange={set('phone')} className={inputClass} />}</Field>
        <Field label="Email" error={errors.email}>{({ id }) => <input id={id} type="email" value={form.email} onChange={set('email')} className={inputClass} />}</Field>
        {/* Seleção de utilizadores: só o admin. Os demais nem veem a lista da equipe. */}
        {isAdmin ? (
          <Field label="Responsável" className="sm:col-span-2">
            {({ id }) => (
              <Select id={id} value={form.owner_id} onChange={set('owner_id')}>
                <option value="">{isEdit ? 'Sem responsável' : 'Eu'}</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </Select>
            )}
          </Field>
        ) : (
          !isEdit && <p className="text-xs text-neutral-500 sm:col-span-2">O negócio fica sob a sua responsabilidade.</p>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Detalhe (drawer)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Agendamento de reunião
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const toDateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toTimeInput = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Sugestão inicial: a reunião atual (reagendar) ou amanhã às 10:00. */
function initialMeeting(deal) {
  if (deal.meeting_at && new Date(deal.meeting_at).getTime() > Date.now()) {
    const current = new Date(deal.meeting_at);
    return { date: toDateInput(current), time: toTimeInput(current) };
  }
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return { date: toDateInput(tomorrow), time: '10:00' };
}

/**
 * Mesmo texto que o backend envia (services/meetingNotifier.js), para o vendedor ver antes.
 * O link da sala só existe depois de agendar: aqui aparece um marcador no lugar dele.
 */
function meetingPreview(deal, when) {
  const link = deal.meeting_code ? meetingUrl(deal.meeting_code) : `${window.location.origin}/sala/…`;
  return confirmationPreview({ name: greetingName({ contactName: deal.contact_name, company: deal.company }), when, link });
}

/**
 * Pop-up aberto ao largar um cartão em "Reunião Agendada" (ou ao escolher o estágio no detalhe,
 * ou em "Reagendar"). Enter/Salvar agenda; Cancelar devolve o cartão à coluna de origem.
 */
function MeetingModal({ deal, rescheduling, submitting, error, onCancel, onConfirm }) {
  const [form, setForm] = useState(() => ({ ...initialMeeting(deal), notify: true }));
  const [localError, setLocalError] = useState(null);

  const when = form.date && form.time ? new Date(`${form.date}T${form.time}`) : null; // hora local de quem agenda
  const valid = when && !Number.isNaN(when.getTime());
  const set = (field) => (event) => {
    setLocalError(null);
    setForm((f) => ({ ...f, [field]: event.target.type === 'checkbox' ? event.target.checked : event.target.value }));
  };

  const submit = (event) => {
    event.preventDefault();
    if (!valid) return setLocalError('Indique a data e a hora da reunião.');
    if (when.getTime() < Date.now()) return setLocalError('Essa data/hora já passou.');
    onConfirm({ meeting_at: when.toISOString(), notify: form.notify });
  };

  const noPhone = !deal.phone && !deal.client_id && !deal.lead_id;
  const shownError = localError ?? error;

  return (
    <Modal
      open
      onClose={onCancel}
      size="sm"
      title={
        <span className="flex items-center gap-2">
          <CalendarClock className="size-5 text-fuchsia-400" />
          {rescheduling ? 'Reagendar reunião' : 'Agendar reunião'}
        </span>
      }
      description={deal.title}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>Cancelar</Button>
          <Button type="submit" form="meeting-form" icon={CalendarCheck} loading={submitting}>
            {form.notify ? 'Agendar e confirmar' : 'Agendar'}
          </Button>
        </>
      }
    >
      <form id="meeting-form" onSubmit={submit} className="space-y-4" noValidate>
        {shownError && <p role="alert" className="rounded-xl bg-red-950/40 px-3 py-2 text-sm text-red-300">{shownError}</p>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Data" required>
            {({ id }) => (
              <input id={id} type="date" value={form.date} min={toDateInput(new Date())} onChange={set('date')} className={inputClass} data-autofocus required />
            )}
          </Field>
          <Field label="Hora" required>
            {({ id }) => <input id={id} type="time" value={form.time} step={300} onChange={set('time')} className={inputClass} required />}
          </Field>
        </div>

        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-neutral-800 p-3 transition hover:border-neutral-700">
          <input type="checkbox" checked={form.notify} onChange={set('notify')} className="mt-0.5 size-4 accent-red-700" />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-sm font-medium text-neutral-200">
              <MessageCircle className="size-4 text-emerald-400" />
              Confirmar ao cliente pelo WhatsApp
            </span>
            {form.notify && valid && (
              <span className="mt-2 block rounded-lg rounded-tl-sm bg-emerald-950/40 px-3 py-2 text-xs leading-relaxed whitespace-pre-line break-all text-emerald-100/90 ring-1 ring-emerald-900/50">
                {meetingPreview(deal, when)}
              </span>
            )}
            {form.notify && noPhone && (
              <span className="mt-1.5 block text-xs text-amber-300">Este negócio não tem telefone: a reunião fica agendada, mas a confirmação não será enviada.</span>
            )}
          </span>
        </label>
      </form>
    </Modal>
  );
}

/** Entrar na sala de vídeo da plataforma (nova aba) e copiar o link para enviar ao cliente. */
function MeetingLinkActions({ code }) {
  const [copied, setCopied] = useState(false);
  const url = meetingUrl(code);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-red-800 px-3 text-xs font-semibold text-white shadow-lg shadow-red-950/40 transition hover:bg-red-700"
      >
        <Video className="size-3.5" />
        Entrar na reunião
      </a>
      <button
        type="button"
        onClick={() => navigator.clipboard?.writeText(url).then(() => setCopied(true))}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-neutral-300 ring-1 ring-neutral-700 transition hover:bg-neutral-800"
      >
        {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
        {copied ? 'Link copiado' : 'Copiar link'}
      </button>
    </div>
  );
}

function DealDrawer({ deal, canEdit, canDelete, onClose, onMoveTo, onReschedule, onDeleted }) {
  const [tab, setTab] = useState('details');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();

  const deleteMutation = useMutation({
    mutationFn: () => deleteDeal(deal.id),
    onSuccess: () => {
      toast.success('Negócio apagado', deal.title);
      onDeleted();
    },
    onError: (err) => toast.error('Não foi possível apagar', err.message),
  });

  const stage = DEAL_STAGE_META[deal.stage];
  return (
    <Drawer
      open
      onClose={onClose}
      title={deal.title}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={deal.stage === 'won' ? 'emerald' : deal.stage === 'lost' ? 'red' : 'neutral'} dot>{stage.label}</Badge>
          <span className="font-semibold text-white tabular-nums">{formatCurrency(deal.value)}</span>
          {deal.client_id && <span className="text-xs">Cliente #{deal.client_id}</span>}
        </span>
      }
      footer={
        tab === 'details' && (
          <>
            {canDelete && (
              <Button variant="danger" icon={Trash2} onClick={() => setConfirmDelete(true)} className="mr-auto">Apagar</Button>
            )}
            <Button variant="ghost" onClick={onClose}>Fechar</Button>
            {canEdit && <Button type="submit" form="deal-edit">Guardar</Button>}
          </>
        )
      }
    >
      <div className="px-5 pt-3">
        <Tabs value={tab} onChange={setTab} options={[{ value: 'details', label: 'Detalhes' }, { value: 'activity', label: 'Histórico' }]} />
      </div>
      <div className="p-5">
        {tab === 'details' ? (
          <div className="space-y-5">
            <Field label="Estágio" hint={canEdit ? 'Também pode arrastar o cartão no quadro.' : 'Só o responsável ou um gestor pode mover.'}>
              {({ id }) => (
                <Select id={id} value={deal.stage} disabled={!canEdit} onChange={(e) => onMoveTo(deal, e.target.value)}>
                  {DEAL_STAGES.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </Select>
              )}
            </Field>
            {deal.stage === 'meeting' && deal.meeting_at && (
              <div className="space-y-3 rounded-xl border border-fuchsia-900/50 bg-fuchsia-950/20 px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-sm text-fuchsia-100">
                    <CalendarClock className="size-4 text-fuchsia-400" />
                    Reunião: <strong className="font-semibold">{formatMeetingAt(deal.meeting_at)}</strong>
                  </span>
                  {canEdit && <Button size="sm" variant="secondary" onClick={() => onReschedule(deal)}>Reagendar</Button>}
                </div>
                {deal.meeting_code && <MeetingLinkActions code={deal.meeting_code} />}
              </div>
            )}
            <fieldset disabled={!canEdit}>
              <DealForm
                formId="deal-edit"
                deal={deal}
                onSaved={() => queryClient.invalidateQueries({ queryKey: ['deals'] })}
              />
            </fieldset>
          </div>
        ) : (
          <ActivityTimeline entity="deals" id={deal.id} primaryType="deal" />
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Apagar negócio?"
        description={`"${deal.title}" sai do pipeline e das métricas. O histórico de auditoria mantém o registo da exclusão.`}
        confirmLabel="Apagar negócio"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
        onClose={() => setConfirmDelete(false)}
      />
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Nota rápida
// ---------------------------------------------------------------------------

const NOTE_MAX = 500;

function QuickNoteModal({ deal, onClose }) {
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const queryClient = useQueryClient();
  const toast = useToast();

  const mutation = useMutation({
    mutationFn: () => addNote('deals', deal.id, text.trim()),
    onSuccess: () => {
      toast.success('Nota adicionada', deal.title);
      queryClient.invalidateQueries({ queryKey: ['deals'] });
      queryClient.invalidateQueries({ queryKey: ['activity', 'deals', deal.id] });
      onClose();
    },
    onError: (err) => setError(err.message),
  });

  const submit = (event) => {
    event.preventDefault();
    if (!text.trim()) return setError('Escreva a nota.');
    mutation.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Nota rápida"
      description={`${deal.title}${deal.owner_name ? ` · responsável: ${deal.owner_name}` : ''}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button type="submit" form="quick-note" loading={mutation.isPending}>Guardar nota</Button>
        </>
      }
    >
      <form id="quick-note" onSubmit={submit} noValidate>
        <Field label="Nota" error={error} hint={`${text.length}/${NOTE_MAX} · fica no histórico do negócio`}>
          {({ id, invalid }) => (
            <textarea
              id={id}
              data-autofocus
              aria-invalid={invalid}
              rows={4}
              maxLength={NOTE_MAX}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(e);
              }}
              placeholder="Ex: Ligou às 15h, pediu orçamento com loja virtual. Retornar sexta."
              className={cx(inputClass, 'h-auto resize-none py-2')}
            />
          )}
        </Field>
      </form>
      {deal.last_note && (
        <p className="mt-3 text-xs text-neutral-500">
          Última nota ({formatRelative(deal.last_note_at)}): <span className="text-neutral-400">“{deal.last_note}”</span>
        </p>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default function PipelinePage() {
  const { user, isAdmin, isManager } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: users = [] } = useUserDirectory({ enabled: isAdmin });
  const [owner, setOwner] = useState(''); // só admin: '' todos · 'mine' · id
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim());
  const [openId, setOpenId] = useState(null);
  const [creatingIn, setCreatingIn] = useState(null);
  const [pendingLoss, setPendingLoss] = useState(null); // movimento para "Perdido" à espera do motivo
  const [lossReason, setLossReason] = useState('');
  // Movimento para "Reunião Agendada" à espera da data/hora: { deal, vars: { id, position?, snapshot?, from } }
  const [pendingMeeting, setPendingMeeting] = useState(null);
  const [noteFor, setNoteFor] = useState(null);

  // Não-admin não envia filtro de pessoa (o backend força o próprio id de qualquer forma).
  const params = isAdmin ? { mine: owner === 'mine', owner_id: owner && owner !== 'mine' ? owner : undefined, q } : { q };
  const boardKey = useMemo(() => ['deals', 'board', params], [isAdmin, owner, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data, isLoading, isError, error, refetch } = useQuery({ queryKey: boardKey, queryFn: () => getDealBoard(params) });

  const moveMutation = useMutation({
    mutationFn: ({ id, stage, position, lost_reason: lostReason }) => moveDeal(id, { stage, position, lost_reason: lostReason }),
    onSuccess: (res, vars) => {
      if (vars.stage === 'won' && vars.from !== 'won') {
        toast.success('Negócio fechado! 🎉', res.meta.client_created_id ? `Cliente conquistado registado a partir de "${res.data.title}".` : res.data.title);
        queryClient.invalidateQueries({ queryKey: ['clients'] });
      }
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
    },
    onError: (err, vars) => {
      if (vars.snapshot) queryClient.setQueryData(boardKey, (old) => (old ? { ...old, data: vars.snapshot } : old));
      toast.error('Não foi possível mover o negócio', err.message);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['deals'] }),
  });

  const canDrag = (deal) => isAdmin || deal.owner_id === user?.id;

  const { board, sensors, collisionDetection, activeItem, handlers } = useBoardDnd({
    columnIds: STAGE_IDS,
    serverBoard: data?.data,
    columnField: 'stage',
    // Não-admin recebe só os próprios negócios: o quadro é SEMPRE parcial, logo as posições
    // na tela não são as do servidor e o hook tem de calcular pelas posições dos vizinhos.
    filtered: !isAdmin || Boolean(owner || q),
    onDrop: (move) => {
      queryClient.setQueryData(boardKey, (old) => (old ? { ...old, data: move.next } : old));
      const vars = { id: move.id, stage: move.column, position: move.position, snapshot: move.snapshot, from: move.from };
      if (move.column === 'lost' && move.from !== 'lost') {
        setLossReason('');
        setPendingLoss(vars); // pede o motivo antes de gravar
        return;
      }
      // Gatilho de reunião: o cartão fica na coluna (otimista) enquanto o pop-up pede a data/hora.
      if (move.column === 'meeting' && move.from !== 'meeting') {
        scheduleMutation.reset();
        setPendingMeeting({ deal: move.item, vars });
        return;
      }
      moveMutation.mutate(vars);
    },
  });

  const scheduleMutation = useMutation({
    mutationFn: ({ vars, meeting_at: meetingAt, notify }) =>
      scheduleMeeting({ deal_id: vars.id, meeting_at: meetingAt, position: vars.position, notify }),
    onSuccess: (res) => {
      setPendingMeeting(null);
      const { notification } = res.meta;
      const when = formatMeetingAt(res.data.meeting_at);
      if (notification.sent) toast.success('Reunião agendada 📅', `${when} · confirmação enviada ao cliente pelo WhatsApp.`);
      else if (notification.reason === 'SKIPPED') toast.success('Reunião agendada 📅', when);
      // A reunião ficou agendada; só a mensagem falhou — o vendedor precisa de saber para avisar o cliente.
      else toast.info('Reunião agendada, mas a confirmação não foi enviada', `${when} · ${notification.message}`);
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      if (notification.client_id) queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
    // Erro (ex.: data no passado): o pop-up fica aberto com a mensagem; o cartão só volta se cancelar.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['deals'] }),
  });

  const cancelMeeting = () => {
    // Vindo do arrasto há snapshot para desfazer o movimento otimista; do detalhe/reagendar, não.
    if (pendingMeeting?.vars.snapshot) {
      queryClient.setQueryData(boardKey, (old) => (old ? { ...old, data: pendingMeeting.vars.snapshot } : old));
    }
    setPendingMeeting(null);
  };
  const openMeetingFor = (deal) => {
    scheduleMutation.reset();
    setPendingMeeting({ deal, vars: { id: deal.id, from: deal.stage } }); // sem position = fim da coluna
  };

  const cancelLoss = () => {
    queryClient.setQueryData(boardKey, (old) => (old ? { ...old, data: pendingLoss.snapshot } : old));
    setPendingLoss(null);
  };
  const confirmLoss = () => {
    moveMutation.mutate({ ...pendingLoss, lost_reason: lossReason.trim() || null });
    setPendingLoss(null);
  };

  const all = Object.values(board).flat();
  const openDeal = openId ? all.find((d) => d.id === openId) : null;
  const totals = data?.meta.totals;
  const openValue = OPEN_DEAL_STAGES.reduce((sum, s) => sum + (totals?.[s.id]?.value ?? 0), 0);
  const forecast = OPEN_DEAL_STAGES.reduce((sum, s) => sum + (totals?.[s.id]?.weighted ?? 0), 0);
  const openCount = OPEN_DEAL_STAGES.reduce((sum, s) => sum + (totals?.[s.id]?.count ?? 0), 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Pipeline de negociação"
        description="Leads qualificados no Radar entram em Triagem/Novo. Arraste os cartões entre colunas; em Cliente Fechado, o cliente é registado automaticamente."
        actions={<Button icon={Plus} onClick={() => setCreatingIn('lead')}>Novo negócio</Button>}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label={`Pipeline aberto (${openCount})`} value={formatCurrency(openValue)} icon={Handshake} tone="sky" loading={isLoading} />
        <StatCard label="Previsão ponderada" value={formatCurrency(forecast)} icon={Target} tone="amber" loading={isLoading} />
        <StatCard label={`Fechados (${totals?.won?.count ?? 0})`} value={formatCurrency(totals?.won?.value ?? 0)} icon={Trophy} tone="emerald" loading={isLoading} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* "Toda a equipe" e a troca de responsável são exclusivos do admin. */}
        {isAdmin && (
          <Select aria-label="Filtrar por responsável" value={owner} onChange={(e) => setOwner(e.target.value)} className="w-52">
            <option value="">Toda a equipe</option>
            <option value="mine">Os meus negócios</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </Select>
        )}
        <label className="relative min-w-0 flex-1 sm:w-72 sm:flex-none">
          <span className="sr-only">Pesquisar negócios</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-neutral-500" />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Título, empresa ou contacto" className={cx(inputClass, 'pl-9')} />
        </label>
        <span className="ml-auto hidden items-center gap-1.5 text-xs text-neutral-500 md:flex">
          <TrendingUp className="size-3.5" />
          Previsão = valor × probabilidade do estágio
        </span>
      </div>

      {isError ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : isLoading ? (
        <div className="flex gap-3 overflow-hidden">
          {DEAL_STAGES.map((s) => <div key={s.id} className="h-72 w-72 shrink-0 animate-pulse rounded-2xl border border-neutral-800 bg-[#161616]" />)}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          {...handlers}
          accessibility={{ screenReaderInstructions: { draggable: 'Prima Espaço para pegar no negócio, setas para mover entre estágios e Espaço para largar. Escape cancela.' } }}
        >
          <div className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-4 sm:mx-0 sm:scroll-px-0 sm:px-0">
            {DEAL_STAGES.map((stage) => (
              <StageColumn
                key={stage.id}
                stage={stage}
                deals={board[stage.id] ?? []}
                totals={totals?.[stage.id]}
                onOpen={(deal) => setOpenId(deal.id)}
                onNote={setNoteFor}
                canDrag={canDrag}
                onAdd={setCreatingIn}
              />
            ))}
          </div>
          <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
            {activeItem ? <DealCard deal={activeItem} overlay /> : null}
          </DragOverlay>
        </DndContext>
      )}

      {creatingIn && (
        <Modal
          open
          onClose={() => setCreatingIn(null)}
          title="Novo negócio"
          description={`Entra no estágio ${DEAL_STAGE_META[creatingIn].label}.`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setCreatingIn(null)}>Cancelar</Button>
              <Button type="submit" form="deal-create">Criar negócio</Button>
            </>
          }
        >
          <DealForm
            formId="deal-create"
            stage={creatingIn}
            onSaved={() => {
              setCreatingIn(null);
              queryClient.invalidateQueries({ queryKey: ['deals'] });
            }}
          />
        </Modal>
      )}

      {noteFor && <QuickNoteModal deal={noteFor} onClose={() => setNoteFor(null)} />}

      {openDeal && (
        <DealDrawer
          key={openDeal.id}
          deal={openDeal}
          canEdit={canDrag(openDeal)}
          // Backend: admin apaga qualquer um; partner só os próprios; agent nenhum.
          canDelete={isAdmin || (isManager && openDeal.owner_id === user?.id)}
          onClose={() => setOpenId(null)}
          onDeleted={() => {
            setOpenId(null);
            queryClient.invalidateQueries({ queryKey: ['deals'] });
          }}
          onMoveTo={(deal, stage) => {
            const vars = { id: deal.id, stage, from: deal.stage }; // sem position = fim do estágio
            if (stage === 'lost' && deal.stage !== 'lost') {
              setLossReason('');
              setPendingLoss(vars);
            } else if (stage === 'meeting' && deal.stage !== 'meeting') {
              openMeetingFor(deal);
            } else moveMutation.mutate(vars);
          }}
          onReschedule={openMeetingFor}
        />
      )}

      {pendingMeeting && (
        <MeetingModal
          key={pendingMeeting.deal.id}
          deal={pendingMeeting.deal}
          rescheduling={pendingMeeting.vars.from === 'meeting'}
          submitting={scheduleMutation.isPending}
          error={scheduleMutation.error?.message}
          onCancel={cancelMeeting}
          onConfirm={(values) => scheduleMutation.mutate({ vars: pendingMeeting.vars, ...values })}
        />
      )}

      <Modal
        open={Boolean(pendingLoss)}
        onClose={cancelLoss}
        size="sm"
        title="Marcar como perdido"
        description="O motivo alimenta a análise de perdas da equipe."
        footer={
          <>
            <Button variant="ghost" onClick={cancelLoss}>Cancelar</Button>
            <Button variant="danger" onClick={confirmLoss}>Marcar como perdido</Button>
          </>
        }
      >
        <Field label="Motivo da perda">
          {({ id }) => (
            <Select id={id} value={lossReason} onChange={(e) => setLossReason(e.target.value)} data-autofocus>
              <option value="">Sem motivo</option>
              <option>Preço acima do orçamento</option>
              <option>Escolheu um concorrente</option>
              <option>Sem resposta do cliente</option>
              <option>Projeto adiado</option>
              <option>Fora do perfil</option>
            </Select>
          )}
        </Field>
      </Modal>
    </div>
  );
}
