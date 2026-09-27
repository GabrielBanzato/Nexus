import { LEAD_GROUPS } from '../services/leadClassifier.js';
import { publish } from '../lib/events.js';
import { notFound } from '../lib/errors.js';
import { requireRole } from '../plugins/auth.js';
import { logActivity } from '../repositories/activityLogRepository.js';
import {
  PROSPECT_STATUSES,
  findLeads,
  listSearchTerms,
  setLeadHidden,
  updateLeadStatus,
} from '../repositories/leadRepository.js';

const leadsQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    grupo: { type: 'string', enum: Object.values(LEAD_GROUPS) },
    nicho: { type: 'string', minLength: 1, maxLength: 100 },
    contato: { type: 'string', enum: ['todos', 'contatados', 'nao_contatados'], default: 'todos' },
    visibilidade: { type: 'string', enum: ['ativos', 'ocultos'], default: 'ativos' },
    busca: { type: 'string', minLength: 1, maxLength: 255 },
    limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
};

const idParams = {
  type: 'object',
  properties: { id: { type: 'integer', minimum: 1 } },
};

const updateStatusSchema = {
  params: idParams,
  body: {
    type: 'object',
    required: ['status'],
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: PROSPECT_STATUSES },
      // Opcional: só altera se o status atual for este (evita sobrescrever o avanço de outro vendedor).
      statusAtual: { type: 'string', enum: PROSPECT_STATUSES },
    },
  },
};

const visibilitySchema = {
  params: idParams,
  body: {
    type: 'object',
    required: ['hidden'],
    additionalProperties: false,
    properties: { hidden: { type: 'boolean' } },
  },
};

export default async function leadRoutes(app) {
  // Base bruta do Painel de Prospecção (todos os leads, sem dono): exclusiva do admin.
  // Partners/agents trabalham os leads pela Triagem, já filtrada por responsável.
  app.addHook('preHandler', requireRole('admin'));

  app.get('/api/leads', { schema: { querystring: leadsQuerySchema } }, async (request) => {
    return findLeads(request.query);
  });

  // Pesquisas já feitas no Radar (alimenta o filtro "Pesquisa").
  app.get('/api/leads/searches', async () => ({ data: await listSearchTerms() }));

  app.patch('/api/leads/:id/status', { schema: updateStatusSchema }, async (request, reply) => {
    const { status, statusAtual } = request.body;
    const result = await updateLeadStatus(request.params.id, status, statusAtual);

    if (result.notFound) {
      return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Lead não encontrado.' });
    }
    if (result.conflict) {
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: `O lead já está com status ${result.lead.status_prospeccao}.`,
        lead: result.lead,
      });
    }
    await logActivity(request, {
      action: 'lead.status',
      entityType: 'lead',
      entityId: result.lead.id,
      details: { name: result.lead.name, status },
    });
    return result.lead;
  });

  // Ocultar/arquivar (soft delete) e restaurar. Nunca apaga o registo.
  app.patch('/api/leads/:id/visibility', { schema: visibilitySchema }, async (request) => {
    const lead = await setLeadHidden(request.params.id, request.body.hidden, request.currentUser.id);
    if (!lead) throw notFound('Lead');

    await logActivity(request, {
      action: lead.is_hidden ? 'lead.hide' : 'lead.unhide',
      entityType: 'lead',
      entityId: lead.id,
      details: { name: lead.name },
    });
    publish('triage', request); // leads ocultos saem da fila de triagem
    return lead;
  });
}
