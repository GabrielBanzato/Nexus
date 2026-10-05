import { AppError, notFound } from '../lib/errors.js';
import { isAdmin } from '../plugins/auth.js';
import { findClientById } from '../repositories/clientRepository.js';
import { findDealById } from '../repositories/dealRepository.js';
import { createMeeting, findMeetingByCode, findMeetingById, listUpcomingMeetings, meetingLink, updateMeeting } from '../repositories/meetingRepository.js';
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
    },
  },
};

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
  // Cria uma sala (ex.: "Videochamada" na Central de Atendimento, ou avulsa).
  app.post('/api/meetings', { schema: createSchema }, async (request, reply) => {
    const user = request.currentUser;
    const { client_id: clientId, deal_id: dealId, scheduled_at: scheduledAt } = request.body;
    let title = request.body.title;

    if (clientId) {
      const client = await findClientById(clientId);
      if (!client || (!isAdmin(user) && client.responsible_id !== user.id)) throw notFound('Cliente');
      title ??= `Reunião com ${client.name}`;
    }
    if (dealId) {
      const deal = await findDealById(dealId);
      if (!deal || (!isAdmin(user) && deal.owner_id !== user.id)) throw notFound('Negócio');
      title ??= `Reunião · ${deal.company || deal.title}`;
    }

    const meeting = await createMeeting({
      title: title ?? `Reunião de ${user.name}`,
      clientId: clientId ?? null,
      dealId: dealId ?? null,
      hostUserId: user.id,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      createdBy: user.id,
    });
    return reply.code(201).send({ data: withLink(meeting) });
  });

  app.get('/api/meetings', async (request) => {
    const user = request.currentUser;
    const data = await listUpcomingMeetings({ hostUserId: isAdmin(user) ? undefined : user.id });
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
