import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, CalendarRange, ChevronLeft, ChevronRight, Clock, Video } from 'lucide-react';
import { listAgenda, meetingUrl } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Avatar, Card, ErrorState, PageHeader, SegmentedTabs, Spinner, cx } from '../components/ui.jsx';

/**
 * Agenda da equipe: todas as reuniões marcadas no sistema (Pipeline, Central, salas), visíveis
 * a todos. Três colunas: hoje · esta semana · o mês (calendário; clicar num dia mostra-o).
 * Horas no fuso do navegador.
 */

const DAY_MS = 24 * 60 * 60_000;
const SOON_MS = 15 * 60_000; // "começa já" / sala aberta antes da hora
const LIVE_WINDOW_MS = 60 * 60_000; // marcada há menos de 1h e ainda não encerrada: "agora"
const WEEKDAYS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfWeek = (d) => addDays(startOfDay(d), -((d.getDay() + 6) % 7)); // segunda-feira
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const sameDay = (a, b) => dayKey(a) === dayKey(b);

const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
const monthFmt = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });
const shortDayFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });

/** Título sem o "Reunião com" do começo: o nome do cliente cabe no cartão. */
const shortTitle = (title) => String(title ?? '').replace(/^Reunião\s*(com|·|-)\s*/i, '') || title;

/** Agrupa por dia (chave local). */
function byDay(meetings) {
  const map = new Map();
  for (const m of meetings) {
    const key = dayKey(new Date(m.scheduled_at));
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(m);
  }
  return map;
}

function useAgenda(from, to, mine) {
  return useQuery({
    queryKey: ['agenda', from.toISOString(), to.toISOString(), mine],
    queryFn: () => listAgenda({ from: from.toISOString(), to: to.toISOString(), mine: mine || undefined }),
    refetchInterval: 60_000,
  });
}

/** Estado da reunião em relação a agora. */
function phaseOf(meeting, now) {
  const at = new Date(meeting.scheduled_at).getTime();
  if (meeting.status === 'ended') return 'ended';
  if (meeting.status === 'live') return 'live';
  if (at - now <= SOON_MS && now - at < LIVE_WINDOW_MS) return at <= now ? 'live' : 'soon';
  if (now - at >= LIVE_WINDOW_MS) return 'past';
  return 'upcoming';
}

const PHASE = {
  live: { label: 'Agora', className: 'bg-emerald-950/70 text-emerald-300 ring-emerald-800/60' },
  soon: { label: 'Começa já', className: 'bg-amber-950/60 text-amber-300 ring-amber-800/60' },
  ended: { label: 'Encerrada', className: 'bg-neutral-800 text-neutral-400 ring-neutral-700' },
  past: { label: 'Já passou', className: 'bg-neutral-800 text-neutral-500 ring-neutral-700' },
  upcoming: null,
};

