import { badRequest, conflict, notFound } from '../lib/errors.js';
import { requireRole } from '../plugins/auth.js';
import { diff, logActivity } from '../repositories/activityLogRepository.js';
import {
  ROLES,
  countActiveAdmins,
  findUserById,
  listUserDirectory,
  listUsers,
  updateUser,
} from '../repositories/userRepository.js';
import { email, idParam, pagination, password } from './schemas.js';

const listSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      role: { type: 'string', enum: ROLES },
      active: { type: 'boolean' },
      ...pagination,
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
      name: { type: 'string', minLength: 2, maxLength: 120 },
      email,
      role: { type: 'string', enum: ROLES },
      is_active: { type: 'boolean' },
      password, // redefinição de senha pelo admin
    },
  },
};

export default async function userRoutes(app) {
  // Diretório para selects (responsável, atribuído): qualquer utilizador autenticado.
  // Expõe só id, nome e papel — sem email nem dados de acesso.
  app.get('/api/users/directory', async () => ({ data: await listUserDirectory() }));

  app.get('/api/users', { schema: listSchema, preHandler: requireRole('admin', 'partner') }, async (request) => {
    const { role, active, limit, offset } = request.query;
    return listUsers({ role, active, limit, offset });
  });

  app.get('/api/users/:id', { schema: { params: idParam }, preHandler: requireRole('admin', 'partner') }, async (request) => {
    const user = await findUserById(request.params.id);
    if (!user) throw notFound('Utilizador');
    return { data: user };
  });

  // Utilizadores não são apagados (histórico e FKs): desativa-se com is_active=false.
  app.patch('/api/users/:id', { schema: updateSchema, preHandler: requireRole('admin') }, async (request) => {
    const { id } = request.params;
    const before = await findUserById(id);
    if (!before) throw notFound('Utilizador');

    const losesAdmin =
      before.role === 'admin' &&
      before.is_active &&
      ((request.body.role && request.body.role !== 'admin') || request.body.is_active === false);
    if (losesAdmin && (await countActiveAdmins({ excludingId: id })) === 0) {
      throw badRequest('Não é possível remover o último admin ativo.');
    }

    let user;
    try {
      user = await updateUser(id, request.body);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw conflict('Já existe uma conta com este email.');
      throw err;
    }

    const changes = diff(before, request.body, ['name', 'email', 'role', 'is_active']);
    if (request.body.password) changes.password = 'redefinida';
    await logActivity(request, { action: 'user.update', entityType: 'user', entityId: id, details: changes });

    return { data: user };
  });
}
