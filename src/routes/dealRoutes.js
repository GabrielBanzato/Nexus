import { publish } from '../lib/events.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { isAdmin, requireRole } from '../plugins/auth.js';
import { diff, logActivity } from '../repositories/activityLogRepository.js';
import {
  CREATE_STAGES,
  DEAL_BILLING_FIELDS,
  DEAL_DETAIL_FIELDS,
  DEAL_FIELDS,
  DEAL_STAGES,
  createDeal,
  deleteDeal,
  findDealById,
  getDealBoard,
  moveDeal,
  scheduleMeeting,
  updateDeal,
} from '../repositories/dealRepository.js';
import { endMeetingsForDeal, ensureMeetingForDeal, learnPublicOrigin, meetingLink } from '../repositories/meetingRepository.js';
import { sendMeetingConfirmation } from '../services/meetingNotifier.js';
import { email, idParam, nullableId } from './schemas.js';

const dealProperties = {
  title: { type: 'string', minLength: 2, maxLength: 200 },
  company: { type: ['string', 'null'], maxLength: 190 },
  contact_name: { type: ['string', 'null'], maxLength: 160 },
  phone: { type: ['string', 'null'], maxLength: 30 },
  email: { ...email, type: ['string', 'null'] },
  value: { type: 'number', minimum: 0, maximum: 9_999_999_999.99 },
  owner_id: nullableId,
  client_id: nullableId,
  expected_close_date: { type: ['string', 'null'], format: 'date' },
};

const longText = { type: ['string', 'null'], maxLength: 4000 };
const firstOfMonth = { type: ['string', 'null'], format: 'date', pattern: '-01$' }; // mês = dia 1
// Respostas dos pop-ups (dores/proposta/isca, proposta final, fecho) e mensalidade.
const detailProperties = {
  pains: longText,
  proposal_offer: longText,
  bait: longText,
  final_proposal: longText,
  won_scope: longText,
  delivery_due: { type: ['string', 'null'], format: 'date' },
  monthly_value: { type: 'number', minimum: 0, maximum: 9_999_999.99 },
  monthly_start: firstOfMonth,
  monthly_end: firstOfMonth,
};

const boardSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      owner_id: { type: 'integer', minimum: 1 },
      mine: { type: 'boolean' },
      q: { type: 'string', minLength: 1, maxLength: 100 },
    },
  },
};

const createSchema = {
  body: {
    type: 'object',
    required: ['title'],
    additionalProperties: false,
    properties: { ...dealProperties, stage: { type: 'string', enum: CREATE_STAGES, default: 'lead' }, lead_id: nullableId },
  },
};

const updateSchema = {
  params: idParam,
  body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { ...dealProperties, ...detailProperties } },
};

const moveSchema = {
  params: idParam,
  body: {
    type: 'object',
    required: ['stage'],
    additionalProperties: false,
    properties: {
      stage: { type: 'string', enum: DEAL_STAGES },
      position: { type: 'integer', minimum: 0 }, // omitido = fim do estágio
      lost_reason: { type: ['string', 'null'], maxLength: 255 },
      value: dealProperties.value, // valor negociado (pop-up de fecho / proposta final)
      ...detailProperties,
    },
  },
};

const scheduleSchema = {
  body: {
    type: 'object',
    required: ['deal_id', 'meeting_at'],
    additionalProperties: false,
    properties: {
      deal_id: { type: 'integer', minimum: 1 },
      meeting_at: { type: 'string', format: 'date-time' }, // ISO com fuso (o browser envia em UTC)
      position: { type: 'integer', minimum: 0 }, // onde o card foi largado (omitido = fim da coluna)
      notify: { type: 'boolean', default: true }, // enviar a confirmação por WhatsApp
    },
  },
};
const MEETING_PAST_TOLERANCE_MS = 5 * 60_000; // relógios ligeiramente desacertados
const MEETING_MAX_AHEAD_MS = 366 * 24 * 60 * 60_000;

const pick = (source, fields) => Object.fromEntries(fields.filter((f) => source[f] !== undefined).map((f) => [f, source[f]]));
const filled = (text) => typeof text === 'string' && text.trim().length > 0;
const trimOrNull = (text) => (filled(text) ? text.trim() : null);

const stageError = (message) => new AppError(422, 'STAGE_DETAILS_REQUIRED', message);

/**
 * Dados pedidos pelo pop-up de cada estágio, ao ENTRAR nele (reordenar na mesma coluna não pede).
 * Devolve os campos a gravar com o movimento; lança 422 se faltar algo obrigatório.
 */
