import { publish } from '../lib/events.js';
import { notFound } from '../lib/errors.js';
import { isAdmin, requireRole } from '../plugins/auth.js';
import { logActivity } from '../repositories/activityLogRepository.js';
import { CREATE_STAGES } from '../repositories/dealRepository.js';
import {
  TRIAGE_VIEWS,
  archiveLead,
  assignLead,
  assignLeads,
  decideLead,
  distributeLeads,
  findTriageByLeadId,
  getTriageSummary,
  listTriage,
  requalifyLead,
  restoreLead,
} from '../repositories/triageRepository.js';
import { idParam, nullableId, pagination } from './schemas.js';

/**
 * Lead que o utilizador pode gerir: o admin, qualquer um; os demais, só os da própria fila.
 * Lead de outra pessoa responde 404 (não revela que existe).
 */
async function findOwnTriage(user, leadId) {
  const triage = await findTriageByLeadId(leadId);
  if (!triage || (!isAdmin(user) && triage.assigned_to !== user.id)) throw notFound('Lead');
  return triage;
}

const listSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: TRIAGE_VIEWS, default: 'pending' },
      assigned_to: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', enum: ['none'] }] },
      mine: { type: 'boolean' },
      q: { type: 'string', minLength: 1, maxLength: 100 },
      nicho: { type: 'string', minLength: 1, maxLength: 100 },
      grupo: { type: 'string', enum: ['COM_SITE', 'SEM_SITE'] },
      ...pagination,
    },
  },
};

const distributeSchema = {
  body: {
    type: 'object',
    required: ['user_ids'],
    additionalProperties: false,
    properties: {
      user_ids: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      nicho: { type: 'string', minLength: 1, maxLength: 100 },
      grupo: { type: 'string', enum: ['COM_SITE', 'SEM_SITE'] },
      strategy: { type: 'string', enum: ['balanced', 'round_robin'], default: 'balanced' },
    },
  },
};

const assignSchema = {
  params: idParam,
  body: { type: 'object', required: ['assigned_to'], additionalProperties: false, properties: { assigned_to: nullableId } },
};

const bulkAssignSchema = {
  body: {
    type: 'object',
    required: ['lead_ids', 'assigned_to'],
    additionalProperties: false,
    properties: {
      lead_ids: { type: 'array', minItems: 1, maxItems: 500, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
      assigned_to: nullableId,
    },
  },
};

const decisionSchema = {
  params: idParam,
  body: {
    type: 'object',
    required: ['status'],
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: ['qualified', 'on_hold', 'discarded'] },
      notes: { type: ['string', 'null'], maxLength: 1000 },
      score: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
      hold_until: { type: ['string', 'null'], format: 'date' },
      // Dados do negócio criado ao qualificar (opcionais: há padrões a partir do lead).
      deal: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 2, maxLength: 200 },
          value: { type: 'number', minimum: 0, maximum: 9_999_999_999.99 },
          owner_id: { type: 'integer', minimum: 1 },
          stage: { type: 'string', enum: CREATE_STAGES }, // os outros estágios pedem dados num pop-up (só movendo)
          expected_close_date: { type: ['string', 'null'], format: 'date' },
        },
      },
    },
  },
};

