import { publish } from '../lib/events.js';
import { forbidden, notFound } from '../lib/errors.js';
import { isAdmin, requireRole } from '../plugins/auth.js';
import { diff, logActivity } from '../repositories/activityLogRepository.js';
import {
  DEAL_FIELDS,
  DEAL_STAGES,
  OPEN_STAGES,
  createDeal,
  deleteDeal,
  findDealById,
  getDealBoard,
  moveDeal,
  updateDeal,
} from '../repositories/dealRepository.js';
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
    properties: { ...dealProperties, stage: { type: 'string', enum: OPEN_STAGES, default: 'lead' }, lead_id: nullableId },
  },
};

const updateSchema = {
  params: idParam,
  body: { type: 'object', additionalProperties: false, minProperties: 1, properties: dealProperties },
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
    },
  },
};

const pick = (source, fields) => Object.fromEntries(fields.filter((f) => source[f] !== undefined).map((f) => [f, source[f]]));

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

    const fields = pick(request.body, DEAL_FIELDS);
    const deal = await updateDeal(before.id, fields);
    await logActivity(request, {
      action: 'deal.update',
      entityType: 'deal',
      entityId: deal.id,
      details: diff(before, fields, DEAL_FIELDS),
    });
    publish('deals', request);
    return { data: deal };
  });

  // Drag-and-drop entre estágios.
  app.patch('/api/deals/:id/move', { schema: moveSchema }, async (request) => {
    const before = await findAccessibleDeal(request.currentUser, request.params.id);

    const { stage, position, lost_reason: lostReason } = request.body;
    const { deal, from, to, clientCreatedId } = await moveDeal(before.id, { stage, position, lostReason });

    if (from.column !== to.column) {
      const action = to.column === 'won' ? 'deal.won' : to.column === 'lost' ? 'deal.lost' : 'deal.stage';
      await logActivity(request, {
        action,
        entityType: 'deal',
        entityId: deal.id,
        details: { from: from.column, to: to.column, value: deal.value, lost_reason: deal.lost_reason ?? undefined },
      });
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

  // Remover do pipeline devolve o lead de origem à fila da Triagem (ver deleteDeal).
  app.delete('/api/deals/:id', { schema: { params: idParam }, preHandler: requireRole('admin', 'partner') }, async (request, reply) => {
    const existing = await findAccessibleDeal(request.currentUser, request.params.id);
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
