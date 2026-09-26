import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DndContext, DragOverlay, useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Building2, CalendarClock, Handshake, Plus, Search, Target, Trash2, TrendingUp, Trophy, UserRound } from 'lucide-react';
import { createDeal, deleteDeal, getDealBoard, moveDeal, updateDeal } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useDebouncedValue, useUserDirectory } from '../lib/hooks.js';
import {
  DEAL_STAGES,
  DEAL_STAGE_META,
  OPEN_DEAL_STAGES,
  formatCurrency,
  formatCurrencyCompact,
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

function DealCard({ deal, overlay = false }) {
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
      <div className="mt-3 flex items-center justify-between gap-2 text-xs">
        {deal.owner_id ? (
          <span className="flex min-w-0 items-center gap-1.5 text-neutral-400">
            <Avatar name={deal.owner_name ?? '?'} id={deal.owner_id} size="xs" />
            <span className="truncate">{deal.owner_name}</span>
          </span>
        ) : (
          <span className="flex items-center gap-1 text-neutral-600"><UserRound className="size-3.5" />Sem responsável</span>
        )}
        {overdue ? (
          <span className="flex shrink-0 items-center gap-1 font-medium text-red-400" title={`Previsão de fecho: ${deal.expected_close_date}`}>
            <CalendarClock className="size-3" />Atrasado
          </span>
        ) : (
          <span className={cx('shrink-0', idle ? 'text-amber-400' : 'text-neutral-600')} title="Tempo neste estágio">
            {closed ? formatRelative(deal.won_at ?? deal.lost_at) : `${daysSince(deal.stage_changed_at)}d no estágio`}
          </span>
        )}
      </div>
    </div>
  );
}

function SortableDeal({ deal, onOpen, canDrag }) {
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
      className={cx('touch-manipulation rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-red-600', isDragging && 'opacity-30', !canDrag && 'cursor-pointer')}
    >
      <DealCard deal={deal} />
    </div>
  );
}

function StageColumn({ stage, deals, totals, onOpen, canDrag, onAdd }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const closedStage = stage.id === 'won' || stage.id === 'lost';

  return (
    <section
      aria-label={stage.label}
      data-board-column={stage.id}
      className="flex w-[82vw] max-w-72 shrink-0 snap-start flex-col rounded-2xl border border-neutral-800 bg-[#161616] sm:w-72"
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
            <SortableDeal key={deal.id} deal={deal} onOpen={onOpen} canDrag={canDrag(deal)} />
          ))}
          {deals.length === 0 && (
            <p className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-neutral-800 px-3 py-6 text-center text-xs text-neutral-600">
              {stage.id === 'won' ? 'Arraste para aqui os negócios fechados' : stage.id === 'lost' ? 'Negócios perdidos' : 'Sem negócios'}
            </p>
          )}
        </div>
      </SortableContext>

      {!closedStage && (
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
  const { isManager } = useAuth();
  const { data: users = [] } = useUserDirectory();
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
    if (isManager && form.owner_id !== '') body.owner_id = Number(form.owner_id);
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
        <Field label="Responsável" hint={isManager ? undefined : 'Negócios criados por agentes ficam sob a sua responsabilidade.'} className="sm:col-span-2">
          {({ id }) => (
            <Select id={id} value={form.owner_id} onChange={set('owner_id')} disabled={!isManager}>
              <option value="">{isEdit ? 'Sem responsável' : 'Eu'}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </Select>
          )}
        </Field>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Detalhe (drawer)
// ---------------------------------------------------------------------------

function DealDrawer({ deal, canEdit, canDelete, onClose, onMoveTo, onDeleted }) {
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
// Página
// ---------------------------------------------------------------------------

export default function PipelinePage() {
  const { user, isManager } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: users = [] } = useUserDirectory();
  const [owner, setOwner] = useState(''); // '' todos · 'mine' · id
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim());
  const [openId, setOpenId] = useState(null);
  const [creatingIn, setCreatingIn] = useState(null);
  const [pendingLoss, setPendingLoss] = useState(null); // movimento para "Perdido" à espera do motivo
  const [lossReason, setLossReason] = useState('');

  const params = { mine: owner === 'mine', owner_id: owner && owner !== 'mine' ? owner : undefined, q };
  const boardKey = useMemo(() => ['deals', 'board', params], [owner, q]); // eslint-disable-line react-hooks/exhaustive-deps
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

  const canDrag = (deal) => isManager || deal.owner_id === user?.id;

  const { board, sensors, collisionDetection, activeItem, handlers } = useBoardDnd({
    columnIds: STAGE_IDS,
    serverBoard: data?.data,
    columnField: 'stage',
    filtered: Boolean(owner || q),
    onDrop: (move) => {
      queryClient.setQueryData(boardKey, (old) => (old ? { ...old, data: move.next } : old));
      const vars = { id: move.id, stage: move.column, position: move.position, snapshot: move.snapshot, from: move.from };
      if (move.column === 'lost' && move.from !== 'lost') {
        setLossReason('');
        setPendingLoss(vars); // pede o motivo antes de gravar
        return;
      }
      moveMutation.mutate(vars);
    },
  });

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
        description="Arraste os negócios entre estágios. Ao fechar, o cliente conquistado é registado automaticamente."
        actions={<Button icon={Plus} onClick={() => setCreatingIn('lead')}>Novo negócio</Button>}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label={`Pipeline aberto (${openCount})`} value={formatCurrency(openValue)} icon={Handshake} tone="sky" loading={isLoading} />
        <StatCard label="Previsão ponderada" value={formatCurrency(forecast)} icon={Target} tone="amber" loading={isLoading} />
        <StatCard label={`Fechados (${totals?.won?.count ?? 0})`} value={formatCurrency(totals?.won?.value ?? 0)} icon={Trophy} tone="emerald" loading={isLoading} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Filtrar por responsável" value={owner} onChange={(e) => setOwner(e.target.value)} className="w-52">
          <option value="">Toda a equipa</option>
          <option value="mine">Os meus negócios</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </Select>
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

      {openDeal && (
        <DealDrawer
          key={openDeal.id}
          deal={openDeal}
          canEdit={canDrag(openDeal)}
          canDelete={isManager}
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
            } else moveMutation.mutate(vars);
          }}
        />
      )}

      <Modal
        open={Boolean(pendingLoss)}
        onClose={cancelLoss}
        size="sm"
        title="Marcar como perdido"
        description="O motivo alimenta a análise de perdas da equipa."
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
