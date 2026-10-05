import { randomBytes } from 'node:crypto';
import { db } from '../config/database.js';
import { config } from '../config/env.js';

/**
 * Salas de videochamada. O link (/sala/<code>) é a única "chave" de quem não tem conta (o
 * cliente): o código tem 72 bits aleatórios (12 caracteres base64url), impraticável de adivinhar.
 */
export const newMeetingCode = () => randomBytes(9).toString('base64url');

/** Link público da sala (para mensagens do servidor). null se PUBLIC_APP_URL não estiver definido. */
export const meetingLink = (code) => (config.app.publicUrl ? `${config.app.publicUrl}/sala/${code}` : null);

const baseQuery = () =>
  db('meetings as m')
    .leftJoin('users as h', 'h.id', 'm.host_user_id')
    .leftJoin('clients as c', 'c.id', 'm.client_id')
    .select('m.*', 'h.name as host_name', 'c.name as client_name');

export const findMeetingById = (id) => baseQuery().where('m.id', id).first();
export const findMeetingByCode = (code) => baseQuery().where('m.code', code).first();

export async function createMeeting({ title, dealId = null, clientId = null, hostUserId, scheduledAt = null, createdBy }) {
  const [id] = await db('meetings').insert({
    code: newMeetingCode(),
    title: title.slice(0, 200),
    deal_id: dealId,
    client_id: clientId,
    host_user_id: hostUserId,
    scheduled_at: scheduledAt,
    created_by: createdBy,
  });
  return findMeetingById(id);
}

export function updateMeeting(id, fields) {
  return db('meetings').where({ id }).update(fields);
}

/**
 * Sala do negócio: reaproveita a que ainda não terminou (reagendar mantém o mesmo link que o
 * cliente já recebeu) ou cria uma. Conduz o dono do negócio.
 */
export async function ensureMeetingForDeal(deal, { scheduledAt, userId }) {
  const open = await db('meetings').where({ deal_id: deal.id }).whereNot('status', 'ended').orderBy('id', 'desc').first('id');
  if (open) {
    await updateMeeting(open.id, { scheduled_at: scheduledAt });
    return findMeetingById(open.id);
  }
  return createMeeting({
    title: `Reunião · ${deal.company || deal.title}`,
    dealId: deal.id,
    clientId: deal.client_id ?? null,
    hostUserId: deal.owner_id ?? userId,
    scheduledAt,
    createdBy: userId,
  });
}

/** Próximas salas e as que estão a decorrer (admin: todas; demais: as que conduzem). */
export function listUpcomingMeetings({ hostUserId, limit = 50 } = {}) {
  const query = baseQuery()
    .whereNot('m.status', 'ended')
    .orderByRaw("m.status = 'live' DESC")
    .orderByRaw('m.scheduled_at IS NULL')
    .orderBy('m.scheduled_at')
    .limit(limit);
  if (hostUserId) query.where('m.host_user_id', hostUserId);
  return query;
}