function relative(at, now) {
  const min = Math.round((at - now) / 60_000);
  if (min <= 0 || min >= 24 * 60) return null;
  return min < 60 ? `em ${min} min` : `em ${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;
}

/** Cartão de uma reunião (coluna de hoje e dia escolhido no mês). */
function MeetingCard({ meeting, now, me }) {
  const at = new Date(meeting.scheduled_at);
  const phase = phaseOf(meeting, now);
  const badge = PHASE[phase];
  const done = phase === 'ended' || phase === 'past';
  const who = meeting.client_name || meeting.company;
  return (
    <li className={cx('rounded-xl bg-[#141414] p-3 ring-1 ring-neutral-800', done && 'opacity-60', phase === 'live' && 'ring-emerald-700/70')}>
      <div className="flex items-start gap-3">
        <div className="w-12 shrink-0 text-center">
          <p className="text-sm font-semibold text-white tabular-nums">{timeFmt.format(at)}</p>
          {!done && relative(at.getTime(), now) && <p className="text-[10px] text-neutral-500">{relative(at.getTime(), now)}</p>}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white" title={meeting.title}>{shortTitle(meeting.title)}</p>
          {who && !shortTitle(meeting.title).includes(who) && <p className="truncate text-xs text-neutral-400">{who}</p>}
          <p className="mt-1 flex items-center gap-1.5 text-xs text-neutral-500">
            <Avatar name={meeting.host_name ?? '?'} id={meeting.host_user_id ?? 0} size="xs" />
            {meeting.host_name ?? 'Sem responsável'}
            {meeting.host_user_id === me && <span className="text-neutral-600">(você)</span>}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {badge && <span className={cx('rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1', badge.className)}>{badge.label}</span>}
          {!done && (
            <a
              href={meetingUrl(meeting.code)}
              target="_blank"
              rel="noopener noreferrer"
              className={cx(
                'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold transition',
                phase === 'live' || phase === 'soon' ? 'bg-emerald-700 text-white hover:bg-emerald-600' : 'text-neutral-300 ring-1 ring-neutral-700 hover:bg-neutral-800',
              )}
            >
              <Video className="size-3.5" /> Entrar
            </a>
          )}
        </div>
      </div>
    </li>
  );
}

function Column({ icon: Icon, title, subtitle, actions, children }) {
  return (
    <Card className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-3">
        <Icon className="size-4 text-red-500" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          {subtitle && <p className="truncate text-xs text-neutral-500 first-letter:uppercase">{subtitle}</p>}
        </div>
        {actions}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
    </Card>
  );
}

const Empty = ({ children }) => <p className="py-6 text-center text-sm text-neutral-500">{children}</p>;

export default function AgendaPage() {
  const { user } = useAuth();
  const [now, setNow] = useState(() => Date.now());
  const [scope, setScope] = useState('all'); // 'all' | 'mine'
  const [monthDate, setMonthDate] = useState(() => startOfMonth(new Date()));
  const [picked, setPicked] = useState(() => startOfDay(new Date()));
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const today = startOfDay(new Date(now));
  const weekStart = startOfWeek(today);
  const weekEnd = addDays(weekStart, 7);
  // O mês aparece numa grelha de semanas completas (segunda a domingo).
  const gridStart = startOfWeek(monthDate);
  const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1);
  const gridEnd = addDays(startOfWeek(addDays(monthEnd, -1)), 7);

  const mine = scope === 'mine';
  const week = useAgenda(weekStart, weekEnd, mine);
  const month = useAgenda(gridStart, gridEnd, mine);

  const weekByDay = useMemo(() => byDay(week.data ?? []), [week.data]);
  const monthByDay = useMemo(() => byDay(month.data ?? []), [month.data]);
  const todays = weekByDay.get(dayKey(today)) ?? [];
  const pickedList = monthByDay.get(dayKey(picked)) ?? [];
  const nextUp = (week.data ?? []).find((m) => ['upcoming', 'soon', 'live'].includes(phaseOf(m, now)));

  const gridDays = [];
  for (let d = gridStart; d < gridEnd; d = addDays(d, 1)) gridDays.push(d);

  const moveMonth = (delta) => {
    const next = new Date(monthDate.getFullYear(), monthDate.getMonth() + delta, 1);
    setMonthDate(next);
    setPicked(sameDay(startOfMonth(today), next) ? today : next);
  };

  const error = week.error || month.error;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Agenda"
        description="Todas as reuniões marcadas no sistema, da equipe inteira."
        actions={
          <SegmentedTabs
            label="Quais reuniões"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: 'Toda a equipe' },
              { value: 'mine', label: 'Só as minhas' },
            ]}
          />
        }
      />

      {error ? (
        <ErrorState error={error} onRetry={() => (week.refetch(), month.refetch())} />
      ) : (
        <div className="grid gap-4 lg:h-[calc(100dvh-12rem)] lg:min-h-[32rem] lg:grid-cols-3">
          {/* Hoje */}
          <Column icon={Clock} title="Hoje" subtitle={dayFmt.format(today)}>
            {week.isLoading ? (
              <Spinner />
            ) : todays.length === 0 ? (
              <Empty>
                Nenhuma reunião hoje.
                {nextUp && (
                  <span className="mt-1 block text-xs text-neutral-600">
                    Próxima: {shortDayFmt.format(new Date(nextUp.scheduled_at))} às {timeFmt.format(new Date(nextUp.scheduled_at))} · {shortTitle(nextUp.title)}
                  </span>
                )}
              </Empty>
            ) : (
              <ul className="space-y-2">
                {todays.map((m) => (
                  <MeetingCard key={m.id} meeting={m} now={now} me={user?.id} />
                ))}
              </ul>
            )}
          </Column>

          {/* Semana */}
          <Column icon={CalendarRange} title="Esta semana" subtitle={`${shortDayFmt.format(weekStart)} a ${shortDayFmt.format(addDays(weekEnd, -1))} · ${week.data?.length ?? 0} reuniões`}>
            {week.isLoading ? (
              <Spinner />
            ) : (
              <ol className="space-y-3">
                {Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)).map((d, i) => {
                  const items = weekByDay.get(dayKey(d)) ?? [];
                  const isToday = sameDay(d, today);
                  const isPast = d < today;
                  return (
                    <li key={dayKey(d)} className={cx(isPast && 'opacity-50')}>
                      <p className={cx('mb-1 flex items-center gap-2 text-xs font-semibold', isToday ? 'text-red-400' : 'text-neutral-400')}>
                        {WEEKDAYS[i]} {d.getDate()}
                        {isToday && <span className="rounded-full bg-red-950/70 px-1.5 py-px text-[10px] text-red-300">hoje</span>}
                      </p>
                      {items.length === 0 ? (
                        <p className="pl-1 text-xs text-neutral-600">—</p>
                      ) : (
                        <ul className="space-y-1">
                          {items.map((m) => {
                            const phase = phaseOf(m, now);
                            return (
                              <li key={m.id}>
                                <a
                                  href={meetingUrl(m.code)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={`${m.title} · ${m.host_name ?? ''}`}
                                  className={cx(
                                    'flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition hover:bg-neutral-800/70',
                                    phase === 'live' ? 'bg-emerald-950/40 text-emerald-200' : 'text-neutral-200',
                                    (phase === 'ended' || phase === 'past') && 'text-neutral-500',
                                  )}
                                >
                                  <span className="w-10 shrink-0 font-semibold tabular-nums">{timeFmt.format(new Date(m.scheduled_at))}</span>
                                  <span className="min-w-0 flex-1 truncate">{shortTitle(m.title)}</span>
                                  <span className="shrink-0 text-neutral-500">{(m.host_name ?? '').split(' ')[0]}</span>
                                </a>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </Column>

          {/* Mês */}
          <Column
            icon={CalendarDays}
            title="Mês"
            subtitle={monthFmt.format(monthDate)}
            actions={
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => moveMonth(-1)} aria-label="Mês anterior" className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-white">
                  <ChevronLeft className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMonthDate(startOfMonth(today));
                    setPicked(today);
                  }}
                  className="rounded-lg px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-white"
                >
                  Hoje
                </button>
                <button type="button" onClick={() => moveMonth(1)} aria-label="Próximo mês" className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-white">
                  <ChevronRight className="size-4" />
                </button>
              </div>
            }
          >
            <div className="grid grid-cols-7 gap-1 text-center">
              {WEEKDAYS.map((w) => (
                <span key={w} className="pb-1 text-[10px] font-semibold text-neutral-500 uppercase">{w}</span>
              ))}
              {gridDays.map((d) => {
                const count = monthByDay.get(dayKey(d))?.length ?? 0;
                const inMonth = d.getMonth() === monthDate.getMonth();
                const isToday = sameDay(d, today);
                const isPicked = sameDay(d, picked);
                return (
                  <button
                    key={dayKey(d)}
                    type="button"
                    onClick={() => setPicked(d)}
                    aria-label={`${dayFmt.format(d)}: ${count} reunião(ões)`}
                    aria-pressed={isPicked}
                    className={cx(
                      'flex aspect-square flex-col items-center justify-center rounded-lg text-xs transition',
                      inMonth ? 'text-neutral-200' : 'text-neutral-600',
                      isPicked ? 'bg-red-900/60 text-white ring-1 ring-red-600' : 'hover:bg-neutral-800',
                      isToday && !isPicked && 'ring-1 ring-red-800',
                    )}
                  >
                    <span className={cx('tabular-nums', isToday && 'font-bold')}>{d.getDate()}</span>
                    {count > 0 && (
                      <span className={cx('mt-0.5 min-w-4 rounded-full px-1 text-[10px] leading-4 font-semibold', isPicked ? 'bg-white/20' : 'bg-red-800/70 text-white')}>{count}</span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="mt-4 border-t border-neutral-800 pt-3">
              <p className="mb-2 text-xs font-semibold text-neutral-300 first-letter:uppercase">{dayFmt.format(picked)}</p>
              {month.isLoading ? (
                <Spinner />
              ) : pickedList.length === 0 ? (
                <p className="text-xs text-neutral-600">Nenhuma reunião neste dia.</p>
              ) : (
                <ul className="space-y-2">
                  {pickedList.map((m) => (
                    <MeetingCard key={m.id} meeting={m} now={now} me={user?.id} />
                  ))}
                </ul>
              )}
            </div>
          </Column>
        </div>
      )}
    </div>
  );
}
