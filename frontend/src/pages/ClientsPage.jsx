import { useState } from 'react';
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Mail, Pencil, Phone, Plus, Search, Trash2, UserRound } from 'lucide-react';
import { createClient, deleteClient, listClients, updateClient } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useDebouncedValue, useUserDirectory } from '../lib/hooks.js';
import { CLIENT_STATUS_META, formatDateTime, formatRelative } from '../lib/labels.js';
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
  IconButton,
  Modal,
  PageHeader,
  Pagination,
  SegmentedTabs,
  Select,
  Spinner,
  apiErrorToForm,
  cx,
  inputClass,
} from '../components/ui.jsx';

const PAGE_SIZE = 20;
const STATUS_TABS = [{ value: '', label: 'Todos' }, ...Object.entries(CLIENT_STATUS_META).map(([value, m]) => ({ value, label: m.label }))];

// ---------------------------------------------------------------------------
// Formulário (criar / editar)
// ---------------------------------------------------------------------------

function ClientFormModal({ client, onClose }) {
  const { user, isManager } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: users = [] } = useUserDirectory();
  const isEdit = Boolean(client?.id);

  const [form, setForm] = useState({
    name: client?.name ?? '',
    company: client?.company ?? '',
    phone: client?.phone ?? '',
    email: client?.email ?? '',
    status: client?.status ?? 'lead',
    responsible_id: client?.responsible_id ?? user?.id ?? '',
  });
  const [errors, setErrors] = useState({});

  const mutation = useMutation({
    mutationFn: (body) => (isEdit ? updateClient(client.id, body) : createClient(body)),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      toast.success(isEdit ? 'Cliente atualizado' : 'Cliente adicionado', saved.name);
      onClose();
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
    if (form.name.trim().length < 2) return setErrors({ name: 'Indique o nome do cliente.' });
    const orNull = (value) => (String(value).trim() ? String(value).trim() : null);
    const body = {
      name: form.name.trim(),
      company: orNull(form.company),
      phone: orNull(form.phone),
      email: orNull(form.email),
      status: form.status,
    };
    // Agentes não escolhem responsável (o backend força o próprio agente).
    if (isManager) body.responsible_id = form.responsible_id ? Number(form.responsible_id) : null;
    mutation.mutate(body);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? 'Editar cliente' : 'Novo cliente'}
      description={isEdit ? `Atualizado ${formatRelative(client.updated_at)}` : 'Registe um cliente conquistado ou em negociação.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="client-form" loading={mutation.isPending}>
            {isEdit ? 'Guardar alterações' : 'Adicionar cliente'}
          </Button>
        </>
      }
    >
      <form id="client-form" onSubmit={submit} className="space-y-4" noValidate>
        {errors.form && <p className="rounded-xl bg-red-950/40 px-3 py-2 text-sm text-red-300">{errors.form}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome do contacto" required error={errors.name}>
            {({ id, invalid }) => <input id={id} aria-invalid={invalid} value={form.name} onChange={set('name')} className={inputClass} />}
          </Field>
          <Field label="Empresa" error={errors.company}>
            {({ id }) => <input id={id} value={form.company} onChange={set('company')} className={inputClass} />}
          </Field>
          <Field label="Telefone" error={errors.phone}>
            {({ id }) => <input id={id} type="tel" value={form.phone} onChange={set('phone')} className={inputClass} placeholder="(11) 99999-0000" />}
          </Field>
          <Field label="Email" error={errors.email}>
            {({ id, invalid }) => <input id={id} type="email" aria-invalid={invalid} value={form.email} onChange={set('email')} className={inputClass} />}
          </Field>
          <Field label="Estado">
            {({ id }) => (
              <Select id={id} value={form.status} onChange={set('status')}>
                {Object.entries(CLIENT_STATUS_META).map(([value, meta]) => (
                  <option key={value} value={value}>
                    {meta.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Responsável" hint={isManager ? undefined : 'Clientes criados por agentes ficam sob a sua responsabilidade.'}>
            {({ id }) => (
              <Select id={id} value={form.responsible_id} onChange={set('responsible_id')} disabled={!isManager}>
                <option value="">Sem responsável</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default function ClientsPage() {
  const { user, isManager } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState(null); // {} = novo, cliente = editar
  const [deleting, setDeleting] = useState(null);
  const q = useDebouncedValue(search.trim());

  const params = { status, q, limit: PAGE_SIZE, offset };
  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['clients', 'list', params],
    queryFn: () => listClients(params),
    placeholderData: keepPreviousData, // mantém a tabela visível ao paginar/filtrar
  });

  // Contagens por estado para as abas (respeitam a pesquisa).
  const counts = useQueries({
    queries: STATUS_TABS.map((tab) => ({
      queryKey: ['clients', 'count', tab.value, q],
      queryFn: () => listClients({ status: tab.value, q, limit: 1 }).then((r) => r.meta.total),
    })),
  });

  const deleteMutation = useMutation({
    mutationFn: (client) => deleteClient(client.id),
    onSuccess: (_, client) => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      toast.success('Cliente removido', client.name);
      setDeleting(null);
    },
    onError: (err) => toast.error('Não foi possível remover', err.message),
  });

  const changeFilter = (setter) => (value) => {
    setter(value);
    setOffset(0);
  };

  const canEdit = (client) => isManager || client.responsible_id === user?.id;
  const clients = data?.data ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Clientes conquistados"
        description="Carteira de clientes, estado da relação e quem é responsável por cada um."
        actions={
          <Button icon={Plus} onClick={() => setEditing({})}>
            Novo cliente
          </Button>
        }
      />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <SegmentedTabs
          label="Filtrar por estado"
          value={status}
          onChange={changeFilter(setStatus)}
          options={STATUS_TABS.map((tab, i) => ({ ...tab, count: counts[i].data }))}
        />
        <label className="relative lg:w-80">
          <span className="sr-only">Pesquisar clientes</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-neutral-500" />
          <input
            type="search"
            value={search}
            onChange={(e) => changeFilter(setSearch)(e.target.value)}
            placeholder="Nome, empresa, email ou telefone"
            className={cx(inputClass, 'pl-9')}
          />
        </label>
      </div>

      {isError ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : isLoading ? (
        <Spinner />
      ) : clients.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={q || status ? 'Nenhum cliente encontrado' : 'Ainda não há clientes'}
          description={q || status ? 'Ajuste a pesquisa ou o filtro de estado.' : 'Quando um lead fechar negócio, registe-o aqui.'}
          action={!q && !status && <Button icon={Plus} onClick={() => setEditing({})}>Adicionar cliente</Button>}
        />
      ) : (
        <Card className={cx('overflow-hidden transition-opacity', isFetching && 'opacity-70')}>
          {/* Tabela (desktop) */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-neutral-800 text-xs tracking-wide text-neutral-500 uppercase">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Cliente</th>
                  <th scope="col" className="px-4 py-3 font-medium">Contacto</th>
                  <th scope="col" className="px-4 py-3 font-medium">Estado</th>
                  <th scope="col" className="px-4 py-3 font-medium">Responsável</th>
                  <th scope="col" className="px-4 py-3 font-medium">Atualizado</th>
                  <th scope="col" className="px-4 py-3"><span className="sr-only">Ações</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800/70">
                {clients.map((client) => (
                  <tr key={client.id} className="transition-colors hover:bg-neutral-800/30">
                    <td className="px-4 py-3">
                      <p className="font-semibold text-white">{client.name}</p>
                      {client.company && <p className="text-xs text-neutral-500">{client.company}</p>}
                    </td>
                    <td className="px-4 py-3 text-neutral-400">
                      {client.phone && (
                        <a href={`tel:${client.phone.replace(/[^\d+]/g, '')}`} className="flex items-center gap-1.5 hover:text-white">
                          <Phone className="size-3.5" /> {client.phone}
                        </a>
                      )}
                      {client.email && (
                        <a href={`mailto:${client.email}`} className="flex items-center gap-1.5 hover:text-white">
                          <Mail className="size-3.5" /> <span className="max-w-52 truncate">{client.email}</span>
                        </a>
                      )}
                      {!client.phone && !client.email && <span className="text-neutral-600">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={CLIENT_STATUS_META[client.status].tone} dot>
                        {CLIENT_STATUS_META[client.status].label}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      {client.responsible_id ? (
                        <span className="flex items-center gap-2 text-neutral-300">
                          <Avatar name={client.responsible_name ?? '?'} id={client.responsible_id} size="sm" />
                          {client.responsible_name}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-neutral-600">
                          <UserRound className="size-4" /> Sem responsável
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-neutral-500" title={formatDateTime(client.updated_at)}>
                      {formatRelative(client.updated_at)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <IconButton
                          icon={Pencil}
                          label={canEdit(client) ? `Editar ${client.name}` : 'Só o responsável ou um gestor pode editar'}
                          disabled={!canEdit(client)}
                          onClick={() => setEditing(client)}
                        />
                        {isManager && <IconButton icon={Trash2} label={`Remover ${client.name}`} onClick={() => setDeleting(client)} className="hover:text-red-400" />}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Cartões (telemóvel) */}
          <ul className="divide-y divide-neutral-800 md:hidden">
            {clients.map((client) => (
              <li key={client.id} className="space-y-2 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-white">{client.name}</p>
                    {client.company && <p className="truncate text-xs text-neutral-500">{client.company}</p>}
                  </div>
                  <Badge tone={CLIENT_STATUS_META[client.status].tone} dot>
                    {CLIENT_STATUS_META[client.status].label}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-neutral-400">
                  {client.phone && <a href={`tel:${client.phone.replace(/[^\d+]/g, '')}`} className="flex items-center gap-1.5"><Phone className="size-3.5" />{client.phone}</a>}
                  {client.email && <a href={`mailto:${client.email}`} className="flex min-w-0 items-center gap-1.5"><Mail className="size-3.5" /><span className="truncate">{client.email}</span></a>}
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-sm text-neutral-400">
                    {client.responsible_id && <Avatar name={client.responsible_name ?? '?'} id={client.responsible_id} size="xs" />}
                    {client.responsible_name ?? 'Sem responsável'}
                  </span>
                  <div className="flex gap-1">
                    {canEdit(client) && <IconButton icon={Pencil} label={`Editar ${client.name}`} onClick={() => setEditing(client)} />}
                    {isManager && <IconButton icon={Trash2} label={`Remover ${client.name}`} onClick={() => setDeleting(client)} />}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <div className="border-t border-neutral-800 px-4 py-3">
            <Pagination meta={data.meta} onChange={setOffset} />
            {data.meta.total <= PAGE_SIZE && <p className="text-sm text-neutral-500">{data.meta.total} cliente(s)</p>}
          </div>
        </Card>
      )}

      {editing && <ClientFormModal key={editing.id ?? 'new'} client={editing} onClose={() => setEditing(null)} />}

      <ConfirmDialog
        open={Boolean(deleting)}
        title={`Remover ${deleting?.name}?`}
        description="O cliente é apagado. Os chamados associados continuam a existir, mas ficam sem cliente. Para manter o histórico, prefira o estado Arquivado."
        confirmLabel="Remover cliente"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate(deleting)}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
