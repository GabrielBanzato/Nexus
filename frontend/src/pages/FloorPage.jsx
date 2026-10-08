import { useQuery } from '@tanstack/react-query';
import { CalendarDays, Crown, Flag, Gift, Target, Trophy, Users } from 'lucide-react';
import { listGoals } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { GOAL_METRICS, GOAL_SCOPES, formatGoalValue, formatPeriod, goalTimeLabel } from '../lib/goals.js';
import { Avatar, Badge, Card, EmptyState, ErrorState, PageHeader, Spinner, cx } from '../components/ui.jsx';

const GRID = [1, 0.75, 0.5, 0.25];
const firstName = (name) => name.split(' ')[0];
const percent = (p) => `${Math.round(p * 100)}%`;

/**
 * Teto relativo: quem está mais alto fica no máximo a 60% da altura do prédio, por mais que
 * venda — o topo nunca é alcançado (sensação de "ainda não cheguei"). O topo do gráfico vale o
 * maior entre a BASE (a meta) e o nível mais alto ÷ 0,6; quem passa da BASE vê a linha dela
 * ficar abaixo de si e o prédio "crescer".
 */
const MAX_REACH = 0.6;
// Topo arredondado para cima a um número "redondo" (1; 1,2; 1,5; 2; 2,5; 3; 4; 5; 6; 8 × 10ⁿ): as linhas de 1/4 caem
// em valores limpos (R$ 5 mil, 10 mil...) em vez de R$ 5.208, e quem lidera fica perto dos 60%.
const NICE = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
const niceCeil = (n) => {
  const power = 10 ** Math.floor(Math.log10(n));
  return NICE.find((step) => step * power >= n) * power;
};
function buildingScale(target, values) {
  const needed = Math.max(0, ...values) / MAX_REACH;
  return needed > target ? niceCeil(needed) : target;
}

// Altura (% a contar de baixo) de uma fração do topo: folga em cima e em baixo para o nome de
// quem ainda está no térreo.
const level = (f) => 12 + f * 76;

/**
 * O prédio: cada pessoa (ou o grupo) na altura do que já fez; a linha BASE é a meta.
 * Visto de cima para baixo: quem está mais alto está mais perto (ou já passou) da BASE.
 */
