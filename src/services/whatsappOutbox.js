import { db } from '../config/database.js';
import { clientAudience } from '../plugins/socket.js';
import { findClientById, toWhatsAppNumber } from '../repositories/clientRepository.js';
import { saveMessage } from '../repositories/messageRepository.js';
import { markLead } from './whatsappCheck.js';
import { clientSummary } from './whatsappInbox.js';

const coded = (code, message) => Object.assign(new Error(message), { code });

/**
 * O número de WhatsApp é PARTILHADO pela equipe: cada mensagem enviada pelo Nexus leva a
 * assinatura de quem a escreveu (userRepository.whatsappSignature) em negrito na 1.ª linha:
 *   *Gabriel*
 *   Olá dona Cleusa, tudo bem?
 */
const signed = (content, signature) => (signature ? `*${signature}*\n${content}` : content);

/**
 * Envia um texto a um cliente pelo WhatsApp da empresa e trata do resto, sempre igual para
 * quem envia (Central de Atendimento, confirmação de reunião):
 *  1. envia (pelo contacto já conhecido ou pelo telefone do cliente);
 *  2. grava em `messages`;
 *  3. liga o contacto ao cliente na primeira conversa;
 *  4. emite `new_message` para quem pode ver o cliente.
 * Só grava depois de o WhatsApp aceitar: se o envio falhar, nada fica registado.
 *
 * `signature` (await whatsappSignature(user)) vai só no texto ENVIADO; no histórico fica a mensagem
 * original — a Central já mostra quem escreveu cada balão.
 *
 * @throws erro com `code`: WHATSAPP_DISABLED | NO_PHONE | WHATSAPP_NOT_READY | NOT_ON_WHATSAPP
 * @returns {Promise<{ message: object, client: object }>}
 */
export async function sendToClient({ whatsapp, io, client, content, senderType, senderUserId = null, signature = null }) {
  if (!whatsapp) throw coded('WHATSAPP_DISABLED', 'A integração com o WhatsApp está desligada.');
  const number = toWhatsAppNumber(client.phone);
  if (!client.whatsapp_jid && !number) throw coded('NO_PHONE', 'Este cliente não tem um telefone válido para WhatsApp.');

  let sent;
  try {
    sent = await whatsapp.sendText({ jid: client.whatsapp_jid, number }, signed(content, signature));
  } catch (err) {
    // Fica registado no lead: a Triagem passa a mostrar "sem WhatsApp" (para ligar).
    if (err.code === 'NOT_ON_WHATSAPP') await markLead(client.lead_id, false).catch(() => {});
    throw err;
  }
  if (!client.whatsapp_jid) await markLead(client.lead_id, true).catch(() => {});

  const record = { clientId: client.id, senderType, content, senderUserId, ack: 1 };
  // Id repetido (o id recuperado na conversa era de um envio anterior com o mesmo texto): a
  // mensagem saiu na mesma, por isso grava-se sem id em vez de se perder.
  const message = (await saveMessage({ ...record, waMessageId: sent.waMessageId })) ?? (await saveMessage({ ...record, waMessageId: null }));
  await db('clients').where({ id: client.id }).update({ updated_at: db.fn.now() });
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
