import { db } from '../config/database.js';

export const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
export const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
export const TICKET_FIELDS = ['title', 'description', 'status', 'priority', 'assigned_to', 'client_id'];

const DONE_STATUSES = new Set(['resolved', 'closed']);
const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

function withNames(query) {
  return query
    .leftJoin('users as creator', 'creator.id', 't.created_by')
    .leftJoin('users as assignee', 'assignee.id', 't.assigned_to')
    .leftJoin('clients as c', 'c.id', 't.client_id')
    .select('t.*', 'creator.name as created_by_name', 'assignee.name as assigned_to_name', 'c.name as client_name', 'c.company as client_company');
}

export function findTicketById(id) {
  return withNames(db('tickets as t')).where('t.id', id).first();
}

export async function listTickets({ status, priority, assignedTo, createdBy, clientId, q, limit, offset }) {
  const query = db('tickets as t');
  if (status) query.whereIn('t.status', [].concat(status));
  if (priority) query.where('t.priority', priority);
  if (assignedTo) query.where('t.assigned_to', assignedTo);
  if (createdBy) query.where('t.created_by', createdBy);
  if (clientId) query.where('t.client_id', clientId);
  if (q) {
    const term = `%${escapeLike(q)}%`;
    query.where((w) => w.where('t.title', 'like', term).orWhere('t.description', 'like', term));
  }

  const [{ total }] = await query.clone().count({ total: '*' });
  const data = await withNames(query.clone())
    // Urgentes primeiro, depois os mais recentes.
    .orderByRaw("FIELD(t.priority, 'urgent', 'high', 'medium', 'low')")
    .orderBy('t.created_at', 'desc')
    .limit(limit)
    .offset(offset);

  return { data, meta: { total: Number(total), limit, offset } };
}

/** resolved_at acompanha o status: preenchido ao resolver/fechar, limpo ao reabrir. */
function withResolvedAt(fields, previousStatus) {
  if (!fields.status || fields.status === previousStatus) return fields;
  if (DONE_STATUSES.has(fields.status) && !DONE_STATUSES.has(previousStatus)) {
    return { ...fields, resolved_at: db.fn.now() };
  }
  if (!DONE_STATUSES.has(fields.status)) return { ...fields, resolved_at: null };
  return fields;
}

export async function createTicket(fields) {
  const [id] = await db('tickets').insert(withResolvedAt(fields, null));
  return findTicketById(id);
}

export async function updateTicket(id, fields, previousStatus) {
  await db('tickets').where({ id }).update(withResolvedAt(fields, previousStatus));
  return findTicketById(id);
}

export function deleteTicket(id) {
  return db('tickets').where({ id }).delete();
}
