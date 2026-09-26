/** Rótulos e cores de domínio, num só lugar. `tone` corresponde às variantes do <Badge>. */

export const ROLE_META = {
  admin: { label: 'Admin', tone: 'red', description: 'Acesso total, gere a equipa' },
  partner: { label: 'Parceiro', tone: 'amber', description: 'Gere clientes, chamados e o quadro' },
  agent: { label: 'Agente', tone: 'sky', description: 'Trabalha os próprios clientes e chamados' },
};

export const CLIENT_STATUS_META = {
  lead: { label: 'Lead', tone: 'sky' },
  active: { label: 'Ativo', tone: 'emerald' },
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
  { id: 'lead', label: 'Lead', dot: 'bg-neutral-400', probability: 0.1 },
  { id: 'qualification', label: 'Qualificação', dot: 'bg-sky-400', probability: 0.25 },
  { id: 'proposal', label: 'Proposta', dot: 'bg-indigo-400', probability: 0.5 },
  { id: 'negotiation', label: 'Negociação', dot: 'bg-amber-400', probability: 0.75 },
  { id: 'won', label: 'Fechado', dot: 'bg-emerald-400', probability: 1 },
  { id: 'lost', label: 'Perdido', dot: 'bg-red-500', probability: 0 },
];
export const DEAL_STAGE_META = Object.fromEntries(DEAL_STAGES.map((s) => [s.id, s]));
export const OPEN_DEAL_STAGES = DEAL_STAGES.filter((s) => s.id !== 'won' && s.id !== 'lost');

export const TRIAGE_STATUS_META = {
  pending: { label: 'Na fila', tone: 'sky' },
  qualified: { label: 'Qualificado', tone: 'emerald' },
  on_hold: { label: 'Em espera', tone: 'amber' },
  discarded: { label: 'Descartado', tone: 'neutral' },
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

/** Texto humano de uma entrada do histórico (activity_logs). */
export function describeActivity(log) {
  const d = log.details ?? {};
  const stage = (id) => DEAL_STAGE_META[id]?.label ?? id;
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
      return { title: `fechou o negócio (${stage(d.from)} → Fechado)`, body: d.value ? formatCurrency(d.value) : null, kind: 'won' };
    case 'deal.lost':
      return { title: 'marcou o negócio como perdido', body: d.lost_reason ? `Motivo: ${d.lost_reason}` : null, kind: 'lost' };
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
