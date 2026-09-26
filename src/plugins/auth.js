import fastifyJwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { config } from '../config/env.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { findUserById } from '../repositories/userRepository.js';

const MIN_SECRET_LENGTH = 32;

/** Falha na inicialização em vez de subir uma API com tokens fracos. */
export function assertAuthConfig() {
  if (config.auth.jwtSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET ausente ou curto demais (mínimo ${MIN_SECRET_LENGTH} caracteres).`);
  }
}

/**
 * Hook onRequest das rotas protegidas: valida o JWT e carrega o utilizador do banco.
 * Consultar o banco a cada pedido faz com que desativar uma conta ou mudar o seu papel
 * tenha efeito imediato, sem esperar o token expirar.
 */
export async function authenticate(request) {
  let payload;
  try {
    payload = await request.jwtVerify();
  } catch {
    throw unauthorized('Sessão inválida ou expirada. Faça login novamente.');
  }

  const user = Number.isInteger(payload.sub) ? await findUserById(payload.sub) : null;
  if (!user || !user.is_active) throw unauthorized('Conta inexistente ou desativada.');

  request.currentUser = user;
}

/** preHandler que restringe a rota a determinados papéis. Uso: { preHandler: requireRole('admin') } */
export function requireRole(...roles) {
  return async function checkRole(request) {
    if (!roles.includes(request.currentUser?.role)) {
      throw forbidden(`Requer papel: ${roles.join(' ou ')}.`);
    }
  };
}

export const isManager = (user) => user.role === 'admin' || user.role === 'partner';

/** Assina o token de sessão de um utilizador. */
export function signSessionToken(reply, user) {
  return reply.jwtSign({ sub: user.id, role: user.role, name: user.name });
}

/**
 * Registra JWT e rate limit no app raiz (não via app.register), para que
 * request.jwtVerify() fique disponível em todos os contextos.
 */
export async function registerAuth(app) {
  await app.register(fastifyJwt, {
    secret: config.auth.jwtSecret,
    sign: { expiresIn: config.auth.jwtExpiresIn },
  });

  // Rate limit apenas nas rotas que optarem (login), contra força bruta.
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (request, context) => ({
      statusCode: 429,
      code: 'RATE_LIMITED',
      message: `Muitas tentativas. Aguarde ${Math.ceil(context.ttl / 1000)}s e tente novamente.`,
    }),
  });
}
