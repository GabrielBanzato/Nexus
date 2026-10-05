import Fastify from 'fastify';
import { config } from './config/env.js';
import { db, initDatabase, closeDatabase } from './config/database.js';
import { createScrapeQueue } from './jobs/scrapeQueue.js';
import { registerErrorHandlers } from './lib/errors.js';
import { assertAuthConfig, authenticate, registerAuth } from './plugins/auth.js';
import { registerMeetSignaling } from './plugins/meetSignaling.js';
import { registerSocket, rooms } from './plugins/socket.js';
import { ensureBootstrapAdmin } from './repositories/userRepository.js';
import { createAiAgent } from './services/aiAgent.js';
import { createOllamaClient } from './services/ollamaClient.js';
import { createWhatsAppClient } from './services/whatsappClient.js';
import { createOwnMessageHandler, createWhatsAppInbox } from './services/whatsappInbox.js';
import activityLogRoutes from './routes/activityLogRoutes.js';
import authRoutes from './routes/authRoutes.js';
import clientRoutes from './routes/clientRoutes.js';
import dealRoutes from './routes/dealRoutes.js';
import eventRoutes from './routes/eventRoutes.js';
import kanbanRoutes from './routes/kanbanRoutes.js';
import leadRoutes from './routes/leadRoutes.js';
import meetingRoutes, { publicMeetingRoutes } from './routes/meetingRoutes.js';
import metricsRoutes from './routes/metricsRoutes.js';
import scrapeRoutes from './routes/scrapeRoutes.js';
import ticketRoutes from './routes/ticketRoutes.js';
import timelineRoutes from './routes/timelineRoutes.js';
import triageRoutes from './routes/triageRoutes.js';
import userRoutes from './routes/userRoutes.js';
import whatsappRoutes from './routes/whatsappRoutes.js';

export async function buildApp() {
  assertAuthConfig();

  const app = Fastify({
    logger: { level: config.server.logLevel },
    trustProxy: config.server.trustProxy,
    // Fecha também ligações longas (SSE) no shutdown, senão o 'docker stop' espera o timeout.
    forceCloseConnections: true,
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

  // Socket.io em /api/socket.io (autenticado com o mesmo JWT; usa app.jwt, por isso vem depois).
  const io = registerSocket(app);
  // Videochamadas: sinalização WebRTC no namespace "/meet" (aceita convidados sem conta).
  registerMeetSignaling(app, io);

  // Agente de IA: criado depois do WhatsApp (precisa dele para responder); o inbox chama-o
  // por esta referência.
  let aiAgent = null;
  const inboxOptions = { io, logger: app.log, autoCreateClients: config.whatsapp.autoCreateClients };

  // WhatsApp: só com WHATSAPP_ENABLED=true. Criado aqui e arrancado em start(), depois do banco.
  const whatsapp = config.whatsapp.enabled
    ? createWhatsAppClient({
        sessionDir: config.whatsapp.sessionDir,
        headless: config.whatsapp.headless,
        logger: app.log.child({ module: 'whatsapp' }),
        onMessage: createWhatsAppInbox({ ...inboxOptions, onClientMessage: (event) => aiAgent?.onClientMessage(event) }),
        // Vendedor a responder pelo telemóvel da empresa: grava e pausa a IA nesse cliente.
        onOwnMessage: createOwnMessageHandler(inboxOptions),
        onState: (state) => {
          // Estado completo (inclui o QR) só para os admins...
          io.to(rooms.admins).emit('whatsapp:state', state);
          // ...e só o estado para todos (a Central de Atendimento sabe se pode enviar).
          io.emit('whatsapp:status', { status: state.status });
        },
      })
    : null;
  app.decorate('whatsapp', whatsapp);
  app.addHook('onClose', async () => whatsapp?.stop());

  // IA: só com AI_ENABLED=true e com o WhatsApp ligado (é por ele que responde).
  const ollama = config.ai.enabled
    ? createOllamaClient({ ...config.ai, baseUrl: config.ai.ollamaUrl, logger: app.log.child({ module: 'ai' }) })
    : null;
  if (ollama && whatsapp) {
    aiAgent = createAiAgent({ ...config.ai, ollama, whatsapp, io, logger: app.log.child({ module: 'ai' }) });
    app.addHook('onClose', async () => aiAgent.stop());
  } else if (ollama) {
    app.log.warn('AI_ENABLED=true mas o WhatsApp está desligado: o agente de IA não vai responder.');
  }
  app.decorate('ai', { ollama, agent: aiAgent, model: config.ai.model, enabled: Boolean(aiAgent) });

  // Login (público) + /me, troca de senha e registo (protegidos internamente).
  await app.register(authRoutes);
  // Página da sala para o convidado (público, com limite por IP).
  await app.register(publicMeetingRoutes);

  // Rotas protegidas: tudo registrado neste contexto exige JWT válido de um utilizador ativo.
  await app.register(async (protectedApp) => {
    protectedApp.addHook('onRequest', authenticate);

    // Prospecção
    await protectedApp.register(scrapeRoutes);
    await protectedApp.register(leadRoutes);

    // Gestão de equipe e operações
    await protectedApp.register(userRoutes);
    await protectedApp.register(clientRoutes);
    await protectedApp.register(ticketRoutes);
    await protectedApp.register(kanbanRoutes);
    await protectedApp.register(activityLogRoutes);

    // CRM comercial
    await protectedApp.register(triageRoutes);
    await protectedApp.register(dealRoutes);
    await protectedApp.register(metricsRoutes);
    await protectedApp.register(timelineRoutes);

    // Tempo real (Server-Sent Events)
    await protectedApp.register(eventRoutes);

    // WhatsApp (sessão, QR Code e conversas)
    await protectedApp.register(whatsappRoutes);

    // Videochamadas (salas da equipe)
    await protectedApp.register(meetingRoutes);
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
    // Em segundo plano: o Chrome do WhatsApp leva alguns segundos e não deve atrasar a API.
    app.whatsapp?.start();
    // Idem para a IA: baixa o modelo na primeira vez (~1,9 GB) e deixa-o carregado na RAM.
    if (app.ai.enabled) app.ai.ollama.warmup();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
