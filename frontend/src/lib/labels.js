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