function stageFields(stage, body) {
  switch (stage) {
    case 'negotiation':
      if (!filled(body.pains) || !filled(body.proposal_offer) || !filled(body.bait)) {
        throw stageError('Para passar a "Em Negociação", conte as dores do cliente, a proposta real e a isca.');
      }
      return { pains: body.pains.trim(), proposal_offer: body.proposal_offer.trim(), bait: body.bait.trim() };
    case 'awaiting':
      if (!filled(body.final_proposal)) throw stageError('Para passar a "Aguardando Resposta", indique a proposta final apresentada.');
      return { final_proposal: body.final_proposal.trim(), ...(body.value !== undefined ? { value: body.value } : {}) };
    case 'won': {
      if (!filled(body.won_scope) || !(body.value > 0) || !body.delivery_due) {
        throw stageError('Para fechar o cliente, indique o sistema a fazer, o valor negociado e o prazo.');
      }
      const monthly = body.monthly_value ?? 0;
      if (monthly > 0 && !body.monthly_start) throw stageError('Indique o mês da primeira mensalidade.');
      return {
        won_scope: body.won_scope.trim(),
        value: body.value,
        delivery_due: body.delivery_due,
        monthly_value: monthly,
        monthly_start: monthly > 0 ? body.monthly_start : null,
        monthly_end: null,
      };
    }
    case 'lost':
      if (!filled(body.lost_reason)) throw stageError('Indique o motivo da perda.');
      return {};
    default:
      return {};
  }
}

/**
 * Privacidade: fora do admin, cada um só acessa os negócios de que é dono.
 * Negócio de outra pessoa responde 404 (não confirma que o id existe).
 */
async function findAccessibleDeal(user, id) {
  const deal = await findDealById(id);
  if (!deal || (!isAdmin(user) && deal.owner_id !== user.id)) throw notFound('Negócio');
  return deal;
}

