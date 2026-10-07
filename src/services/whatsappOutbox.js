import { db } from '../config/database.js';
import { clientAudience } from '../plugins/socket.js';
import { findClientById, toWhatsAppNumber } from '../repositories/clientRepository.js';
import { saveMessage } from '../repositories/messageRepository.js';
import { clientSummary } from './whatsappInbox.js';

const coded = (code, message) => Object.assign(new Error(message), { code });

/**
 * Assinatura de quem escreve: o número de WhatsApp é PARTILHADO pela equipe, por isso cada
 * mensagem enviada pelo Nexus leva o primeiro nome do utilizador em negrito na 1.ª linha:
 *   *Gabriel*
 *   Olá dona Cleusa, tudo bem?
 * Tira os caracteres de formatação do WhatsApp (* _ ~ `) para um nome não partir o negrito.
 */
export function whatsappSignature(user) {
  const first = String(user?.name ?? '').trim().split(/\s+/)[0] ?? '';
  return first.replace(/[*_~`]/g, '').slice(0, 40) || null;
}

const signed = (content, signature) => (signature ? `*${signature}*\n${content}` : content);

/**
 * Envia um texto a um cliente pelo WhatsApp da empresa e trata do resto, sempre igual para
 * quem envia (Central de Atendimento, confirmação de reunião, futura IA):
 *  1. envia (pelo contacto já conhecido ou pelo telefone do cliente);
 *  2. grava em `messages`;
 *  3. liga o contacto ao cliente na primeira conversa;
 *  4. aplica `clientChanges` (ex.: bot_active = false quando um humano responde);
 *  5. emite `new_message` para quem pode ver o cliente.
 * Só grava depois de o WhatsApp aceitar: se o envio falhar, nada fica registado.
 *
 * `signature` (whatsappSignature(user)) vai só no texto ENVIADO; no histórico fica a mensagem
 * original — a Central já mostra quem escreveu cada balão.
 *
 * @throws erro com `code`: WHATSAPP_DISABLED | NO_PHONE | WHATSAPP_NOT_READY | NOT_ON_WHATSAPP
 * @returns {Promise<{ message: object, client: object }>}
 */
export async function sendToClient({ whatsapp, io, client, content, senderType, senderUserId = null, signature = null, clientChanges = {} }) {
  if (!whatsapp) throw coded('WHATSAPP_DISABLED', 'A integração com o WhatsApp está desligada.');
  const number = toWhatsAppNumber(client.phone);
  if (!client.whatsapp_jid && !number) throw coded('NO_PHONE', 'Este cliente não tem um telefone válido para WhatsApp.');

  const sent = await whatsapp.sendText({ jid: client.whatsapp_jid, number }, signed(content, signature));

  const message = await saveMessage({ clientId: client.id, senderType, content, waMessageId: sent.waMessageId, senderUserId });
  await db('clients').where({ id: client.id }).update({ updated_at: db.fn.now(), ...clientChanges });
  if (!client.whatsapp_jid) {
    // whereNull: nunca rouba um contacto já ligado a outro cliente (índice único).
    await db('clients')
      .where({ id: client.id })
      .whereNull('whatsapp_jid')
      .update({ whatsapp_jid: sent.chatId })
      .catch((err) => {
        if (err.code !== 'ER_DUP_ENTRY') throw err;
      });
  }

  const updated = await findClientById(client.id);
  io.to(clientAudience(updated)).emit('new_message', { message, client: clientSummary(updated) });
  return { message, client: updated };
}
