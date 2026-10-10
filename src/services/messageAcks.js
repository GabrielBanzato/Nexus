import { db } from '../config/database.js';
import { clientAudience } from '../plugins/socket.js';
import { findClientById } from '../repositories/clientRepository.js';
import { messageKey, updateMessageAck } from '../repositories/messageRepository.js';

const RETRY_DELAYS_MS = [2_000, 8_000];
const REFRESH_EVERY_MS = 30_000; // por conversa
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * "Visto" das mensagens (✓ enviada · ✓✓ entregue · ✓✓ azul lida), por dois caminhos:
 *  1. Evento do WhatsApp (message_ack), na hora. O "entregue" chega em milissegundos — às vezes
 *     antes de a mensagem estar gravada —, por isso tenta outra vez uns segundos depois.
 *  2. Ao abrir uma conversa, pergunta ao WhatsApp o estado atual das últimas mensagens enviadas:
 *     corrige o que se perdeu (servidor a reiniciar, sessão a religar...).
 * As mensagens são encontradas pela parte estável do id (ver messageKey): com a migração dos
 * contactos para "@lid", o id do evento pode não ser igual ao gravado no envio.
 */
export function createAckSync({ whatsapp, io, logger }) {
  const lastRefresh = new Map(); // clientId → instante

  async function emit(changed) {
    const client = await findClientById(changed.client_id);
    if (client) io?.to(clientAudience(client)).emit('message_ack', { client_id: changed.client_id, message_id: changed.id, ack: changed.ack });
  }

  async function apply(waMessageId, ack) {
    const result = await updateMessageAck(waMessageId, ack);
    if (result.changed) await emit(result.changed);
    return result.found;
  }

  return {
    /** Evento message_ack do WhatsApp. */
    async onAck(msg, ack) {
      const waId = msg.id?._serialized;
      if (await apply(waId, ack)) return;
      for (const wait of RETRY_DELAYS_MS) {
        await sleep(wait);
        if (await apply(waId, ack)) return;
      }
      logger.debug?.({ waId, ack }, 'WhatsApp: estado de uma mensagem que não está no Nexus');
    },

    /** Ao abrir a conversa (no máximo a cada 30s por cliente). Nunca lança. */
    async refresh(client) {
      if (!whatsapp || !client?.whatsapp_jid) return;
      const now = Date.now();
      if (now - (lastRefresh.get(client.id) ?? 0) < REFRESH_EVERY_MS) return;
      lastRefresh.set(client.id, now);
      try {
        const pending = await db('messages')
          .where({ client_id: client.id })
          .whereIn('sender_type', ['agent', 'bot'])
          .whereNotNull('wa_message_id')
          .where((w) => w.whereNull('ack').orWhere('ack', '<', 3))
          .orderBy('id', 'desc')
          .limit(30)
          .select('id', 'wa_message_id');
        if (!pending.length) return;
        const acks = await whatsapp.recentAcks(client.whatsapp_jid);
        for (const row of pending) {
          const ack = acks.get(messageKey(row.wa_message_id));
          if (ack >= 1) await apply(row.wa_message_id, ack);
        }
      } catch (err) {
        logger.warn({ err: err.message, clientId: client.id }, 'WhatsApp: não foi possível atualizar o "visto"');
      }
    },
  };
}
