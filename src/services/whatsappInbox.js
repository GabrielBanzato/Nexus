import { db } from '../config/database.js';
import { publish } from '../lib/events.js';
import { clientAudience } from '../plugins/socket.js';
import { findOrCreateWhatsAppClient } from '../repositories/clientRepository.js';
import { saveMessage } from '../repositories/messageRepository.js';

// Conversas individuais: @c.us (número) e @lid (identificador sem número exposto).
// Grupos (@g.us), canais (@newsletter) e estados (status@broadcast) ficam fora do CRM.
const DIRECT_CHAT = /@(c\.us|lid)$/;

const MEDIA_LABELS = {
  image: '📷 Imagem',
  video: '🎬 Vídeo',
  audio: '🎤 Áudio',
  ptt: '🎤 Áudio',
  document: '📄 Documento',
  sticker: '🖼️ Figurinha',
  location: '📍 Localização',
  vcard: '👤 Contacto',
  multi_vcard: '👤 Contactos',
};

/** Texto a guardar: a mensagem, ou uma etiqueta (+ legenda) quando é mídia. */
function describeContent(msg) {
  const text = (msg.body ?? '').trim();
  const label = MEDIA_LABELS[msg.type];
  if (!label) return text || `[${msg.type}]`;
  return text && msg.type !== 'location' && msg.type !== 'vcard' ? `${label}: ${text}` : label;
}

/** Dados do cliente que viajam no evento (o suficiente para a lista de conversas). */
export const clientSummary = (client) => ({
  id: client.id,
  name: client.name,
  company: client.company ?? null,
  phone: client.phone,
  status: client.status,
  responsible_id: client.responsible_id,
  responsible_name: client.responsible_name ?? null,
});

/**
 * Handler das mensagens recebidas no WhatsApp:
 *  1. identifica (ou cria) o cliente da conversa;
 *  2. grava em `messages` (sender_type = client), sem duplicar reentregas;
 *  3. emite `new_message` via Socket.io só para quem pode ver o cliente (admins + responsável).
 *
 * Depois, `onClientMessage` (o assistente de IA) decide se prepara uma sugestão de resposta.
 */
export function createWhatsAppInbox({ io, logger, autoCreateClients, onClientMessage }) {
  return async function handleIncomingMessage(msg) {
    if (msg.fromMe || msg.isStatus || msg.broadcast || !DIRECT_CHAT.test(msg.from)) return;

    const contact = await msg.getContact().catch(() => null);
    // Em contas @lid o número real (quando visível) vem no contacto, não no jid.
    const digits = (contact?.number || (msg.from.endsWith('@c.us') ? msg.from.split('@')[0] : '')).replace(/\D/g, '');

    const { client, created } = await findOrCreateWhatsAppClient({
      jid: msg.from,
      digits,
      name: contact?.pushname || contact?.name || null,
      autoCreate: autoCreateClients,
    });
    if (!client) {
      logger.info({ from: msg.from }, 'WhatsApp: mensagem de contacto sem cliente ignorada (WHATSAPP_AUTO_CREATE_CLIENTS=false)');
      return;
    }

    const message = await saveMessage({
      clientId: client.id,
      senderType: 'client',
      content: describeContent(msg),
      waMessageId: msg.id?._serialized ?? null,
      // Hora do WhatsApp, não a de chegada: mensagens recebidas após uma reconexão ficam na ordem certa.
      createdAt: msg.timestamp ? new Date(msg.timestamp * 1000) : undefined,
    });
    if (!message) return; // reentrega de uma mensagem já gravada

    // Conversa com mensagem nova sobe na lista de clientes (ordenada por updated_at).
    await db('clients').where({ id: client.id }).update({ updated_at: db.fn.now() });

    io.to(clientAudience(client)).emit('new_message', { message, client: clientSummary(client) });
    if (created) publish('clients'); // SSE: listas de clientes abertas recarregam

    onClientMessage?.({ client, message, type: msg.type, sentAt: msg.timestamp ? msg.timestamp * 1000 : Date.now() });
  };
}

/**
 * Mensagem enviada pelo número da empresa FORA do Nexus (escrita direto no telemóvel): grava-a
 * no histórico como mensagem humana sem autor (sender_user_id null), para a conversa na Central
 * ficar igual à do telemóvel.
 */
export function createOwnMessageHandler({ io, autoCreateClients }) {
  return async function handleOwnMessage(msg) {
    const jid = msg.to;
    if (!DIRECT_CHAT.test(jid ?? '')) return;

    const { client } = await findOrCreateWhatsAppClient({
      jid,
      digits: jid.endsWith('@c.us') ? jid.split('@')[0] : '',
      name: null,
      autoCreate: autoCreateClients,
    });
    if (!client) return;

    const message = await saveMessage({
      clientId: client.id,
      senderType: 'agent', // humano; sender_user_id null = "pelo telemóvel da empresa"
      content: describeContent(msg),
      waMessageId: msg.id?._serialized ?? null,
      createdAt: msg.timestamp ? new Date(msg.timestamp * 1000) : undefined,
    });
    if (!message) return;

    await db('clients').where({ id: client.id }).update({ updated_at: db.fn.now() });
    io.to(clientAudience(client)).emit('new_message', { message, client: clientSummary(client) });
  };
}
