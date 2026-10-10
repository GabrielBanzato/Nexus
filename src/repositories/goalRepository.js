import { db } from '../config/database.js';
import { dateKeyIn, startOfDayIn } from '../lib/time.js';

/**
 * Metas (o "Piso"): o admin define o alvo, o período e a recompensa, para uma pessoa ou um grupo.
 *  - individual: cada membro tem de bater o alvo sozinho;
 *  - group: a soma do grupo é que conta.
 * Progresso calculado na hora a partir do pipeline (nada a lançar à mão).
 */
export const GOAL_METRICS = ['won_value', 'won_count', 'meetings', 'new_mrr'];
export const GOAL_SCOPES = ['individual', 'group'];
const DAY_MS = 86_400_000;

const nextDay = (ymd) => new Date(Date.parse(`${ymd}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Valor da métrica por pessoa no intervalo [from, to). */
async function metricByUser(metric, userIds, from, to) {
  if (!userIds.length) return new Map();
  let rows;
  if (metric === 'meetings') {
    // Reuniões marcadas (no pipeline ou na Central); reagendar não conta outra vez.
    rows = await db('activity_logs')
      .whereIn('action', ['deal.meeting', 'meeting.schedule'])
      .whereIn('user_id', userIds)
      .where('created_at', '>=', from)
      .where('created_at', '<', to)
      .whereRaw("COALESCE(JSON_UNQUOTE(JSON_EXTRACT(details, '$.from')), '') <> 'meeting'")
      .groupBy('user_id')
      .select('user_id', db.raw('COUNT(*) AS total'));
  } else {
    const aggregate = { won_value: 'COALESCE(SUM(value), 0)', won_count: 'COUNT(*)', new_mrr: 'COALESCE(SUM(monthly_value), 0)' }[metric];
    rows = await db('deals')
      .where('stage', 'won')
      .whereIn('owner_id', userIds)
      .where('won_at', '>=', from)
      .where('won_at', '<', to)
      .groupBy('owner_id')
      .select('owner_id as user_id', db.raw(`${aggregate} AS total`));
  }
  return new Map(rows.map((r) => [r.user_id, Number(r.total)]));
}

async function membersOf(goalIds) {
  if (!goalIds.length) return new Map();
  const rows = await db('goal_members as m')
    .join('users as u', 'u.id', 'm.user_id')
    .whereIn('m.goal_id', goalIds)
    .select('m.goal_id', 'u.id as user_id', 'u.name', 'u.is_active')
    .orderBy('u.name');
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.goal_id)) map.set(r.goal_id, []);
    map.get(r.goal_id).push({ user_id: r.user_id, name: r.name, is_active: r.is_active });
  }
  return map;
}

/** Meta com o progresso de cada membro (e do grupo), no fuso da empresa. */
async function withProgress(goal, members, timeZone, now) {
  const from = startOfDayIn(goal.starts_on, timeZone);
  const to = startOfDayIn(nextDay(goal.ends_on), timeZone);
  const today = dateKeyIn(now, timeZone);
  const status = today < goal.starts_on ? 'upcoming' : today > goal.ends_on ? 'ended' : 'active';
  const values = await metricByUser(goal.metric, members.map((m) => m.user_id), from, to);
  const target = Number(goal.target);

  const rows = members
    .map((m) => {
      const value = round2(values.get(m.user_id) ?? 0);
      return { ...m, value, pct: value / target, reached: value >= target };
    })
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  const total = round2(rows.reduce((sum, m) => sum + m.value, 0));

  return {
    ...goal,
    target,
    status,
    // Dias que faltam, contando com hoje (0 depois de acabar).
    days_left: status === 'ended' ? 0 : Math.round((Date.parse(`${goal.ends_on}T12:00:00Z`) - Date.parse(`${status === 'upcoming' ? goal.starts_on : today}T12:00:00Z`)) / DAY_MS) + 1,
    members: rows,
    total,
    total_pct: total / target,
    reached: goal.scope === 'group' ? total >= target : rows.length > 0 && rows.every((m) => m.reached),
  };
}

/**
 * Metas visíveis para `viewer`: o admin vê todas; os demais, só aquelas em que participam.
 * `include`: 'current' (a decorrer e futuras + acabadas há menos de 7 dias) ou 'all'.
 */
export async function listGoals({ viewer, include = 'current', timeZone, now = new Date() }) {
  const query = db('goals as g').whereNull('g.archived_at').select('g.*').orderBy([{ column: 'g.ends_on' }, { column: 'g.id' }]);
  if (viewer.role !== 'admin') query.whereExists(db('goal_members as m').whereRaw('m.goal_id = g.id').where('m.user_id', viewer.id));
  if (include === 'current') {
    const weekAgo = dateKeyIn(new Date(now.getTime() - 7 * DAY_MS), timeZone);
    query.where('g.ends_on', '>=', weekAgo);
  }
  const goals = await query;
  const members = await membersOf(goals.map((g) => g.id));
  return Promise.all(goals.map((g) => withProgress(g, members.get(g.id) ?? [], timeZone, now)));
}

export async function findGoal(id, { timeZone, now = new Date() }) {
  const goal = await db('goals').where({ id }).whereNull('archived_at').first();
  if (!goal) return null;
  const members = await membersOf([id]);
  return withProgress(goal, members.get(id) ?? [], timeZone, now);
}

const GOAL_COLUMNS = ['title', 'metric', 'target', 'scope', 'starts_on', 'ends_on', 'reward'];

export async function createGoal({ memberIds, ...fields }, createdBy) {
  return db.transaction(async (trx) => {
    const row = Object.fromEntries(GOAL_COLUMNS.filter((k) => fields[k] !== undefined).map((k) => [k, fields[k]]));
    const [id] = await trx('goals').insert({ ...row, created_by: createdBy });
    await trx('goal_members').insert(memberIds.map((userId) => ({ goal_id: id, user_id: userId })));
    return id;
  });
}

export async function updateGoal(id, { memberIds, ...fields }) {
  return db.transaction(async (trx) => {
    const row = Object.fromEntries(GOAL_COLUMNS.filter((k) => fields[k] !== undefined).map((k) => [k, fields[k]]));
    if (Object.keys(row).length) await trx('goals').where({ id }).update(row);
    if (memberIds) {
      await trx('goal_members').where({ goal_id: id }).delete();
      await trx('goal_members').insert(memberIds.map((userId) => ({ goal_id: id, user_id: userId })));
    }
  });
}

/** Sai do Piso (soft delete). */
export function archiveGoal(id) {
  return db('goals').where({ id }).whereNull('archived_at').update({ archived_at: db.fn.now() });
}
