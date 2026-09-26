import { createHash, timingSafeEqual } from 'node:crypto';
import fastifyJwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { config } from '../config/env.js';

const MIN_SECRET_LENGTH = 32;

/** Falha na inicialização em vez de subir uma API desprotegida. */
export function assertAuthConfig() {
  const { adminPassword, jwtSecret } = config.auth;
  if (!adminPassword) throw new Error('ADMIN_PASSWORD não definido.');
  if (jwtSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET ausente ou curto demais (mínimo ${MIN_SECRET_LENGTH} caracteres).`);
  }
}

/** Comparação em tempo constante: não vaza, pelo tempo de resposta, quantos caracteres batem. */
function passwordMatches(candidate) {
  const hash = (value) => createHash('sha256').update(String(value)).digest();
  return timingSafeEqual(hash(candidate), hash(config.auth.adminPassword));
}

/** Hook onRequest para rotas protegidas: exige "Authorization: Bearer <token>". */
export async function authenticate(request, reply) {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Sessão inválida ou expirada. Faça login novamente.',
    });
  }
}

/**
 * Registra o JWT e a rota pública POST /api/login.
 * É chamada diretamente com o app raiz (não via app.register) para que
 * request.jwtVerify() fique disponível em todos os contextos, inclusive os protegidos.
 */
export async function registerAuth(app) {
  await app.register(fastifyJwt, {
    secret: config.auth.jwtSecret,
    sign: { expiresIn: config.auth.jwtExpiresIn },
  });

  // Rate limit apenas onde é necessário (login), contra força bruta na senha fixa.
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (request, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Muitas tentativas de login. Aguarde ${Math.ceil(context.ttl / 1000)}s e tente novamente.`,
    }),
  });

  app.post(
    '/api/login',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['senha'],
          additionalProperties: false,
          properties: { senha: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      if (!passwordMatches(request.body.senha)) {
        request.log.warn({ ip: request.ip }, 'Tentativa de login com senha incorreta');
        return reply.code(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Senha incorreta.' });
      }

      const token = await reply.jwtSign({ sub: 'admin', role: 'admin' });
      return { token, expiresIn: config.auth.jwtExpiresIn };
    },
  );
}
