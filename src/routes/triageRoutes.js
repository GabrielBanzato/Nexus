import { publish } from '../lib/events.js';
import { forbidden, notFound } from '../lib/errors.js';
import { isManager, requireRole } from '../plugins/auth.js';
import { logActivity } from '../repositories/activityLogRepository.js';
import { OPEN_STAGES } from '../repositories/dealRepository.js';
import {
  TRIAGE_STATUSES,
  assignLead,
  decideLead,
  distributeLeads,
  findTriageByLeadId,
  getTriageSummary,
  listTriage,
} from '../repositories/triageRepository.js';
import { idParam, nullableId, pagination } from './schemas.js';

const listSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: TRIAGE_STATUSES, default: 'pending' },
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
          stage: { type: 'string', enum: OPEN_STAGES },
          expected_close_date: { type: ['string', 'null'], format: 'date' },
        },
      },
    },
  },
};

export default async function triageRoutes(app) {
  // Agentes veem só a própria fila; gestores veem tudo (e filtram por responsável).
  app.get('/api/triage', { schema: listSchema }, async (request) => {
    const user = request.currentUser;
    const { status, q, nicho, grupo, limit, offset, mine } = request.query;
    const assignedTo = !isManager(user) || mine ? user.id : request.query.assigned_to;
    return listTriage({ status, assignedTo, q, nicho, grupo, limit, offset });
  });

  app.get('/api/triage/summary', async (request) => {
    const user = request.currentUser;
    const summary = await getTriageSummary({ assignedTo: isManager(user) ? undefined : user.id });
    if (!isManager(user)) {
      delete summary.workload; // carga da equipe é visão de gestão
      delete summary.unassigned;
    }
    return { data: summary };
  });

  app.post('/api/triage/distribute', { schema: distributeSchema, preHandler: requireRole('admin', 'partner') }, async (request) => {
    const { user_ids: userIds, limit, nicho, grupo, strategy } = request.body;
    const result = await distributeLeads({ userIds, limit, nicho, grupo, strategy });
    await logActivity(request, { action: 'triage.distribute', details: { ...result, strategy, filters: { nicho, grupo } } });
    publish('triage', request);
    return { data: result };
  });

  app.patch('/api/triage/:id/assign', { schema: assignSchema, preHandler: requireRole('admin', 'partner') }, async (request) => {
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
    // Agentes decidem os leads da sua fila e os ainda sem responsável (ex.: qualificados no Radar).
    if (!isManager(user) && current.assigned_to && current.assigned_to !== user.id) {
      throw forbidden(`Este lead está na fila de ${current.assigned_to_name ?? 'outro colaborador'}.`);
    }
    const body = { ...request.body };
    if (body.deal && !isManager(user)) delete body.deal.owner_id; // agentes qualificam para si

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
}
