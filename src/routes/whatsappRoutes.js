import { db } from '../config/database.js';
import { publish } from '../lib/events.js';
import { AppError, notFound } from '../lib/errors.js';
import { isAdmin, requireRole } from '../plugins/auth.js';
import { clientAudience } from '../plugins/socket.js';
import { logActivity } from '../repositories/activityLogRepository.js';
import { findClientById } from '../repositories/clientRepository.js';
import { listConversations, listMessages } from '../repositories/messageRepository.js';
import { clientSummary } from '../services/whatsappInbox.js';
import { sendToClient, whatsappSignature } from '../services/whatsappOutbox.js';
import { idParam } from './schemas.js';

/** Cliente que o utilizador pode ver: admin qualquer um; os demais, só os seus (senão 404). */
async function findAccessibleClient(user, id) {
  const client = await findClientById(id);
  if (!client || (!isAdmin(user) && client.responsible_id !== user.id)) throw notFound('Cliente');
  return client;
}

const conversationsSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      q: { type: 'string', minLength: 1, maxLength: 100 },
      limit: { type: 'integer', minimum: 1, maximum: 300, default: 150 },
    },
  },
};

const sendSchema = {
  params: idParam,
  body: {
    type: 'object',
    required: ['content'],
    additionalProperties: false,
    // 4096 = limite prático de uma mensagem de texto no WhatsApp.
    properties: { content: { type: 'string', minLength: 1, maxLength: 4096, pattern: '\\S' } },
  },
};

const botStatusSchema = {
  params: idParam,
  body: {
    type: 'object',
    required: ['bot_active'],
    additionalProperties: false,
    properties: { bot_active: { type: 'boolean' } },
  },
};

const disabled = () =>
  new AppError(503, 'WHATSAPP_DISABLED', 'A integração com o WhatsApp está desligada (defina WHATSAPP_ENABLED=true no servidor).');

const messagesSchema = {
  params: idParam,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      before: { type: 'integer', minimum: 1 }, // id da mensagem mais antiga já carregada
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    },
  },
};

