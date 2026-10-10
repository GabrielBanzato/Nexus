import { db } from '../config/database.js';

/**
 * Linha do tempo de uma entidade a partir de activity_logs.
 *  - client: eventos do cliente + dos seus chamados e negócios.
 *  - deal:   eventos do negócio + da triagem do lead que o originou.
 *  - ticket: eventos do chamado.
 */
export async function getTimeline(entityType, id, { limit = 100, before } = {}) {
  const query = db('activity_logs as l')
    .leftJoin('users as u', 'u.id', 'l.user_id')
    .select('l.id', 'l.action', 'l.entity_type', 'l.entity_id', 'l.details', 'l.created_at', 'l.user_id', 'u.name as user_name')
    .where((w) => {
      w.where({ 'l.entity_type': entityType, 'l.entity_id': id });

      if (entityType === 'client') {
        w.orWhere((q) => q.where('l.entity_type', 'ticket').whereIn('l.entity_id', db('tickets').select('id').where({ client_id: id })));
        w.orWhere((q) => q.where('l.entity_type', 'deal').whereIn('l.entity_id', db('deals').select('id').where({ client_id: id })));
      }
      if (entityType === 'deal') {
        w.orWhere((q) =>
          q.where('l.entity_type', 'lead').whereIn('l.entity_id', db('deals').select('lead_id').where({ id }).whereNotNull('lead_id')),
        );
      }
    })
    .orderBy('l.id', 'desc')
    .limit(limit);

  if (before) query.where('l.id', '<', before); // paginação por cursor
  return query;
}
