import { formatCurrency, formatCurrencyCompact } from './labels.js';

/** Métricas das metas (backend: repositories/goalRepository.js). */
export const GOAL_METRICS = {
  won_value: { label: 'Valor vendido', short: 'vendido', money: true },
  won_count: { label: 'Vendas fechadas', unit: ['venda', 'vendas'] },
  meetings: { label: 'Reuniões marcadas', unit: ['reunião', 'reuniões'] },
  new_mrr: { label: 'Mensalidades novas (R$/mês)', short: 'em mensalidades', money: true },
};

export const GOAL_SCOPES = {
  individual: { label: 'Individual', description: 'Cada pessoa tem de bater o alvo sozinha' },
  group: { label: 'Em grupo', description: 'A soma de todos é que conta' },
};

/** "R$ 12.500" / "3 vendas" / "1 reunião". `compact` para eixos e marcadores. */
export function formatGoalValue(metric, value, { compact = false } = {}) {
  const meta = GOAL_METRICS[metric];
  if (meta?.money) return compact ? formatCurrencyCompact(value) : formatCurrency(value);
  const n = Math.round(Number(value) || 0);
  return meta ? `${n} ${n === 1 ? meta.unit[0] : meta.unit[1]}` : String(n);
}

const dayMonth = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' });
const fromYmd = (ymd) => new Date(`${ymd}T12:00:00`);
/** "01 out. – 31 out." */
export const formatPeriod = (goal) => `${dayMonth.format(fromYmd(goal.starts_on))} – ${dayMonth.format(fromYmd(goal.ends_on))}`;

export function goalTimeLabel(goal) {
  if (goal.status === 'ended') return 'Encerrada';
  if (goal.status === 'upcoming') return `Começa em ${dayMonth.format(fromYmd(goal.starts_on))}`;
  return goal.days_left === 1 ? 'Último dia!' : `Faltam ${goal.days_left} dias`;
}
