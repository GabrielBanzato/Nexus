import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, Bot, CalendarClock, Check, CheckCheck, CircleAlert, Clock, Eye, MessagesSquare, QrCode, RefreshCw, Search, SendHorizontal, Sparkles, Target, Video, WifiOff, X } from 'lucide-react';
import {
  createMeeting,
  endMeeting,
  getAiSuggestion,
  getClientMessages,
  listConversations,
  listMeetings,
  meetingUrl,
  requestAiSuggestion,
  sendClientMessage,
  updateClient,
} from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { CLIENT_STATUS_META } from '../lib/labels.js';
import { clearPendingChat, peekPendingChat } from '../lib/chatDraft.js';
import { confirmationPreview, greetingName, instantInvitePreview } from '../lib/meetingTexts.js';
import { useDebouncedValue, useUserDirectory } from '../lib/hooks.js';
import { useSocketConnected, useSocketEvent } from '../lib/socket.js';
import { useToast } from '../components/toast.jsx';
import { WhatsAppConnectModal, WhatsAppStatusPill } from '../components/WhatsAppConnect.jsx';
import { NexReviewCard, useNexReview } from '../components/NexReview.jsx';
import { Avatar, Button, ConfirmDialog, EmptyState, ErrorState, Modal, Spinner, cx, inputClass } from '../components/ui.jsx';

/**
 * Central de Atendimento: conversas do WhatsApp da empresa, estilo WhatsApp Web.
 *
 * Dados: lista em ['conversations', { q, scope }], mensagens em ['messages', clientId]
 * (paginadas para trás) e a sugestão da IA em ['ai-suggestion', clientId]. Tempo real pelo
 * Socket.io: `new_message` atualiza as caches na hora, tanto para mensagens recebidas como para
 * as enviadas por outra pessoa (ou noutra aba). Ao religar o socket, recarrega tudo (pode ter
 * perdido eventos enquanto esteve em baixo).
 *
 * O número é partilhado pela equipe: cada mensagem sai assinada por quem a escreveu e a IA só
 * SUGERE respostas (quem envia é sempre uma pessoa).
 */

const MAX_LENGTH = 4096; // limite do backend (e do WhatsApp) por mensagem

/**
 * O que a IA percebeu da última mensagem do cliente (backend: ai/prompt.js INTENTS). Só as
 * intenções que o modelo acerta bem; "sem_interesse" fica de fora (já marcou como tal quem
 * pediu uma loja virtual).
 */
const AI_INTENT_HINTS = {
  preco: 'pediu preço/orçamento',
  agendar_reuniao: 'quer marcar uma conversa',
  suporte: 'precisa de suporte',
  reclamacao: 'fez uma reclamação',
};

/** Conversa pedida no endereço (#/atendimento?c=12), vinda de uma notificação. */
const readTargetConversation = () => Number(new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('c')) || null;

// Admin: "Ver tudo" (tudo o que chega ao número) ou "Foco" (só as empresas atribuídas a ele).
const SCOPE_STORAGE_KEY = 'nexus:attendance-scope';
function readScope() {
  try {
    return window.localStorage.getItem(SCOPE_STORAGE_KEY) === 'mine' ? 'mine' : 'all';
  } catch {
    return 'all';
  }
}
function saveScope(scope) {
  try {
    window.localStorage.setItem(SCOPE_STORAGE_KEY, scope);
  } catch {
    // sem armazenamento (janela privada): só não lembra a escolha
  }
}

const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const weekdayFormat = new Intl.DateTimeFormat('pt-BR', { weekday: 'short' });
const shortDateFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
const longDayFormat = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });

