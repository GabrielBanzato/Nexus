/** Rótulos e cores de domínio, num só lugar. `tone` corresponde às variantes do <Badge>. */

export const ROLE_META = {
  admin: { label: 'Admin', tone: 'red', description: 'Acesso total, gere a equipe' },
  partner: { label: 'Parceiro', tone: 'amber', description: 'Gere clientes, chamados e o quadro' },
  agent: { label: 'Agente', tone: 'sky', description: 'Trabalha os próprios clientes e chamados' },
};

/** Estado de um contacto. active = cliente de verdade (aparece na aba Clientes). */
export const CLIENT_STATUS_META = {
  lead: { label: 'Lead', tone: 'sky' },
  active: { label: 'Cliente', tone: 'emerald' },
  on_hold: { label: 'Em espera', tone: 'amber' },
  archived: { label: 'Arquivado', tone: 'neutral' },
};

export const TICKET_STATUS_META = {
  open: { label: 'Aberto', tone: 'sky' },
  in_progress: { label: 'Em progresso', tone: 'amber' },
  resolved: { label: 'Resolvido', tone: 'emerald' },
  closed: { label: 'Fechado', tone: 'neutral' },
};

export const PRIORITY_META = {
  urgent: { label: 'Urgente', tone: 'red', bar: 'bg-red-500', rank: 0 },
  high: { label: 'Alta', tone: 'amber', bar: 'bg-amber-500', rank: 1 },
  medium: { label: 'Média', tone: 'sky', bar: 'bg-sky-500', rank: 2 },
  low: { label: 'Baixa', tone: 'neutral', bar: 'bg-neutral-600', rank: 3 },
};

export const KANBAN_COLUMNS = [
  { id: 'todo', label: 'A Fazer', dot: 'bg-neutral-400' },
  { id: 'in_progress', label: 'Em Progresso', dot: 'bg-amber-400' },
  { id: 'review', label: 'Em Revisão', dot: 'bg-sky-400' },
  { id: 'done', label: 'Concluído', dot: 'bg-emerald-400' },
];

// --- CRM comercial ----------------------------------------------------------

export const DEAL_STAGES = [
  { id: 'lead', label: 'Triagem/Novo', dot: 'bg-sky-400', probability: 0.1 },
  { id: 'meeting', label: 'Reunião Agendada', dot: 'bg-fuchsia-400', probability: 0.25 },
  { id: 'negotiation', label: 'Em Negociação', dot: 'bg-amber-400', probability: 0.4 },
  { id: 'awaiting', label: 'Aguardando Resposta', dot: 'bg-violet-400', probability: 0.6 },
  { id: 'won', label: 'Cliente Fechado', dot: 'bg-emerald-400', probability: 1 },
  { id: 'lost', label: 'Perdido', dot: 'bg-red-500', probability: 0 },
];
export const DEAL_STAGE_META = Object.fromEntries(DEAL_STAGES.map((s) => [s.id, s]));
// Estágios antigos (antes da migração) ainda aparecem no histórico de auditoria.
const LEGACY_STAGE_LABELS = { qualification: 'Qualificação', proposal: 'Proposta' };
export const OPEN_DEAL_STAGES = DEAL_STAGES.filter((s) => s.id !== 'won' && s.id !== 'lost');
/** Estágios onde se entra sem dados extra. "Reunião Agendada" exige data/hora (modal de agendamento). */
export const DIRECT_DEAL_STAGES = OPEN_DEAL_STAGES.filter((s) => s.id !== 'meeting');

const meetingDateTime = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
/** "qui., 01/10, 14:30" (no fuso de quem vê). */
export const formatMeetingAt = (value) => (value ? meetingDateTime.format(new Date(value)) : '');

