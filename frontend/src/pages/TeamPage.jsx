import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Dices, Eye, EyeOff, Handshake, Headset, Pencil, Power, QrCode, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { WhatsAppConnectModal, WhatsAppStatusPill, useWhatsAppAdminState } from '../components/WhatsAppConnect.jsx';
import { createUser, listUsers, updateUser } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { ROLE_META, formatDateTime, formatRelative } from '../lib/labels.js';
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
  SegmentedTabs,
  Select,
  Spinner,
  StatCard,
  apiErrorToForm,
  cx,
  inputClass,
} from '../components/ui.jsx';

function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  const bytes = crypto.getRandomValues(new Uint32Array(14));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

// ---------------------------------------------------------------------------
// Adicionar / editar membro
// ---------------------------------------------------------------------------

/** "Gabriel Banzato Silva" → { firstName: 'Gabriel', lastName: 'Banzato Silva' }. */
function splitName(name) {
  const [firstName = '', ...rest] = String(name ?? '').trim().split(/\s+/);
  return { firstName, lastName: rest.join(' ') };
}

const joinName = (firstName, lastName) => [firstName.trim(), lastName.trim()].filter(Boolean).join(' ');

/**
 * O número de WhatsApp é partilhado e cada mensagem sai assinada com o primeiro nome. Se já
 * houver outro membro com o mesmo primeiro nome, o servidor responde SURNAME_REQUIRED e este
 * popup pede o sobrenome (a assinatura passa a "Gabriel Banzato").
 */
