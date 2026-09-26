import Fastify from 'fastify';
import { config } from './config/env.js';
import { db, initDatabase, closeDatabase } from './config/database.js';
import { createScrapeQueue } from './jobs/scrapeQueue.js';
import { registerErrorHandlers } from './lib/errors.js';
import { assertAuthConfig, authenticate, registerAuth } from './plugins/auth.js';
import { ensureBootstrapAdmin } from './repositories/userRepository.js';
import activityLogRoutes from './routes/activityLogRoutes.js';
import authRoutes from './routes/authRoutes.js';
import clientRoutes from './routes/clientRoutes.js';
import kanbanRoutes from './routes/kanbanRoutes.js';
import leadRoutes from './routes/leadRoutes.js';
import scrapeRoutes from './routes/scrapeRoutes.js';
import ticketRoutes from './routes/ticketRoutes.js';
import userRoutes from './routes/userRoutes.js';

export async function buildApp() {
  assertAuthConfig();

  const app = Fastify({
    logger: { level: config.server.logLevel },
    trustProxy: config.server.trustProxy,
    // Aceita "?grupo=sem_site" além de "SEM_SITE".
    ajv: { customOptions: { coerceTypes: true, useDefaults: true } },
  });

  // Antes de qualquer rota: os contextos filhos herdam o handler de erros.
  registerErrorHandlers(app);

  app.addHook('preValidation', async (request) => {
    if (typeof request.query?.grupo === 'string') {
      request.query.grupo = request.query.grupo.toUpperCase();
    }
  });

  app.decorate('scrapeQueue', createScrapeQueue({ logger: app.log }));

  // Usado pelo healthcheck do Docker: só responde 200 se o MySQL também estiver acessível.
  app.get('/health', async (request, reply) => {
    try {
      await db.raw('SELECT 1');
      return { status: 'ok', database: 'up' };
    } catch {
      return reply.code(503).send({ status: 'error', database: 'down' });
    }
  });

  await registerAuth(app);

  // Login (público) + /me, troca de senha e registo (protegidos internamente).
  await app.register(authRoutes);

  // Rotas protegidas: tudo registrado neste contexto exige JWT válido de um utilizador ativo.
  await app.register(async (protectedApp) => {
    protectedApp.addHook('onRequest', authenticate);

    // Prospecção
    await protectedApp.register(scrapeRoutes);
    await protectedApp.register(leadRoutes);

    // Gestão de equipa e operações
    await protectedApp.register(userRoutes);
    await protectedApp.register(clientRoutes);
    await protectedApp.register(ticketRoutes);
    await protectedApp.register(kanbanRoutes);
    await protectedApp.register(activityLogRoutes);
  });

  app.addHook('onClose', async () => closeDatabase());

  return app;
}

async function start() {
  let app;
  try {
    app = await buildApp();
  } catch (err) {
    console.error(`[nexus] Configuração inválida: ${err.message}`);
    process.exit(1);
  }

  const shutdown = async (signal) => {
    app.log.info({ signal }, 'Encerrando servidor');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await initDatabase({ logger: app.log });
    await ensureBootstrapAdmin(app.log);
    await app.listen({ port: config.server.port, host: config.server.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