const startOfDay = (value) => {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const daysAgo = (value) => Math.round((startOfDay(Date.now()) - startOfDay(value)) / 86_400_000);

/** Hora na lista: hoje → 14:05; ontem → Ontem; esta semana → seg.; antes → 03/09/26. */
function listTime(value) {
  if (!value) return '';
  const days = daysAgo(value);
  if (days === 0) return timeFormat.format(new Date(value));
  if (days === 1) return 'Ontem';
  if (days < 7) return weekdayFormat.format(new Date(value)).replace('.', '');
  return shortDateFormat.format(new Date(value));
}

function dayLabel(value) {
  const days = daysAgo(value);
  if (days === 0) return 'Hoje';
  if (days === 1) return 'Ontem';
  const label = longDayFormat.format(new Date(value));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function lastPreview(conversation) {
  if (!conversation.last_message) return conversation.phone ? `${conversation.phone} · sem mensagens` : 'Sem mensagens';
  const prefix = { agent: 'Equipe: ', bot: '🤖 ' }[conversation.last_sender_type] ?? '';
  return prefix + conversation.last_message;
}

// ---------------------------------------------------------------------------
// Caches (TanStack Query)
// ---------------------------------------------------------------------------

const messagesKey = (clientId) => ['messages', clientId];

/** Aplica `fn` às páginas de mensagens de um cliente (se a conversa já foi aberta). */
function updatePages(queryClient, clientId, fn) {
  queryClient.setQueryData(messagesKey(clientId), (old) => (old ? { ...old, pages: fn(old.pages) } : old));
}

const hasMessage = (pages, id) => pages.some((page) => page.data.some((m) => m.id === id));

/**
 * Mensagem nova (socket ou resposta do envio). Se for a confirmação de uma mensagem nossa
 * ainda "a enviar", substitui a provisória em vez de duplicar.
 */
/** ✓ enviada · ✓✓ entregue · ✓✓ azul lida (como no WhatsApp). Mensagens antigas (sem ack): ✓. */
function AckTicks({ ack }) {
  if (ack >= 3) return <CheckCheck className="size-3.5 text-[#53bdeb]" aria-label="Lida" />;
  if (ack === 2) return <CheckCheck className="size-3.5" aria-label="Entregue" />;
  return <Check className="size-3" aria-label="Enviada" />;
}

/** Estado no WhatsApp mudou (entregue/lida): atualiza a mensagem na cache, se estiver carregada. */
function patchMessageAck(queryClient, clientId, messageId, ack) {
  updatePages(queryClient, clientId, (pages) =>
    pages.map((page) => ({ ...page, data: page.data.map((m) => (m.id === messageId && (m.ack ?? 0) < ack ? { ...m, ack } : m)) })),
  );
}

function upsertMessage(queryClient, clientId, message) {
  updatePages(queryClient, clientId, (pages) => {
    if (hasMessage(pages, message.id)) return pages;
    const [latest, ...older] = pages;
    const tempIndex = latest.data.findIndex(
      (m) => m.pending && m.content === message.content && m.sender_user_id === message.sender_user_id,
    );
    const data = tempIndex >= 0 ? latest.data.map((m, i) => (i === tempIndex ? message : m)) : [...latest.data, message];
    return [{ ...latest, data }, ...older];
  });
}

/** Sobe a conversa para o topo com a última mensagem; cliente fora da lista → recarrega. */
function bumpConversation(queryClient, client, message) {
  let found = false;
  queryClient.setQueriesData({ queryKey: ['conversations'] }, (old) => {
    if (!old) return old;
    const index = old.data.findIndex((c) => c.id === client.id);
    if (index === -1) return old;
    found = true;
    const row = {
      ...old.data[index],
      ...client,
      last_message: message.content,
      last_sender_type: message.sender_type,
      last_message_at: message.created_at,
    };
    return { ...old, data: [row, ...old.data.filter((_, i) => i !== index)] };
  });
  if (!found) queryClient.invalidateQueries({ queryKey: ['conversations'] });
}

function patchConversation(queryClient, clientId, patch) {
  queryClient.setQueriesData({ queryKey: ['conversations'] }, (old) =>
    old ? { ...old, data: old.data.map((c) => (c.id === clientId ? { ...c, ...patch } : c)) } : old,
  );
}

// ---------------------------------------------------------------------------
// Lista de conversas (sidebar)
// ---------------------------------------------------------------------------

const dayMonth = (ymd) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Selo na lista: "Cliente", "Em espera até 12/10" ou "Retomar" (a data já chegou). Lead não leva selo. */
function StatusChip({ conversation }) {
  const { status, hold_until: holdUntil } = conversation;
  if (status === 'active') {
    return <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300 ring-1 ring-emerald-500/30">Cliente</span>;
  }
  if (status === 'on_hold') {
    const due = holdUntil && holdUntil <= todayYmd();
    return (
      <span className={cx('shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1', due ? 'bg-red-500/10 text-red-300 ring-red-500/30' : 'bg-amber-500/10 text-amber-300 ring-amber-500/30')}>
        {due ? 'Retomar' : holdUntil ? `Espera até ${dayMonth(holdUntil)}` : 'Em espera'}
      </span>
    );
  }
  if (status === 'archived') {
    return <span className="shrink-0 rounded-full bg-neutral-800 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-400">Arquivado</span>;
  }
  return null;
}

function ConversationItem({ conversation, active, unread, aiSuggesting, unassigned, onSelect }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(conversation)}
        aria-current={active ? 'true' : undefined}
        className={cx(
          'flex w-full items-center gap-3 border-l-2 px-4 py-3 text-left transition',
          active ? 'border-red-600 bg-red-950/30' : 'border-transparent hover:bg-neutral-800/40',
        )}
      >
        <Avatar name={conversation.name} id={conversation.id} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={cx('truncate text-sm', unread ? 'font-bold text-white' : 'font-semibold text-neutral-100')}>{conversation.name}</span>
            <span className={cx('shrink-0 text-[11px] tabular-nums', unread ? 'font-semibold text-red-400' : 'text-neutral-500')}>
              {listTime(conversation.last_message_at)}
            </span>
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            {aiSuggesting ? (
              <span className="min-w-0 flex-1 truncate text-xs text-sky-400 italic">✨ IA a preparar uma sugestão...</span>
            ) : (
              <span className={cx('min-w-0 flex-1 truncate text-xs', unread ? 'text-neutral-200' : 'text-neutral-500')}>{lastPreview(conversation)}</span>
            )}
            <StatusChip conversation={conversation} />
            {unassigned && (
              <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 ring-1 ring-amber-500/30">
                Sem responsável
              </span>
            )}
            {unread > 0 && (
              <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-red-600 px-1.5 text-[10px] font-bold text-white tabular-nums">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

const SCOPES = [
  { value: 'all', label: 'Ver tudo', icon: Eye, title: 'Tudo o que chega ao número, como no app do telemóvel' },
  { value: 'mine', label: 'Foco', icon: Target, title: 'Só as empresas atribuídas a você' },
];

/** Admin: alterna entre ver tudo o que chega ao número e só as suas empresas. */
function ScopeToggle({ value, onChange }) {
  return (
    <div role="radiogroup" aria-label="O que mostrar" className="grid grid-cols-2 gap-1 rounded-xl bg-[#111111] p-1 ring-1 ring-neutral-800">
      {SCOPES.map(({ value: option, label, icon: Icon, title }) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          title={title}
          onClick={() => onChange(option)}
          className={cx(
            'flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold transition',
            value === option ? 'bg-red-900/60 text-white shadow ring-1 ring-red-700/40' : 'text-neutral-400 hover:text-white',
          )}
        >
          <Icon className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

function Sidebar({ hidden, search, onSearch, query, selectedId, unread, onSelect, waStatus, onOpenConnect, realtime, aiSuggesting, scope, onScopeChange }) {
  const conversations = query.data?.data ?? [];
  const showUnassigned = scope === 'all'; // só o admin vê conversas sem responsável (e atribui-as)
  return (
    // Telemóvel: lista OU conversa. Uma só classe de display por breakpoint (flex vs hidden não podem coexistir).
    <aside className={cx('min-h-0 w-full flex-col border-neutral-800 md:w-80 md:border-r lg:w-96', hidden ? 'hidden md:flex' : 'flex')}>
      <div className="space-y-3 border-b border-neutral-800 p-4">
        <div className="flex items-center justify-between gap-2">
          <h1 className="flex items-center gap-2 text-lg font-bold tracking-tight text-white">
            <MessagesSquare className="size-5 text-red-500" />
            Atendimento
          </h1>
          <WhatsAppStatusPill status={waStatus} compact onClick={onOpenConnect} />
        </div>
        <label className="relative block">
          <span className="sr-only">Pesquisar conversas</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-neutral-500" />
          <input type="search" value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Nome, empresa ou telefone" className={cx(inputClass, 'pl-9')} />
        </label>
        {onScopeChange && <ScopeToggle value={scope} onChange={onScopeChange} />}
        {!realtime && (
          <p className="flex items-center gap-1.5 text-xs text-amber-300/90" role="status">
            <WifiOff className="size-3.5" />
            Tempo real indisponível. A tentar religar...
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.isError ? (
          <div className="p-4"><ErrorState error={query.error} onRetry={query.refetch} /></div>
        ) : query.isLoading ? (
          <Spinner label="A carregar conversas..." />
        ) : conversations.length === 0 ? (
          <EmptyState
            icon={MessagesSquare}
            title={search ? 'Nenhuma conversa encontrada' : 'Sem clientes para atender'}
            description={
              search
                ? 'Tente outro nome ou telefone.'
                : onScopeChange && scope === 'mine'
                  ? 'Nenhuma empresa atribuída a você ainda. Em "Ver tudo" aparece tudo o que chega ao número.'
                  : 'Clientes com telefone aparecem aqui. Quem escrever para o WhatsApp da empresa também.'
            }
          />
        ) : (
          <ul className={cx('divide-y divide-neutral-800/60 transition-opacity', query.isFetching && query.isPlaceholderData && 'opacity-60')}>
            {conversations.map((c) => (
              <ConversationItem
                key={c.id}
                conversation={c}
                active={c.id === selectedId}
                unread={unread[c.id] ?? 0}
                aiSuggesting={Boolean(aiSuggesting[c.id])}
                unassigned={showUnassigned && !c.responsible_id}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Conversa aberta
// ---------------------------------------------------------------------------

/**
 * Admin: atribui a conversa a um parceiro. O número é partilhado; cada empresa é de UM
 * parceiro, e só ele (e o admin) a vê. Números novos chegam sem responsável e só o admin os
 * vê até atribuir. Ao trocar, a conversa some da Central do anterior (filtro no servidor).
 */
function ResponsibleSelect({ conversation }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: users = [] } = useUserDirectory();
  const mutation = useMutation({
    mutationFn: (responsibleId) => updateClient(conversation.id, { responsible_id: responsibleId }),
    onSuccess: (client) => {
      patchConversation(queryClient, client.id, { responsible_id: client.responsible_id, responsible_name: client.responsible_name });
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      toast.success('Responsável atualizado', `${client.name} → ${client.responsible_name ?? 'sem responsável'}`);
    },
    onError: (err) => toast.error('Não foi possível atribuir', err.message),
  });
  return (
    <select
      aria-label={`Responsável por ${conversation.name}`}
      title="Parceiro que atende esta empresa (só ele e o admin veem a conversa)"
      value={conversation.responsible_id ?? ''}
      disabled={mutation.isPending}
      onChange={(e) => mutation.mutate(e.target.value ? Number(e.target.value) : null)}
      className={cx(
        'hidden h-9 max-w-40 shrink-0 cursor-pointer rounded-full border bg-[#141414] px-3 text-xs outline-none sm:block',
        conversation.responsible_id ? 'border-neutral-700 text-neutral-200' : 'border-amber-700/70 text-amber-300',
      )}
    >
      <option value="">Sem responsável</option>
      {users.map((u) => (
        <option key={u.id} value={u.id}>{u.name}</option>
      ))}
    </select>
  );
}

const STATUS_OPTIONS = ['lead', 'active', 'on_hold', 'archived'];
const STATUS_TOASTS = {
  lead: 'Volta a ser um lead (sai da aba Clientes).',
  active: 'Agora aparece na aba Clientes.',
  on_hold: 'Fica em espera, como na Triagem.',
  archived: 'Sai da Central no modo Foco (no "Ver tudo" continua, se houver mensagens).',
};

/**
 * Estado do contacto (para todos os que veem a conversa): Lead, Cliente (vai para a aba
 * Clientes), Em espera (com data de retomar opcional, como na Triagem) ou Arquivado.
 */
function ClientStatusSelect({ conversation }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [holding, setHolding] = useState(false);
  const [holdUntil, setHoldUntil] = useState('');
  const mutation = useMutation({
    mutationFn: (body) => updateClient(conversation.id, body),
    onSuccess: (client) => {
      setHolding(false);
      patchConversation(queryClient, client.id, { status: client.status, hold_until: client.hold_until });
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      toast.success(`${client.name}: ${CLIENT_STATUS_META[client.status].label}`, STATUS_TOASTS[client.status]);
    },
    onError: (err) => toast.error('Não foi possível mudar o estado', err.message),
  });
  const status = conversation.status ?? 'lead';
  const tone = { lead: 'border-sky-800/70 text-sky-300', active: 'border-emerald-700/70 text-emerald-300', on_hold: 'border-amber-700/70 text-amber-300', archived: 'border-neutral-700 text-neutral-400' }[status];

  return (
    <>
      <select
        aria-label={`Estado de ${conversation.name}`}
        title="Lead, cliente (aparece na aba Clientes), em espera ou arquivado"
        value={status}
        disabled={mutation.isPending}
        onChange={(e) => {
          const next = e.target.value;
          if (next === 'on_hold') {
            setHoldUntil('');
            setHolding(true);
          } else mutation.mutate({ status: next });
        }}
        className={cx('h-9 max-w-32 shrink-0 cursor-pointer rounded-full border bg-[#141414] px-3 text-xs font-medium outline-none', tone)}
      >
        {STATUS_OPTIONS.map((value) => (
          <option key={value} value={value}>{CLIENT_STATUS_META[value].label}</option>
        ))}
      </select>
      <Modal
        open={holding}
        onClose={() => setHolding(false)}
        size="sm"
        title="Pôr em espera"
        description={`${conversation.name} fica marcado como "Em espera" na Central.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setHolding(false)}>Cancelar</Button>
            <Button loading={mutation.isPending} onClick={() => mutation.mutate({ status: 'on_hold', hold_until: holdUntil || null })}>Pôr em espera</Button>
          </>
        }
      >
        <label className="block text-sm font-medium text-neutral-300" htmlFor="hold-until">Retomar em (opcional)</label>
        <input id="hold-until" type="date" value={holdUntil} min={toDateInput(new Date())} onChange={(e) => setHoldUntil(e.target.value)} className={cx(inputClass, 'mt-1.5')} data-autofocus />
        <p className="mt-1.5 text-xs text-neutral-500">Nesse dia o selo passa a "Retomar" na lista de conversas.</p>
      </Modal>
    </>
  );
}

const pad = (n) => String(n).padStart(2, '0');
const toDateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Sugestão de horário: a próxima hora cheia com pelo menos 1h de folga. */
function nextSlot() {
  const d = new Date(Date.now() + 90 * 60_000);
  d.setMinutes(0, 0, 0);
  return { date: toDateInput(d), time: `${pad(d.getHours())}:00` };
}
const meetingWhen = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * Videochamada na plataforma, com duas opções:
 *  - Agora: cria a sala, o servidor envia o convite ao cliente pelo WhatsApp (assinado por quem
 *    clica) e a sala abre numa nova aba.
 *  - Agendar: data e hora; o cliente recebe a confirmação na hora e, depois, lembretes
 *    automáticos no dia e 1h antes (quem conduz também é lembrado).
 */
function VideoCallButton({ conversation, canSend }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('now'); // now | schedule
  const [slot, setSlot] = useState(nextSlot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const when = slot.date && slot.time ? new Date(`${slot.date}T${slot.time}`) : null; // hora local
  const name = greetingName({ contactName: conversation.name, company: conversation.company });
  const placeholderLink = `${window.location.origin}/sala/…`;

  const openDialog = () => {
    setMode('now');
    setSlot(nextSlot());
    setError(null);
    setOpen(true);
  };

  const startNow = async () => {
    // Abre a aba JÁ, no clique: depois de esperar pela API o navegador bloquearia o pop-up.
    const win = window.open('', '_blank');
    setBusy(true);
    try {
      const { data: meeting, meta } = await createMeeting({ client_id: conversation.id, notify: canSend });
      const url = meetingUrl(meeting.code);
      if (win) win.location.href = url;
      else window.open(url, '_blank');
      if (meta.notification.sent) {
        toast.success('Videochamada iniciada', `Convite enviado a ${conversation.name} pelo WhatsApp.`);
      } else {
        await navigator.clipboard?.writeText(url).catch(() => {});
        toast.info('Sala criada: link copiado', meta.notification.message ?? 'Envie o link ao cliente por outro meio.');
      }
      setOpen(false);
    } catch (err) {
      win?.close();
      toast.error('Não foi possível iniciar a videochamada', err.message);
    } finally {
      setBusy(false);
    }
  };

  const schedule = async () => {
    if (!when || Number.isNaN(when.getTime())) return setError('Indique a data e a hora.');
    if (when.getTime() < Date.now()) return setError('Esse horário já passou.');
    setBusy(true);
    setError(null);
    try {
      const { data: meeting, meta } = await createMeeting({ client_id: conversation.id, scheduled_at: when.toISOString(), notify: canSend });
      queryClient.invalidateQueries({ queryKey: ['meetings', { client_id: conversation.id }] });
      if (meta.notification.sent) {
        toast.success('Reunião agendada', `${conversation.name} recebeu a confirmação e vai ser lembrado no dia e 1h antes.`);
      } else {
        await navigator.clipboard?.writeText(meetingUrl(meeting.code)).catch(() => {});
        toast.info('Reunião agendada: link copiado', meta.notification.message ?? 'Envie o link ao cliente por outro meio.');
      }
      setOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const preview = mode === 'now' ? instantInvitePreview({ name, link: placeholderLink }) : when && !Number.isNaN(when.getTime()) ? confirmationPreview({ name, when, link: placeholderLink }) : null;

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        title="Videochamada na plataforma: agora ou agendada"
        aria-label="Videochamada"
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-neutral-300 ring-1 ring-neutral-700 transition hover:bg-neutral-800 hover:text-white"
      >
        <Video className="size-4" />
      </button>
      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        title={`Videochamada com ${conversation.name}`}
        description={canSend ? 'O cliente recebe a mensagem pelo WhatsApp, assinada com o seu nome.' : 'O WhatsApp está desconectado: criamos a sala e copiamos o link para você enviar.'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button icon={mode === 'now' ? Video : CalendarClock} loading={busy} onClick={mode === 'now' ? startNow : schedule}>
              {mode === 'now' ? 'Começar agora' : 'Agendar reunião'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div role="radiogroup" aria-label="Quando" className="grid grid-cols-2 gap-1 rounded-xl bg-[#111111] p-1 ring-1 ring-neutral-800">
            {[
              { value: 'now', label: 'Agora', icon: Video },
              { value: 'schedule', label: 'Agendar', icon: CalendarClock },
            ].map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={mode === value}
                onClick={() => {
                  setMode(value);
                  setError(null);
                }}
                className={cx(
                  'flex items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-semibold transition',
                  mode === value ? 'bg-red-900/60 text-white ring-1 ring-red-700/40' : 'text-neutral-400 hover:text-white',
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </div>

          {mode === 'schedule' && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-neutral-300">Dia</span>
                <input type="date" value={slot.date} min={toDateInput(new Date())} onChange={(e) => setSlot((s) => ({ ...s, date: e.target.value }))} className={inputClass} />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-neutral-300">Hora</span>
                <input type="time" value={slot.time} step={300} onChange={(e) => setSlot((s) => ({ ...s, time: e.target.value }))} className={inputClass} />
              </label>
              <p className="col-span-2 text-xs text-neutral-500">
                Lembretes automáticos no dia (de manhã) e 1h antes, para o cliente e para você.
              </p>
            </div>
          )}

          {error && <p className="rounded-xl bg-red-950/40 px-3 py-2 text-sm text-red-300">{error}</p>}

          {canSend && preview && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-neutral-400">Mensagem que o cliente vai receber</p>
              <p className="max-h-48 overflow-y-auto rounded-xl bg-red-950/30 px-3 py-2.5 text-sm break-words whitespace-pre-wrap text-red-50 ring-1 ring-red-900/40">{preview}</p>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}

/**
 * Próxima reunião marcada com este cliente, por cima da conversa: dia/hora, entrar, copiar o
 * link ou cancelar (a sala fecha e não há mais lembretes).
 */
function UpcomingMeeting({ conversation }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = ['meetings', { client_id: conversation.id }];
  const { data: meetings = [] } = useQuery({ queryKey: key, queryFn: () => listMeetings({ client_id: conversation.id }) });
  const next = meetings.find((m) => m.scheduled_at && m.status === 'scheduled' && new Date(m.scheduled_at).getTime() > Date.now() - 60 * 60_000);
  const cancel = useMutation({
    mutationFn: () => endMeeting(next.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: key });
      toast.success('Reunião cancelada', 'Os lembretes automáticos foram cancelados. Avise o cliente, se precisar.');
    },
    onError: (err) => toast.error('Não foi possível cancelar', err.message),
  });
  const [confirming, setConfirming] = useState(false);
  if (!next) return null;
  const url = meetingUrl(next.code);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-neutral-800 bg-sky-950/30 px-4 py-2 text-xs text-sky-100">
      <CalendarClock className="size-4 shrink-0 text-sky-400" />
      <span className="min-w-0 flex-1">
        Reunião marcada: <strong className="font-semibold">{meetingWhen.format(new Date(next.scheduled_at))}</strong>
        {next.host_name && <span className="text-sky-300/80"> · com {next.host_name}</span>}
      </span>
      <a href={url} target="_blank" rel="noopener noreferrer" className="font-semibold text-sky-300 hover:text-white">Entrar</a>
      <button type="button" onClick={() => navigator.clipboard?.writeText(url).then(() => toast.success('Link copiado'))} className="font-semibold text-sky-300 hover:text-white">
        Copiar link
      </button>
      <button type="button" onClick={() => setConfirming(true)} className="font-semibold text-red-300 hover:text-red-200">
        Cancelar
      </button>
      <ConfirmDialog
        open={confirming}
        title="Cancelar esta reunião?"
        description="A sala fecha (o link deixa de funcionar) e ninguém recebe os lembretes. O cliente não é avisado automaticamente."
        confirmLabel="Cancelar reunião"
        tone="danger"
        loading={cancel.isPending}
        onConfirm={() => cancel.mutate(undefined, { onSettled: () => setConfirming(false) })}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}

function MessageBubble({ message, mine, onRetry }) {
  const outgoing = message.sender_type !== 'client';
  const isBot = message.sender_type === 'bot';
  return (
    <div className={cx('flex', outgoing ? 'justify-end' : 'justify-start')}>
      <div
        className={cx(
          'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm shadow-sm sm:max-w-[70%]',
          !outgoing && 'rounded-bl-md bg-[#232323] text-neutral-100 ring-1 ring-neutral-800',
          outgoing && !isBot && 'rounded-br-md bg-red-900/50 text-red-50 ring-1 ring-red-800/40',
          isBot && 'rounded-br-md bg-sky-950/60 text-sky-50 ring-1 ring-sky-900/60',
          message.failed && 'ring-2 ring-red-600',
        )}
      >
        {outgoing && !mine && (
          <p className={cx('mb-0.5 flex items-center gap-1 text-[11px] font-semibold', isBot ? 'text-sky-300' : 'text-red-300')}>
            {isBot && <Bot className="size-3" />}
            {/* bot com sender_user = mensagem automática disparada por alguém (ex.: confirmação de reunião). */}
            {isBot ? (message.sender_user_name ? `Automática · ${message.sender_user_name}` : 'IA') : message.sender_user_name ?? 'Equipe'}
          </p>
        )}
        <p className="break-words whitespace-pre-wrap">{message.content}</p>
        <p className="mt-1 flex items-center justify-end gap-1 text-[10px] text-neutral-400 tabular-nums">
          {timeFormat.format(new Date(message.created_at))}
          {message.pending && <Clock className="size-3" aria-label="A enviar" />}
          {outgoing && !message.pending && !message.failed && <AckTicks ack={message.ack} />}
        </p>
        {message.failed && (
          <button type="button" onClick={() => onRetry(message)} className="mt-1 flex items-center gap-1 text-xs font-semibold text-red-300 hover:text-red-200">
            <CircleAlert className="size-3.5" />
            Não enviada · Tentar de novo
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Sugestão da IA por cima do campo de mensagem. Nunca é enviada sozinha: "Usar" põe o texto no
 * campo para a pessoa rever/editar e enviar (com a assinatura dela).
 */
function AiSuggestionCard({ ai, onUse }) {
  const { suggestion, pending, requesting, onRequest, onDismiss } = ai;
  const busy = pending || requesting;

  if (!suggestion) {
    return (
      <button
        type="button"
        onClick={onRequest}
        disabled={busy}
        className="mb-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold text-sky-300 ring-1 ring-sky-900/70 transition hover:bg-sky-950/50 disabled:cursor-wait disabled:opacity-80"
      >
        {busy ? <RefreshCw className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
        {busy ? 'IA a preparar uma sugestão...' : 'Sugerir resposta com IA'}
      </button>
    );
  }

  const hint = AI_INTENT_HINTS[suggestion.intent];
  return (
    <div className="mb-2 rounded-xl bg-sky-950/40 p-2.5 ring-1 ring-sky-900/60" role="status">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-sky-300">
        <Sparkles className="size-3" />
        Sugestão da IA{hint && <span className="font-normal text-sky-400/80">· o cliente {hint}</span>}
        <button type="button" onClick={onDismiss} aria-label="Descartar sugestão" className="ml-auto rounded p-0.5 text-sky-400/70 hover:text-white">
          <X className="size-3.5" />
        </button>
      </div>
      {suggestion.reply ? (
        <p className="max-h-24 overflow-y-auto text-sm break-words whitespace-pre-wrap text-sky-50">{suggestion.reply}</p>
      ) : (
        <p className="text-xs text-sky-200/80">A IA não teve uma resposta segura para esta mensagem. Responda você mesmo.</p>
      )}
      <div className="mt-2 flex gap-2">
        {suggestion.reply && (
          <button type="button" onClick={() => onUse(suggestion.reply)} className="rounded-lg bg-sky-800/70 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-sky-700">
            Usar e editar
          </button>
        )}
        <button
          type="button"
          onClick={onRequest}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold text-sky-300 ring-1 ring-sky-900/70 transition hover:bg-sky-950/60 disabled:cursor-wait"
        >
          <RefreshCw className={cx('size-3', busy && 'animate-spin')} />
          {busy ? 'A gerar...' : 'Gerar outra'}
        </button>
      </div>
    </div>
  );
}

/**
 * `disabled` = histórico ainda a carregar (a mensagem provisória não teria onde entrar).
 * `signature`: o número é partilhado pela equipe, por isso cada envio sai com "*Nome*" no topo.
 * `ai`: sugestão da IA (null = IA desligada no servidor).
 * `initialText`: texto já no campo (ex.: abordagem vinda do "Chamar no WhatsApp").
 */
function Composer({ disabled, onSend, signature, ai, initialText = '' }) {
  const [text, setText] = useState(initialText);
  const ref = useRef(null);
  // Nex revê cada mensagem (sempre ligado): o envio só libera depois do pop-up dele aparecer.
  const nex = useNexReview(text);

  const applyNexVersion = (value) => {
    setText(value);
    nex.accept(value);
    requestAnimationFrame(() => {
      const el = ref.current;
      el?.focus();
      el?.setSelectionRange(value.length, value.length);
    });
  };

  const applySuggestion = (reply) => {
    setText(reply);
    ai.onDismiss();
    requestAnimationFrame(() => {
      const el = ref.current;
      el?.focus();
      el?.setSelectionRange(reply.length, reply.length);
    });
  };

  // Cresce com o texto até ~6 linhas; depois faz scroll.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const trimmed = text.trim();
  const tooLong = text.length > MAX_LENGTH;

  const submit = (event) => {
    event?.preventDefault();
    if (!trimmed || tooLong || disabled) return;
    if (!nex.ready) return nex.reviewNow(); // Enter antes da revisão: pede-a já, não envia
    onSend(trimmed);
    nex.reset();
    setText('');
    ref.current?.focus();
  };

  return (
    <form onSubmit={submit} className="flex items-end gap-2 border-t border-neutral-800 bg-[#141414] p-3">
      <div className="min-w-0 flex-1">
        {ai && <AiSuggestionCard ai={ai} onUse={applySuggestion} />}
        <NexReviewCard nex={nex} text={text} onUse={applyNexVersion} />
        {signature && (
          <p className="mb-1.5 text-[11px] text-neutral-500">
            Suas mensagens chegam ao cliente assinadas como <strong className="font-semibold text-neutral-300">*{signature}*</strong>
          </p>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter envia; Shift+Enter quebra a linha. isComposing: não enviar a meio de um acento/IME.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
          }}
          disabled={disabled}
          aria-label="Mensagem"
          placeholder={disabled ? 'A carregar a conversa...' : 'Escreva uma mensagem'}
          className={cx(inputClass, 'block h-auto min-h-10 resize-none py-2.5 leading-5', tooLong && 'border-red-700')}
        />
        {text.length > MAX_LENGTH - 500 && (
          <p className={cx('mt-1 text-right text-[11px] tabular-nums', tooLong ? 'text-red-400' : 'text-neutral-500')}>
            {text.length}/{MAX_LENGTH}
          </p>
        )}
      </div>
      <button
        type="submit"
        disabled={disabled || !trimmed || tooLong || !nex.ready}
        aria-label="Enviar mensagem"
        title={trimmed && !nex.ready ? 'Aguarde a revisão do Nex' : 'Enviar (Enter)'}
        className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-red-800 text-white shadow-lg shadow-red-950/40 ring-1 ring-red-600/30 transition hover:bg-red-700 active:scale-95 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500 disabled:shadow-none disabled:ring-0"
      >
        <SendHorizontal className="size-4" />
      </button>
    </form>
  );
}

/**
 * Sugestão da IA da conversa aberta. Só vale para a última mensagem (`for_message_id`): chegou
 * ou saiu outra, deixa de aparecer. Chega pelo socket (ai:suggestion) ou pelo botão.
 */
function useAiSuggestion({ clientId, enabled, lastMessageId, suggesting }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState(null); // created_at da sugestão descartada

  const query = useQuery({
    queryKey: ['ai-suggestion', clientId],
    queryFn: () => getAiSuggestion(clientId),
    enabled,
    staleTime: Infinity, // atualizações chegam pelo socket
  });
  const mutation = useMutation({
    mutationFn: () => requestAiSuggestion(clientId),
    onSuccess: (suggestion) => {
      queryClient.setQueryData(['ai-suggestion', clientId], (old) => ({ ...old, data: suggestion, meta: { enabled: true, pending: false } }));
      setDismissed(null);
    },
    onError: (err) => toast.error('Sem sugestão da IA', err.message),
  });

  if (!enabled) return null;
  const suggestion = query.data?.data;
  const fresh = suggestion && suggestion.for_message_id === lastMessageId && suggestion.created_at !== dismissed ? suggestion : null;
  return {
    suggestion: fresh,
    pending: suggesting || Boolean(query.data?.meta.pending && !suggestion),
    requesting: mutation.isPending,
    onRequest: () => mutation.mutate(),
    onDismiss: () => setDismissed(suggestion?.created_at ?? null),
  };
}

function ChatView({ conversation, waStatus, signature, aiEnabled, aiSuggesting, draft, onBack, onOpenConnect }) {
  const { user, isAdmin } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const clientId = conversation.id;

  const messages = useInfiniteQuery({
    queryKey: messagesKey(clientId),
    queryFn: ({ pageParam, signal }) => getClientMessages(clientId, { before: pageParam, signal }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.meta.next_before ?? undefined, // "next" = mais antigas
  });

  // pages[0] = as mais recentes; as seguintes, cada vez mais antigas.
  const list = useMemo(() => (messages.data ? [...messages.data.pages].reverse().flatMap((p) => p.data) : []), [messages.data]);
  const lastMessageId = list.at(-1)?.id ?? null;
  const ai = useAiSuggestion({ clientId, enabled: aiEnabled, lastMessageId, suggesting: aiSuggesting });

  // ---- Scroll: fica no fundo ao chegar mensagem (se já lá estava), preserva ao carregar antigas.
  const scrollRef = useRef(null);
  const atBottomRef = useRef(true);
  const restoreFromBottomRef = useRef(null);
  const lastIdRef = useRef(null);
  const [newBelow, setNewBelow] = useState(false);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setNewBelow(false);
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (restoreFromBottomRef.current !== null) {
      el.scrollTop = el.scrollHeight - restoreFromBottomRef.current;
      restoreFromBottomRef.current = null;
      return;
    }
    const last = list.at(-1);
    if (!last || last.id === lastIdRef.current) return;
    const first = lastIdRef.current === null;
    lastIdRef.current = last.id;
    const mine = last.pending || last.sender_user_id === user?.id;
    if (first || mine || atBottomRef.current) scrollToBottom();
    else setNewBelow(true);
  }, [list, user?.id]);

  const onScroll = () => {
    const el = scrollRef.current;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (atBottomRef.current) setNewBelow(false);
  };

  const loadOlder = () => {
    const el = scrollRef.current;
    restoreFromBottomRef.current = el.scrollHeight - el.scrollTop;
    messages.fetchNextPage();
  };

  // ---- Envio otimista: aparece na hora como "a enviar"; a confirmação troca pela real.
  const send = async (content, retryOf) => {
    const tempId = retryOf?.id ?? `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (retryOf) {
      updatePages(queryClient, clientId, (pages) =>
        pages.map((p) => ({ ...p, data: p.data.map((m) => (m.id === tempId ? { ...m, pending: true, failed: false } : m)) })),
      );
    } else {
      const temp = {
        id: tempId,
        client_id: clientId,
        sender_type: 'agent',
        content,
        sender_user_id: user?.id,
        sender_user_name: user?.name,
        created_at: new Date().toISOString(),
        pending: true,
      };
      updatePages(queryClient, clientId, ([latest, ...older]) => [{ ...latest, data: [...latest.data, temp] }, ...older]);
    }

    try {
      const { data: message, meta } = await sendClientMessage(clientId, content);
      // O socket pode ter entregado a real antes desta resposta: nesse caso só some a provisória.
      updatePages(queryClient, clientId, (pages) =>
        pages.map((p) => ({
          ...p,
          data: hasMessage(pages, message.id)
            ? p.data.filter((m) => m.id !== tempId)
            : p.data.map((m) => (m.id === tempId ? message : m)),
        })),
      );
      bumpConversation(queryClient, meta.client, message);
    } catch (err) {
      if (err.status === 401) return;
      updatePages(queryClient, clientId, (pages) =>
        pages.map((p) => ({ ...p, data: p.data.map((m) => (m.id === tempId ? { ...m, pending: false, failed: true } : m)) })),
      );
      toast.error('Mensagem não enviada', err.message);
    }
  };

  const canSend = waStatus === 'ready';
  let rendered = [];
  let previousDay = null;
  for (const message of list) {
    const day = startOfDay(message.created_at);
    if (day !== previousDay) {
      rendered.push(
        <div key={`day-${day}`} className="sticky top-2 z-10 flex justify-center py-2">
          <span className="rounded-full bg-[#1f1f1f]/95 px-3 py-1 text-[11px] font-medium text-neutral-400 shadow ring-1 ring-neutral-800 backdrop-blur">
            {dayLabel(message.created_at)}
          </span>
        </div>,
      );
      previousDay = day;
    }
    rendered.push(<MessageBubble key={message.id} message={message} mine={message.sender_user_id === user?.id} onRetry={(m) => send(m.content, m)} />);
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={`Conversa com ${conversation.name}`}>
      <header className="flex items-center gap-3 border-b border-neutral-800 bg-[#1a1a1a] px-3 py-2.5 sm:px-4">
        <button type="button" onClick={onBack} aria-label="Voltar às conversas" className="-ml-1 rounded-lg p-1.5 text-neutral-400 transition hover:bg-neutral-800 hover:text-white md:hidden">
          <ArrowLeft className="size-5" />
        </button>
        <Avatar name={conversation.name} id={conversation.id} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-white">{conversation.name}</p>
          <p className="truncate text-xs text-neutral-500">
            {[conversation.phone, conversation.company !== conversation.name && conversation.company, conversation.responsible_name && `Resp.: ${conversation.responsible_name}`]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <ClientStatusSelect conversation={conversation} />
        {isAdmin && <ResponsibleSelect conversation={conversation} />}
        <VideoCallButton conversation={conversation} canSend={canSend} />
      </header>
      <UpcomingMeeting conversation={conversation} />

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-full space-y-1.5 overflow-y-auto bg-[#111111] bg-[radial-gradient(ellipse_70%_50%_at_50%_0%,rgba(127,29,29,0.10),transparent)] px-3 py-3 sm:px-6"
        >
          {messages.isError ? (
            <ErrorState error={messages.error} onRetry={messages.refetch} />
          ) : messages.isLoading ? (
            <Spinner label="A carregar mensagens..." />
          ) : list.length === 0 ? (
            <EmptyState icon={MessagesSquare} title="Ainda não há mensagens" description={canSend ? 'Escreva abaixo para iniciar a conversa pelo WhatsApp.' : 'As mensagens deste cliente aparecem aqui.'} />
          ) : (
            <>
              {messages.hasNextPage && (
                <div className="flex justify-center pb-2">
                  <Button variant="ghost" size="sm" loading={messages.isFetchingNextPage} onClick={loadOlder}>
                    Carregar mensagens anteriores
                  </Button>
                </div>
              )}
              {rendered}
            </>
          )}
        </div>
        {newBelow && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-red-800 px-3 py-1.5 text-xs font-semibold text-white shadow-lg shadow-black/50 transition hover:bg-red-700"
          >
            <ArrowDown className="size-3.5" />
            Novas mensagens
          </button>
        )}
      </div>

      {canSend ? (
        <Composer
          key={clientId}
          disabled={!messages.data}
          signature={signature}
          ai={list.length ? ai : null} // sem mensagens não há o que responder
          initialText={draft}
          onSend={(content) => send(content)}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-800 bg-[#141414] px-4 py-3">
          <p className="flex items-center gap-2 text-sm text-neutral-400">
            <WifiOff className="size-4 shrink-0 text-amber-400" />
            {waStatus === 'disabled'
              ? 'A integração com o WhatsApp está desligada no servidor.'
              : isAdmin
                ? 'O WhatsApp da empresa não está conectado.'
                : 'O WhatsApp da empresa não está conectado. Peça ao admin para ler o QR Code.'}
          </p>
          {isAdmin && waStatus !== 'disabled' && (
            <Button size="sm" icon={QrCode} onClick={onOpenConnect}>Conectar WhatsApp</Button>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default function AttendancePage() {
  const { user, isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const realtime = useSocketConnected();
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim());
  // "Chamar no WhatsApp" (Prospecção/Triagem): abre já essa conversa com a abordagem no campo.
  const [initialChat] = useState(peekPendingChat);
  useEffect(() => clearPendingChat(), []);
  const [selected, setSelected] = useState(() => initialChat?.conversation ?? null);
  const [unread, setUnread] = useState({}); // não lidas nesta sessão, por cliente
  const [liveWaStatus, setLiveWaStatus] = useState(null);
  const [aiSuggesting, setAiSuggesting] = useState({}); // clientId → a IA está a preparar uma sugestão
  const [connectOpen, setConnectOpen] = useState(false);
  // Admin escolhe "Ver tudo"/"Foco"; os demais veem sempre só as suas empresas (o servidor garante).
  const [adminScope, setAdminScope] = useState(readScope);
  const scope = isAdmin ? adminScope : 'mine';
  const changeScope = (next) => {
    setAdminScope(next);
    saveScope(next);
  };

  const conversations = useQuery({
    queryKey: ['conversations', { q, scope }],
    queryFn: () => listConversations({ q: q || undefined, scope: isAdmin ? scope : undefined }),
    placeholderData: keepPreviousData,
  });

  // O evento do socket é mais recente que o meta da lista; sem evento, vale o meta.
  const waStatus = liveWaStatus ?? conversations.data?.meta.whatsapp.status ?? 'disabled';
  const meta = conversations.data?.meta;

  // Mantém a conversa aberta com os dados mais recentes da lista (nome, responsável...).
  const selectedId = selected?.id ?? null;
  const fresh = conversations.data?.data.find((c) => c.id === selectedId);
  const current = fresh ?? selected;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  useSocketEvent('new_message', ({ message, client }) => {
    upsertMessage(queryClient, client.id, message);
    bumpConversation(queryClient, client, message);
    // O admin recebe tudo; no Foco só contam as conversas atribuídas a ele.
    const visible = scopeRef.current === 'all' || client.responsible_id === user?.id;
    if (visible && client.id !== selectedIdRef.current && message.sender_type === 'client') {
      setUnread((u) => ({ ...u, [client.id]: (u[client.id] ?? 0) + 1 }));
    }
  });
  useSocketEvent('message_ack', ({ client_id: clientId, message_id: messageId, ack }) => patchMessageAck(queryClient, clientId, messageId, ack));
  useSocketEvent('whatsapp:status', ({ status }) => setLiveWaStatus(status));
  // IA a preparar uma sugestão (≈10–20s na CPU do servidor): aviso na lista e no chat.
  useSocketEvent('ai:suggesting', ({ client_id: clientId, on }) => setAiSuggesting((s) => ({ ...s, [clientId]: on })));
  useSocketEvent('ai:suggestion', ({ client_id: clientId, suggestion }) =>
    queryClient.setQueryData(['ai-suggestion', clientId], { data: suggestion, meta: { enabled: true, pending: false } }),
  );
  // Religou: podem ter-se perdido eventos enquanto esteve em baixo. Recarrega do servidor.
  useSocketEvent('connect', () => {
    setLiveWaStatus(null);
    queryClient.invalidateQueries({ queryKey: ['conversations'] });
    queryClient.invalidateQueries({ queryKey: ['messages'] });
    queryClient.invalidateQueries({ queryKey: ['ai-suggestion'] });
  });

  const select = (conversation) => {
    setSelected(conversation);
    setUnread((u) => (u[conversation.id] ? { ...u, [conversation.id]: 0 } : u));
  };

  // Notificação tocada (#/atendimento?c=<id>): abre essa conversa assim que a lista a tiver.
  const [targetId, setTargetId] = useState(readTargetConversation);
  useEffect(() => {
    const onHash = () => {
      const id = readTargetConversation();
      if (id) setTargetId(id);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (!targetId) return;
    const row = conversations.data?.data.find((c) => c.id === targetId);
    if (!row) return;
    select(row);
    setTargetId(null);
    window.history.replaceState(null, '', '#/atendimento'); // F5 não reabre a mesma
  }, [targetId, conversations.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Não lidas no título da aba: quem está noutra aba vê que chegou mensagem.
  const totalUnread = Object.values(unread).reduce((sum, n) => sum + n, 0);
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\+?\)\s*/, '');
    document.title = totalUnread ? `(${totalUnread > 99 ? '99+' : totalUnread}) ${base}` : base;
    return () => {
      document.title = document.title.replace(/^\(\d+\+?\)\s*/, '');
    };
  }, [totalUnread]);

  const openConnect = isAdmin ? () => setConnectOpen(true) : undefined;

  return (
    <>
      {/* Altura do ecrã menos o cabeçalho do telemóvel / o padding do desktop: o chat não faz a página rolar. */}
      <div className="flex h-[calc(100dvh-10.5rem)] min-h-[26rem] overflow-hidden rounded-2xl border border-neutral-800 bg-[#161616] shadow-2xl shadow-black/30 lg:h-[calc(100dvh-3rem)]">
        <Sidebar
          hidden={Boolean(current)}
          search={search}
          onSearch={setSearch}
          query={conversations}
          selectedId={selectedId}
          unread={unread}
          onSelect={select}
          waStatus={waStatus}
          onOpenConnect={openConnect}
          realtime={realtime}
          aiSuggesting={aiSuggesting}
          scope={scope}
          onScopeChange={isAdmin ? changeScope : undefined}
        />
        {current ? (
          <ChatView
            key={current.id}
            conversation={current}
            waStatus={waStatus}
            signature={meta?.signature ?? null}
            aiEnabled={Boolean(meta?.ai?.enabled)}
            aiSuggesting={Boolean(aiSuggesting[current.id])}
            draft={current.id === initialChat?.conversation.id ? initialChat.draft : undefined}
            onBack={() => setSelected(null)}
            onOpenConnect={openConnect}
          />
        ) : (
          <div className="hidden flex-1 flex-col items-center justify-center gap-3 bg-[#111111] p-8 text-center md:flex">
            <span className="flex size-16 items-center justify-center rounded-2xl bg-red-950/40 ring-1 ring-red-900/50">
              <MessagesSquare className="size-8 text-red-500" />
            </span>
            <p className="text-lg font-semibold text-white">Central de Atendimento</p>
            <p className="max-w-sm text-sm text-neutral-500">
              Escolha uma conversa à esquerda. As mensagens do WhatsApp da empresa chegam aqui em tempo real.
            </p>
            {isAdmin && waStatus !== 'ready' && waStatus !== 'disabled' && (
              <Button icon={QrCode} onClick={openConnect} className="mt-2">Conectar WhatsApp</Button>
            )}
          </div>
        )}
      </div>

      {isAdmin && <WhatsAppConnectModal open={connectOpen} onClose={() => setConnectOpen(false)} />}
    </>
  );
}
