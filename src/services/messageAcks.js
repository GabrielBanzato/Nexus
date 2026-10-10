import { db } from '../config/database.js';
import { clientAudience } from '../plugins/socket.js';
import { findClientById } from '../repositories/clientRepository.js';
import { messageKey, updateMessageAck } from '../repositories/messageRepository.js';
import { serializeMessageId } from '../lib/waId.js';

const RETRY_DELAYS_MS = [2_000, 8_000];
const REFRESH_EVERY_MS = 15_000; // por conversa
const SWEEP_EVERY_MS = 20_000; // varrimento das conversas com mensagens por ler
const SWEEP_WINDOW_H = 24; // só mensagens enviadas nas últimas 24h
const SWEEP_MAX_CLIENTS = 12;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** O texto enviado leva a assinatura ("*Gabriel*\nteste"); no Nexus fica só "teste". */
const sameText = (body, content) => body === content || body.endsWith(`\n${content}`);

/**
 * "Visto" das mensagens (✓ enviada · ✓✓ entregue · ✓✓ azul lida), sem depender só do evento do
 * WhatsApp (que nem sempre chega):
 *  1. Evento message_ack, na hora (com nova tentativa: o "entregue" chega às vezes antes de a
 *     mensagem estar gravada).
 *  2. Varrimento a cada 20s das conversas com mensagens enviadas nas últimas 24h ainda não lidas:
 *     pergunta ao WhatsApp o estado atual. Também ao abrir uma conversa.
 * As mensagens são encontradas pela parte estável do id (o contacto pode ter migrado para @lid)
 * e, se a mensagem ficou sem id no envio, pelo texto (na ordem de envio).
 */
