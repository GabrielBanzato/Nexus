import { publish } from '../lib/events.js';
import { forbidden, notFound } from '../lib/errors.js';
import { isManager, requireRole } from '../plugins/auth.js';
import { diff, logActivity } from '../repositories/activityLogRepository.js';
import {
  TICKET_FIELDS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  createTicket,
  deleteTicket,
  findTicketById,
  listTickets,
  updateTicket,
} from '../repositories/ticketRepository.js';
import { idParam, nullableId, pagination } from './schemas.js';

const ticketProperties = {
  title: { type: 'string', minLength: 3, maxLength: 200 },
  description: { type: ['string', 'null'], maxLength: 10_000 },
  status: { type: 'string', enum: TICKET_STATUSES },
  priority: { type: 'string', enum: TICKET_PRIORITIES },
  assigned_to: nullableId,
  client_id: nullableId,
};

const listSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: TICKET_STATUSES },
      priority: { type: 'string', enum: TICKET_PRIORITIES },
      assigned_to: { type: 'integer', minimum: 1 },
      created_by: { type: 'integer', minimum: 1 },
      client_id: { type: 'integer', minimum: 1 },
      mine: { type: 'boolean', description: 'Apenas chamados atribuídos a mim' },
      open_only: { type: 'boolean', description: 'Apenas open e in_progress' },
      q: { type: 'string', minLength: 1, maxLength: 100 },
      ...pagination,
    },
  },
};

const createSchema = {
  body: { type: 'object', required: ['title'], additionalProperties: false, properties: ticketProperties },
};

const updateSchema = {
  params: idParam,
  body: { type: 'object', additionalProperties: false, minProperties: 1, properties: ticketProperties },
};

const pick = (source, fields) => Object.fromEntries(fields.filter((f) => source[f] !== undefined).map((f) => [f, source[f]]));

/** Agentes só alteram chamados que abriram ou que lhes foram atribuídos. */
function assertCanEdit(user, ticket) {
  if (isManager(user)) return;
  if (ticket.created_by !== user.id && ticket.assigned_to !== user.id) {
    throw forbidden('Só pode alterar chamados que abriu ou que lhe foram atribuídos.');
  }
}

export default async function ticketRoutes(app) {
  app.get('/api/tickets', { schema: listSchema }, async (request) => {
    const { q, limit, offset, mine, open_only: openOnly } = request.query;
    return listTickets({
      status: openOnly ? ['open', 'in_progress'] : request.query.status,
      priority: request.query.priority,
      assignedTo: mine ? request.currentUser.id : request.query.assigned_to,
      createdBy: request.query.created_by,
      clientId: request.query.client_id,
      q,
      limit,
      offset,
    });
  });

  app.get('/api/tickets/:id', { schema: { params: idParam } }, async (request) => {
    const ticket = await findTicketById(request.params.id);
    if (!ticket) throw notFound('Chamado');
    return { data: ticket };
  });

  app.post('/api/tickets', { schema: createSchema }, async (request, reply) => {
    const fields = { ...pick(request.body, TICKET_FIELDS), created_by: request.currentUser.id };
    const ticket = await createTicket(fields);
    await logActivity(request, {
      action: 'ticket.create',
      entityType: 'ticket',
      entityId: ticket.id,
      details: { title: ticket.title, priority: ticket.priority, assigned_to: ticket.assigned_to },
    });
    publish('tickets', request);
    return reply.code(201).send({ data: ticket });
  });

  app.patch('/api/tickets/:id', { schema: updateSchema }, async (request) => {
    const before = await findTicketById(request.params.id);
    if (!before) throw notFound('Chamado');
    assertCanEdit(request.currentUser, before);

    const fields = pick(request.body, TICKET_FIELDS);
    const ticket = await updateTicket(before.id, fields, before.status);
    await logActivity(request, {
      action: fields.status && fields.status !== before.status ? `ticket.status.${fields.status}` : 'ticket.update',
      entityType: 'ticket',
      entityId: ticket.id,
      details: diff(before, fields, TICKET_FIELDS.filter((f) => f !== 'description')),
    });
    publish('tickets', request);
    return { data: ticket };
  });

  app.delete('/api/tickets/:id', { schema: { params: idParam }, preHandler: requireRole('admin') }, async (request, reply) => {
    const before = await findTicketById(request.params.id);
    if (!before) throw notFound('Chamado');

    await deleteTicket(before.id);
    await logActivity(request, {
      action: 'ticket.delete',
      entityType: 'ticket',
      entityId: before.id,
      details: { title: before.title },
    });
    publish('tickets', request);
    return reply.code(204).send();
  });
}
