import { config } from '../config/env.js';
import { badRequest, conflict, unauthorized } from '../lib/errors.js';
import { authenticate, requireRole, signSessionToken } from '../plugins/auth.js';
import { logActivity } from '../repositories/activityLogRepository.js';
import {
  ROLES,
  createUser,
  updateUser,
  verifyCredentials,
  verifyPassword,
} from '../repositories/userRepository.js';
import { email, password } from './schemas.js';

const loginSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', minLength: 3, maxLength: 190 },
      password: { type: 'string', minLength: 1, maxLength: 128 },
    },
  },
};

const registerSchema = {
  body: {
    type: 'object',
    required: ['name', 'email', 'password'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 120 },
      email,
      password,
      role: { type: 'string', enum: ROLES, default: 'agent' },
    },
  },
};

const changePasswordSchema = {
  body: {
    type: 'object',
    required: ['currentPassword', 'newPassword'],
    additionalProperties: false,
    properties: {
      currentPassword: { type: 'string', minLength: 1, maxLength: 128 },
      newPassword: password,
    },
  },
};

// Força bruta: 5 tentativas/min por conta (IP + email). A chave inclui o email para que
// uma equipe inteira atrás do mesmo IP (escritório/NAT) consiga entrar ao mesmo tempo.
// Roda no preHandler porque no onRequest o body (email) ainda não foi lido.
const loginRateLimitPerAccount = {
  max: 5,
  timeWindow: '1 minute',
  hook: 'preHandler',
  keyGenerator: (request) => `login:${request.ip}:${String(request.body?.email ?? '').trim().toLowerCase()}`,
};

export default async function authRoutes(app) {
  // --- Público --------------------------------------------------------------
  app.post(
    '/api/auth/login',
    { schema: loginSchema, config: { rateLimit: loginRateLimitPerAccount } },
    async (request, reply) => {
      const user = await verifyCredentials(request.body.email, request.body.password);
      if (!user) {
        request.log.warn({ ip: request.ip }, 'Tentativa de login inválida');
        throw unauthorized('Email ou senha incorretos.');
      }

      await logActivity(request, { userId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id });
      const token = await signSessionToken(reply, user);
      return { data: { token, expiresIn: config.auth.jwtExpiresIn, user } };
    },
  );

  // --- Autenticado ----------------------------------------------------------
  await app.register(async (priv) => {
    priv.addHook('onRequest', authenticate);

    priv.get('/api/auth/me', async (request) => ({ data: request.currentUser }));

    priv.patch('/api/auth/me/password', { schema: changePasswordSchema }, async (request) => {
      const { currentPassword, newPassword } = request.body;
      if (!(await verifyPassword(request.currentUser.id, currentPassword))) {
        throw badRequest('Senha atual incorreta.');
      }
      if (currentPassword === newPassword) throw badRequest('A nova senha deve ser diferente da atual.');

      await updateUser(request.currentUser.id, { password: newPassword });
      await logActivity(request, { action: 'auth.password_change', entityType: 'user', entityId: request.currentUser.id });
      return { data: { message: 'Senha alterada com sucesso.' } };
    });

    // Registo de contas: só admins (numa ferramenta interna, registo aberto permitiria criar admins).
    priv.post(
      '/api/auth/register',
      { schema: registerSchema, preHandler: requireRole('admin') },
      async (request, reply) => {
        try {
          const user = await createUser(request.body);
          await logActivity(request, {
            action: 'user.create',
            entityType: 'user',
            entityId: user.id,
            details: { email: user.email, role: user.role },
          });
          return reply.code(201).send({ data: user });
        } catch (err) {
          if (err.code === 'ER_DUP_ENTRY') throw conflict('Já existe uma conta com este email.');
          throw err;
        }
      },
    );
  });
}
