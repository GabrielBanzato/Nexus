import { db } from '../config/database.js';

/**
 * Regista uma ação no log de atividade.
 * Falhas aqui nunca derrubam a operação principal: apenas geram um aviso no log do servidor.
 */
export async function logActivity(request, { action, entityType = null, entityId = null, details = null, userId }) {
  try {
    await db('activity_logs').insert({
      user_id: userId ?? request.currentUser?.id ?? null,
      action,
      entity_type: entityType,
      entity_id: entityId,
      details: details ? JSON.stringify(details) : null,
      ip: request.ip,
    });
  } catch (err) {
    request.log.warn({ err, action }, 'Falha ao gravar activity log');
  }
}

/** Diferença campo a campo entre o antes e o depois (para o `details` do log). */
export function diff(before, after, fields) {
  const changes = {};
  for (const field of fields) {
    if (after[field] !== undefined && String(before[field]) !== String(after[field])) {
      changes[field] = { from: before[field], to: after[field] };
    }
  }
  return changes;
}

export async function listActivityLogs({ userId, action, entityType, entityId, limit, offset }) {
  const query = db('activity_logs as l').leftJoin('users as u', 'u.id', 'l.user_id');
  if (userId) query.where('l.user_id', userId);
  if (action) query.where('l.action', 'like', `${action}%`);
  if (entityType) query.where('l.entity_type', entityType);
  if (entityId) query.where('l.entity_id', entityId);

  const [{ total }] = await query.clone().count({ total: '*' });
  const data = await query
    .clone()
    .select('l.id', 'l.user_id', 'u.name as user_name', 'l.action', 'l.entity_type', 'l.entity_id', 'l.details', 'l.ip', 'l.created_at')
    .orderBy('l.id', 'desc')
    .limit(limit)
    .offset(offset);

  return { data, meta: { total: Number(total), limit, offset } };
}
