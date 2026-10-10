import { db } from '../config/database.js';
import { publish } from '../lib/events.js';
import { notFound } from '../lib/errors.js';
import { logActivity } from '../repositories/activityLogRepository.js';
import { getTimeline } from '../repositories/timelineRepository.js';
import { idParam } from './schemas.js';

// Rota (plural) → tipo da entidade nos logs, tabela e tópico de tempo real.
const ENTITIES = {
  clients: { type: 'client', table: 'clients', label: 'Cliente', topic: 'clients' },
  tickets: { type: 'ticket', table: 'tickets', label: 'Chamado', topic: 'tickets' },
  deals: { type: 'deal', table: 'deals', label: 'Negócio', topic: 'deals' },
};

const timelineQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
    before: { type: 'integer', minimum: 1 },
  },
};

const noteBody = {
  type: 'object',
  required: ['text'],
  additionalProperties: false,
  properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } },
};

async function assertExists(entity, id) {
  const row = await db(entity.table).select('id').where({ id }).first();
  if (!row) throw notFound(entity.label);
}

export default async function timelineRoutes(app) {
  for (const [path, entity] of Object.entries(ENTITIES)) {
    // Histórico/auditoria: qualquer membro que acede à entidade vê o seu histórico.
    app.get(`/api/${path}/:id/activity`, { schema: { params: idParam, querystring: timelineQuery } }, async (request) => {
      await assertExists(entity, request.params.id);
      const data = await getTimeline(entity.type, request.params.id, request.query);
      return { data, meta: { next_before: data.length === request.query.limit ? data[data.length - 1].id : null } };
    });

    // Nota manual no histórico (registo de chamada, reunião, combinado com o cliente...).
    app.post(`/api/${path}/:id/notes`, { schema: { params: idParam, body: noteBody } }, async (request, reply) => {
      await assertExists(entity, request.params.id);
      await logActivity(request, {
        action: 'note',
        entityType: entity.type,
        entityId: request.params.id,
        details: { text: request.body.text.trim() },
      });
      publish(entity.topic, request);
      return reply.code(201).send({ data: { message: 'Nota registrada.' } });
    });
  }
}
