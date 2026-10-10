import { publish } from '../lib/events.js';
import { forbidden, notFound } from '../lib/errors.js';
import { isAdmin, requireRole } from '../plugins/auth.js';
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
  // Em espera: retomar a partir deste dia (opcional; como o "Espera" da Triagem).
  hold_until: { type: ['string', 'null'], format: 'date' },
  responsible_id: nullableId,
  lead_id: nullableId,
  // false = um humano assumiu a conversa no WhatsApp e a IA não deve responder.
  bot_active: { type: 'boolean' },
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

/**
 * Privacidade (o mesmo número de WhatsApp é partilhado pela equipe): cada parceiro trabalha
 * as SUAS empresas e não vê as dos outros. Admin vê tudo; os demais, só os clientes de que
 * são responsáveis. Cliente de outra pessoa responde 404 (não confirma que existe).
 */
async function findAccessibleClient(user, id) {
  const client = await findClientById(id);
  if (!client || (!isAdmin(user) && client.responsible_id !== user.id)) throw notFound('Cliente');
  return client;
}

export default async function clientRoutes(app) {
  app.get('/api/clients', { schema: listSchema }, async (request) => {
    const user = request.currentUser;
    const { status, q, limit, offset } = request.query;
    // Não-admin: SEMPRE os próprios, ignorando o responsible_id vindo da query.
    const responsibleId = isAdmin(user) ? request.query.responsible_id : user.id;
    return listClients({ status, responsibleId, q, limit, offset });
  });

  app.get('/api/clients/:id', { schema: { params: idParam } }, async (request) => {
    return { data: await findAccessibleClient(request.currentUser, request.params.id) };
  });

  app.post('/api/clients', { schema: createSchema }, async (request, reply) => {
    const user = request.currentUser;
    const fields = pick(request.body, CLIENT_FIELDS);

    // Só o admin cria clientes para outra pessoa (os demais criam para si).
    if (!isAdmin(user) || fields.responsible_id === undefined) fields.responsible_id = user.id;

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
    const before = await findAccessibleClient(user, request.params.id);
    // Transferir uma empresa para outro parceiro (ou atribuir uma conversa nova): só o admin.
    if (!isAdmin(user) && request.body.responsible_id !== undefined && request.body.responsible_id !== user.id) {
      throw forbidden('Apenas o admin pode transferir um cliente para outra pessoa.');
    }

    const fields = pick(request.body, CLIENT_FIELDS);
    // Saiu de "Em espera": a data de retomar deixa de fazer sentido.
    if (fields.status && fields.status !== 'on_hold') fields.hold_until = null;
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
      // Partner apaga só os seus; admin qualquer um.
      const before = await findAccessibleClient(request.currentUser, request.params.id);

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
