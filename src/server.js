import Fastify from 'fastify';
import { config } from './config/env.js';
import { db, initDatabase, closeDatabase } from './config/database.js';
import { createMeetingReminders } from './jobs/meetingReminders.js';
import { createScrapeQueue } from './jobs/scrapeQueue.js';
import { scheduleDaily } from './lib/time.js';
import { logActivity } from './repositories/activityLogRepository.js';
import { registerErrorHandlers } from './lib/errors.js';
import { assertAuthConfig, authenticate, registerAuth } from './plugins/auth.js';
import { registerMeetSignaling } from './plugins/meetSignaling.js';
import { registerSocket, rooms } from './plugins/socket.js';
import { ensureBootstrapAdmin } from './repositories/userRepository.js';
import { createAiAgent } from './services/aiAgent.js';
import { createOllamaClient } from './services/ollamaClient.js';
import { createWhatsAppClient } from './services/whatsappClient.js';
import { publicOrigin } from './repositories/meetingRepository.js';
import { createPushService } from './services/pushNotifications.js';
import { createOwnMessageHandler, createWhatsAppInbox } from './services/whatsappInbox.js';
import activityLogRoutes from './routes/activityLogRoutes.js';
import authRoutes from './routes/authRoutes.js';
import clientRoutes from './routes/clientRoutes.js';
import dealRoutes from './routes/dealRoutes.js';
import eventRoutes from './routes/eventRoutes.js';
import kanbanRoutes from './routes/kanbanRoutes.js';
import leadRoutes from './routes/leadRoutes.js';
import meetingRoutes, { publicMeetingRoutes } from './routes/meetingRoutes.js';
import pushRoutes from './routes/pushRoutes.js';
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

  // Assistente de IA (sugere respostas): criado depois do WhatsApp; o inbox chama-o por esta
  // referência a cada mensagem recebida.
  let aiAgent = null;

  // Notificações no telemóvel (Web Push, app instalado). Chaves preparadas em start(), com o banco.
  const push = createPushService({
    logger: app.log.child({ module: 'push' }),
    // Os serviços de push (Apple inclusive) exigem um contacto: o endereço do painel ou o email do admin.
    subject: () => publicOrigin() || `mailto:${config.auth.adminEmail}`,
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
  });
  app.decorate('push', push);

  const inboxOptions = { io, push, logger: app.log, autoCreateClients: config.whatsapp.autoCreateClients };

  /**
   * O WhatsApp ficou sem sessão e precisa do QR Code (reinício diário falhou, ficou preso a
   * sincronizar, ou o número foi desligado no telemóvel): avisa os admins no Nexus e no celular.
   */
  async function notifyNeedsQr(reason) {
    io.to(rooms.admins).emit('whatsapp:needs_qr', { reason });
    await logActivity({}, { action: 'whatsapp.daily_reset', details: { result: reason } }).catch(() => {});
    await push
      .sendToAdmins({
        title: 'WhatsApp desconectado',
        body: 'Leia o QR Code de novo para a Central voltar a enviar e receber mensagens.',
        url: '/#/equipe',
        tag: 'whatsapp-qr',
        always: true,
      })
      .catch(() => {});
  }

  // WhatsApp: só com WHATSAPP_ENABLED=true. Criado aqui e arrancado em start(), depois do banco.
  const whatsapp = config.whatsapp.enabled
    ? createWhatsAppClient({
        sessionDir: config.whatsapp.sessionDir,
        headless: config.whatsapp.headless,
        logger: app.log.child({ module: 'whatsapp' }),
        onMessage: createWhatsAppInbox({ ...inboxOptions, onClientMessage: (event) => aiAgent?.onClientMessage(event) }),
        // Mensagem escrita direto no telemóvel do número: grava-a no histórico do cliente.
        onOwnMessage: createOwnMessageHandler(inboxOptions),
        // Preso a sincronizar mesmo depois de reiniciar: a sessão foi apagada e o painel pede QR.
        onSessionReset: (reason) => notifyNeedsQr(reason),
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

  // Todo dia (7h por padrão) reinicia a ligação ao WhatsApp Web: renova o Chrome (memória) e,
  // se a sessão estiver estragada, apaga-a e pede o QR Code de novo — avisando os admins.
  if (whatsapp && config.whatsapp.dailyRestartHour !== null) {
    const daily = scheduleDaily({
      hour: config.whatsapp.dailyRestartHour,
      timeZone: config.business.timezone,
      logger: app.log,
      task: async () => {
        const result = await whatsapp.restart({ readyTimeoutMs: config.whatsapp.dailyRestartTimeoutMs });
        app.log.info({ result }, 'WhatsApp: reinício diário concluído');
        if (result === 'reset' || result === 'qr') await notifyNeedsQr(result === 'reset' ? 'daily_restart_failed' : 'logged_out');
      },
    });
    app.addHook('onClose', async () => daily.stop());
  }

  // IA: só com AI_ENABLED=true e com o WhatsApp ligado (sugere respostas às conversas dele).
  const ollama = config.ai.enabled
    ? createOllamaClient({ ...config.ai, baseUrl: config.ai.ollamaUrl, logger: app.log.child({ module: 'ai' }) })
    : null;
  if (ollama && whatsapp) {
    aiAgent = createAiAgent({ ...config.ai, ollama, io, logger: app.log.child({ module: 'ai' }) });
    app.addHook('onClose', async () => aiAgent.stop());
  } else if (ollama) {
    app.log.warn('AI_ENABLED=true mas o WhatsApp está desligado: a IA não vai sugerir respostas.');
  }
  app.decorate('ai', { ollama, agent: aiAgent, model: config.ai.model, enabled: Boolean(aiAgent) });

  // Lembretes das reuniões marcadas (no dia e 1h antes), ao cliente e a quem conduz.
  const reminders = createMeetingReminders({
    whatsapp,
    io,
    push,
    logger: app.log.child({ module: 'reminders' }),
    timeZone: config.business.timezone,
    reminderHour: config.business.reminderHour,
  });
  app.decorate('meetingReminders', reminders);
  app.addHook('onClose', async () => reminders.stop());

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

    // Notificações (inscrição dos aparelhos)
    await protectedApp.register(pushRoutes);
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
    await app.push.init();
    await app.listen({ port: config.server.port, host: config.server.host });
    // Em segundo plano: o Chrome do WhatsApp leva alguns segundos e não deve atrasar a API.
    app.whatsapp?.start();
    // Depois do banco pronto (as colunas dos lembretes vêm das migrações).
    app.meetingReminders.start();
    // Idem para a IA: baixa o modelo na primeira vez (~1,9 GB) e deixa-o carregado na RAM.
    if (app.ai.enabled) app.ai.ollama.warmup();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
