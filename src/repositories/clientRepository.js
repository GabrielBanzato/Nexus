import { db } from '../config/database.js';

export const CLIENT_STATUSES = ['lead', 'active', 'archived'];
export const CLIENT_FIELDS = ['name', 'company', 'phone', 'email', 'status', 'responsible_id', 'lead_id'];

const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

function baseQuery() {
  return db('clients as c')
    .leftJoin('users as u', 'u.id', 'c.responsible_id')
    .select('c.*', 'u.name as responsible_name');
}

export function findClientById(id) {
  return baseQuery().where('c.id', id).first();
}

export async function listClients({ status, responsibleId, q, limit, offset }) {
  const query = db('clients as c');
  if (status) query.where('c.status', status);
  if (responsibleId) query.where('c.responsible_id', responsibleId);
  if (q) {
    const term = `%${escapeLike(q)}%`;
    query.where((w) =>
      w.where('c.name', 'like', term).orWhere('c.company', 'like', term).orWhere('c.email', 'like', term).orWhere('c.phone', 'like', term),
    );
  }

  const [{ total }] = await query.clone().count({ total: '*' });
  const data = await query
    .clone()
    .leftJoin('users as u', 'u.id', 'c.responsible_id')
    .select('c.*', 'u.name as responsible_name')
    .orderBy('c.updated_at', 'desc')
    .limit(limit)
    .offset(offset);

  return { data, meta: { total: Number(total), limit, offset } };
}

export async function createClient(fields) {
  const [id] = await db('clients').insert(fields);
  return findClientById(id);
}

export async function updateClient(id, fields) {
  await db('clients').where({ id }).update(fields);
  return findClientById(id);
}

export function deleteClient(id) {
  return db('clients').where({ id }).delete();
}
