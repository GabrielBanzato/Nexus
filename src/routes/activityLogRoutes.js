import { requireRole } from '../plugins/auth.js';
import { listActivityLogs } from '../repositories/activityLogRepository.js';
import { pagination } from './schemas.js';

const listSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      user_id: { type: 'integer', minimum: 1 },
      action: { type: 'string', minLength: 1, maxLength: 64, description: 'Prefixo, ex: "ticket" ou "kanban.move"' },
      entity_type: { type: 'string', enum: ['user', 'client', 'ticket', 'kanban_task', 'lead', 'deal'] },
      entity_id: { type: 'integer', minimum: 1 },
      ...pagination,
    },
  },
};

export default async function activityLogRoutes(app) {
  app.get('/api/activity-logs', { schema: listSchema, preHandler: requireRole('admin', 'partner') }, async (request) => {
    const { user_id: userId, action, entity_type: entityType, entity_id: entityId, limit, offset } = request.query;
    return listActivityLogs({ userId, action, entityType, entityId, limit, offset });
  });
}
