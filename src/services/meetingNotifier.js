import { config } from '../config/env.js';
import { ensureClientForDeal } from '../repositories/clientRepository.js';
import { whatsappSignature } from '../repositories/userRepository.js';
import { sendToClient } from './whatsappOutbox.js';

// Criados no arranque: um BUSINESS_TIMEZONE inválido derruba o boot com erro claro,
// em vez de falhar só quando alguém agendar uma reunião.
const dateFormat = new Intl.DateTimeFormat('pt-BR', { timeZone: config.business.timezone, weekday: 'long', day: '2-digit', month: '2-digit' });
const timeFormat = new Intl.DateTimeFormat('pt-BR', { timeZone: config.business.timezone, hour: '2-digit', minute: '2-digit' });

/** "quinta-feira, 02/10" e "14:30", no fuso da empresa (o servidor corre em UTC). */
export function formatMeeting(date) {
  return { date: dateFormat.format(date), time: timeFormat.format(date) };
}

/**
 * Primeiro nome da pessoa, para cumprimentar ("Oi, Ana!"). Nunca o nome da empresa ("Oi,
 * Pizzaria!") nem um número: nesses casos o cumprimento vai sem nome.
 */
export function greetingName({ contactName, company } = {}) {
  const name = String(contactName ?? '').trim();
  if (!name || /^[+\d(]/.test(name)) return null;
  if (company && name.toLowerCase() === String(company).trim().toLowerCase()) return null;
  return name.split(/\s+/)[0];
}

const hi = (name, word = 'Oi') => `${word}${name ? `, ${name}` : ''}!`;

// ---------------------------------------------------------------------------
// Textos ao cliente (saem assinados por quem conduz: "*Gabriel*" na 1.ª linha)
// ---------------------------------------------------------------------------

/** Convite para entrar AGORA (botão de vídeo na Central). */
export function instantInviteText({ name, link }) {
  return [
    `${hi(name)} Que tal a gente continuar essa conversa por vídeo? Fica bem mais fácil eu te mostrar tudo com calma 🙂`,
    `É só tocar no link abaixo, pelo celular ou pelo computador. Não precisa instalar nada nem criar conta:\n${link}`,
    'Já estou te esperando na sala!',
  ].join('\n\n');
}

/**
 * Confirmação de uma reunião marcada (Pipeline ou Central). Com `link` (sala da plataforma)
 * envia-o já; sem PUBLIC_APP_URL, promete-o.
 */
export function meetingConfirmationText({ name, meetingAt, link }) {
  const { date, time } = formatMeeting(meetingAt);
  const head = `${hi(name)} Combinado: nossa conversa por vídeo fica marcada para *${date}, às ${time}* ✅`;
  if (!link) return `${head}\n\nPerto do horário eu te mando o link por aqui. Até lá!`;
  return [
    head,
    `Na hora, é só tocar neste link (funciona no celular ou no computador, sem instalar nada):\n${link}`,
    'Vou te lembrar no dia e uma hora antes. Se precisar mudar o horário, é só me chamar aqui!',
  ].join('\n\n');
}

/** Lembretes ao cliente: 'day' = de manhã, no dia da reunião; 'hour' = 1h antes. */
export function clientReminderText({ kind, name, meetingAt, link }) {
  const { time } = formatMeeting(meetingAt);
  const where = link ? `O link é este:\n${link}` : 'Já já te mando o link por aqui.';
  if (kind === 'day') {
    return [`${hi(name, 'Bom dia')} ☀️ Passando para lembrar que hoje, às *${time}*, temos a nossa conversa por vídeo.`, where, 'Até mais tarde!'].join('\n\n');
  }
  return [
    `${hi(name)} Daqui a 1 hora, às *${time}*, a gente se fala por vídeo 🙂`,
    link ? `É só tocar no link na hora:\n${link}` : where,
    'Se surgir algum imprevisto, me avisa por aqui que a gente remarca.',
  ].join('\n\n');
}

/** Lembrete a quem conduz (vai do número da empresa para o WhatsApp do membro). */
export function hostReminderText({ kind, clientName, meetingAt, link }) {
  const { time } = formatMeeting(meetingAt);
  const head = kind === 'day' ? `🔔 *Lembrete do Nexus*\nHoje às ${time} você tem reunião com *${clientName}*.` : `⏰ *Lembrete do Nexus*\nEm 1 hora (às ${time}): reunião com *${clientName}*.`;
  return link ? `${head}\nSala: ${link}` : head;
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

const REASONS = {
  WHATSAPP_DISABLED: 'A integração com o WhatsApp está desligada.',
  WHATSAPP_NOT_READY: 'O WhatsApp da empresa não está conectado.',
  NO_PHONE: 'O cliente não tem um telefone válido para WhatsApp.',
  NOT_ON_WHATSAPP: 'O telefone do cliente não tem WhatsApp.',
};

/**
 * Envia uma mensagem da reunião ao cliente, assinada por `user` (sender_type = bot: automática,
 * com sender_user_id = quem a disparou). NUNCA lança: a reunião já existe quando isto corre;
 * o resultado vai para a UI avisar quem agendou.
 * @returns {Promise<{ sent: boolean, reason?: string, message?: string, client_id?: number, content?: string }>}
 */
export async function sendMeetingMessage({ whatsapp, io, client, content, user, logger }) {
  try {
    if (!client) return { sent: false, reason: 'NO_PHONE', message: REASONS.NO_PHONE };
    const signature = await whatsappSignature(user);
    const { message } = await sendToClient({ whatsapp, io, client, content, senderType: 'bot', senderUserId: user?.id ?? null, signature });
    return { sent: true, client_id: client.id, message_id: message.id, content };
  } catch (err) {
    if (!REASONS[err.code]) logger.error({ err, clientId: client?.id }, 'Falha ao enviar mensagem da reunião');
    return { sent: false, reason: err.code ?? 'SEND_FAILED', message: REASONS[err.code] ?? 'Falha inesperada ao enviar pelo WhatsApp.' };
  }
}

/** Confirmação da reunião de um negócio (Pipeline → "Reunião Agendada"). */
export async function sendMeetingConfirmation({ whatsapp, io, deal, meetingAt, link = null, user, logger }) {
  let client = null;
  try {
    client = await ensureClientForDeal(deal);
  } catch (err) {
    logger.error({ err, dealId: deal.id }, 'Falha ao preparar o cliente do negócio para a confirmação');
  }
  const content = meetingConfirmationText({ name: greetingName({ contactName: deal.contact_name, company: deal.company }), meetingAt, link });
  return sendMeetingMessage({ whatsapp, io, client, content, user, logger });
}
