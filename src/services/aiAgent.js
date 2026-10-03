import { DENIES_SERVICE, HANDOFF_INTENTS, RESPONSE_SCHEMA, buildMessages, correctionMessages } from '../ai/prompt.js';
import { db } from '../config/database.js';
import { clientAudience } from '../plugins/socket.js';
import { logActivity } from '../repositories/activityLogRepository.js';
import { findClientById } from '../repositories/clientRepository.js';
import { listMessages } from '../repositories/messageRepository.js';
import { clientSummary } from './whatsappInbox.js';
import { sendToClient } from './whatsappOutbox.js';

// Mensagens mais velhas que isto não recebem resposta: o WhatsApp reentrega o atraso quando a
// sessão reconecta, e responder a uma mensagem de horas atrás seria estranho (e em massa).
const MAX_MESSAGE_AGE_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;

// O modelo não ouve áudio nem vê imagem: estes tipos vão direto para um humano.
const NON_TEXT_REPLY = 'Recebi sua mensagem! Vou pedir para um dos nossos consultores dar uma olhada e já te responde por aqui. 😉';
// Quando a IA falha (Ollama em baixo, timeout): o cliente não fica sem resposta nem é ignorado.
const FAILURE_HANDOFF_REASON = 'falha_ia';

// Na passagem para humano o bot fica calado a seguir: o cliente TEM de saber que alguém vem.
// O modelo nem sempre o diz (ex.: "posso te passar um orçamento... o que mais quer saber?"),
// por isso o código garante a frase quando a resposta não fala de consultor/atendente.
const HANDOFF_NOTE = 'Um consultor da nossa equipe vai continuar o atendimento com você por aqui em instantes. 😉';
const MENTIONS_HUMAN = /consultor|atendente|especialista|equipe|vendedor|humano/i;
export const withHandoffNote = (reply) => (MENTIONS_HUMAN.test(reply) ? reply : `${reply}\n\n${HANDOFF_NOTE}`.trim());

/**
 * Agente de IA do WhatsApp.
 *
 * Regras de segurança (o mais importante deste ficheiro):
 *  - Só responde a clientes com bot_active = true, e volta a confirmar ANTES de enviar: a
 *    geração leva ~10s na CPU e um vendedor pode assumir nesse intervalo.
 *  - Só responde se a última mensagem da conversa ainda for do cliente (ninguém respondeu).
 *  - Espera `debounceMs` sem mensagens novas (o cliente costuma mandar várias seguidas).
 *  - Uma geração de cada vez (fila): com 2 vCPU, duas em paralelo travariam o servidor.
 *  - Limite de respostas por hora por cliente (anti-loop com outro robô) → passa a humano.
 *  - Preço, reunião, suporte, reclamação, áudio/imagem ou falha da IA → passa a humano:
 *    responde uma vez, desliga o bot nesse cliente e avisa o responsável (ai:handoff).
 *
 * Eventos Socket.io (para quem vê o cliente): ai:typing { client_id, typing }, ai:handoff.
 */