function Building({ goal, viewerId }) {
  const group = goal.scope === 'group';
  // Grupo: um só "elevador" com o total. Individual: cada pessoa na sua altura.
  const climbers = group
    ? [{ key: 'group', label: 'Equipe', value: goal.total, pct: goal.total_pct, reached: goal.reached, group: true }]
    : goal.members.map((m) => ({ key: m.user_id, label: firstName(m.name), name: m.name, id: m.user_id, value: m.value, pct: m.pct, reached: m.reached, me: m.user_id === viewerId }));
  const lanes = Math.max(climbers.length, 1);
  const top = buildingScale(goal.target, climbers.map((c) => c.value));
  const base = goal.target / top; // fração da altura onde fica a linha BASE (1 = no topo)
  // Linhas de grelha com o valor; some a que ficaria colada à BASE (os rótulos não se sobrepõem).
  const grid = GRID.filter((f) => Math.abs(f - base) > 0.09);

  return (
    <div className="relative flex h-80 select-none">
      {/* Escala */}
      <div className="relative w-16 shrink-0 sm:w-20">
        {grid.map((f) => (
          <span key={f} className="absolute right-2 translate-y-1/2 text-right text-[10px] leading-tight text-neutral-600 tabular-nums" style={{ bottom: `${level(f)}%` }}>
            {formatGoalValue(goal.metric, top * f, { compact: true })}
          </span>
        ))}
        <span className="absolute right-2 translate-y-1/2 text-right text-[10px] leading-tight tabular-nums" style={{ bottom: `${level(base)}%` }}>
          <span className="block font-semibold text-amber-300">BASE</span>
          <span className="block text-amber-300/60">{formatGoalValue(goal.metric, goal.target, { compact: true })}</span>
        </span>
        <span className="absolute right-2 translate-y-1/2 text-[10px] text-neutral-500" style={{ bottom: `${level(0)}%` }}>
          térreo
        </span>
      </div>
      <div className="relative flex-1 rounded-xl border border-neutral-800 bg-[linear-gradient(to_bottom,rgba(245,158,11,0.10),transparent_30%)]">
        {grid.map((f) => (
          <span key={f} className="absolute inset-x-0 border-t border-dashed border-neutral-800" style={{ bottom: `${level(f)}%` }} />
        ))}
        <span className="absolute inset-x-0 border-t border-neutral-700" style={{ bottom: `${level(0)}%` }} />
        <span className="absolute inset-x-0 border-t border-amber-500/60 transition-all duration-700" style={{ bottom: `${level(base)}%` }} />
        {climbers.map((c, i) => {
          const at = level(Math.max(c.value, 0) / top);
          const left = `${((i + 0.5) / lanes) * 100}%`;
          return (
            <div key={c.key} className="absolute inset-y-0 -translate-x-1/2" style={{ left }}>
              {/* rasto do caminho já feito (do térreo até onde está) */}
              <span
                className={cx('absolute left-1/2 w-1.5 -translate-x-1/2 rounded-full transition-all duration-700', c.reached ? 'bg-emerald-500/70' : c.me || c.group ? 'bg-red-600/70' : 'bg-neutral-600/60')}
                style={{ bottom: `${level(0)}%`, height: `${at - level(0)}%` }}
              />
              {/* avatar centrado na altura a que chegou; coroa em cima e nome em baixo */}
              <span className="absolute left-1/2 -translate-x-1/2 translate-y-1/2 transition-all duration-700" style={{ bottom: `${at}%` }}>
                {c.reached && <Crown className="absolute bottom-full left-1/2 mb-0.5 size-4 -translate-x-1/2 text-amber-400 drop-shadow" />}
                {c.group ? (
                  <span className="flex size-9 items-center justify-center rounded-full bg-red-800 text-white ring-2 ring-red-500/60">
                    <Users className="size-4" />
                  </span>
                ) : (
                  <span className={cx('block rounded-full ring-2', c.reached ? 'ring-emerald-400' : c.me ? 'ring-red-500' : 'ring-neutral-700')}>
                    <Avatar name={c.name} id={c.id} size="sm" />
                  </span>
                )}
                <span className={cx('absolute top-full left-1/2 mt-1 -translate-x-1/2 rounded px-1 text-[10px] font-medium whitespace-nowrap', c.me ? 'bg-red-900/80 text-white' : 'bg-black/70 text-neutral-300')}>
                  {c.label} · {percent(c.pct)}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Ranking de cima para baixo (quem está mais alto no prédio primeiro). */
function Ranking({ goal, viewerId }) {
  const group = goal.scope === 'group';
  return (
    <ol className="space-y-1.5">
      {goal.members.map((m, i) => {
        const me = m.user_id === viewerId;
        const share = group && goal.total > 0 ? m.value / goal.total : null;
        return (
          <li key={m.user_id} className={cx('flex items-center gap-2.5 rounded-xl px-2.5 py-2', me ? 'bg-red-950/40 ring-1 ring-red-900/60' : 'bg-neutral-900/50')}>
            <span className={cx('w-5 text-center text-xs font-bold tabular-nums', i === 0 && m.value > 0 ? 'text-amber-400' : 'text-neutral-500')}>{i + 1}</span>
            <Avatar name={m.name} id={m.user_id} size="xs" />
            <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">
              {m.name}
              {me && <span className="ml-1 text-xs text-red-300">(você)</span>}
            </span>
            <span className="text-right text-xs tabular-nums">
              <span className="block font-semibold text-white">{formatGoalValue(goal.metric, m.value, { compact: true })}</span>
              <span className="text-neutral-500">{group ? (share !== null ? `${percent(share)} do grupo` : '—') : percent(m.pct)}</span>
            </span>
            {!group && m.reached && <Trophy className="size-4 shrink-0 text-emerald-400" />}
          </li>
        );
      })}
    </ol>
  );
}

function GoalCard({ goal, viewerId }) {
  const group = goal.scope === 'group';
  const mine = goal.members.find((m) => m.user_id === viewerId);
  const progress = group ? goal.total : mine?.value;
  const remaining = Math.max(goal.target - (progress ?? 0), 0);
  return (
    <Card className={cx('overflow-hidden', goal.status === 'ended' && 'opacity-75')}>
      <header className="flex flex-wrap items-start gap-3 border-b border-neutral-800 p-4">
        <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-xl', goal.reached ? 'bg-emerald-950/60 text-emerald-400' : 'bg-amber-950/40 text-amber-400')}>
          {goal.reached ? <Trophy className="size-5" /> : <Flag className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-white">{goal.title}</h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-400">
            <span>{GOAL_METRICS[goal.metric].label}</span>
            <span className="text-neutral-700">·</span>
            <span>Alvo {formatGoalValue(goal.metric, goal.target)}{group ? ' (juntos)' : ' (cada um)'}</span>
            <span className="text-neutral-700">·</span>
            <span className="flex items-center gap-1"><CalendarDays className="size-3" />{formatPeriod(goal)}</span>
          </p>
        </div>
        {/* No telemóvel as etiquetas descem para uma linha própria (o título fica com a largura toda). */}
        <div className="flex w-full items-center gap-2 pl-13 sm:w-auto sm:pl-0">
          <Badge tone={group ? 'sky' : 'neutral'}>{GOAL_SCOPES[goal.scope].label}</Badge>
          <Badge tone={goal.status === 'active' ? (goal.days_left <= 3 ? 'red' : 'amber') : 'neutral'} dot={goal.status === 'active'}>
            {goalTimeLabel(goal)}
          </Badge>
        </div>
      </header>
      {goal.reward && (
        <p className="flex items-center gap-2 border-b border-neutral-800 bg-amber-950/20 px-4 py-2 text-sm text-amber-200">
          <Gift className="size-4 shrink-0 text-amber-400" />
          <span><span className="font-semibold">Recompensa:</span> {goal.reward}</span>
        </p>
      )}
      <div className="grid gap-5 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
        <Building goal={goal} viewerId={viewerId} />
        <div className="space-y-3">
          {progress !== undefined && (
            <div className="rounded-xl bg-neutral-900/60 p-3">
              <p className="text-xs text-neutral-500">{group ? 'A equipe já fez' : 'Você já fez'}</p>
              <p className="text-2xl font-bold text-white tabular-nums">{formatGoalValue(goal.metric, progress)}</p>
              <p className={cx('text-xs', remaining > 0 ? 'text-neutral-400' : 'text-emerald-400')}>
                {remaining > 0 ? `Faltam ${formatGoalValue(goal.metric, remaining)} para a BASE` : 'BASE batida! 🏆'}
              </p>
            </div>
          )}
          <Ranking goal={goal} viewerId={viewerId} />
        </div>
      </div>
    </Card>
  );
}

/** O Piso: as metas de cada um, vistas de cima para baixo (todos veem as metas em que participam). */
export default function FloorPage() {
  const { user, isAdmin } = useAuth();
  const { data = [], isLoading, isError, error, refetch } = useQuery({ queryKey: ['goals', 'current'], queryFn: () => listGoals({ include: 'current' }), refetchInterval: 60_000 });
  const active = data.filter((g) => g.status !== 'ended');
  const ended = data.filter((g) => g.status === 'ended');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Piso"
        description="As metas vistas de cima: a linha BASE é a meta e o prédio cresce com quem vende mais. Atualiza sozinho com cada venda e reunião."
      />
      {isError ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : isLoading ? (
        <Spinner />
      ) : !data.length ? (
        <EmptyState
          icon={Target}
          title="Nenhuma meta a decorrer"
          description={isAdmin ? 'Crie metas em Contratos e metas → Metas.' : 'Quando o admin lançar uma meta para você, ela aparece aqui.'}
          action={isAdmin ? <a href="#/contratos" className="text-sm font-medium text-red-400 hover:text-red-300">Criar uma meta →</a> : undefined}
        />
      ) : (
        <>
          {active.map((g) => <GoalCard key={g.id} goal={g} viewerId={user.id} />)}
          {ended.length > 0 && (
            <>
              <h2 className="pt-2 text-sm font-semibold tracking-wide text-neutral-500 uppercase">Encerradas (últimos 7 dias)</h2>
              {ended.map((g) => <GoalCard key={g.id} goal={g} viewerId={user.id} />)}
            </>
          )}
        </>
      )}
    </div>
  );
}
