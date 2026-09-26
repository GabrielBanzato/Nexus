import { db } from '../config/database.js';
import { OPEN_STAGES, STAGE_PROBABILITY } from './dealRepository.js';

const DAY_MS = 86_400_000;
const num = (value) => Number(value ?? 0);
const round = (value, digits = 2) => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits);
const rate = (won, lost) => (won + lost > 0 ? won / (won + lost) : null);

/** Granularidade da série temporal conforme o tamanho do intervalo. */
function bucketFor(from, to) {
  const days = (to - from) / DAY_MS;
  if (days <= 45) return { unit: 'day', sql: 'DATE(won_at)' };
  if (days <= 200) return { unit: 'week', sql: 'DATE(DATE_SUB(won_at, INTERVAL WEEKDAY(won_at) DAY))' };
  return { unit: 'month', sql: "DATE_FORMAT(won_at, '%Y-%m-01')" };
}

const toKey = (date) => date.toISOString().slice(0, 10);

/** Série contínua (buckets sem vendas aparecem com zero, para o gráfico não "saltar" datas). */
function fillSeries(rows, unit, from, to) {
  const byKey = new Map(rows.map((r) => [String(r.bucket).slice(0, 10), r]));
  const series = [];
  const cursor = new Date(from);
  if (unit === 'week') cursor.setUTCDate(cursor.getUTCDate() - ((cursor.getUTCDay() + 6) % 7));
  if (unit === 'month') cursor.setUTCDate(1);

  while (cursor < to) {
    const key = toKey(cursor);
    const row = byKey.get(key);
    series.push({ bucket: key, won_count: num(row?.won_count), won_value: num(row?.won_value) });
    if (unit === 'day') cursor.setUTCDate(cursor.getUTCDate() + 1);
    else if (unit === 'week') cursor.setUTCDate(cursor.getUTCDate() + 7);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return series;
}

/**
 * Desempenho comercial no intervalo [from, to).
 * @param {{ from: Date, to: Date, userId?: number, leaderboardUserId?: number }} params
 *   userId           → restringe o overview/série/funil a um colaborador.
 *   leaderboardUserId → restringe o leaderboard a uma linha (agentes só veem a própria).
 */
export async function getPerformance({ from, to, userId, leaderboardUserId }) {
  const scoped = (query, column = 'owner_id') => (userId ? query.where(column, userId) : query);

  // --- Overview ---------------------------------------------------------------
  const [won] = await scoped(
    db('deals')
      .where('won_at', '>=', from)
      .andWhere('won_at', '<', to)
      .select(
        db.raw('COUNT(*) AS won_count'),
        db.raw('COALESCE(SUM(value), 0) AS won_value'),
        db.raw('AVG(value) AS avg_deal_value'),
        db.raw('AVG(TIMESTAMPDIFF(HOUR, created_at, won_at)) / 24 AS avg_cycle_days'),
      ),
  );
  const [lost] = await scoped(db('deals').where('lost_at', '>=', from).andWhere('lost_at', '<', to).count({ lost_count: '*' }));
  const [created] = await scoped(db('deals').where('created_at', '>=', from).andWhere('created_at', '<', to).count({ created_count: '*' }));

  // Pipeline aberto é uma fotografia do momento (não depende do intervalo).
  const funnelRows = await scoped(
    db('deals').whereIn('stage', OPEN_STAGES).select('stage').count({ count: '*' }).sum({ value: 'value' }).groupBy('stage'),
  );
  const funnel = OPEN_STAGES.map((stage) => {
    const row = funnelRows.find((r) => r.stage === stage);
    const value = num(row?.value);
    return { stage, count: num(row?.count), value, weighted: value * STAGE_PROBABILITY[stage] };
  });

  const wonCount = num(won.won_count);
  const lostCount = num(lost.lost_count);
  const overview = {
    won_count: wonCount,
    won_value: num(won.won_value),
    lost_count: lostCount,
    win_rate: round(rate(wonCount, lostCount), 4),
    created_count: num(created.created_count),
    avg_deal_value: won.avg_deal_value === null ? null : round(num(won.avg_deal_value)),
    avg_cycle_days: won.avg_cycle_days === null ? null : round(num(won.avg_cycle_days), 1),
    open_count: funnel.reduce((s, f) => s + f.count, 0),
    open_value: funnel.reduce((s, f) => s + f.value, 0),
    forecast_value: round(funnel.reduce((s, f) => s + f.weighted, 0)),
  };

  // --- Série temporal -----------------------------------------------------------
  const bucket = bucketFor(from, to);
  const seriesRows = await scoped(
    db('deals')
      .where('won_at', '>=', from)
      .andWhere('won_at', '<', to)
      .select(db.raw(`${bucket.sql} AS bucket`), db.raw('COUNT(*) AS won_count'), db.raw('SUM(value) AS won_value'))
      .groupByRaw(bucket.sql)
      .orderBy('bucket'),
  );
  const timeline = { unit: bucket.unit, points: fillSeries(seriesRows, bucket.unit, from, to) };

  // --- Leaderboard --------------------------------------------------------------
  const wonAgg = db('deals')
    .select('owner_id')
    .count({ won_count: '*' })
    .sum({ won_value: 'value' })
    .where('won_at', '>=', from)
    .andWhere('won_at', '<', to)
    .groupBy('owner_id')
    .as('w');
  const lostAgg = db('deals').select('owner_id').count({ lost_count: '*' }).where('lost_at', '>=', from).andWhere('lost_at', '<', to).groupBy('owner_id').as('ls');
  const createdAgg = db('deals').select('owner_id').count({ created_count: '*' }).where('created_at', '>=', from).andWhere('created_at', '<', to).groupBy('owner_id').as('cr');
  const openAgg = db('deals').select('owner_id').count({ open_count: '*' }).sum({ open_value: 'value' }).whereIn('stage', OPEN_STAGES).groupBy('owner_id').as('op');
  const triageAgg = db('lead_triage')
    .select('triaged_by')
    .count({ triaged_count: '*' })
    .select(db.raw("SUM(status = 'qualified') AS qualified_count"))
    .where('triaged_at', '>=', from)
    .andWhere('triaged_at', '<', to)
    .groupBy('triaged_by')
    .as('tr');

  const leaderboardQuery = db('users as u')
    .leftJoin(wonAgg, 'w.owner_id', 'u.id')
    .leftJoin(lostAgg, 'ls.owner_id', 'u.id')
    .leftJoin(createdAgg, 'cr.owner_id', 'u.id')
    .leftJoin(openAgg, 'op.owner_id', 'u.id')
    .leftJoin(triageAgg, 'tr.triaged_by', 'u.id')
    // Inativos só aparecem se tiveram resultados no período (histórico continua visível).
    .where((w) => w.where('u.is_active', true).orWhere('w.won_count', '>', 0))
    .select(
      'u.id as user_id',
      'u.name',
      'u.role',
      'u.is_active',
      'w.won_count',
      'w.won_value',
      'ls.lost_count',
      'cr.created_count',
      'op.open_count',
      'op.open_value',
      'tr.triaged_count',
      'tr.qualified_count',
    )
    .orderByRaw('COALESCE(w.won_value, 0) DESC, COALESCE(w.won_count, 0) DESC, u.name ASC');

  // O ranking é calculado sobre todos; o filtro por utilizador vem depois,
  // para um agente ver a sua posição real (ex.: 3º) e não "1º de 1".
  const ranked = (await leaderboardQuery).map((row, index) => {
    const w = num(row.won_count);
    const l = num(row.lost_count);
    return {
      rank: index + 1,
      user_id: row.user_id,
      name: row.name,
      role: row.role,
      is_active: Boolean(row.is_active),
      won_count: w,
      won_value: num(row.won_value),
      lost_count: l,
      win_rate: round(rate(w, l), 4),
      created_count: num(row.created_count),
      open_count: num(row.open_count),
      open_value: num(row.open_value),
      triaged_count: num(row.triaged_count),
      qualified_count: num(row.qualified_count),
    };
  });
  const leaderboard = leaderboardUserId ? ranked.filter((row) => row.user_id === leaderboardUserId) : ranked;

  return { overview, timeline, funnel, leaderboard, team_size: ranked.length };
}
