import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, Bot, Check, CircleAlert, Clock, Headset, MessagesSquare, QrCode, Search, SendHorizontal, Video, WifiOff } from 'lucide-react';
import { createMeeting, getClientMessages, listConversations, meetingUrl, sendClientMessage, setBotStatus } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useDebouncedValue } from '../lib/hooks.js';
import { useSocketConnected, useSocketEvent } from '../lib/socket.js';
import { useToast } from '../components/toast.jsx';
import { AI_HANDOFF_REASONS } from '../lib/labels.js';
import { WhatsAppConnectModal, WhatsAppStatusPill } from '../components/WhatsAppConnect.jsx';
import { Avatar, Button, ConfirmDialog, EmptyState, ErrorState, Spinner, cx, inputClass } from '../components/ui.jsx';

/**
 * Central de Atendimento: conversas do WhatsApp da empresa, estilo WhatsApp Web.
 *
 * Dados: lista em ['conversations', q] e mensagens em ['messages', clientId] (paginadas para
 * trás). Tempo real pelo Socket.io: `new_message` atualiza as duas caches na hora, tanto para
 * mensagens recebidas como para as enviadas por outra pessoa (ou noutra aba). Ao religar o
 * socket, recarrega tudo (pode ter perdido eventos enquanto esteve em baixo).
 */

const MAX_LENGTH = 4096; // limite do backend (e do WhatsApp) por mensagem

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