export default async function whatsappRoutes(app) {
  const sessionOnly = { preHandler: requireRole('admin') };

  const requireService = () => {
    if (!app.whatsapp) throw disabled();
    return app.whatsapp;
  };

  /**
   * QR Code para ligar o número da empresa. `qr` é um data URL (PNG) para <img src>; vem null
   * quando não há QR a mostrar (a iniciar, já ligado...). O QR renova-se a cada ~20s: o painel
   * pode voltar a pedir, ou ouvir `whatsapp:state` no Socket.io (sala dos admins).
   * Exclusivo do admin: quem lê o QR liga um aparelho à conta de WhatsApp da empresa.
   */
  app.get('/api/whatsapp/qr', sessionOnly, async (request, reply) => {
    const { status, qr, qr_updated_at: qrUpdatedAt } = requireService().getState();
    reply.header('Cache-Control', 'no-store');
    return { data: { status, qr, qr_updated_at: qrUpdatedAt } };
  });

  // Estado do agente de IA (admin): Ollama no ar, modelo baixado/carregado, última resposta.
  app.get('/api/ai/status', sessionOnly, async () => {
    const ai = app.ai;
    if (!ai?.ollama) return { data: { enabled: false, model: ai?.model ?? null } };
    return {
      data: {
        enabled: ai.enabled,
        model: ai.model,
        ...(await ai.ollama.status()),
        last_reply: ai.agent?.lastResult() ?? null,
      },
    };
  });

  app.get('/api/whatsapp/status', sessionOnly, async () => {
    const { qr, ...state } = requireService().getState();
    return { data: { ...state, has_qr: Boolean(qr), enabled: true } };
  });

  // Desliga o número atual (ex.: trocar de telemóvel). Em seguida é gerado um QR novo.
  app.post('/api/whatsapp/logout', sessionOnly, async (request) => {
    const done = await requireService().logout();
    if (!done) throw new AppError(409, 'CONFLICT', 'Não há nenhum número ligado neste momento.');
    await logActivity(request, { action: 'whatsapp.logout' });
    return { data: requireService().getState() };
  });

  /**
   * Histórico da conversa de um cliente (ordem cronológica, paginado para trás com `before`).
   * Mesma regra de privacidade do resto do CRM: admin vê tudo; os demais só os clientes de que
   * são responsáveis (outro cliente responde 404).
   */
  app.get('/api/clients/:id/messages', { schema: messagesSchema }, async (request) => {
    const client = await findAccessibleClient(request.currentUser, request.params.id);
    const { before, limit } = request.query;
    return listMessages(client.id, { before, limit });
  });

  /**
   * Lista da Central de Atendimento (admin: todos; demais: só os seus clientes).
   * `meta.whatsapp` diz a todos se dá para enviar agora (sem expor o QR a não-admins).
   */
  app.get('/api/conversations', { schema: conversationsSchema }, async (request) => {
    const user = request.currentUser;
    const { q, limit } = request.query;
    const data = await listConversations({ responsibleId: isAdmin(user) ? undefined : user.id, q, limit });
    return {
      data,
      meta: { whatsapp: { enabled: Boolean(app.whatsapp), status: app.whatsapp?.getState().status ?? 'disabled' } },
    };
  });

  /**
   * Envia uma mensagem de texto ao cliente pelo WhatsApp e grava-a (sender_type = agent).
   * Um humano a responder = o humano assumiu: bot_active passa a false (a IA fica calada até
   * alguém a reativar). O evento new_message chega a todos os que veem o cliente, inclusive
   * às outras abas de quem enviou.
   */
  app.post('/api/clients/:id/messages', { schema: sendSchema }, async (request, reply) => {
    const user = request.currentUser;
    const client = await findAccessibleClient(user, request.params.id);
    requireService();

    let result;
    try {
      result = await sendToClient({
        whatsapp: app.whatsapp,
        io: app.io,
        client,
        content: request.body.content.trim(),
        senderType: 'agent',
        senderUserId: user.id,
        // Número partilhado: o cliente vê quem da equipe está a falar ("*Gabriel*\n...").
        signature: whatsappSignature(user),
        clientChanges: client.bot_active ? { bot_active: false } : {},
      });
    } catch (err) {
      throw toHttpError(err, client);
    }

    if (client.bot_active) {
      await logActivity(request, { action: 'client.human_takeover', entityType: 'client', entityId: client.id, details: { name: client.name } });
    }
    return reply.code(201).send({ data: result.message, meta: { client: clientSummary(result.client) } });
  });

  /**
   * "Assumir atendimento" (manual override): liga/desliga a IA para este cliente.
   * bot_active = false → a IA não responde (um humano assumiu); true → devolve à IA.
   * Avisa na hora, via Socket.io, todos os que veem o cliente (o botão muda nas outras telas).
   */
  app.patch('/api/clients/:id/bot-status', { schema: botStatusSchema }, async (request) => {
    const user = request.currentUser;
    const client = await findAccessibleClient(user, request.params.id);
    const botActive = request.body.bot_active;

    if (client.bot_active !== botActive) {
      await db('clients').where({ id: client.id }).update({ bot_active: botActive });
      await logActivity(request, {
        action: botActive ? 'client.bot_resumed' : 'client.human_takeover',
        entityType: 'client',
        entityId: client.id,
        details: { name: client.name },
      });
    }

    const updated = clientSummary(await findClientById(client.id));
    app.io.to(clientAudience(updated)).emit('client:bot_status', { client: updated, by: user.id });
    publish('clients', request); // SSE: listas de clientes abertas recarregam
    return { data: updated };
  });
}

/** Erros do envio (whatsappOutbox) → resposta HTTP com mensagem para o utilizador. */
function toHttpError(err, client) {
  switch (err.code) {
    case 'WHATSAPP_DISABLED':
      return disabled();
    case 'WHATSAPP_NOT_READY':
      return new AppError(503, err.code, 'O WhatsApp da empresa não está ligado. Peça ao admin para ler o QR Code.');
    case 'NO_PHONE':
      return new AppError(422, err.code, err.message);
    case 'NOT_ON_WHATSAPP':
      return new AppError(422, err.code, `O número ${client.phone} não tem WhatsApp.`);
    default:
      return err;
  }
}
