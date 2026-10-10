import { db } from '../config/database.js';
import { publish } from '../lib/events.js';
import { clientAudience } from '../plugins/socket.js';
import { findOrCreateWhatsAppClient } from '../repositories/clientRepository.js';
import { saveMessage } from '../repositories/messageRepository.js';
import { serializeMessageId } from '../lib/waId.js';

// Conversas individuais: @c.us (número) e @lid (identificador sem número exposto).
// Grupos (@g.us), canais (@newsletter) e estados (status@broadcast) ficam fora do CRM.
const DIRECT_CHAT = /@(c\.us|lid)$/;

/**
 * Avisos de sistema do WhatsApp que não são mensagens de ninguém: "as mensagens são protegidas
 * com criptografia" (e2e_notification), "o código de segurança mudou", modelos de notificação,
 * mudanças de grupo, mensagens ainda por decifrar... Antes apareciam na Central como "[e2e_notification]".
 */
export const SYSTEM_TYPES = new Set(['e2e_notification', 'notification', 'notification_template', 'gp2', 'protocol', 'ciphertext', 'broadcast_notification', 'debug', 'unknown', 'pinned_message']);

const MEDIA_LABELS = {
  image: '📷 Imagem',
  video: '🎬 Vídeo',
  audio: '🎤 Áudio',
  ptt: '🎤 Áudio',
  document: '📄 Documento',
  sticker: '🖼️ Figurinha',
  location: '📍 Localização',
  vcard: '👤 Contato',
  multi_vcard: '👤 Contatos',
  call_log: '📞 Chamada de voz/vídeo',
  revoked: '🚫 Mensagem apagada',
};

/** Texto a guardar: a mensagem, ou uma etiqueta (+ legenda) quando é mídia. */
function describeContent(msg) {
  const text = (msg.body ?? '').trim();
  const label = MEDIA_LABELS[msg.type];
  if (!label) return text || `[${msg.type}]`;
  return text && msg.type !== 'location' && msg.type !== 'vcard' ? `${label}: ${text}` : label;
}

/**
 * Telefone (só dígitos) de quem escreveu. Contas "@lid" escondem o número no jid (o
 * "158965480575081" do @lid NÃO é telefone): pede-se o número ao WhatsApp. '' se não houver.
 */
async function phoneDigits(msg, contact) {
  const jid = msg.from;
  if (jid.endsWith('@c.us')) return jid.split('@')[0];
  const lidUser = jid.split('@')[0];
  try {
    const [found] = (await msg.client.getContactLidAndPhone(jid)) ?? [];
    const pn = found?.pn?.split('@')[0]?.replace(/\D/g, '');
    if (pn) return pn;
  } catch {
    // versão do WhatsApp Web sem esta função: segue para o contacto
  }
  const number = (contact?.number ?? '').replace(/\D/g, '');
  return number && number !== lidUser ? number : '';
}

/**
 * Clientes criados antes desta correção ficaram com o id @lid como "telefone" (+158965480575081).
 * Com o número real em mãos, corrige o telefone (e o nome, se era esse mesmo id).
 */
async function repairLidPhone(client, jid, digits) {
  if (!jid.endsWith('@lid') || !digits) return client;
  const fake = `+${jid.split('@')[0]}`;
  if (client.phone !== fake) return client;
  const changes = { phone: `+${digits}`.slice(0, 30), ...(client.name === fake && { name: `+${digits}` }) };
  await db('clients').where({ id: client.id }).update(changes);
  return { ...client, ...changes };
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
export function createWhatsAppInbox({ io, logger, autoCreateClients, onClientMessage, push }) {
  return async function handleIncomingMessage(msg) {
    if (msg.fromMe || msg.isStatus || msg.broadcast || !DIRECT_CHAT.test(msg.from) || SYSTEM_TYPES.has(msg.type)) return;

    const contact = await msg.getContact().catch(() => null);
    const digits = await phoneDigits(msg, contact);

    let { client, created } = await findOrCreateWhatsAppClient({
      jid: msg.from,
      digits,
      name: contact?.pushname || contact?.name || null,
      autoCreate: autoCreateClients,
    });
    if (!client) {
      logger.info({ from: msg.from }, 'WhatsApp: mensagem de contacto sem cliente ignorada (WHATSAPP_AUTO_CREATE_CLIENTS=false)');
      return;
    }
    client = await repairLidPhone(client, msg.from, digits);

    const message = await saveMessage({
      clientId: client.id,
      senderType: 'client',
      content: describeContent(msg),
      waMessageId: serializeMessageId(msg.id),
      // Hora do WhatsApp, não a de chegada: mensagens recebidas após uma reconexão ficam na ordem certa.
      createdAt: msg.timestamp ? new Date(msg.timestamp * 1000) : undefined,
    });
    if (!message) return; // reentrega de uma mensagem já gravada

    // Conversa com mensagem nova sobe na lista de clientes (ordenada por updated_at).
    await db('clients').where({ id: client.id }).update({ updated_at: db.fn.now() });

    io.to(clientAudience(client)).emit('new_message', { message, client: clientSummary(client) });
    if (created) publish('clients'); // SSE: listas de clientes abertas recarregam

    // Notificação no telemóvel do parceiro responsável (app instalado). Contactos sem
    // responsável (pessoais) não: o telemóvel do número já avisa deles.
    if (client.responsible_id && push) {
      const body = message.content.length > 140 ? `${message.content.slice(0, 137)}...` : message.content;
      push
        .sendToUsers([client.responsible_id], { title: client.name, body, url: `/#/atendimento?c=${client.id}`, tag: `chat-${client.id}` })
        .catch(() => {});
    }

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
    if (!DIRECT_CHAT.test(jid ?? '') || SYSTEM_TYPES.has(msg.type)) return;

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
      ack: 1,
      content: describeContent(msg),
      waMessageId: serializeMessageId(msg.id),
      createdAt: msg.timestamp ? new Date(msg.timestamp * 1000) : undefined,
    });
    if (!message) return;

    await db('clients').where({ id: client.id }).update({ updated_at: db.fn.now() });
    io.to(clientAudience(client)).emit('new_message', { message, client: clientSummary(client) });
  };
}
