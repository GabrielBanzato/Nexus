import { db } from '../config/database.js';

export const SENDER_TYPES = ['client', 'agent', 'bot'];

const COLUMNS = [
  'm.id',
  'm.client_id',
  'm.sender_type',
  'm.content',
  'm.sender_user_id',
  'm.ack',
  'u.name as sender_user_name',
  'm.created_at',
];

const baseQuery = () => db('messages as m').leftJoin('users as u', 'u.id', 'm.sender_user_id').select(COLUMNS);

export function findMessageById(id) {
  return baseQuery().where('m.id', id).first();
}

/**
 * Grava uma mensagem. Com `waMessageId` repetido (o WhatsApp reentrega mensagens quando a
 * sessão reconecta) não duplica nada e devolve null — quem chama não deve reemitir o evento.
 * @returns {Promise<object|null>}
 */
export async function saveMessage({ clientId, senderType, content, waMessageId = null, senderUserId = null, createdAt, ack = null }) {
  const [id] = await db('messages')
    .insert({
      client_id: clientId,
      sender_type: senderType,
      content,
      wa_message_id: waMessageId,
      sender_user_id: senderUserId,
      ack,
      ...(createdAt && { created_at: createdAt }),
    })
    .onConflict('wa_message_id')
    .ignore(); // INSERT IGNORE: duplicado → insertId 0
  return id ? findMessageById(id) : null;
}

const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * Lista da Central de Atendimento: clientes contactáveis (com telefone ou conversa no WhatsApp),
 * com a última mensagem — conversas mais recentes primeiro, depois os clientes sem conversa.
 * `responsibleId` restringe aos clientes de um utilizador (privacidade e modo "Foco").
 * Arquivados ficam de fora, exceto com `includeArchived` (modo "Ver tudo": se trocaram
 * mensagens, aparecem, como no telemóvel).
 */
export async function listConversations({ responsibleId, q, limit = 100, includeArchived = false } = {}) {
  const query = db('clients as c')
    .leftJoin('users as u', 'u.id', 'c.responsible_id')
    // Última mensagem por cliente: MAX(id) usa o índice (client_id, id).
    .leftJoin('messages as lm', 'lm.id', db.raw('(SELECT MAX(x.id) FROM messages x WHERE x.client_id = c.id)'))
    .where((w) => (includeArchived ? w.whereNot('c.status', 'archived').orWhereNotNull('lm.id') : w.whereNot('c.status', 'archived')))
    .where((w) => w.whereNotNull('c.phone').orWhereNotNull('c.whatsapp_jid'))
    .select(
      'c.id',
      'c.name',
      'c.company',
      'c.phone',
      'c.status',
      'c.hold_until',
      'c.responsible_id',
      'u.name as responsible_name',
      'lm.content as last_message',
      'lm.sender_type as last_sender_type',
      'lm.created_at as last_message_at',
    )
    .orderByRaw('lm.id IS NULL') // com conversa primeiro
    .orderBy('lm.id', 'desc')
    .orderBy('c.updated_at', 'desc')
    .limit(limit);

  if (responsibleId) query.where('c.responsible_id', responsibleId);
  if (q) {
    const term = `%${escapeLike(q)}%`;
    query.where((w) => w.where('c.name', 'like', term).orWhere('c.company', 'like', term).orWhere('c.phone', 'like', term));
  }
  return query;
}

/**
 * Conversa de um cliente, paginada "para trás": as `limit` mensagens anteriores a `before`
 * (ou as mais recentes), devolvidas em ordem cronológica para o chat renderizar direto.
 */
/**
 * Estado da mensagem no WhatsApp (✓ enviada, ✓✓ entregue, ✓✓ azul lida). Só avança: um evento
 * atrasado de "entregue" não apaga um "lida".
 * @returns {{ found: boolean, changed: null | { id, client_id, ack } }} found = a mensagem existe no Nexus
 */
export async function updateMessageAck(waMessageId, ack) {
  const key = messageKey(waMessageId);
  if (!key || !(ack >= 1)) return { found: false, changed: null };
  const row = await db('messages')
    .where((w) => w.where('wa_message_id', waMessageId).orWhere('wa_message_id', 'like', `%\\_${escapeLike(key)}`))
    .orderBy('id', 'desc')
    .first('id', 'client_id', 'ack');
  if (!row) return { found: false, changed: null };
  if ((row.ack ?? 0) >= ack) return { found: true, changed: null };
  await db('messages').where({ id: row.id }).update({ ack });
  return { found: true, changed: { id: row.id, client_id: row.client_id, ack } };
}

/**
 * Parte estável do id de uma mensagem do WhatsApp: "true_5511999999999@c.us_3EB0A1B2" e
 * "true_158965480575081@lid_3EB0A1B2" são a MESMA mensagem (o contacto migrou para @lid e o
 * evento de "lida" pode trazer o outro formato). O que não muda é o último pedaço.
 */
export function messageKey(waMessageId) {
  const key = String(waMessageId ?? '').split('_').pop();
  return key && key.length >= 6 ? key : null;
}

export async function listMessages(clientId, { before, limit = 50 } = {}) {
  const rows = await baseQuery()
    .where('m.client_id', clientId)
    .modify((qb) => before && qb.where('m.id', '<', before))
    .orderBy('m.id', 'desc')
    .limit(limit + 1); // +1 só para saber se há mais antigas
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit).reverse();
  return { data, meta: { has_more: hasMore, next_before: hasMore ? data[0].id : null } };
}
