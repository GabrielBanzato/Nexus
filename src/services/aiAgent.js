import { DENIES_SERVICE, RESPONSE_SCHEMA, buildMessages, correctionMessages } from '../ai/prompt.js';
import { clientAudience } from '../plugins/socket.js';
import { findClientById } from '../repositories/clientRepository.js';
import { listMessages } from '../repositories/messageRepository.js';

// Mensagens mais velhas que isto não geram sugestão automática: o WhatsApp reentrega o atraso
// quando a sessão reconecta, e gerar dezenas de sugestões de uma vez travaria a CPU.
const MAX_MESSAGE_AGE_MS = 10 * 60_000;
// Sugestões guardadas (só em memória): as mais antigas saem primeiro.
const MAX_STORED = 300;

/**
 * Assistente de IA do WhatsApp: SUGERE respostas, nunca envia nada ao cliente.
 *
 * O número é partilhado pela equipe e cada mensagem sai assinada por quem a escreveu, por isso
 * só um humano envia. A IA prepara um rascunho; na Central, o responsável usa-o (pode editar)
 * e envia com a assinatura dele — ou ignora.
 *
 *  - Automática: mensagem de texto de um cliente COM responsável → espera `debounceMs` sem
 *    mensagens novas (o cliente costuma mandar várias seguidas) e gera. Contactos sem
 *    responsável (números pessoais do telemóvel) não gastam CPU; aí só a pedido.
 *  - A pedido: botão "Sugerir resposta" na Central (suggestNow).
 *  - Uma geração de cada vez (fila): com 2 vCPU, duas em paralelo travariam o servidor.
 *  - A sugestão vale para a última mensagem da conversa (`for_message_id`); chegou ou saiu
 *    outra mensagem, fica desatualizada e deixa de ser mostrada.
 *
 * Eventos Socket.io (para quem vê o cliente): ai:suggesting { client_id, on },
 * ai:suggestion { client_id, suggestion }.
 */
export function createAiAgent({ ollama, io, logger, debounceMs, historyLimit }) {
  const timers = new Map(); // clientId → timeout do debounce
  const suggestions = new Map(); // clientId → última sugestão
  const pending = new Map(); // clientId → Promise da geração em curso (não gera duas vezes)
  let queue = Promise.resolve();
  let lastResult = null; // para o painel de estado

  const enqueue = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  const emitTo = (client, event, payload) => io.to(clientAudience(client)).emit(event, payload);

  /**
   * Gera com a guarda de saída. Se negar um serviço que oferecemos (erro conhecido do modelo
   * pequeno), a 2.ª tentativa leva a resposta errada + a correção (autocorreção). Medido no caso
   * difícil: baixar a temperatura recuperava 0/4; a autocorreção recuperou 11/11. Se ainda assim
   * negar, a sugestão vem vazia (`blocked`): a frase errada nem chega a ser mostrada.
   */
  async function generate(messages) {
    const first = await ollama.chat({ messages, format: RESPONSE_SCHEMA });
    const firstReply = String(first.data.reply ?? '').trim();
    if (!DENIES_SERVICE.test(firstReply)) return { intent: first.data.intent, reply: firstReply, stats: first.stats, blocked: false };

    logger.warn({ reply: firstReply }, 'IA: sugestão negava um serviço oferecido; a autocorrigir');
    const second = await ollama.chat({ messages: [...messages, ...correctionMessages(firstReply)], format: RESPONSE_SCHEMA });
    const secondReply = String(second.data.reply ?? '').trim();
    if (!DENIES_SERVICE.test(secondReply)) return { intent: first.data.intent, reply: secondReply, stats: second.stats, blocked: false };
    return { intent: first.data.intent, reply: '', stats: second.stats, blocked: true };
  }

  function store(clientId, suggestion) {
    suggestions.delete(clientId);
    suggestions.set(clientId, suggestion);
    if (suggestions.size > MAX_STORED) suggestions.delete(suggestions.keys().next().value);
  }

  /** Gera (na fila) a sugestão para a última mensagem do cliente. Devolve a sugestão ou null. */
  async function suggest(clientId) {
    const client = await findClientById(clientId);
    if (!client) return null;
    const { data: history } = await listMessages(clientId, { limit: historyLimit });
    const last = history.at(-1);
    if (!last) return null;

    emitTo(client, 'ai:suggesting', { client_id: clientId, on: true });
    try {
      const { intent, reply, stats, blocked } = await generate(buildMessages({ clientName: client.name, history }));
      const suggestion = {
        client_id: clientId,
        for_message_id: last.id,
        intent: intent ?? null,
        reply: reply.slice(0, 4096),
        blocked,
        created_at: new Date().toISOString(),
      };
      store(clientId, suggestion);
      lastResult = { at: new Date(), client_id: clientId, intent, stats, ok: true };
      logger.info({ clientId, intent, ...stats }, 'IA: sugestão gerada');
      emitTo(client, 'ai:suggestion', { client_id: clientId, suggestion });
      return suggestion;
    } catch (err) {
      lastResult = { at: new Date(), client_id: clientId, ok: false, error: err.message };
      throw err;
    } finally {
      emitTo(client, 'ai:suggesting', { client_id: clientId, on: false });
    }
  }

  /** Uma geração por cliente de cada vez: um 2.º pedido espera pela que já está em curso. */
  function schedule(clientId) {
    if (pending.has(clientId)) return pending.get(clientId);
    const run = enqueue(() => suggest(clientId)).finally(() => pending.delete(clientId));
    pending.set(clientId, run);
    return run;
  }

  return {
    /** Chamado pelo inbox a cada mensagem recebida (já gravada). */
    onClientMessage({ client, type, sentAt }) {
      if (!client.responsible_id) return; // contacto pessoal / por atribuir: só a pedido
      if (type && type !== 'chat') return; // áudio, imagem...: a IA não os entende
      if (Date.now() - sentAt > MAX_MESSAGE_AGE_MS) return;

      clearTimeout(timers.get(client.id));
      timers.set(
        client.id,
        setTimeout(() => {
          timers.delete(client.id);
          schedule(client.id).catch((err) => logger.error({ err, clientId: client.id }, 'IA: falha ao gerar a sugestão'));
        }, debounceMs),
      );
    },

    /** Botão "Sugerir resposta": gera já (ou espera pela geração em curso). */
    suggestNow(clientId) {
      clearTimeout(timers.get(clientId));
      timers.delete(clientId);
      return schedule(clientId);
    },

    /** Última sugestão do cliente, se ainda corresponder à última mensagem da conversa. */
    current(clientId, lastMessageId) {
      const suggestion = suggestions.get(clientId);
      return suggestion && suggestion.for_message_id === lastMessageId ? suggestion : null;
    },

    isSuggesting: (clientId) => pending.has(clientId) || timers.has(clientId),

    lastResult: () => lastResult,

    stop() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
