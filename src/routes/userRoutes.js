import { publish } from '../lib/events.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { requireRole } from '../plugins/auth.js';
import { disconnectUser } from '../plugins/socket.js';
import { diff, logActivity } from '../repositories/activityLogRepository.js';
import {
  ROLES,
  countActiveAdmins,
  findUserById,
  listUserDirectory,
  listUsers,
  updateUser,
  validateTeamName,
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
      // WhatsApp do membro: recebe os lembretes das reuniões que conduz.
      phone: { type: ['string', 'null'], maxLength: 30, pattern: '^[0-9+()\\s-]*$' },
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
    if (!user) throw notFound('Usuário');
    return { data: user };
  });

  // Utilizadores não são apagados (histórico e FKs): desativa-se com is_active=false.
  app.patch('/api/users/:id', { schema: updateSchema, preHandler: requireRole('admin') }, async (request) => {
    const { id } = request.params;
    const before = await findUserById(id);
    if (!before) throw notFound('Usuário');

    const losesAdmin =
      before.role === 'admin' &&
      before.is_active &&
      ((request.body.role && request.body.role !== 'admin') || request.body.is_active === false);
    if (losesAdmin && (await countActiveAdmins({ excludingId: id })) === 0) {
      throw badRequest('Não é possível remover o último admin ativo.');
    }

    // Assinatura do WhatsApp única: vale ao renomear e ao reativar (volta a contar na equipe).
    const renamed = request.body.name !== undefined && request.body.name.trim() !== before.name;
    const reactivated = request.body.is_active === true && !before.is_active;
    if (renamed || reactivated) {
      const nameProblem = await validateTeamName(request.body.name ?? before.name, { excludingId: id });
      if (nameProblem) throw new AppError(409, nameProblem.code, nameProblem.message);
    }

    let user;
    try {
      user = await updateUser(id, request.body);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw conflict('Já existe uma conta com este email.');
      throw err;
    }

    const changes = diff(before, request.body, ['name', 'email', 'role', 'is_active', 'phone']);
    if (request.body.password) changes.password = 'redefinida';
    await logActivity(request, { action: 'user.update', entityType: 'user', entityId: id, details: changes });
    publish('users', request);
    // Papel ou acesso mudou: as salas do Socket.io têm de ser recalculadas já.
    if (changes.role || changes.is_active) disconnectUser(app.io, id);

    return { data: user };
  });
}
