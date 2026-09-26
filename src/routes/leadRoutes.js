import { LEAD_GROUPS } from '../services/leadClassifier.js';
import { logActivity } from '../repositories/activityLogRepository.js';
import { PROSPECT_STATUSES, findLeads, updateLeadStatus } from '../repositories/leadRepository.js';

const leadsQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    grupo: { type: 'string', enum: Object.values(LEAD_GROUPS) },
    nicho: { type: 'string', minLength: 1, maxLength: 100 },
    limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
};

const updateStatusSchema = {
  params: {
    type: 'object',
    properties: { id: { type: 'integer', minimum: 1 } },
  },
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

export default async function leadRoutes(app) {
  app.get('/api/leads', { schema: { querystring: leadsQuerySchema } }, async (request) => {
    return findLeads(request.query);
  });

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
}