export function createAiAgent({ ollama, whatsapp, io, logger, debounceMs, historyLimit, maxRepliesPerHour }) {
  const timers = new Map(); // clientId → timeout do debounce
  const nonText = new Map(); // clientId → houve áudio/imagem/... nesta rajada
  const replies = new Map(); // clientId → timestamps das respostas da última hora
  let queue = Promise.resolve();
  let lastResult = null; // para o painel de estado

  const enqueue = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  const emitTo = (client, event, payload) => io.to(clientAudience(client)).emit(event, payload);

  /**
   * Gera a resposta com a guarda de saída. Se negar um serviço que oferecemos (erro conhecido do
   * modelo pequeno, ~2% em geral e ~25% no caso "vender pela internet"), a 2.ª tentativa leva a
   * resposta errada + a correção (autocorreção). Medido no caso difícil: baixar a temperatura
   * recuperava 0/4; a autocorreção recuperou 11/11. Se ainda assim negar, devolve `blocked`: a
   * frase errada nunca é enviada e a conversa passa a um humano.
   */
  async function generate(messages) {
    const first = await ollama.chat({ messages, format: RESPONSE_SCHEMA });
    const firstReply = String(first.data.reply ?? '').trim();
    if (!DENIES_SERVICE.test(firstReply)) return { intent: first.data.intent, reply: firstReply, stats: first.stats, blocked: false };

    logger.warn({ reply: firstReply }, 'IA: resposta negava um serviço oferecido; a autocorrigir');
    const second = await ollama.chat({ messages: [...messages, ...correctionMessages(firstReply)], format: RESPONSE_SCHEMA });
    const secondReply = String(second.data.reply ?? '').trim();
    if (!DENIES_SERVICE.test(secondReply)) return { intent: first.data.intent, reply: secondReply, stats: second.stats, blocked: false };
    return { intent: first.data.intent, reply: '', stats: second.stats, blocked: true };
  }

  function recentReplies(clientId) {
    const now = Date.now();
    const list = (replies.get(clientId) ?? []).filter((t) => now - t < HOUR_MS);
    replies.set(clientId, list);
    return list;
  }

  /** Desliga o bot neste cliente e avisa quem o vê. */
  async function handoff(client, { intent, reason }) {
    await db('clients').where({ id: client.id }).update({ bot_active: false });
    const summary = clientSummary({ ...client, bot_active: false });
    emitTo(client, 'client:bot_status', { client: summary, by: null });
    emitTo(client, 'ai:handoff', { client: summary, intent: intent ?? null, reason });
    await logActivity({}, { action: 'ai.handoff', entityType: 'client', entityId: client.id, details: { name: client.name, intent, reason } });
    logger.info({ clientId: client.id, intent, reason }, 'IA: conversa passada para um humano');
  }

  async function respond(clientId) {
    const hadNonText = nonText.get(clientId) ?? false;
    nonText.delete(clientId);

    const client = await findClientById(clientId);
    if (!client?.bot_active) return; // um humano assumiu entretanto
    if (whatsapp.getState().status !== 'ready') return;

    const { data: history } = await listMessages(clientId, { limit: historyLimit });
    const last = history.at(-1);
    if (!last || last.sender_type !== 'client') return; // já foi respondida (humano ou bot)

    if (recentReplies(clientId).length >= maxRepliesPerHour) {
      await handoff(client, { reason: 'limite_respostas' });
      return;
    }

    const typing = (on) => emitTo(client, 'ai:typing', { client_id: client.id, typing: on });
    typing(true);
    try {
      let reply;
      let intent = null;
      let stats = null;
      let blocked = false;
      if (hadNonText) {
        reply = NON_TEXT_REPLY;
        intent = 'nao_texto';
      } else {
        await whatsapp.sendTyping(client.whatsapp_jid);
        ({ intent, reply, stats, blocked } = await generate(buildMessages({ clientName: client.name, history })));
      }

      // Segunda verificação, DEPOIS da geração: o vendedor pode ter assumido ou respondido.
      const fresh = await findClientById(clientId);
      const { data: latest } = await listMessages(clientId, { limit: 1 });
      if (!fresh?.bot_active || latest.at(-1)?.id !== last.id) {
        logger.info({ clientId }, 'IA: resposta descartada (um humano assumiu ou a conversa mudou durante a geração)');
        return;
      }

      // blocked: a resposta foi barrada pela guarda → só o aviso de que um humano continua.
      const shouldHandoff = hadNonText || blocked || HANDOFF_INTENTS.has(intent);
      if (shouldHandoff) reply = withHandoffNote(reply);
      if (reply) {
        await sendToClient({ whatsapp, io, client: fresh, content: reply.slice(0, 4096), senderType: 'bot' });
        recentReplies(clientId).push(Date.now());
      }
      lastResult = { at: new Date(), client_id: clientId, intent, stats, ok: true };
      logger.info({ clientId, intent, ...stats }, 'IA: resposta enviada');

      if (shouldHandoff) {
        const reason = hadNonText ? 'mensagem_nao_texto' : blocked ? 'resposta_bloqueada' : 'intencao';
        await handoff(fresh, { intent, reason });
      }
      // Sem interesse: o bot agradece (acima) e para de escrever a este cliente, sem alarme.
      else if (intent === 'sem_interesse') {
        await db('clients').where({ id: clientId }).update({ bot_active: false });
        emitTo(fresh, 'client:bot_status', { client: clientSummary({ ...fresh, bot_active: false }), by: null });
      }
    } catch (err) {
      lastResult = { at: new Date(), client_id: clientId, ok: false, error: err.message };
      logger.error({ err, clientId }, 'IA: falha ao gerar/enviar a resposta; a passar para um humano');
      const current = await findClientById(clientId).catch(() => null);
      if (current?.bot_active) await handoff(current, { reason: FAILURE_HANDOFF_REASON }).catch(() => {});
    } finally {
      typing(false);
    }
  }

  return {
    /** Chamado pelo inbox a cada mensagem recebida (já gravada). */
    onClientMessage({ client, type, sentAt }) {
      if (!client.bot_active) return;
      if (Date.now() - sentAt > MAX_MESSAGE_AGE_MS) return;
      if (type && type !== 'chat') nonText.set(client.id, true);

      clearTimeout(timers.get(client.id));
      timers.set(
        client.id,
        setTimeout(() => {
          timers.delete(client.id);
          enqueue(() => respond(client.id)).catch((err) => logger.error({ err }, 'IA: erro inesperado na fila'));
        }, debounceMs),
      );
    },

    lastResult: () => lastResult,

    stop() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
