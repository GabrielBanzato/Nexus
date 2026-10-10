import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, BarChart3, Clock, Crosshair, Filter, Percent, PhoneCall, Receipt, Table2, Trophy, Users } from 'lucide-react';
import { getPerformance, getProspecting } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useUserDirectory } from '../lib/hooks.js';
import {
  DEAL_STAGE_META,
  ROLE_META,
  formatCurrency,
  formatCurrencyCompact,
  formatPercent,
} from '../lib/labels.js';
import { Avatar, Badge, Card, EmptyState, ErrorState, PageHeader, Select, Spinner, StatCard, Tabs, cx, inputClass } from '../components/ui.jsx';

// Cor única das séries (validada contra o fundo #1a1a1a: faixa de luminosidade, croma e
// contraste ≥ 3:1). Azul e não o vermelho da marca: em números financeiros o vermelho
// lê-se como prejuízo, e verde/vermelho estão reservados para estados.
const SERIES = '#3b82f6';
const SERIES_HOVER = '#60a5fa';

const DAY_MS = 86_400_000;
const isoDay = (date) => date.toISOString().slice(0, 10);

const PRESETS = [
  { value: '7d', label: 'Últimos 7 dias' },
  { value: '30d', label: 'Últimos 30 dias' },
  { value: '90d', label: 'Últimos 90 dias' },
  { value: 'month', label: 'Este mês' },
  { value: 'year', label: 'Este ano' },
  { value: 'custom', label: 'Personalizado' },
];

function rangeFor(preset, custom) {
  const today = new Date(`${isoDay(new Date())}T00:00:00Z`);
  switch (preset) {
    case '7d':
      return { from: isoDay(new Date(today - 6 * DAY_MS)), to: isoDay(today) };
    case '90d':
      return { from: isoDay(new Date(today - 89 * DAY_MS)), to: isoDay(today) };
    case 'month':
      return { from: `${isoDay(today).slice(0, 8)}01`, to: isoDay(today) };
    case 'year':
      return { from: `${isoDay(today).slice(0, 4)}-01-01`, to: isoDay(today) };
    case 'custom':
      return custom;
    default:
      return { from: isoDay(new Date(today - 29 * DAY_MS)), to: isoDay(today) };
  }
}

/** Topo do eixo "redondo" (0 / 5 mil / 10 mil...) e 4 intervalos. */
function niceScale(max) {
  if (max <= 0) return { top: 1000, ticks: [0, 250, 500, 750, 1000] };
  const rough = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough);
  const top = step * Math.ceil(max / step);
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}

const bucketLabel = (bucket, unit, long = false) => {
  const date = new Date(`${bucket}T12:00:00Z`);
  if (unit === 'month') return date.toLocaleDateString('pt-PT', { month: long ? 'long' : 'short', year: long ? 'numeric' : '2-digit' });
  const day = date.toLocaleDateString('pt-PT', { day: '2-digit', month: 'short' });
  return unit === 'week' && long ? `Semana de ${day}` : day;
};

// ---------------------------------------------------------------------------
// Gráfico de receita (colunas)
// ---------------------------------------------------------------------------

