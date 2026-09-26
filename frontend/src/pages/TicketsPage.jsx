import { useState } from 'react';
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, CircleDashed, Flag, Plus, Search, Ticket, Trash2, UserRound } from 'lucide-react';
import { createTicket, deleteTicket, listTickets, updateTicket } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useClientOptions, useDebouncedValue, useUserDirectory } from '../lib/hooks.js';
import { PRIORITY_META, TICKET_STATUS_META, formatDateTime, formatRelative } from '../lib/labels.js';
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
  Pagination,
  SegmentedTabs,
  Select,
  Spinner,
  StatCard,
  Textarea,
  apiErrorToForm,
  cx,
  inputClass,
} from '../components/ui.jsx';

const PAGE_SIZE = 25;

const STATUS_TABS = [
  { value: 'open_only', label: 'Em aberto' },
  ...Object.entries(TICKET_STATUS_META).map(([value, m]) => ({ value, label: m.label })),
  { value: 'all', label: 'Todos' },
];

// ---------------------------------------------------------------------------
// Formulário / detalhe
// ---------------------------------------------------------------------------

function TicketModal({ ticket, onClose, canEdit, canDelete }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: users = [] } = useUserDirectory();
  const { data: clients = [] } = useClientOptions();
  const isEdit = Boolean(ticket?.id);
  const readOnly = isEdit && !canEdit;

  const [form, setForm] = useState({
    title: ticket?.title ?? '',
    description: ticket?.description ?? '',
    priority: ticket?.priority ?? 'medium',
    status: ticket?.status ?? 'open',
    assigned_to: ticket?.assigned_to ?? '',
    client_id: ticket?.client_id ?? '',
  });
  const [errors, setErrors] = useState({});
  const [confirmDelete, setConfirmDelete] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['tickets'] });

  const mutation = useMutation({
    mutationFn: (body) => (isEdit ? updateTicket(ticket.id, body) : createTicket(body)),
    onSuccess: (saved) => {
      invalidate();
      toast.success(isEdit ? 'Chamado atualizado' : `Chamado #${saved.id} aberto`, saved.title);
      onClose();
    },
    onError: (err) => {
      const { fields, message } = apiErrorToForm(err);
      setErrors(Object.keys(fields).length ? fields : { form: message });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteTicket(ticket.id),
    onSuccess: () => {
      invalidate();
      toast.success(`Chamado #${ticket.id} apagado`);
      onClose();
    },
    onError: (err) => toast.error('Não foi possível apagar', err.message),
  });

  const set = (field) => (event) => {
    setForm((f) => ({ ...f, [field]: event.target.value }));
    setErrors((e) => ({ ...e, [field]: undefined, form: undefined }));
  };

  const submit = (event) => {
    event.preventDefault();
    if (form.title.trim().length < 3) return setErrors({ title: 'O título deve ter pelo menos 3 caracteres.' });
    const body = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      priority: form.priority,
      assigned_to: form.assigned_to ? Number(form.assigned_to) : null,
      client_id: form.client_id ? Number(form.client_id) : null,
    };
    if (isEdit) body.status = form.status;
    mutation.mutate(body);
  };

  return (
    <>
      <Modal
        open
        onClose={onClose}
        size="lg"
        title={isEdit ? `Chamado #${ticket.id}` : 'Novo chamado'}
        description={
          isEdit
            ? `Aberto por ${ticket.created_by_name ?? '—'} ${formatRelative(ticket.created_at)}${ticket.resolved_at ? ` · resolvido ${formatRelative(ticket.resolved_at)}` : ''}`
            : 'Descreva o problema ou pedido do cliente.'
        }
        footer={
          <>
            {isEdit && canDelete && (
              <Button variant="danger" icon={Trash2} onClick={() => setConfirmDelete(true)} className="mr-auto">
                Apagar
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              {readOnly ? 'Fechar' : 'Cancelar'}
            </Button>
            {!readOnly && (
              <Button type="submit" form="ticket-form" loading={mutation.isPending}>
                {isEdit ? 'Guardar' : 'Abrir chamado'}
              </Button>
            )}
          </>
        }
      >
        <form id="ticket-form" onSubmit={submit} className="space-y-4" noValidate>
          {readOnly && (
            <p className="rounded-xl bg-neutral-800/60 px-3 py-2 text-sm text-neutral-400">
              Só quem abriu o chamado, o atribuído ou um gestor podem alterá-lo.
            </p>
          )}
          {errors.form && <p className="rounded-xl bg-red-950/40 px-3 py-2 text-sm text-red-300">{errors.form}</p>}
          <fieldset disabled={readOnly} className="space-y-4">
            <Field label="Título" required error={errors.title}>
              {({ id, invalid }) => <input id={id} aria-invalid={invalid} value={form.title} onChange={set('title')} maxLength={200} className={inputClass} placeholder="Ex: Site fora do ar" />}
            </Field>
            <Field label="Descrição" error={errors.description}>
              {({ id }) => <Textarea id={id} value={form.description} onChange={set('description')} rows={5} placeholder="Passos para reproduzir, impacto, prints..." />}
            </Field>
            <div className={cx('grid gap-4', isEdit ? 'sm:grid-cols-2' : 'sm:grid-cols-3')}>
              <Field label="Prioridade">
                {({ id }) => (
                  <Select id={id} value={form.priority} onChange={set('priority')}>
                    {Object.entries(PRIORITY_META).map(([value, meta]) => (
                      <option key={value} value={value}>{meta.label}</option>
                    ))}
                  </Select>
                )}
              </Field>
              {isEdit && (
                <Field label="Estado">
                  {({ id }) => (
                    <Select id={id} value={form.status} onChange={set('status')}>
                      {Object.entries(TICKET_STATUS_META).map(([value, meta]) => (
                        <option key={value} value={value}>{meta.label}</option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}
              <Field label="Atribuído a">
                {({ id }) => (
                  <Select id={id} value={form.assigned_to} onChange={set('assigned_to')}>
                    <option value="">Ninguém</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>{u.name}</option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Cliente">
                {({ id }) => (
                  <Select id={id} value={form.client_id} onChange={set('client_id')}>
                    <option value="">Sem cliente</option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>{c.company ? `${c.name} · ${c.company}` : c.name}</option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
          </fieldset>
        </form>
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        title={`Apagar chamado #${ticket?.id}?`}
        description="O chamado e o seu histórico de estado serão removidos. Para manter registo, prefira o estado Fechado."
        confirmLabel="Apagar chamado"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
        onClose={() => setConfirmDelete(false)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Linha da lista
// ---------------------------------------------------------------------------

function TicketRow({ ticket, canEdit, onOpen, onStatusChange }) {
  const priority = PRIORITY_META[ticket.priority];
  const status = TICKET_STATUS_META[ticket.status];
  const done = ticket.status === 'resolved' || ticket.status === 'closed';

  return (
    <li className="relative">
      <span className={cx('absolute inset-y-0 left-0 w-1', priority.bar)} aria-hidden="true" />
      <div className="flex flex-col gap-3 py-3.5 pr-4 pl-5 sm:flex-row sm:items-center">
        <button type="button" onClick={() => onOpen(ticket)} className="group min-w-0 flex-1 text-left">
          <p className="flex items-center gap-2">
            <span className="shrink-0 text-xs font-medium text-neutral-500 tabular-nums">#{ticket.id}</span>
            <span className={cx('truncate text-sm font-semibold group-hover:text-red-300', done ? 'text-neutral-400 line-through decoration-neutral-600' : 'text-white')}>
              {ticket.title}
            </span>
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
            <span className="flex items-center gap-1">
              <Flag className="size-3" />
              {priority.label}
            </span>
            {ticket.client_name && (
              <span className="flex items-center gap-1">
                <Building2 className="size-3" />
                {ticket.client_company || ticket.client_name}
              </span>
            )}
            <span title={formatDateTime(ticket.created_at)}>{formatRelative(ticket.created_at)}</span>
          </p>
        </button>

        <div className="flex items-center justify-between gap-3 sm:justify-end">
          {ticket.assigned_to ? (
            <span className="flex items-center gap-1.5 text-xs text-neutral-400" title={`Atribuído a ${ticket.assigned_to_name}`}>
              <Avatar name={ticket.assigned_to_name ?? '?'} id={ticket.assigned_to} size="sm" />
              <span className="hidden max-w-28 truncate lg:inline">{ticket.assigned_to_name}</span>
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs text-neutral-600">
              <UserRound className="size-4" />
              <span className="hidden lg:inline">Não atribuído</span>
            </span>
          )}

          {canEdit ? (
            <Select
              aria-label={`Estado do chamado #${ticket.id}`}
              value={ticket.status}
              onChange={(e) => onStatusChange(ticket, e.target.value)}
              className="h-8 w-36 text-xs"
            >
              {Object.entries(TICKET_STATUS_META).map(([value, meta]) => (
                <option key={value} value={value}>{meta.label}</option>
              ))}
            </Select>
          ) : (
            <Badge tone={status.tone} dot>{status.label}</Badge>
          )}
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default function TicketsPage() {
  const { user, isManager, isAdmin } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('open_only');
  const [priority, setPriority] = useState('');
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [modal, setModal] = useState(null); // {} = novo, ticket = detalhe
  const q = useDebouncedValue(search.trim());

  const params = {
    open_only: tab === 'open_only',
    status: tab !== 'open_only' && tab !== 'all' ? tab : undefined,
    priority,
    mine,
    q,
    limit: PAGE_SIZE,
    offset,
  };

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['tickets', 'list', params],
    queryFn: () => listTickets(params),
    placeholderData: keepPreviousData,
  });

  // Contadores do topo: consultas leves (limit=1) que só leem o total.
  const [openCount, urgentCount, mineCount] = useQueries({
    queries: [
      ['open', { open_only: true }],
      ['urgent', { open_only: true, priority: 'urgent' }],
      ['mine', { open_only: true, mine: true }],
    ].map(([key, statParams]) => ({
      queryKey: ['tickets', 'stat', key],
      queryFn: () => listTickets({ ...statParams, limit: 1 }).then((r) => r.meta.total),
    })),
  });

  const statusMutation = useMutation({
    mutationFn: ({ ticket, status }) => updateTicket(ticket.id, { status }),
    // Otimista: o select muda na hora em todas as listas em cache.
    onMutate: async ({ ticket, status }) => {
      await queryClient.cancelQueries({ queryKey: ['tickets', 'list'] });
      const previous = queryClient.getQueriesData({ queryKey: ['tickets', 'list'] });
      queryClient.setQueriesData({ queryKey: ['tickets', 'list'] }, (old) =>
        old ? { ...old, data: old.data.map((t) => (t.id === ticket.id ? { ...t, status } : t)) } : old,
      );
      return { previous };
    },
    onError: (err, _vars, context) => {
      context?.previous.forEach(([key, value]) => queryClient.setQueryData(key, value));
      toast.error('Não foi possível mudar o estado', err.message);
    },
    onSuccess: (saved) => toast.success(`#${saved.id} → ${TICKET_STATUS_META[saved.status].label}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['tickets'] }),
  });

  const canEdit = (ticket) => isManager || ticket.created_by === user?.id || ticket.assigned_to === user?.id;
  const changeFilter = (setter) => (value) => {
    setter(value);
    setOffset(0);
  };
  const tickets = data?.data ?? [];
  const filtered = Boolean(q || priority || mine);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Chamados"
        description="Pedidos e problemas dos clientes, por prioridade e estado."
        actions={
          <Button icon={Plus} onClick={() => setModal({})}>
            Novo chamado
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Em aberto" value={openCount.data ?? 0} icon={CircleDashed} tone="sky" loading={openCount.isLoading} />
        <StatCard label="Urgentes em aberto" value={urgentCount.data ?? 0} icon={Flag} tone="red" loading={urgentCount.isLoading} />
        <StatCard label="Atribuídos a mim" value={mineCount.data ?? 0} icon={UserRound} tone="amber" loading={mineCount.isLoading} />
      </div>

      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <SegmentedTabs label="Filtrar por estado" value={tab} onChange={changeFilter(setTab)} options={STATUS_TABS} />
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
            <span className="sr-only">Pesquisar chamados</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-neutral-500" />
            <input type="search" value={search} onChange={(e) => changeFilter(setSearch)(e.target.value)} placeholder="Pesquisar" className={cx(inputClass, 'pl-9')} />
          </label>
          <Select aria-label="Filtrar por prioridade" value={priority} onChange={(e) => changeFilter(setPriority)(e.target.value)} className="w-40">
            <option value="">Todas as prioridades</option>
            {Object.entries(PRIORITY_META).map(([value, meta]) => (
              <option key={value} value={value}>{meta.label}</option>
            ))}
          </Select>
          <label className="flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-neutral-800 px-3 text-sm text-neutral-300 select-none hover:border-neutral-700">
            <input type="checkbox" checked={mine} onChange={(e) => changeFilter(setMine)(e.target.checked)} className="size-4 accent-red-700" />
            Só os meus
          </label>
        </div>
      </div>

      {isError ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : isLoading ? (
        <Spinner />
      ) : tickets.length === 0 ? (
        <EmptyState
          icon={Ticket}
          title={filtered || tab !== 'open_only' ? 'Nenhum chamado encontrado' : 'Nenhum chamado em aberto'}
          description={filtered || tab !== 'open_only' ? 'Ajuste os filtros para ver outros chamados.' : 'Tudo em dia. Novos pedidos dos clientes aparecem aqui.'}
        />
      ) : (
        <Card className={cx('overflow-hidden transition-opacity', isFetching && 'opacity-70')}>
          <ul className="divide-y divide-neutral-800">
            {tickets.map((ticket) => (
              <TicketRow
                key={ticket.id}
                ticket={ticket}
                canEdit={canEdit(ticket)}
                onOpen={setModal}
                onStatusChange={(t, status) => statusMutation.mutate({ ticket: t, status })}
              />
            ))}
          </ul>
          {data.meta.total > PAGE_SIZE && (
            <div className="border-t border-neutral-800 px-4 py-3">
              <Pagination meta={data.meta} onChange={setOffset} />
            </div>
          )}
        </Card>
      )}

      {modal && (
        <TicketModal
          key={modal.id ?? 'new'}
          ticket={modal}
          canEdit={!modal.id || canEdit(modal)}
          canDelete={isAdmin}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