function SurnamePrompt({ open, firstName, message, onConfirm, onClose }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(null);

  const submit = (event) => {
    event.preventDefault();
    if (value.trim().length < 2) {
      setError('Indique o sobrenome.');
      return;
    }
    onConfirm(value.trim());
    setValue('');
    setError(null);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Já existe outro ${firstName} na equipe`}
      description="Qual é o sobrenome? Ele entra na assinatura das mensagens do WhatsApp, para o cliente saber com quem fala."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="surname-prompt" icon={Check}>
            Continuar
          </Button>
        </>
      }
    >
      <form id="surname-prompt" onSubmit={submit} className="space-y-3" noValidate>
        {message && <p className="text-sm text-neutral-400">{message}</p>}
        <Field label="Sobrenome" required error={error}>
          {({ id, invalid }) => (
            <input
              id={id}
              autoFocus
              aria-invalid={invalid}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              className={inputClass}
              placeholder="Ex: Banzato"
            />
          )}
        </Field>
        {value.trim() && (
          <p className="text-xs text-neutral-500">
            Assinatura no WhatsApp: <strong className="text-neutral-300">*{firstName} {value.trim().split(/\s+/).at(-1)}*</strong>
          </p>
        )}
      </form>
    </Modal>
  );
}

/** `member` = editar esse membro; sem `member` = adicionar um novo. */
function MemberModal({ open, member, onClose }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const editing = Boolean(member);
  const initial = () => ({ ...splitName(member?.name), email: member?.email ?? '', phone: member?.phone ?? '', role: member?.role ?? 'partner', password: '' });
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const [showPassword, setShowPassword] = useState(false);
  const [copied, setCopied] = useState(false);
  const [surnamePrompt, setSurnamePrompt] = useState(null); // mensagem do servidor

  // Abrir para outro membro (ou para adicionar) recomeça o formulário.
  const [openedFor, setOpenedFor] = useState(null);
  const key = open ? (member?.id ?? 'new') : null;
  if (key !== openedFor) {
    setOpenedFor(key);
    if (open) {
      setForm(initial());
      setErrors({});
      setShowPassword(false);
      setSurnamePrompt(null);
    }
  }

  const mutation = useMutation({
    mutationFn: (body) => (editing ? updateUser(member.id, body) : createUser(body)),
    onSuccess: (user) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      if (editing) toast.success('Membro atualizado', user.name);
      else toast.success(`${user.name} foi adicionado à equipe`, `Compartilhe a senha por um canal seguro. Acesso com ${user.email}.`);
      onClose();
    },
    onError: (err) => {
      const code = err.body?.code;
      if (code === 'SURNAME_REQUIRED') {
        setSurnamePrompt(err.message);
        return;
      }
      if (code === 'SIGNATURE_TAKEN' || code === 'OTHER_SURNAME_REQUIRED') {
        setErrors({ lastName: err.message });
        return;
      }
      const { fields, message } = apiErrorToForm(err);
      if (code === 'CONFLICT') fields.email = 'Já existe uma conta com este email.';
      if (fields.name) fields.firstName = fields.name;
      setErrors(Object.keys(fields).length ? fields : { form: message });
    },
  });

  const set = (field) => (event) => {
    setForm((f) => ({ ...f, [field]: event.target.value }));
    setErrors((e) => ({ ...e, [field]: undefined, form: undefined }));
  };

  const save = (values) => {
    const body = { name: joinName(values.firstName, values.lastName), email: values.email.trim(), phone: values.phone.trim() || null };
    if (!editing) body.role = values.role;
    if (values.password) body.password = values.password;
    if (editing) {
      // Só o que mudou (o PATCH valida o nome só quando ele muda).
      if (body.name === member.name) delete body.name;
      if (body.email === member.email) delete body.email;
      if (body.phone === (member.phone ?? null)) delete body.phone;
      if (!Object.keys(body).length) {
        onClose();
        return;
      }
    }
    mutation.mutate(body);
  };

  const submit = (event) => {
    event.preventDefault();
    const next = {};
    if (form.firstName.trim().length < 2) next.firstName = 'Indique o nome.';
    if (/\s/.test(form.firstName.trim())) next.firstName = 'Só o primeiro nome aqui; o resto vai no sobrenome.';
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) next.email = 'Email inválido.';
    if (form.phone.trim() && form.phone.replace(/\D/g, '').length < 10) next.phone = 'Informe o número com DDD, ex.: (19) 99876-5432.';
    else if (/[^0-9+()\s-]/.test(form.phone)) next.phone = 'Use só números (e + ( ) -).';
    if ((!editing || form.password) && form.password.length < 8) next.password = 'A senha deve ter pelo menos 8 caracteres.';
    setErrors(next);
    if (Object.keys(next).length) return;
    save(form);
  };

  const confirmSurname = (lastName) => {
    const next = { ...form, lastName };
    setForm(next);
    setSurnamePrompt(null);
    save(next);
  };

  const fillPassword = () => {
    setForm((f) => ({ ...f, password: generatePassword() }));
    setShowPassword(true);
    setErrors((e) => ({ ...e, password: undefined }));
  };

  const copyPassword = async () => {
    try {
      await navigator.clipboard.writeText(form.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Não foi possível copiar', 'Copie a senha manualmente.');
    }
  };

  return (
    <>
      <Modal
        open={open && !surnamePrompt}
        onClose={onClose}
        title={editing ? `Editar ${member.name}` : 'Adicionar membro'}
        description={
          editing
            ? 'O nome aparece na assinatura das mensagens do WhatsApp. Deixe a senha em branco para mantê-la.'
            : 'A pessoa entra com o email e a senha definidos aqui e pode alterá-la depois.'
        }
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" form="member-form" icon={editing ? Check : UserPlus} loading={mutation.isPending}>
              {editing ? 'Salvar alterações' : 'Adicionar à equipe'}
            </Button>
          </>
        }
      >
        <form id="member-form" onSubmit={submit} className="space-y-4" noValidate>
          {errors.form && <p className="rounded-xl bg-red-950/40 px-3 py-2 text-sm text-red-300">{errors.form}</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome" required error={errors.firstName}>
              {({ id, invalid }) => (
                <input id={id} aria-invalid={invalid} value={form.firstName} onChange={set('firstName')} className={inputClass} placeholder="Ex: Paula" />
              )}
            </Field>
            <Field label="Sobrenome" error={errors.lastName} hint="Obrigatório se já houver alguém com o mesmo nome.">
              {({ id, invalid }) => (
                <input id={id} aria-invalid={invalid} value={form.lastName} onChange={set('lastName')} className={inputClass} placeholder="Ex: Martins" />
              )}
            </Field>
          </div>
          <Field label="Email" required error={errors.email}>
            {({ id, invalid }) => (
              <input id={id} type="email" aria-invalid={invalid} value={form.email} onChange={set('email')} className={inputClass} placeholder="paula@empresa.com" autoComplete="off" />
            )}
          </Field>

          <Field label="WhatsApp" error={errors.phone} hint="Opcional. Recebe aqui os lembretes das reuniões que conduzir (no dia e 1h antes).">
            {({ id, invalid }) => (
              <input id={id} type="tel" aria-invalid={invalid} value={form.phone} onChange={set('phone')} className={inputClass} placeholder="(19) 99876-5432" autoComplete="off" />
            )}
          </Field>

          {!editing && (
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-neutral-300">Papel</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {Object.entries(ROLE_META).map(([role, meta]) => (
                  <label
                    key={role}
                    className={cx(
                      'cursor-pointer rounded-xl border p-3 transition',
                      form.role === role ? 'border-red-800 bg-red-950/30' : 'border-neutral-800 hover:border-neutral-700',
                    )}
                  >
                    <input type="radio" name="role" value={role} checked={form.role === role} onChange={set('role')} className="sr-only" />
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    <span className="mt-1.5 block text-xs text-neutral-500">{meta.description}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <Field
            label={editing ? 'Nova senha' : 'Senha inicial'}
            required={!editing}
            error={errors.password}
            hint={editing ? 'Opcional. Mínimo 8 caracteres.' : 'Mínimo 8 caracteres.'}
          >
            {({ id, invalid }) => (
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    id={id}
                    type={showPassword ? 'text' : 'password'}
                    aria-invalid={invalid}
                    value={form.password}
                    onChange={set('password')}
                    className={cx(inputClass, 'pr-10 font-mono')}
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                    className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1 text-neutral-500 hover:text-white"
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                <Button variant="secondary" icon={Dices} onClick={fillPassword} title="Gerar senha forte">
                  Gerar
                </Button>
                {form.password && (
                  <Button variant="secondary" icon={copied ? Check : Copy} onClick={copyPassword} aria-label="Copiar senha" />
                )}
              </div>
            )}
          </Field>
        </form>
      </Modal>

      <SurnamePrompt
        open={open && Boolean(surnamePrompt)}
        firstName={form.firstName.trim()}
        message={surnamePrompt}
        onConfirm={confirmSurname}
        onClose={() => setSurnamePrompt(null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

const TABS = [
  { value: 'active', label: 'Ativos' },
  { value: 'inactive', label: 'Inativos' },
  { value: 'all', label: 'Todos' },
];

export default function TeamPage() {
  const { user: me, isAdmin } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('active');
  const [memberModal, setMemberModal] = useState({ open: false, member: null }); // adicionar (member null) ou editar
  const [toggling, setToggling] = useState(null); // membro a (des)ativar
  const [whatsappOpen, setWhatsappOpen] = useState(false);
  const whatsapp = useWhatsAppAdminState({ enabled: isAdmin });

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['users', 'list'],
    queryFn: () => listUsers({ limit: 200 }),
    enabled: isAdmin,
  });

  const members = useMemo(() => data?.data ?? [], [data]);
  const visible = members.filter((m) => (tab === 'all' ? true : tab === 'active' ? m.is_active : !m.is_active));
  const active = members.filter((m) => m.is_active);
  const counts = {
    admin: active.filter((m) => m.role === 'admin').length,
    partner: active.filter((m) => m.role === 'partner').length,
    agent: active.filter((m) => m.role === 'agent').length,
  };

  const updateMutation = useMutation({
    mutationFn: ({ id, ...body }) => updateUser(id, body),
    onSuccess: (user, variables) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      if ('role' in variables) toast.success('Papel atualizado', `${user.name} agora é ${ROLE_META[user.role].label}.`);
      if ('is_active' in variables) toast.success(user.is_active ? `${user.name} foi reativado` : `${user.name} foi desativado`);
      setToggling(null);
    },
    onError: (err) => {
      toast.error('Não foi possível atualizar', err.message);
      setToggling(null);
    },
  });

  if (!isAdmin) {
    return <EmptyState icon={ShieldCheck} title="Acesso restrito" description="A gestão de equipe está disponível apenas para administradores." />;
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="equipe"
        description="Membros com acesso ao Nexus e os respetivos papéis."
        actions={
          isAdmin && (
            <div className="flex flex-wrap items-center gap-2">
              {/* Ligação do WhatsApp da empresa (QR Code) usado pela Central de Atendimento. */}
              <Button variant="secondary" icon={QrCode} onClick={() => setWhatsappOpen(true)}>
                WhatsApp
                {whatsapp.status && <WhatsAppStatusPill status={whatsapp.status} compact />}
              </Button>
              <Button icon={UserPlus} onClick={() => setMemberModal({ open: true, member: null })}>
                Adicionar membro
              </Button>
            </div>
          )
        }
      />
      <WhatsAppConnectModal open={whatsappOpen} onClose={() => setWhatsappOpen(false)} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Administradores" value={counts.admin} icon={ShieldCheck} tone="red" loading={isLoading} />
        <StatCard label="Parceiros" value={counts.partner} icon={Handshake} tone="amber" loading={isLoading} />
        <StatCard label="Agentes" value={counts.agent} icon={Headset} tone="sky" loading={isLoading} />
      </div>

      <SegmentedTabs
        label="Filtrar membros"
        value={tab}
        onChange={setTab}
        options={TABS.map((t) => ({
          ...t,
          count: t.value === 'all' ? members.length : t.value === 'active' ? active.length : members.length - active.length,
        }))}
      />

      {isError ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : isLoading ? (
        <Spinner />
      ) : visible.length === 0 ? (
        <EmptyState icon={Users} title="Ninguém por aqui" description={tab === 'inactive' ? 'Não há membros desativados.' : 'Adicione o primeiro membro da equipe.'} />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-neutral-800">
            {visible.map((member) => {
              const isSelf = member.id === me?.id;
              return (
                <li key={member.id} className={cx('flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5 sm:flex-nowrap', !member.is_active && 'opacity-60')}>
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Avatar name={member.name} id={member.id} />
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 truncate text-sm font-semibold text-white">
                        {member.name}
                        {isSelf && <span className="text-xs font-normal text-neutral-500">(você)</span>}
                      </p>
                      <p className="truncate text-sm text-neutral-500">{member.email}</p>
                    </div>
                  </div>

                  <div className="hidden w-36 text-xs text-neutral-500 md:block" title={formatDateTime(member.last_login_at)}>
                    {member.last_login_at ? `Último acesso ${formatRelative(member.last_login_at)}` : 'Nunca acedeu'}
                  </div>

                  <div className="flex items-center gap-2">
                    {isAdmin && !isSelf && member.is_active ? (
                      <Select
                        aria-label={`Papel de ${member.name}`}
                        value={member.role}
                        disabled={updateMutation.isPending}
                        onChange={(e) => updateMutation.mutate({ id: member.id, role: e.target.value })}
                        className="h-8 w-32 text-xs"
                      >
                        {Object.entries(ROLE_META).map(([role, meta]) => (
                          <option key={role} value={role}>
                            {meta.label}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Badge tone={ROLE_META[member.role].tone}>{ROLE_META[member.role].label}</Badge>
                    )}
                    {!member.is_active && <Badge tone="neutral">Inativo</Badge>}
                    {isAdmin && (
                      <Button variant="ghost" size="sm" icon={Pencil} onClick={() => setMemberModal({ open: true, member })} aria-label={`Editar ${member.name}`}>
                        <span className="hidden sm:inline">Editar</span>
                      </Button>
                    )}
                    {isAdmin && !isSelf && (
                      <Button
                        variant={member.is_active ? 'ghost' : 'secondary'}
                        size="sm"
                        icon={Power}
                        onClick={() => setToggling(member)}
                        aria-label={member.is_active ? `Desativar ${member.name}` : `Reativar ${member.name}`}
                      >
                        {member.is_active ? 'Desativar' : 'Reativar'}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <MemberModal open={memberModal.open} member={memberModal.member} onClose={() => setMemberModal((m) => ({ ...m, open: false }))} />

      <ConfirmDialog
        open={Boolean(toggling)}
        title={toggling?.is_active ? `Desativar ${toggling?.name}?` : `Reativar ${toggling?.name}?`}
        description={
          toggling?.is_active
            ? 'A pessoa perde o acesso imediatamente, mas o histórico (chamados, clientes, logs) é mantido.'
            : 'A pessoa volta a conseguir entrar com a senha atual.'
        }
        confirmLabel={toggling?.is_active ? 'Desativar acesso' : 'Reativar'}
        tone={toggling?.is_active ? 'danger' : 'primary'}
        loading={updateMutation.isPending}
        onConfirm={() => updateMutation.mutate({ id: toggling.id, is_active: !toggling.is_active })}
        onClose={() => setToggling(null)}
      />
    </div>
  );
}