export default async function dealRoutes(app) {
  app.get('/api/deals/board', { schema: boardSchema }, async (request) => {
    const user = request.currentUser;
    // Não-admin: WHERE owner_id = <próprio id>, ignorando qualquer owner_id vindo da query.
    const ownerId = !isAdmin(user) || request.query.mine ? user.id : request.query.owner_id;
    // O repositório reaplica o escopo a partir de `viewer` (segunda trava, fail-closed).
    const { board, totals } = await getDealBoard({ viewer: user, ownerId, q: request.query.q });
    return { data: board, meta: { stages: DEAL_STAGES, totals } };
  });

  app.get('/api/deals/:id', { schema: { params: idParam } }, async (request) => {
    return { data: await findAccessibleDeal(request.currentUser, request.params.id) };
  });

  app.post('/api/deals', { schema: createSchema }, async (request, reply) => {
    const user = request.currentUser;
    const fields = { ...pick(request.body, [...DEAL_FIELDS, 'lead_id']), stage: request.body.stage, created_by: user.id };
    // Não-admin cria negócios para si; o admin pode atribuir (sem dono = quem cria).
    if (!isAdmin(user) || fields.owner_id === undefined) fields.owner_id = user.id;

    const deal = await createDeal(fields);
    await logActivity(request, {
      action: 'deal.create',
      entityType: 'deal',
      entityId: deal.id,
      details: { title: deal.title, value: deal.value, stage: deal.stage, owner: deal.owner_name },
    });
    publish('deals', request);
    return reply.code(201).send({ data: deal });
  });

  app.patch('/api/deals/:id', { schema: updateSchema }, async (request) => {
    const user = request.currentUser;
    const before = await findAccessibleDeal(user, request.params.id);
    if (!isAdmin(user) && request.body.owner_id !== undefined && request.body.owner_id !== user.id) {
      throw forbidden('Apenas o admin pode transferir um negócio para outra pessoa.');
    }

    if (!isAdmin(user) && DEAL_BILLING_FIELDS.some((f) => request.body[f] !== undefined)) {
      throw forbidden('Só o admin altera a mensalidade de um negócio fechado.');
    }

    const fields = pick(request.body, [...DEAL_FIELDS, ...DEAL_DETAIL_FIELDS, ...DEAL_BILLING_FIELDS]);
    for (const f of DEAL_DETAIL_FIELDS) if (typeof fields[f] === 'string') fields[f] = trimOrNull(fields[f]);
    const deal = await updateDeal(before.id, fields);
    await logActivity(request, {
      action: 'deal.update',
      entityType: 'deal',
      entityId: deal.id,
      details: diff(before, fields, [...DEAL_FIELDS, ...DEAL_DETAIL_FIELDS, ...DEAL_BILLING_FIELDS]),
    });
    publish('deals', request);
    return { data: deal };
  });

  // Drag-and-drop entre estágios.
  app.patch('/api/deals/:id/move', { schema: moveSchema }, async (request) => {
    const before = await findAccessibleDeal(request.currentUser, request.params.id);

    const { stage, position } = request.body;
    // Entrar em "Reunião Agendada" exige data/hora e envia confirmação: só pela rota própria.
    // Reordenar dentro da própria coluna continua a passar por aqui.
    if (stage === 'meeting' && before.stage !== 'meeting') {
      throw new AppError(422, 'MEETING_REQUIRES_SCHEDULE', 'Para mover para "Reunião Agendada", indique a data e a hora da reunião.');
    }
    const entering = stage !== before.stage;
    const fields = entering ? stageFields(stage, request.body) : {};
    const lostReason = entering && stage === 'lost' ? request.body.lost_reason.trim() : undefined;
    const { deal, from, to, clientCreatedId } = await moveDeal(before.id, { stage, position, lostReason, fields });

    if (from.column !== to.column) {
      const action = to.column === 'won' ? 'deal.won' : to.column === 'lost' ? 'deal.lost' : 'deal.stage';
      await logActivity(request, {
        action,
        entityType: 'deal',
        entityId: deal.id,
        details: { from: from.column, to: to.column, value: deal.value, lost_reason: deal.lost_reason ?? undefined },
      });
      // Admin avisado no telemóvel: fecho (repete até confirmar) e perda (com o motivo).
      if (to.column === 'won') await app.adminAlerts?.dealWon(deal, request.currentUser);
      if (to.column === 'lost') await app.adminAlerts?.dealLost(deal, request.currentUser);
      if (clientCreatedId) {
        await logActivity(request, {
          action: 'client.create',
          entityType: 'client',
          entityId: clientCreatedId,
          details: { name: deal.client_name, from_deal: deal.id },
        });
        publish('clients', request);
      }
    }
    publish('deals', request);
    return { data: deal, meta: { client_created_id: clientCreatedId } };
  });

  /**
   * Agendar (ou reagendar) a reunião: move o negócio para "Reunião Agendada" com a data/hora e,
   * se `notify`, envia ao cliente a confirmação pelo WhatsApp.
   * A reunião fica agendada mesmo que o envio falhe: `meta.notification` diz se a mensagem saiu
   * (e porquê não), para a UI avisar o vendedor.
   */
  app.post('/api/pipeline/schedule-meeting', { schema: scheduleSchema }, async (request) => {
    const user = request.currentUser;
    const { deal_id: dealId, meeting_at: meetingAtRaw, position, notify } = request.body;
    const before = await findAccessibleDeal(user, dealId);

    const meetingAt = new Date(meetingAtRaw);
    if (meetingAt.getTime() < Date.now() - MEETING_PAST_TOLERANCE_MS) {
      throw new AppError(422, 'MEETING_IN_PAST', 'A data da reunião já passou. Escolha uma data futura.');
    }
    if (meetingAt.getTime() > Date.now() + MEETING_MAX_AHEAD_MS) {
      throw new AppError(422, 'MEETING_TOO_FAR', 'A reunião tem de ser dentro dos próximos 12 meses.');
    }

    const { deal, from } = await scheduleMeeting(before.id, { meetingAt, position });
    const hadClient = Boolean(deal.client_id);
    // Sala de videochamada da plataforma: criada (ou reaproveitada ao reagendar, mantendo o link).
    learnPublicOrigin(request.headers.origin);
    const meeting = await ensureMeetingForDeal(deal, { scheduledAt: meetingAt, userId: user.id });
    const link = meetingLink(meeting.code);
    const notification = notify
      ? await sendMeetingConfirmation({ whatsapp: app.whatsapp, io: app.io, deal, meetingAt, link, user, logger: request.log })
      : { sent: false, reason: 'SKIPPED' };

    await logActivity(request, {
      action: 'deal.meeting',
      entityType: 'deal',
      entityId: deal.id,
      details: { from: from.column, meeting_at: meetingAt.toISOString(), notified: notification.sent, reason: notification.reason },
    });
    publish('deals', request);
    // O envio pode ter criado/associado um cliente ao negócio.
    if (!hadClient && notification.client_id) publish('clients', request);

    return { data: await findDealById(deal.id), meta: { notification, meeting: { code: meeting.code, link } } };
  });

  // Remover do pipeline devolve o lead de origem à fila da Triagem (ver deleteDeal).
  app.delete('/api/deals/:id', { schema: { params: idParam }, preHandler: requireRole('admin', 'partner') }, async (request, reply) => {
    const existing = await findAccessibleDeal(request.currentUser, request.params.id);
    await endMeetingsForDeal(existing.id); // antes: a FK zera deal_id e a sala ficaria órfã (com lembretes)
    const removed = await deleteDeal(existing.id);
    await logActivity(request, {
      action: 'deal.delete',
      entityType: 'deal',
      entityId: removed.id,
      details: { title: removed.title, value: removed.value, stage: removed.stage, requeued_lead_id: removed.requeued_lead_id ?? undefined },
    });
    if (removed.requeued_lead_id) {
      await logActivity(request, {
        action: 'triage.requeue',
        entityType: 'lead',
        entityId: removed.requeued_lead_id,
        details: { from_deal: removed.id, title: removed.title },
      });
      publish('triage', request);
    }
    publish('deals', request);
    return reply.code(204).send();
  });
}