function ConversationItem({ conversation, active, unread, aiTyping, onSelect }) {
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
            {aiTyping ? (
              <span className="min-w-0 flex-1 truncate text-xs text-emerald-400 italic">🤖 IA a escrever...</span>
            ) : (
              <span className={cx('min-w-0 flex-1 truncate text-xs', unread ? 'text-neutral-200' : 'text-neutral-500')}>{lastPreview(conversation)}</span>
            )}
            {!conversation.bot_active && (
              <Headset className="size-3.5 shrink-0 text-amber-400/80" aria-label="Atendimento humano" />
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

function Sidebar({ hidden, search, onSearch, query, selectedId, unread, onSelect, waStatus, onOpenConnect, realtime, aiTyping }) {
  const conversations = query.data?.data ?? [];
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
            description={search ? 'Tente outro nome ou telefone.' : 'Clientes com telefone aparecem aqui. Quem escrever para o WhatsApp da empresa também.'}
          />
        ) : (
          <ul className={cx('divide-y divide-neutral-800/60 transition-opacity', query.isFetching && query.isPlaceholderData && 'opacity-60')}>
            {conversations.map((c) => (
              <ConversationItem key={c.id} conversation={c} active={c.id === selectedId} unread={unread[c.id] ?? 0} aiTyping={Boolean(aiTyping[c.id])} onSelect={onSelect} />
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
 * Videochamada na plataforma: cria a sala, envia o link ao cliente pelo WhatsApp (fica no
 * histórico como mensagem da equipe) e abre a sala para quem clicou.
 */
function VideoCallButton({ conversation, canSend }) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    // Abre a aba JÁ, no clique: depois de esperar pela API o navegador bloquearia o pop-up.
    const win = window.open('', '_blank');
    setBusy(true);
    try {
      const meeting = await createMeeting({ client_id: conversation.id });
      const url = meetingUrl(meeting.code);
      if (win) win.location.href = url;
      else window.open(url, '_blank');
      if (canSend) {
        await sendClientMessage(
          conversation.id,
          `Olá! Vamos conversar por vídeo? É só abrir este link no celular ou no computador (não precisa instalar nada):\n${url}`,
        );
        toast.success('Videochamada iniciada', `Link enviado a ${conversation.name} pelo WhatsApp.`);
      } else {
        await navigator.clipboard?.writeText(url).catch(() => {});
        toast.info('Sala criada: link copiado', 'O WhatsApp está desconectado: envie o link ao cliente por outro meio.');
      }
      setConfirming(false);
    } catch (err) {
      win?.close();
      toast.error('Não foi possível iniciar a videochamada', err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        title="Videochamada na plataforma (envia o link ao cliente)"
        aria-label="Iniciar videochamada"
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-neutral-300 ring-1 ring-neutral-700 transition hover:bg-neutral-800 hover:text-white"
      >
        <Video className="size-4" />
      </button>
      <ConfirmDialog
        open={confirming}
        tone="primary"
        title={`Videochamada com ${conversation.name}?`}
        description={
          canSend
            ? 'Vamos criar a sala, enviar o link ao cliente pelo WhatsApp e abri-la para você numa nova aba.'
            : 'O WhatsApp está desconectado: criamos a sala e copiamos o link para você enviar por outro meio.'
        }
        confirmLabel="Iniciar videochamada"
        loading={busy}
        onConfirm={start}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}

/**
 * "Assumir atendimento" (manual override de clients.bot_active), no cabeçalho do chat.
 *  - Verde "Bot Ativo": a IA pode responder a este cliente. Clicar = o humano assume.
 *  - Vermelho "Assumido por Humano": a IA fica calada. Clicar = devolve à IA.
 * É o sinal que a futura IA consulta antes de responder, para não atropelar o vendedor.
 * Enviar uma mensagem pela Central também passa para "Humano" (no servidor).
 */
function BotStatusToggle({ conversation }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const botActive = Boolean(conversation.bot_active);

  const mutation = useMutation({
    mutationFn: (next) => setBotStatus(conversation.id, next),
    // Otimista: o botão muda de cor no clique; volta atrás se o servidor recusar.
    onMutate: (next) => patchConversation(queryClient, conversation.id, { bot_active: next }),
    onSuccess: (client) => {
      patchConversation(queryClient, client.id, { bot_active: client.bot_active });
      toast.success(client.bot_active ? 'Atendimento devolvido ao bot' : 'Você assumiu o atendimento', client.name);
    },
    onError: (err, next) => {
      patchConversation(queryClient, conversation.id, { bot_active: !next });
      toast.error('Não foi possível alterar o atendimento', err.message);
    },
  });

  const Icon = botActive ? Bot : Headset;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={botActive}
      aria-label={botActive ? 'Bot ativo. Clique para assumir o atendimento.' : 'Assumido por humano. Clique para devolver ao bot.'}
      title={botActive ? 'Clique para assumir: o bot deixa de responder a este cliente' : 'Clique para devolver o atendimento ao bot'}
      disabled={mutation.isPending}
      onClick={() => mutation.mutate(!botActive)}
      className={cx(
        'group inline-flex h-9 shrink-0 items-center gap-2 rounded-full py-1 pr-3 pl-1 text-xs font-semibold ring-1 transition active:scale-[0.97] disabled:cursor-wait disabled:opacity-70',
        botActive
          ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40 hover:bg-emerald-500/25'
          : 'bg-red-500/15 text-red-300 ring-red-500/40 hover:bg-red-500/25',
      )}
    >
      {/* Trilho do interruptor: a bolinha fica à direita com o bot ativo. */}
      <span className={cx('relative h-7 w-12 rounded-full transition-colors', botActive ? 'bg-emerald-600' : 'bg-red-700')}>
        <span
          className={cx(
            'absolute top-0.5 flex size-6 items-center justify-center rounded-full bg-white text-neutral-900 shadow transition-all',
            botActive ? 'left-[calc(100%-1.625rem)]' : 'left-0.5',
          )}
        >
          <Icon className="size-3.5" />
        </span>
      </span>
      <span className="whitespace-nowrap">
        <span className="sm:hidden">{botActive ? 'Bot' : 'Humano'}</span>
        <span className="hidden sm:inline">{botActive ? 'Bot Ativo' : 'Assumido por Humano'}</span>
      </span>
    </button>
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
          {outgoing && !message.pending && !message.failed && <Check className="size-3" aria-label="Enviada" />}
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

/** `disabled` = histórico ainda a carregar (a mensagem provisória não teria onde entrar). */
function Composer({ disabled, onSend }) {
  const [text, setText] = useState('');
  const ref = useRef(null);

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
    onSend(trimmed);
    setText('');
    ref.current?.focus();
  };

  return (
    <form onSubmit={submit} className="flex items-end gap-2 border-t border-neutral-800 bg-[#141414] p-3">
      <div className="min-w-0 flex-1">
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
        disabled={disabled || !trimmed || tooLong}
        aria-label="Enviar mensagem"
        title="Enviar (Enter)"
        className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-red-800 text-white shadow-lg shadow-red-950/40 ring-1 ring-red-600/30 transition hover:bg-red-700 active:scale-95 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500 disabled:shadow-none disabled:ring-0"
      >
        <SendHorizontal className="size-4" />
      </button>
    </form>
  );
}

function ChatView({ conversation, waStatus, aiTyping, onBack, onOpenConnect }) {
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

  // O balão "IA a escrever" entra no fim da conversa: se já estava no fundo, acompanha-o.
  useLayoutEffect(() => {
    if (aiTyping && atBottomRef.current) scrollToBottom();
  }, [aiTyping]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <VideoCallButton conversation={conversation} canSend={canSend} />
        <BotStatusToggle conversation={conversation} />
      </header>

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
              {aiTyping && (
                <div className="flex justify-end" role="status">
                  <span className="flex items-center gap-2 rounded-2xl rounded-br-md bg-sky-950/60 px-3.5 py-2 text-xs text-sky-200 ring-1 ring-sky-900/60">
                    <Bot className="size-3.5" />
                    IA a escrever
                    <span className="flex gap-0.5" aria-hidden="true">
                      {[0, 150, 300].map((delay) => (
                        <span key={delay} className="size-1 animate-bounce rounded-full bg-sky-300" style={{ animationDelay: `${delay}ms` }} />
                      ))}
                    </span>
                  </span>
                </div>
              )}
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
        <Composer key={clientId} disabled={!messages.data} onSend={(content) => send(content)} />
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
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const realtime = useSocketConnected();
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim());
  const [selected, setSelected] = useState(null);
  const [unread, setUnread] = useState({}); // não lidas nesta sessão, por cliente
  const [liveWaStatus, setLiveWaStatus] = useState(null);
  const [aiTyping, setAiTyping] = useState({}); // clientId → a IA está a gerar resposta
  const toast = useToast();
  const [connectOpen, setConnectOpen] = useState(false);

  const conversations = useQuery({
    queryKey: ['conversations', { q }],
    queryFn: () => listConversations({ q: q || undefined }),
    placeholderData: keepPreviousData,
  });

  // O evento do socket é mais recente que o meta da lista; sem evento, vale o meta.
  const waStatus = liveWaStatus ?? conversations.data?.meta.whatsapp.status ?? 'disabled';

  // Mantém a conversa aberta com os dados mais recentes da lista (bot_active, nome...).
  const selectedId = selected?.id ?? null;
  const fresh = conversations.data?.data.find((c) => c.id === selectedId);
  const current = fresh ?? selected;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  useSocketEvent('new_message', ({ message, client }) => {
    upsertMessage(queryClient, client.id, message);
    bumpConversation(queryClient, client, message);
    if (client.id !== selectedIdRef.current && message.sender_type === 'client') {
      setUnread((u) => ({ ...u, [client.id]: (u[client.id] ?? 0) + 1 }));
    }
  });
  useSocketEvent('whatsapp:status', ({ status }) => setLiveWaStatus(status));
  // IA a gerar a resposta (≈10–15s na CPU do servidor): mostra "a escrever" na lista e no chat.
  useSocketEvent('ai:typing', ({ client_id: clientId, typing }) => setAiTyping((t) => ({ ...t, [clientId]: typing })));
  // A IA passou a conversa a um humano: avisa quem a vê (o responsável e os admins).
  useSocketEvent('ai:handoff', ({ client, reason, intent }) => {
    patchConversation(queryClient, client.id, { bot_active: false });
    toast.info(`A IA passou ${client.name} para atendimento humano`, AI_HANDOFF_REASONS[reason]?.(intent) ?? '');
  });
  // Outro operador assumiu/devolveu a conversa: o botão muda aqui também, na hora.
  useSocketEvent('client:bot_status', ({ client }) => patchConversation(queryClient, client.id, { bot_active: client.bot_active }));
  // Religou: podem ter-se perdido eventos enquanto esteve em baixo. Recarrega do servidor.
  useSocketEvent('connect', () => {
    setLiveWaStatus(null);
    queryClient.invalidateQueries({ queryKey: ['conversations'] });
    queryClient.invalidateQueries({ queryKey: ['messages'] });
  });

  const select = (conversation) => {
    setSelected(conversation);
    setUnread((u) => (u[conversation.id] ? { ...u, [conversation.id]: 0 } : u));
  };

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
          aiTyping={aiTyping}
        />
        {current ? (
          <ChatView
            key={current.id}
            conversation={current}
            waStatus={waStatus}
            aiTyping={Boolean(aiTyping[current.id])}
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