function RevenueChart({ timeline }) {
  const [hover, setHover] = useState(null);
  const [asTable, setAsTable] = useState(false);
  const points = timeline.points;
  const { top, ticks } = niceScale(Math.max(...points.map((p) => p.won_value), 0));

  const W = 720;
  const H = 240;
  const pad = { top: 12, right: 8, bottom: 28, left: 56 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const band = plotW / points.length;
  const barW = Math.min(24, Math.max(3, band - 2)); // ≤ 24px, com ar entre colunas
  const y = (v) => pad.top + plotH - (v / top) * plotH;
  const labelEvery = Math.ceil(points.length / 8);

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-white">Receita fechada</h2>
          <p className="text-xs text-neutral-500">Por {timeline.unit === 'day' ? 'dia' : timeline.unit === 'week' ? 'semana' : 'mês'}, pela data de fecho</p>
        </div>
        <button
          type="button"
          onClick={() => setAsTable((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-neutral-400 transition hover:bg-neutral-800 hover:text-white"
        >
          {asTable ? <BarChart3 className="size-3.5" /> : <Table2 className="size-3.5" />}
          {asTable ? 'Ver gráfico' : 'Ver tabela'}
        </button>
      </div>

      {asTable ? (
        <div className="mt-3 max-h-64 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[#1a1a1a] text-xs text-neutral-500">
              <tr><th scope="col" className="py-2 text-left font-medium">Período</th><th scope="col" className="py-2 text-right font-medium">Negócios</th><th scope="col" className="py-2 text-right font-medium">Receita</th></tr>
            </thead>
            <tbody className="divide-y divide-neutral-800/70 text-neutral-300 tabular-nums">
              {points.map((p) => (
                <tr key={p.bucket}><td className="py-1.5">{bucketLabel(p.bucket, timeline.unit, true)}</td><td className="py-1.5 text-right">{p.won_count}</td><td className="py-1.5 text-right">{formatCurrency(p.won_value)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative mt-3 overflow-x-auto">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[480px]" role="img" aria-label="Receita fechada por período (valores disponíveis em Ver tabela)">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} stroke="#2a2a2a" strokeWidth="1" />
                <text x={pad.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-neutral-500 text-[11px] tabular-nums">
                  {formatCurrencyCompact(t)}
                </text>
              </g>
            ))}
            {points.map((p, i) => {
              const cx0 = pad.left + band * i + band / 2;
              const h = (p.won_value / top) * plotH;
              const r = Math.min(4, h, barW / 2);
              const x = cx0 - barW / 2;
              const yTop = pad.top + plotH - h;
              // Topo arredondado (4px), base quadrada na linha zero.
              const path = h > 0
                ? `M${x},${pad.top + plotH} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${pad.top + plotH} Z`
                : null;
              const active = hover?.i === i;
              return (
                <g
                  key={p.bucket}
                  tabIndex={0}
                  role="button"
                  aria-label={`${bucketLabel(p.bucket, timeline.unit, true)}: ${formatCurrency(p.won_value)}, ${p.won_count} negócio(s)`}
                  onPointerEnter={() => setHover({ i, p, x: cx0, y: yTop })}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover({ i, p, x: cx0, y: yTop })}
                  onBlur={() => setHover(null)}
                  className="outline-none"
                >
                  {/* Alvo de hover maior que a coluna: a faixa inteira. */}
                  <rect x={pad.left + band * i} y={pad.top} width={band} height={plotH} fill="transparent" />
                  {path && <path d={path} fill={active ? SERIES_HOVER : SERIES} />}
                  {i % labelEvery === 0 && (
                    <text x={cx0} y={H - 8} textAnchor="middle" className="fill-neutral-500 text-[11px]">
                      {bucketLabel(p.bucket, timeline.unit)}
                    </text>
                  )}
                </g>
              );
            })}
            <line x1={pad.left} x2={W - pad.right} y1={pad.top + plotH} y2={pad.top + plotH} stroke="#3a3a3a" strokeWidth="1" />
          </svg>
          {hover && (
            <div
              // Sempre dentro da área do gráfico: preso entre 12% e 88% na horizontal e no topo do plot
              // (seguir a coluna fazia o tooltip da última barra sair do contêiner e ser cortado).
              className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-lg border border-neutral-700 bg-[#111] px-3 py-2 text-xs whitespace-nowrap shadow-xl"
              style={{ left: `${Math.min(88, Math.max(12, (hover.x / W) * 100))}%` }}
              role="status"
            >
              <p className="text-sm font-semibold text-white tabular-nums">{formatCurrency(hover.p.won_value)}</p>
              <p className="text-neutral-400">{bucketLabel(hover.p.bucket, timeline.unit, true)} · {hover.p.won_count} negócio(s)</p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Funil (pipeline aberto)
// ---------------------------------------------------------------------------

function Funnel({ funnel }) {
  const max = Math.max(...funnel.map((f) => f.value), 1);
  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-white">Pipeline aberto por estágio</h2>
      <p className="text-xs text-neutral-500">Situação atual (não depende do período)</p>
      <ul className="mt-4 space-y-3">
        {funnel.map((f) => (
          <li key={f.stage} title={`${DEAL_STAGE_META[f.stage].label}: ${f.count} negócio(s), ${formatCurrency(f.value)} (ponderado ${formatCurrency(f.weighted)})`}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
              <span className="text-neutral-300">{DEAL_STAGE_META[f.stage].label} <span className="text-neutral-500">· {f.count}</span></span>
              <span className="font-medium text-neutral-200 tabular-nums">{formatCurrency(f.value)}</span>
            </div>
            <div className="h-2 rounded-full bg-neutral-800">
              <div className="h-2 rounded-full transition-[width] duration-500" style={{ width: `${Math.max(f.value ? 2 : 0, (f.value / max) * 100)}%`, background: SERIES }} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

const COLUMNS = [
  { key: 'won_value', label: 'Receita', format: formatCurrency },
  { key: 'won_count', label: 'Clientes conquistados' },
  { key: 'win_rate', label: 'Conversão', format: formatPercent },
  { key: 'open_value', label: 'Pipeline aberto', format: formatCurrencyCompact },
  { key: 'qualified_count', label: 'Qualificados' },
];

function Leaderboard({ rows, selectedId, onSelect, canSelect, meId, teamSize }) {
  const [sort, setSort] = useState({ key: 'won_value', dir: 'desc' });
  const sorted = useMemo(
    () => [...rows].sort((a, b) => ((a[sort.key] ?? -1) - (b[sort.key] ?? -1)) * (sort.dir === 'desc' ? -1 : 1)),
    [rows, sort],
  );
  const toggleSort = (key) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }));

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between px-4 pt-4 pb-3 sm:px-5">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white"><Trophy className="size-4 text-amber-400" />Leaderboard da equipe</h2>
          <p className="text-xs text-neutral-500">
            {canSelect ? 'Clique em um membro para focar as métricas nele.' : `Sua posição entre ${teamSize} membros.`}
          </p>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-y border-neutral-800 text-xs text-neutral-500">
            <tr>
              <th scope="col" className="w-12 px-4 py-2.5 font-medium sm:px-5">#</th>
              <th scope="col" className="px-2 py-2.5 font-medium">Membro</th>
              {COLUMNS.map((c) => (
                <th key={c.key} scope="col" className="px-3 py-2.5 text-right font-medium" aria-sort={sort.key === c.key ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none'}>
                  <button type="button" onClick={() => toggleSort(c.key)} className={cx('inline-flex items-center gap-1 hover:text-white', sort.key === c.key && 'text-neutral-200')}>
                    {c.label}
                    {sort.key === c.key && (sort.dir === 'desc' ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800/70">
            {sorted.map((row) => {
              const selected = row.user_id === selectedId;
              return (
                <tr
                  key={row.user_id}
                  onClick={canSelect ? () => onSelect(selected ? '' : String(row.user_id)) : undefined}
                  className={cx('transition-colors', canSelect && 'cursor-pointer hover:bg-neutral-800/30', selected && 'bg-red-950/20')}
                >
                  <td className="px-4 py-3 sm:px-5">
                    <span className={cx('inline-flex size-6 items-center justify-center rounded-full text-xs font-bold tabular-nums', row.rank === 1 ? 'bg-amber-400/15 text-amber-300 ring-1 ring-amber-400/40' : row.rank <= 3 ? 'bg-neutral-700/60 text-neutral-200' : 'text-neutral-500')}>
                      {row.rank}
                    </span>
                  </td>
                  <td className="px-2 py-3">
                    <span className="flex items-center gap-2.5">
                      <Avatar name={row.name} id={row.user_id} size="sm" />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-white">
                          {row.name}
                          {row.user_id === meId && <span className="ml-1 text-xs font-normal text-neutral-500">(você)</span>}
                        </span>
                        <span className="text-xs text-neutral-500">{ROLE_META[row.role]?.label}{!row.is_active && ' · inativo'}</span>
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right font-semibold text-white tabular-nums">{formatCurrency(row.won_value)}</td>
                  <td className="px-3 py-3 text-right text-neutral-300 tabular-nums">{row.won_count}</td>
                  <td className="px-3 py-3">
                    <div className="flex items-center justify-end gap-2" title={`${row.won_count} ganhos / ${row.lost_count} perdidos no período`}>
                      <div className="hidden h-1.5 w-16 rounded-full bg-neutral-800 sm:block">
                        {row.win_rate !== null && <div className="h-1.5 rounded-full" style={{ width: `${row.win_rate * 100}%`, background: SERIES }} />}
                      </div>
                      <span className="w-10 text-right text-neutral-300 tabular-nums">{formatPercent(row.win_rate)}</span>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right text-neutral-400 tabular-nums">{formatCurrencyCompact(row.open_value)}</td>
                  <td className="px-3 py-3 text-right text-neutral-400 tabular-nums" title={`${row.triaged_count} lead(s) triados no período`}>{row.qualified_count}/{row.triaged_count}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Prospecção hoje / esta semana
// ---------------------------------------------------------------------------

/** Meia-noite de hoje e segunda-feira desta semana, no fuso de quem vê. */
function prospectingWindows() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const week = new Date(today);
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
  return { today: today.toISOString(), week: week.toISOString() };
}

const PROSPECTING_METRICS = [
  { key: 'contacted', label: 'Leads prospectados', hint: 'Leads distintos marcados como contatados (WhatsApp ou interruptor do Radar)', icon: PhoneCall },
  { key: 'qualified', label: 'Qualificados', hint: 'Leads enviados para Triagem/Novo no pipeline', icon: Filter },
  { key: 'won', label: 'Clientes fechados', hint: 'Negócios movidos para Cliente Fechado', icon: Trophy },
];

function ProspectingBoard({ meId, isManager }) {
  const [period, setPeriod] = useState('today');
  // Recalculado a cada render: se o ecrã ficar aberto até depois da meia-noite, a janela avança.
  const windows = prospectingWindows();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['metrics', 'prospecting', windows],
    queryFn: () => getProspecting(windows),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  const suffix = period === 'today' ? '_today' : '_week';
  const members = data?.data.members ?? [];
  const rows = [...members]
    .map((m) => ({ ...m, contacted: m[`contacted${suffix}`], qualified: m[`qualified${suffix}`], won: m[`won${suffix}`] }))
    .sort((a, b) => b.contacted - a.contacted || b.won - a.won || b.qualified - a.qualified || a.name.localeCompare(b.name));
  const totals = data?.data.totals;
  const max = Math.max(1, ...rows.map((r) => r.contacted));
  const periodLabel = period === 'today' ? 'hoje' : 'esta semana';

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 pb-3 sm:px-5">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white"><Crosshair className="size-4 text-red-500" />Prospecção da equipe</h2>
          <p className="text-xs text-neutral-500">
            {isManager ? `Quem mais prospectou ${periodLabel}. Atualiza sozinho a cada minuto.` : `Seus números ${periodLabel}.`}
          </p>
        </div>
        <Tabs value={period} onChange={setPeriod} options={[{ value: 'today', label: 'Hoje' }, { value: 'week', label: 'Esta semana' }]} />
      </div>

      {isError ? (
        <div className="px-4 pb-4 sm:px-5"><ErrorState error={error} onRetry={refetch} /></div>
      ) : isLoading ? (
        <div className="px-4 pb-4 sm:px-5"><Spinner label="Carregando prospecção..." /></div>
      ) : (
        <>
          {totals && (
            <dl className="grid grid-cols-3 border-t border-neutral-800">
              {PROSPECTING_METRICS.map(({ key, label, hint, icon: Icon }) => (
                <div key={key} className="border-r border-neutral-800 px-4 py-3 last:border-r-0 sm:px-5" title={hint}>
                  <dt className="flex items-center gap-1.5 text-xs text-neutral-500"><Icon className="size-3.5 shrink-0" /><span className="truncate">{label}</span></dt>
                  <dd className="mt-1 text-2xl font-bold text-white tabular-nums">{totals[`${key}${suffix}`]}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="border-y border-neutral-800 text-xs text-neutral-500">
                <tr>
                  <th scope="col" className="w-12 px-4 py-2.5 font-medium sm:px-5">#</th>
                  <th scope="col" className="px-2 py-2.5 font-medium">Membro</th>
                  {PROSPECTING_METRICS.map((m) => (
                    <th key={m.key} scope="col" className="px-3 py-2.5 text-right font-medium" title={m.hint}>{m.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800/70">
                {rows.map((row, index) => {
                  const idle = !row.contacted && !row.qualified && !row.won;
                  return (
                    <tr key={row.user_id} className={cx(row.user_id === meId && 'bg-red-950/15')}>
                      <td className="px-4 py-3 sm:px-5">
                        {isManager && !idle ? (
                          <span className={cx('inline-flex size-6 items-center justify-center rounded-full text-xs font-bold tabular-nums', index === 0 ? 'bg-amber-400/15 text-amber-300 ring-1 ring-amber-400/40' : index <= 2 ? 'bg-neutral-700/60 text-neutral-200' : 'text-neutral-500')}>
                            {index + 1}
                          </span>
                        ) : (
                          <span className="inline-flex size-6 items-center justify-center text-neutral-600">—</span>
                        )}
                      </td>
                      <td className="px-2 py-3">
                        <span className="flex items-center gap-2.5">
                          <Avatar name={row.name} id={row.user_id} size="sm" />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-white">
                              {row.name}
                              {row.user_id === meId && <span className="ml-1 text-xs font-normal text-neutral-500">(você)</span>}
                            </span>
                            <span className="text-xs text-neutral-500">{ROLE_META[row.role]?.label}{!row.is_active && ' · inativo'}</span>
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <div className="hidden h-1.5 w-24 rounded-full bg-neutral-800 sm:block" aria-hidden>
                            {row.contacted > 0 && <div className="h-1.5 rounded-full" style={{ width: `${(row.contacted / max) * 100}%`, background: SERIES }} />}
                          </div>
                          <span className={cx('w-8 text-right font-semibold tabular-nums', row.contacted ? 'text-white' : 'text-neutral-600')}>{row.contacted}</span>
                        </div>
                      </td>
                      <td className={cx('px-3 py-3 text-right tabular-nums', row.qualified ? 'text-neutral-200' : 'text-neutral-600')}>{row.qualified}</td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {row.won ? (
                          <span className="inline-flex items-center gap-1 font-semibold text-emerald-300"><Trophy className="size-3.5" />{row.won}</span>
                        ) : (
                          <span className="text-neutral-600">0</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && <p className="px-5 py-6 text-center text-sm text-neutral-500">Sem membros ativos.</p>}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default function PerformancePage() {
  const { user, isManager } = useAuth();
  const { data: users = [] } = useUserDirectory();
  const [preset, setPreset] = useState('30d');
  const [custom, setCustom] = useState(() => rangeFor('30d'));
  const [member, setMember] = useState('');
  const range = rangeFor(preset, custom);
  const params = { ...range, user_id: isManager && member ? member : undefined };

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['metrics', 'performance', params],
    queryFn: () => getPerformance(params),
    placeholderData: keepPreviousData, // mantém o ecrã ao trocar filtros (sem "piscar")
    enabled: Boolean(range.from && range.to && range.from <= range.to),
  });

  const o = data?.data.overview;
  const focusName = member ? users.find((u) => String(u.id) === member)?.name : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Desempenho comercial"
        description={isManager ? 'Prospecção do dia e da semana, e resultados da equipe no período.' : 'Sua prospecção, seus resultados no período e sua posição na equipe.'}
      />

      <ProspectingBoard meId={user?.id} isManager={isManager} />

      <h2 className="pt-2 text-sm font-semibold text-neutral-300">Resultados comerciais no período</h2>

      {/* Filtros: uma linha, acima de tudo o que eles afetam. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Período" value={preset} onChange={(e) => setPreset(e.target.value)} className="w-48">
          {PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </Select>
        {preset === 'custom' && (
          <>
            <input type="date" aria-label="Data inicial" value={custom.from} max={custom.to} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className={cx(inputClass, 'w-40')} />
            <span className="text-neutral-500">até</span>
            <input type="date" aria-label="Data final" value={custom.to} min={custom.from} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className={cx(inputClass, 'w-40')} />
          </>
        )}
        {isManager && (
          <Select aria-label="Colaborador" value={member} onChange={(e) => setMember(e.target.value)} className="w-52">
            <option value="">Toda a equipe</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        )}
        {focusName && <Badge tone="red" dot>Vendo: {focusName}</Badge>}
        {data && (
          <span className="ml-auto text-xs text-neutral-500">
            {new Date(`${data.meta.from}T12:00:00Z`).toLocaleDateString('pt-PT')} – {new Date(`${data.meta.to}T12:00:00Z`).toLocaleDateString('pt-PT')}
          </span>
        )}
      </div>

      {isError ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : isLoading || !data ? (
        <Spinner label="Calculando métricas..." />
      ) : (
        <div className={cx('space-y-5 transition-opacity', isFetching && 'opacity-60')}>
          <div className="grid gap-3 lg:grid-cols-[1.2fr_2fr]">
            {/* Um único número de destaque por ecrã. */}
            <Card className="flex flex-col justify-between p-5">
              <p className="text-sm font-medium text-neutral-400">Receita fechada</p>
              <p className="mt-2 text-5xl font-bold tracking-tight text-white">{formatCurrency(o.won_value)}</p>
              <p className="mt-3 text-sm text-neutral-500">
                {o.won_count} cliente(s) conquistado(s) · {o.created_count} negócio(s) criado(s) no período
              </p>
            </Card>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2">
              <StatCard label="Taxa de conversão" value={formatPercent(o.win_rate)} icon={Percent} tone="sky" />
              <StatCard label="Ticket médio" value={o.avg_deal_value === null ? '—' : formatCurrency(o.avg_deal_value)} icon={Receipt} tone="neutral" />
              <StatCard label="Ciclo médio de venda" value={o.avg_cycle_days === null ? '—' : `${String(o.avg_cycle_days).replace('.', ',')} dias`} icon={Clock} tone="neutral" />
              <StatCard label="Previsão ponderada" value={formatCurrencyCompact(o.forecast_value)} icon={Users} tone="amber" />
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-[2fr_1fr]">
            <RevenueChart timeline={data.data.timeline} />
            <Funnel funnel={data.data.funnel} />
          </div>

          {data.data.leaderboard.length ? (
            <Leaderboard
              rows={data.data.leaderboard}
              selectedId={member ? Number(member) : null}
              onSelect={setMember}
              canSelect={isManager}
              meId={user?.id}
              teamSize={data.data.team_size}
            />
          ) : (
            <EmptyState icon={Trophy} title="Sem dados de equipe" description="O leaderboard aparece assim que houver membros ativos." />
          )}

          <p className="text-xs text-neutral-600">
            Conversão = negócios fechados ÷ (fechados + perdidos) no período. Clientes conquistados = negócios fechados. Datas em UTC.
          </p>
        </div>
      )}
    </div>
  );
}
