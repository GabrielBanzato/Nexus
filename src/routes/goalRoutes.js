import { config } from '../config/env.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireRole } from '../plugins/auth.js';
import { logActivity } from '../repositories/activityLogRepository.js';
import { GOAL_METRICS, GOAL_SCOPES, archiveGoal, createGoal, findGoal, listGoals, updateGoal } from '../repositories/goalRepository.js';
import { db } from '../config/database.js';
import { idParam } from './schemas.js';

const goalProperties = {
  title: { type: 'string', minLength: 2, maxLength: 160 },
  metric: { type: 'string', enum: GOAL_METRICS },
  target: { type: 'number', exclusiveMinimum: 0, maximum: 999_999_999_999 },
  scope: { type: 'string', enum: GOAL_SCOPES },
  starts_on: { type: 'string', format: 'date' },
  ends_on: { type: 'string', format: 'date' },
  reward: { type: ['string', 'null'], maxLength: 500 },
  member_ids: { type: 'array', minItems: 1, maxItems: 200, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
};

const createSchema = {
  body: {
    type: 'object',
    required: ['title', 'metric', 'target', 'scope', 'starts_on', 'ends_on', 'member_ids'],
    additionalProperties: false,
    properties: goalProperties,
  },
};
const updateSchema = { params: idParam, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: goalProperties } };
const listSchema = {
  querystring: { type: 'object', additionalProperties: false, properties: { include: { type: 'string', enum: ['current', 'all'] } } },
};

const opts = () => ({ timeZone: config.business.timezone });

async function assertMembers(ids) {
  const found = await db('users').whereIn('id', ids).count({ n: '*' }).first();
  if (Number(found.n) !== ids.length) throw badRequest('Há participantes que não existem.');
}

/** Metas / Piso: todos veem as suas; só o admin cria, edita e arquiva. */
export default async function goalRoutes(app) {
  app.get('/api/goals', { schema: listSchema }, async (request) => ({
    data: await listGoals({ viewer: request.currentUser, include: request.query.include, ...opts() }),
  }));

  app.post('/api/goals', { schema: createSchema, preHandler: requireRole('admin') }, async (request, reply) => {
    const { member_ids: memberIds, ...fields } = request.body;
    if (fields.ends_on < fields.starts_on) throw badRequest('A data final tem de ser igual ou depois da inicial.');
    await assertMembers(memberIds);
    const id = await createGoal({ ...fields, reward: fields.reward?.trim() || null, memberIds }, request.currentUser.id);
    await logActivity(request, { action: 'goal.create', entityType: 'goal', entityId: id, details: { title: fields.title, target: fields.target, scope: fields.scope } });
    return reply.code(201).send({ data: await findGoal(id, opts()) });
  });

  app.patch('/api/goals/:id', { schema: updateSchema, preHandler: requireRole('admin') }, async (request) => {
    const current = await findGoal(request.params.id, opts());
    if (!current) throw notFound('Meta');
    const { member_ids: memberIds, ...fields } = request.body;
    if ((fields.ends_on ?? current.ends_on) < (fields.starts_on ?? current.starts_on)) {
      throw badRequest('A data final tem de ser igual ou depois da inicial.');
    }
    if (memberIds) await assertMembers(memberIds);
    if (fields.reward !== undefined) fields.reward = fields.reward?.trim() || null;
    await updateGoal(current.id, { ...fields, memberIds });
    await logActivity(request, { action: 'goal.update', entityType: 'goal', entityId: current.id, details: { title: fields.title ?? current.title } });
    return { data: await findGoal(current.id, opts()) };
  });

  app.delete('/api/goals/:id', { schema: { params: idParam }, preHandler: requireRole('admin') }, async (request, reply) => {
    const archived = await archiveGoal(request.params.id);
    if (!archived) throw notFound('Meta');
    await logActivity(request, { action: 'goal.archive', entityType: 'goal', entityId: request.params.id });
    return reply.code(204).send();
  });
}
