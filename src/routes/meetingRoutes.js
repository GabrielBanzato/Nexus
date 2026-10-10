import { AppError, notFound } from '../lib/errors.js';
import { isAdmin } from '../plugins/auth.js';
import { findClientById } from '../repositories/clientRepository.js';
import { findDealById } from '../repositories/dealRepository.js';
import { createMeeting, findMeetingByCode, findMeetingById, learnPublicOrigin, listUpcomingMeetings, meetingLink, updateMeeting } from '../repositories/meetingRepository.js';
import { logActivity } from '../repositories/activityLogRepository.js';
import { greetingName, instantInviteText, meetingConfirmationText, sendMeetingMessage } from '../services/meetingNotifier.js';
import { idParam } from './schemas.js';

const codeParam = { type: 'object', required: ['code'], properties: { code: { type: 'string', pattern: '^[A-Za-z0-9_-]{6,32}$' } } };

const createSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 2, maxLength: 200 },
      client_id: { type: 'integer', minimum: 1 },
      deal_id: { type: 'integer', minimum: 1 },
      scheduled_at: { type: ['string', 'null'], format: 'date-time' },
      // Envia ao cliente (client_id) o convite ou a confirmação pelo WhatsApp.
      notify: { type: 'boolean', default: false },
    },
  },
};

const listSchema = {
  querystring: { type: 'object', additionalProperties: false, properties: { client_id: { type: 'integer', minimum: 1 } } },
};

const PAST_TOLERANCE_MS = 5 * 60_000;
const MAX_AHEAD_MS = 366 * 24 * 60 * 60_000;

const publicView = (m) => ({ code: m.code, title: m.title, host_name: m.host_name, scheduled_at: m.scheduled_at, status: m.status });
const withLink = (m) => ({ ...m, link: meetingLink(m.code) });

/**
 * Rota PÚBLICA (sem login): o que a página da sala mostra ao convidado antes de entrar.
 * Só dados mínimos; limite por IP contra quem tentasse adivinhar códigos.
 */
export async function publicMeetingRoutes(app) {
  app.get(
    '/api/public/meetings/:code',
    { schema: { params: codeParam }, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const meeting = await findMeetingByCode(request.params.code);
      if (!meeting) throw notFound('Sala');
      return { data: publicView(meeting) };
    },
  );
}

/** Rotas da equipe (protegidas). Mesma privacidade do CRM: admin vê tudo; os demais, o que conduzem. */
export default async function meetingRoutes(app) {
  /**
   * Cria uma sala: para já (botão de vídeo na Central) ou marcada (`scheduled_at`).
   * Com `notify` e um cliente, o servidor envia-lhe pelo WhatsApp, assinado por quem cria, o
   * convite (agora) ou a confirmação com data e hora (marcada). Marcada = lembretes automáticos
   * no dia e 1h antes, ao cliente e a quem conduz (jobs/meetingReminders.js).
   */
  app.post('/api/meetings', { schema: createSchema }, async (request, reply) => {
    const user = request.currentUser;
    learnPublicOrigin(request.headers.origin);
    const { client_id: clientId, deal_id: dealId, scheduled_at: scheduledAtRaw, notify } = request.body;
    let title = request.body.title;

    let client = null;
    if (clientId) {
      client = await findClientById(clientId);
      if (!client || (!isAdmin(user) && client.responsible_id !== user.id)) throw notFound('Cliente');
      title ??= `Reunião com ${client.name}`;
    }
    if (dealId) {
      const deal = await findDealById(dealId);
      if (!deal || (!isAdmin(user) && deal.owner_id !== user.id)) throw notFound('Negócio');
      title ??= `Reunião · ${deal.company || deal.title}`;
    }

    const scheduledAt = scheduledAtRaw ? new Date(scheduledAtRaw) : null;
    if (scheduledAt && scheduledAt.getTime() < Date.now() - PAST_TOLERANCE_MS) {
      throw new AppError(422, 'MEETING_IN_PAST', 'Esse horário já passou. Escolha um horário futuro.');
    }
    if (scheduledAt && scheduledAt.getTime() > Date.now() + MAX_AHEAD_MS) {
      throw new AppError(422, 'MEETING_TOO_FAR', 'A reunião tem de ser dentro dos próximos 12 meses.');
    }

    const meeting = await createMeeting({
      title: title ?? `Reunião de ${user.name}`,
      clientId: clientId ?? null,
      dealId: dealId ?? null,
      hostUserId: user.id,
      scheduledAt,
      createdBy: user.id,
    });

    let notification = { sent: false, reason: 'SKIPPED' };
    if (notify && client) {
      const link = meetingLink(meeting.code);
      const name = greetingName({ contactName: client.name, company: client.company });
      const content = scheduledAt ? meetingConfirmationText({ name, meetingAt: scheduledAt, link }) : instantInviteText({ name, link });
      notification = await sendMeetingMessage({ whatsapp: app.whatsapp, io: app.io, client, content, user, logger: request.log });
    }
    if (scheduledAt) {
      await logActivity(request, {
        action: 'meeting.schedule',
        entityType: client ? 'client' : 'meeting',
        entityId: client?.id ?? meeting.id,
        details: { meeting_id: meeting.id, scheduled_at: scheduledAt.toISOString(), notified: notification.sent },
      });
    }
    return reply.code(201).send({ data: withLink(meeting), meta: { notification } });
  });

  app.get('/api/meetings', { schema: listSchema }, async (request) => {
    const user = request.currentUser;
    const data = await listUpcomingMeetings({ hostUserId: isAdmin(user) ? undefined : user.id, clientId: request.query.client_id });
    return { data: data.map(withLink) };
  });

  // Fecha a sala (o link deixa de funcionar). Quem está dentro sai pelo evento meet:ended.
  app.post('/api/meetings/:id/end', { schema: { params: idParam } }, async (request) => {
    const user = request.currentUser;
    const meeting = await findMeetingById(request.params.id);
    if (!meeting || (!isAdmin(user) && meeting.host_user_id !== user.id)) throw notFound('Sala');
    if (meeting.status === 'ended') throw new AppError(409, 'CONFLICT', 'Esta sala já foi encerrada.');
    await updateMeeting(meeting.id, { status: 'ended', ended_at: new Date() });
    const nsp = app.io.of('/meet');
    nsp.to(`meet:${meeting.id}`).to(`meet-lobby:${meeting.id}`).emit('meet:ended', { by: user.name });
    nsp.in(`meet:${meeting.id}`).disconnectSockets(true);
    nsp.in(`meet-lobby:${meeting.id}`).disconnectSockets(true);
    return { data: withLink(await findMeetingById(meeting.id)) };
  });
}