export default async function triageRoutes(app) {
  // Privacidade: partners e agents veem só a própria fila (WHERE assigned_to = <próprio id>);
  // apenas o admin vê tudo e pode filtrar por responsável ("Toda a equipe").
  app.get('/api/triage', { schema: listSchema }, async (request) => {
    const user = request.currentUser;
    const { status, q, nicho, grupo, limit, offset, mine } = request.query;
    const assignedTo = !isAdmin(user) || mine ? user.id : request.query.assigned_to;
    return listTriage({ status, assignedTo, q, nicho, grupo, limit, offset });
  });

  app.get('/api/triage/summary', async (request) => {
    const user = request.currentUser;
    const summary = await getTriageSummary({ assignedTo: isAdmin(user) ? undefined : user.id });
    if (!isAdmin(user)) {
      delete summary.workload; // carga da equipe é visão de gestão
      delete summary.unassigned;
    }
    return { data: summary };
  });

  // Distribuir e reatribuir mexem na fila de outras pessoas: só o admin.
  app.post('/api/triage/distribute', { schema: distributeSchema, preHandler: requireRole('admin') }, async (request) => {
    const { user_ids: userIds, limit, nicho, grupo, strategy } = request.body;
    const result = await distributeLeads({ userIds, limit, nicho, grupo, strategy });
    await logActivity(request, { action: 'triage.distribute', details: { ...result, strategy, filters: { nicho, grupo } } });
    publish('triage', request);
    return { data: result };
  });

  // Ação em massa da Triagem: transfere vários leads de uma vez (uma única UPDATE).
  app.post('/api/triage/assign', { schema: bulkAssignSchema, preHandler: requireRole('admin') }, async (request) => {
    const { lead_ids: leadIds, assigned_to: assignedTo } = request.body;
    const result = await assignLeads(leadIds, assignedTo);
    await logActivity(request, {
      action: 'triage.assign_bulk',
      details: { requested: leadIds.length, assigned: result.assigned, assigned_to: assignedTo },
    });
    publish('triage', request);
    return { data: result };
  });

  app.patch('/api/triage/:id/assign', { schema: assignSchema, preHandler: requireRole('admin') }, async (request) => {
    const triage = await assignLead(request.params.id, request.body.assigned_to);
    await logActivity(request, {
      action: 'triage.assign',
      entityType: 'lead',
      entityId: triage.id,
      details: { name: triage.name, assigned_to: triage.assigned_to_name ?? null },
    });
    publish('triage', request);
    return { data: triage };
  });

  app.post('/api/triage/:id/decision', { schema: decisionSchema }, async (request) => {
    const user = request.currentUser;
    const current = await findTriageByLeadId(request.params.id);
    if (!current) throw notFound('Lead');
    // Fora do admin, só se decide leads da própria fila e os ainda sem responsável. Lead da
    // fila de outra pessoa responde 404, sem revelar de quem é.
    if (!isAdmin(user) && current.assigned_to && current.assigned_to !== user.id) throw notFound('Lead');
    const body = { ...request.body };
    if (body.deal && !isAdmin(user)) delete body.deal.owner_id; // não-admin qualifica para si

    const { triage, deal } = await decideLead(
      request.params.id,
      { status: body.status, notes: body.notes, score: body.score, holdUntil: body.hold_until, deal: body.deal },
      user,
    );

    await logActivity(request, {
      action: `triage.${body.status}`,
      entityType: 'lead',
      entityId: triage.id,
      details: { name: triage.name, score: triage.score ?? undefined, notes: triage.notes ?? undefined, deal_id: deal?.id },
    });
    if (deal) {
      await logActivity(request, {
        action: 'deal.create',
        entityType: 'deal',
        entityId: deal.id,
        details: { title: deal.title, value: deal.value, stage: deal.stage, owner: deal.owner_name, from_lead: triage.id },
      });
      publish('deals', request);
    }
    publish('triage', request);
    return { data: { triage, deal } };
  });

  // Requalificar: devolve o lead à 1.ª coluna do pipeline ("Triagem/Novo"). Ver requalifyLead.
  app.patch('/api/triage/:id/requalify', { schema: { params: idParam } }, async (request) => {
    await findOwnTriage(request.currentUser, request.params.id);
    const { triage, deal, reopened } = await requalifyLead(request.params.id, request.currentUser);

    await logActivity(request, {
      action: 'triage.requalify',
      entityType: 'lead',
      entityId: triage.id,
      details: { name: triage.name, deal_id: deal.id, reopened },
    });
    await logActivity(request, {
      action: reopened ? 'deal.stage' : 'deal.create',
      entityType: 'deal',
      entityId: deal.id,
      details: reopened
        ? { from: 'lost', to: 'lead', value: deal.value, from_lead: triage.id }
        : { title: deal.title, value: deal.value, stage: deal.stage, owner: deal.owner_name, from_lead: triage.id },
    });
    publish('deals', request);
    publish('triage', request);
    return { data: { triage, deal, reopened } };
  });

  // Arquivar: sai da Triagem, mas o registo (estado, notas, negócio, histórico) fica intacto.
  app.patch('/api/triage/:id/archive', { schema: { params: idParam } }, async (request) => {
    await findOwnTriage(request.currentUser, request.params.id);
    const triage = await archiveLead(request.params.id, request.currentUser.id);
    await logActivity(request, {
      action: 'triage.archive',
      entityType: 'lead',
      entityId: triage.id,
      details: { name: triage.name, status: triage.triage_status },
    });
    publish('triage', request);
    return { data: triage };
  });

  // Desfazer o arquivamento (vista "Arquivados" e botão "Desfazer" do aviso).
  app.patch('/api/triage/:id/restore', { schema: { params: idParam } }, async (request) => {
    await findOwnTriage(request.currentUser, request.params.id);
    const triage = await restoreLead(request.params.id);
    await logActivity(request, {
      action: 'triage.restore',
      entityType: 'lead',
      entityId: triage.id,
      details: { name: triage.name, status: triage.triage_status },
    });
    publish('triage', request);
    return { data: triage };
  });
}
