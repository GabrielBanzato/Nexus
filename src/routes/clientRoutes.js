import { publish } from '../lib/events.js';
import { forbidden, notFound } from '../lib/errors.js';
import { isManager, requireRole } from '../plugins/auth.js';
import { diff, logActivity } from '../repositories/activityLogRepository.js';
import {
  CLIENT_FIELDS,
  CLIENT_STATUSES,
  createClient,
  deleteClient,
  findClientById,
  listClients,
  updateClient,
} from '../repositories/clientRepository.js';
import { email, idParam, nullableId, pagination } from './schemas.js';

const clientProperties = {
  name: { type: 'string', minLength: 2, maxLength: 160 },
  company: { type: ['string', 'null'], maxLength: 190 },
  phone: { type: ['string', 'null'], maxLength: 30 },
  email: { ...email, type: ['string', 'null'] },
  status: { type: 'string', enum: CLIENT_STATUSES },
  responsible_id: nullableId,
  lead_id: nullableId,
};

const listSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: CLIENT_STATUSES },
      responsible_id: { type: 'integer', minimum: 1 },
      q: { type: 'string', minLength: 1, maxLength: 100 },
      ...pagination,
    },
  },
};

const createSchema = {
  body: { type: 'object', required: ['name'], additionalProperties: false, properties: clientProperties },
};

const updateSchema = {
  params: idParam,
  body: { type: 'object', additionalProperties: false, minProperties: 1, properties: clientProperties },
};

const pick = (source, fields) => Object.fromEntries(fields.filter((f) => source[f] !== undefined).map((f) => [f, source[f]]));

export default async function clientRoutes(app) {
  app.get('/api/clients', { schema: listSchema }, async (request) => {
    const { status, responsible_id: responsibleId, q, limit, offset } = request.query;
    return listClients({ status, responsibleId, q, limit, offset });
  });

  app.get('/api/clients/:id', { schema: { params: idParam } }, async (request) => {
    const client = await findClientById(request.params.id);
    if (!client) throw notFound('Cliente');
    return { data: client };
  });

  app.post('/api/clients', { schema: createSchema }, async (request, reply) => {
    const user = request.currentUser;
    const fields = pick(request.body, CLIENT_FIELDS);

    // Agentes só criam clientes sob a própria responsabilidade.
    if (!isManager(user)) fields.responsible_id = user.id;
    else if (fields.responsible_id === undefined) fields.responsible_id = user.id;

    const client = await createClient(fields);
    await logActivity(request, {
      action: 'client.create',
      entityType: 'client',
      entityId: client.id,
      details: { name: client.name, status: client.status },
    });
    publish('clients', request);
    return reply.code(201).send({ data: client });
  });

  app.patch('/api/clients/:id', { schema: updateSchema }, async (request) => {
    const user = request.currentUser;
    const before = await findClientById(request.params.id);
    if (!before) throw notFound('Cliente');

    if (!isManager(user)) {
      if (before.responsible_id !== user.id) throw forbidden('Só pode editar clientes sob a sua responsabilidade.');
      if (request.body.responsible_id !== undefined && request.body.responsible_id !== user.id) {
        throw forbidden('Apenas admin/partner podem transferir a responsabilidade de um cliente.');
      }
    }

    const fields = pick(request.body, CLIENT_FIELDS);
    const client = await updateClient(before.id, fields);
    await logActivity(request, {
      action: 'client.update',
      entityType: 'client',
      entityId: client.id,
      details: diff(before, fields, CLIENT_FIELDS),
    });
    publish('clients', request);
    return { data: client };
  });

  app.delete(
    '/api/clients/:id',
    { schema: { params: idParam }, preHandler: requireRole('admin', 'partner') },
    async (request, reply) => {
      const before = await findClientById(request.params.id);
      if (!before) throw notFound('Cliente');

      await deleteClient(before.id); // tickets do cliente ficam com client_id = NULL (FK SET NULL)
      await logActivity(request, {
        action: 'client.delete',
        entityType: 'client',
        entityId: before.id,
        details: { name: before.name, company: before.company },
      });
      publish('clients', request);
      return reply.code(204).send();
    },
  );
}
