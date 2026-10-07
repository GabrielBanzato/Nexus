import { randomBytes } from 'node:crypto';
import { db } from '../config/database.js';
import { config } from '../config/env.js';

/**
 * Salas de videochamada. O link (/sala/<code>) é a única "chave" de quem não tem conta (o
 * cliente): o código tem 72 bits aleatórios (12 caracteres base64url), impraticável de adivinhar.
 */
export const newMeetingCode = () => randomBytes(9).toString('base64url');

// Sem PUBLIC_APP_URL, o endereço do painel é aprendido do Origin de quem cria/agenda salas (a
// equipe usa o mesmo endereço que o cliente vai abrir). Perde-se num reinício até ao próximo uso.
let learnedOrigin = null;
export function learnPublicOrigin(origin) {
  if (!config.app.publicUrl && typeof origin === 'string' && /^https?:\/\/[^/\s]+$/.test(origin)) learnedOrigin = origin;
}

/** Link público da sala (para mensagens do servidor). null se o endereço público for desconhecido. */
export const meetingLink = (code) => {
  const base = config.app.publicUrl || learnedOrigin;
  return base ? `${base}/sala/${code}` : null;
};

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
    // Reagendar = lembretes de novo (do dia e de 1h antes) para o novo horário.
    await updateMeeting(open.id, { scheduled_at: scheduledAt, remind_day_sent_at: null, remind_hour_sent_at: null });
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

/** Negócio apagado: as salas dele fecham (o link deixa de valer e não há lembretes). */
export function endMeetingsForDeal(dealId) {
  return db('meetings').where({ deal_id: dealId }).whereNot('status', 'ended').update({ status: 'ended', ended_at: new Date() });
}

/**
 * Próximas salas e as que estão a decorrer (admin: todas; demais: as que conduzem).
 * `clientId`: só as de um cliente (ex.: a próxima reunião na conversa da Central).
 */
export function listUpcomingMeetings({ hostUserId, clientId, limit = 50 } = {}) {
  const query = baseQuery()
    .whereNot('m.status', 'ended')
    .orderByRaw("m.status = 'live' DESC")
    .orderByRaw('m.scheduled_at IS NULL')
    .orderBy('m.scheduled_at')
    .limit(limit);
  if (hostUserId) query.where('m.host_user_id', hostUserId);
  if (clientId) query.where('m.client_id', clientId);
  return query;
}

/**
 * Salas marcadas nas próximas `withinMs` com algum lembrete por enviar. Reunião de negócio só
 * conta enquanto o negócio está em "Reunião Agendada" (moveu-se ou perdeu-se: sem lembretes).
 * O cliente vem da sala ou, se faltar, do negócio.
 */
export function listMeetingsToRemind({ now, withinMs }) {
  return db('meetings as m')
    .leftJoin('deals as d', 'd.id', 'm.deal_id')
    .leftJoin('users as h', 'h.id', 'm.host_user_id')
    .whereNot('m.status', 'ended')
    .where('m.scheduled_at', '>', now)
    .where('m.scheduled_at', '<=', new Date(now.getTime() + withinMs))
    .where((w) => w.whereNull('m.remind_day_sent_at').orWhereNull('m.remind_hour_sent_at'))
    .where((w) => w.whereNull('m.deal_id').orWhere('d.stage', 'meeting'))
    .select(
      'm.id',
      'm.code',
      'm.title',
      'm.scheduled_at',
      'm.created_at',
      'm.remind_day_sent_at',
      'm.remind_hour_sent_at',
      'm.host_user_id',
      db.raw('COALESCE(m.client_id, d.client_id) AS client_id'),
      'd.contact_name',
      'd.company as deal_company',
      'h.name as host_name',
      'h.phone as host_phone',
      'h.is_active as host_active',
    );
}