export function createAckSync({ whatsapp, io, logger }) {
  const lastRefresh = new Map(); // clientId → instante
  let timer = null;
  let sweeping = false;
  const events = []; // últimos eventos message_ack recebidos (para o diagnóstico)
  let lastError = null;
  let lastSweep = null;

  async function emit(changed) {
    const client = await findClientById(changed.client_id);
    if (client) io?.to(clientAudience(client)).emit('message_ack', { client_id: changed.client_id, message_id: changed.id, ack: changed.ack });
  }

  async function apply(waMessageId, ack) {
    const result = await updateMessageAck(waMessageId, ack);
    if (result.changed) {
      logger.info({ messageId: result.changed.id, ack: result.changed.ack }, 'WhatsApp: visto atualizado');
      await emit(result.changed);
    }
    return result.found;
  }

  /**
   * Confere no WhatsApp o estado das últimas mensagens enviadas a este cliente.
   * Com `report`, devolve o que viu e fez (diagnóstico do admin).
   */
  async function refresh(client, { force = false, report = null } = {}) {
    if (!whatsapp || !client?.whatsapp_jid) return report && Object.assign(report, { skipped: 'sem WhatsApp ou contacto sem conversa' });
    const now = Date.now();
    if (!force && now - (lastRefresh.get(client.id) ?? 0) < REFRESH_EVERY_MS) return;
    lastRefresh.set(client.id, now);
    try {
      const pending = await db('messages')
        .where({ client_id: client.id })
        .whereIn('sender_type', ['agent', 'bot'])
        .where((w) => w.whereNull('ack').orWhere('ack', '<', 3))
        .where('created_at', '>=', new Date(now - 7 * 24 * 3_600_000))
        .orderBy('id', 'desc')
        .limit(30)
        .select('id', 'wa_message_id', 'content', 'created_at');
      if (report) report.pending = pending.map((r) => ({ id: r.id, wa_message_id: r.wa_message_id, text: String(r.content).slice(0, 40), created_at: r.created_at }));
      if (!pending.length) return;
      const sent = await whatsapp.recentOwnMessages(client.whatsapp_jid);
      if (report) {
        report.whatsapp_sent_7d = sent.length;
        report.whatsapp_this_contact = sent.filter((m) => m.mine).map((m) => ({ id: m.id, ack: m.ack, text: m.body.slice(0, 50), t: m.timestamp }));
        report.remotes = [...new Set(sent.map((m) => m.remote))].slice(0, 30);
        report.applied = [];
      }
      if (!sent.length) return;
      const byKey = new Map(sent.map((m) => [m.key, m]));
      // Ids já ligados a mensagens deste cliente (não se reaproveitam para outra).
      const known = new Set((await db('messages').where({ client_id: client.id }).whereNotNull('wa_message_id').pluck('wa_message_id')).map(messageKey));

      for (const row of pending.filter((r) => r.wa_message_id)) {
        const m = byKey.get(messageKey(row.wa_message_id));
        report?.applied.push({ id: row.id, by: 'id', found: Boolean(m), ack: m?.ack ?? null });
        if (m?.ack >= 1) await apply(row.wa_message_id, m.ack);
      }
      // Sem id (ex.: dois "teste" seguidos — o segundo ficou sem id no envio): pelo texto, na ordem
      // de envio (a mais antiga sem id fica com a mais antiga do WhatsApp com o mesmo texto ainda
      // não ligada). Pela ordem e não pela hora exata: não depende do fuso do relógio do MySQL.
      const orphans = pending.filter((r) => !r.wa_message_id).sort((a, b) => a.id - b.id);
      const candidates = sent.filter((m) => m.mine).sort((a, b) => a.timestamp - b.timestamp);
      for (const row of orphans) {
        const match = candidates.find((m) => !known.has(m.key) && sameText(m.body, row.content));
        report?.applied.push({ id: row.id, by: 'texto', found: Boolean(match), ack: match?.ack ?? null });
        if (!match) continue;
        known.add(match.key);
        const linked = await db('messages')
          .where({ id: row.id })
          .whereNull('wa_message_id')
          .update({ wa_message_id: match.id })
          .catch(() => 0); // id já usado noutra linha: deixa estar
        if (linked && match.ack >= 1) await apply(match.id, match.ack);
      }
    } catch (err) {
      lastError = { at: new Date(), clientId: client.id, error: err.message };
      if (report) report.error = err.message;
      logger.warn({ err: err.message, clientId: client.id }, 'WhatsApp: não foi possível atualizar o "visto"');
    }
  }

  async function sweep() {
    if (sweeping || !whatsapp) return;
    sweeping = true;
    try {
      const clients = await db('messages as m')
        .join('clients as c', 'c.id', 'm.client_id')
        .whereIn('m.sender_type', ['agent', 'bot'])
        .where((w) => w.whereNull('m.ack').orWhere('m.ack', '<', 3))
        .where('m.created_at', '>=', new Date(Date.now() - SWEEP_WINDOW_H * 3_600_000))
        .whereNotNull('c.whatsapp_jid')
        .groupBy('c.id', 'c.whatsapp_jid')
        .orderByRaw('MAX(m.id) DESC')
        .limit(SWEEP_MAX_CLIENTS)
        .select('c.id', 'c.whatsapp_jid');
      lastSweep = { at: new Date(), clients: clients.length };
      for (const client of clients) await refresh(client);
    } catch (err) {
      logger.warn({ err: err.message }, 'WhatsApp: varrimento do "visto" falhou');
    } finally {
      sweeping = false;
    }
  }

  return {
    /** Evento message_ack do WhatsApp. */
    async onAck(msg, ack) {
      const waId = serializeMessageId(msg.id);
      const event = { at: new Date(), id: waId, ack, found: false };
      events.unshift(event);
      events.length = Math.min(events.length, 30);
      if ((event.found = await apply(waId, ack))) return;
      for (const wait of RETRY_DELAYS_MS) {
        await sleep(wait);
        if ((event.found = await apply(waId, ack))) return;
      }
    },

    /** Diagnóstico (admin): o que o WhatsApp diz desta conversa e o que o Nexus fez com isso. */
    async diagnose(client) {
      const report = { client: { id: client.id, whatsapp_jid: client.whatsapp_jid }, whatsapp: whatsapp?.getState?.().status ?? 'desligado' };
      const started = Date.now();
      await refresh(client, { force: true, report });
      return { ...report, ms: Date.now() - started, sweep_running: Boolean(timer), last_sweep: lastSweep, last_error: lastError, recent_events: events };
    },

    /** Ao abrir a conversa. Nunca lança. */
    refresh,
    sweep,

    start() {
      if (timer || !whatsapp) return;
      timer = setInterval(() => sweep(), SWEEP_EVERY_MS);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
