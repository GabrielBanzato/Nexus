import { publish } from '../lib/events.js';
import { forbidden, notFound } from '../lib/errors.js';
import { isManager } from '../plugins/auth.js';
import { diff, logActivity } from '../repositories/activityLogRepository.js';
import {
  KANBAN_COLUMNS,
  createTask,
  deleteTask,
  findTaskById,
  getBoard,
  moveTask,
  updateTask,
} from '../repositories/kanbanRepository.js';
import { idParam, nullableId } from './schemas.js';

const CONTENT_FIELDS = ['title', 'description', 'responsible_id'];

const createSchema = {
  body: {
    type: 'object',
    required: ['title'],
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      description: { type: ['string', 'null'], maxLength: 10_000 },
      column_name: { type: 'string', enum: KANBAN_COLUMNS, default: 'todo' },
      position: { type: 'integer', minimum: 0 },
      responsible_id: nullableId,
    },
  },
};

const updateSchema = {
  params: idParam,
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      description: { type: ['string', 'null'], maxLength: 10_000 },
      responsible_id: nullableId,
    },
  },
};

// Drag-and-drop: coluna de destino + índice de destino dentro dela (0 = topo).
const moveSchema = {
  params: idParam,
  body: {
    type: 'object',
    required: ['position'],
    additionalProperties: false,
    properties: {
      column_name: { type: 'string', enum: KANBAN_COLUMNS },
      position: { type: 'integer', minimum: 0 },
    },
  },
};

const pick = (source, fields) => Object.fromEntries(fields.filter((f) => source[f] !== undefined).map((f) => [f, source[f]]));

export default async function kanbanRoutes(app) {
  app.get(
    '/api/kanban',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { responsible_id: { type: 'integer', minimum: 1 }, mine: { type: 'boolean' } },
        },
      },
    },
    async (request) => {
      const responsibleId = request.query.mine ? request.currentUser.id : request.query.responsible_id;
      return { data: await getBoard({ responsibleId }), meta: { columns: KANBAN_COLUMNS } };
    },
  );

  app.post('/api/kanban/tasks', { schema: createSchema }, async (request, reply) => {
    const task = await createTask({ ...request.body, created_by: request.currentUser.id });
    await logActivity(request, {
      action: 'kanban.create',
      entityType: 'kanban_task',
      entityId: task.id,
      details: { title: task.title, column: task.column_name },
    });
    publish('kanban', request);
    return reply.code(201).send({ data: task });
  });

  app.patch('/api/kanban/tasks/:id', { schema: updateSchema }, async (request) => {
    const before = await findTaskById(request.params.id);
    if (!before) throw notFound('Tarefa');

    const fields = pick(request.body, CONTENT_FIELDS);
    const task = await updateTask(before.id, fields);
    await logActivity(request, {
      action: 'kanban.update',
      entityType: 'kanban_task',
      entityId: task.id,
      details: diff(before, fields, ['title', 'responsible_id']),
    });
    publish('kanban', request);
    return { data: task };
  });

  // Endpoint do drag-and-drop.
  app.patch('/api/kanban/tasks/:id/move', { schema: moveSchema }, async (request) => {
    const { task, from } = await moveTask(request.params.id, {
      column: request.body.column_name,
      position: request.body.position,
    });

    if (from.column !== task.column_name || from.position !== task.position) {
      await logActivity(request, {
        action: 'kanban.move',
        entityType: 'kanban_task',
        entityId: task.id,
        details: { from, to: { column: task.column_name, position: task.position } },
      });
      publish('kanban', request);
    }
    return { data: task };
  });

  app.delete('/api/kanban/tasks/:id', { schema: { params: idParam } }, async (request, reply) => {
    const user = request.currentUser;
    const existing = await findTaskById(request.params.id);
    if (!existing) throw notFound('Tarefa');
    if (!isManager(user) && existing.responsible_id !== user.id && existing.created_by !== user.id) {
      throw forbidden('Só pode apagar tarefas que criou ou pelas quais é responsável.');
    }

    const task = await deleteTask(existing.id);
    await logActivity(request, {
      action: 'kanban.delete',
      entityType: 'kanban_task',
      entityId: existing.id,
      details: { title: task.title, column: task.column_name },
    });
    publish('kanban', request);
    return reply.code(204).send();
  });
}