export const TRIAGE_STATUS_META = {
  pending: { label: 'Na fila', tone: 'sky' },
  qualified: { label: 'Qualificado', tone: 'emerald' },
  on_hold: { label: 'Em espera', tone: 'amber' },
  discarded: { label: 'Descartado', tone: 'neutral' },
  // Vista, não estado: arquivado mantém o estado original (ver lead_triage.archived_at).
  archived: { label: 'Arquivado', tone: 'neutral' },
};

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const brlCompact = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 });
export const formatCurrency = (value) => brl.format(Number(value) || 0);
/** R$ 12,5 mil / R$ 1,2 mi — para cabeçalhos e eixos. */
export const formatCurrencyCompact = (value) => (Math.abs(Number(value)) >= 10_000 ? brlCompact.format(Number(value)) : brl.format(Number(value) || 0));
/** "12.500,50" / "12500" / "R$ 4.500" → número. Ponto seguido de 3 dígitos = milhar. */
export const parseMoney = (text) =>
  Number(String(text ?? '').replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')) || 0;
export const formatPercent =(value) => (value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`);

const AI_INTENT_LABELS = {
  preco: 'pediu preço/orçamento',
  agendar_reuniao: 'quer marcar uma conversa',
  suporte: 'precisa de suporte',
  reclamacao: 'fez uma reclamação',
};
/** Porque é que a IA passou a conversa a um humano (backend: services/aiAgent.js). */
export const AI_HANDOFF_REASONS = {
  intencao: (intent) => `o cliente ${AI_INTENT_LABELS[intent] ?? 'precisa de atendimento humano'}`,
  mensagem_nao_texto: () => 'o cliente mandou áudio/imagem (a IA não os entende)',
  resposta_bloqueada: () => 'a IA não teve uma resposta segura para dar',
  limite_respostas: () => 'muitas mensagens seguidas com a IA',
  falha_ia: () => 'a IA está indisponível',
};

/** Texto humano de uma entrada do histórico (activity_logs). */
export function describeActivity(log) {
  const d = log.details ?? {};
  const stage = (id) => DEAL_STAGE_META[id]?.label ?? LEGACY_STAGE_LABELS[id] ?? id;
  switch (log.action) {
    case 'note':
      return { title: 'adicionou uma nota', body: d.text, kind: 'note' };
    case 'deal.create':
      return { title: `criou o negócio "${d.title}"`, body: d.value ? formatCurrency(d.value) : null, kind: 'deal' };
    case 'deal.update':
      return { title: 'atualizou o negócio', body: Object.keys(d).map((k) => FIELD_LABELS[k] ?? k).join(', '), kind: 'edit' };
    case 'deal.stage':
      return { title: `moveu de ${stage(d.from)} para ${stage(d.to)}`, kind: 'move' };
    case 'deal.won':
      return { title: `fechou o negócio (${stage(d.from)} → Cliente Fechado)`, body: d.value ? formatCurrency(d.value) : null, kind: 'won' };
    case 'deal.lost':
      return { title: 'marcou o negócio como perdido', body: d.lost_reason ? `Motivo: ${d.lost_reason}` : null, kind: 'lost' };
    case 'deal.meeting':
      return {
        title: `agendou reunião para ${formatMeetingAt(d.meeting_at)}`,
        body: d.notified ? 'Confirmação enviada ao cliente pelo WhatsApp.' : d.reason === 'SKIPPED' ? null : 'Confirmação por WhatsApp não enviada.',
        kind: 'move',
      };
    case 'meeting.schedule':
      return {
        title: `agendou videochamada para ${formatMeetingAt(d.scheduled_at)}`,
        body: d.notified ? 'Confirmação enviada ao cliente pelo WhatsApp; lembretes no dia e 1h antes.' : null,
        kind: 'move',
      };
    case 'client.human_takeover':
      return { title: 'assumiu o atendimento no WhatsApp (IA pausada)', kind: 'edit' };
    case 'client.bot_resumed':
      return { title: 'devolveu o atendimento à IA', kind: 'edit' };
    case 'ai.handoff':
      return { title: `A IA passou a conversa para um humano: ${AI_HANDOFF_REASONS[d.reason]?.(d.intent) ?? d.reason}`, kind: 'move' };
    case 'payment.record':
      return { title: `marcou a mensalidade de ${d.month?.split('-').reverse().join('/')} como paga`, body: d.amount != null ? formatCurrency(d.amount) : null, kind: 'won' };
    case 'payment.remove':
      return { title: `desmarcou o pagamento da mensalidade de ${d.month?.split('-').reverse().join('/')}`, kind: 'edit' };
    case 'deal.delete':
      return { title: `apagou o negócio "${d.title}"`, kind: 'delete' };
    case 'client.create':
      return { title: d.from_deal ? 'conquistou o cliente (negócio fechado)' : `registou o cliente ${d.name ?? ''}`, kind: 'won' };
    case 'client.update':
      return { title: 'atualizou o cliente', body: Object.keys(d).map((k) => FIELD_LABELS[k] ?? k).join(', '), kind: 'edit' };
    case 'ticket.create':
      return { title: `abriu o chamado "${d.title}"`, kind: 'ticket' };
    case 'ticket.update':
      return { title: 'atualizou o chamado', body: Object.keys(d).map((k) => FIELD_LABELS[k] ?? k).join(', '), kind: 'edit' };
    case 'ticket.delete':
      return { title: `apagou o chamado "${d.title}"`, kind: 'delete' };
    case 'triage.qualified':
      return { title: 'qualificou o lead na triagem', body: [d.score != null && `Pontuação ${d.score}/100`, d.notes].filter(Boolean).join(' · ') || null, kind: 'won' };
    case 'triage.on_hold':
      return { title: 'pôs o lead em espera', body: d.notes, kind: 'move' };
    case 'triage.discarded':
      return { title: 'descartou o lead', body: d.notes, kind: 'lost' };
    case 'triage.assign':
      return { title: d.assigned_to ? `atribuiu o lead a ${d.assigned_to}` : 'removeu o responsável do lead', kind: 'move' };
    case 'triage.requalify':
      return { title: d.reopened ? 'requalificou o lead (negócio perdido reaberto em Triagem/Novo)' : 'requalificou o lead (novo negócio em Triagem/Novo)', kind: 'won' };
    case 'triage.requeue':
      return { title: `devolveu o lead à fila (negócio "${d.title}" apagado do pipeline)`, kind: 'move' };
    case 'triage.archive':
      return { title: 'arquivou o lead na triagem', kind: 'delete' };
    case 'triage.restore':
      return { title: 'restaurou o lead arquivado', kind: 'move' };
    default:
      if (log.action.startsWith('ticket.status.')) {
        const status = log.action.split('.').pop();
        return { title: `mudou o estado para ${TICKET_STATUS_META[status]?.label ?? status}`, kind: status === 'resolved' || status === 'closed' ? 'won' : 'move' };
      }
      return { title: log.action, kind: 'edit' };
  }
}

const FIELD_LABELS = {
  title: 'título',
  value: 'valor',
  owner_id: 'responsável',
  responsible_id: 'responsável',
  assigned_to: 'atribuição',
  status: 'estado',
  priority: 'prioridade',
  company: 'empresa',
  contact_name: 'contacto',
  phone: 'telefone',
  email: 'email',
  name: 'nome',
  client_id: 'cliente',
  expected_close_date: 'previsão de fecho',
  pains: 'dores do cliente',
  proposal_offer: 'proposta real',
  bait: 'isca',
  final_proposal: 'proposta final',
  won_scope: 'sistema a fazer',
  delivery_due: 'prazo de entrega',
  monthly_value: 'mensalidade',
  monthly_start: 'início da mensalidade',
  monthly_end: 'fim da mensalidade',
};

const relative = new Intl.RelativeTimeFormat('pt-PT', { numeric: 'auto' });
const UNITS = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** "há 3 dias", "ontem", "agora mesmo". */
export function formatRelative(date) {
  if (!date) return '—';
  const seconds = (new Date(date).getTime() - Date.now()) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return 'agora mesmo';
}

export function formatDateTime(date) {
  if (!date) return '—';
  return new Date(date).toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short' });
}
