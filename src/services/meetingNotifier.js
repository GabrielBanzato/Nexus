import { config } from '../config/env.js';
import { ensureClientForDeal } from '../repositories/clientRepository.js';
import { sendToClient } from './whatsappOutbox.js';

// Criados no arranque: um BUSINESS_TIMEZONE inválido derruba o boot com erro claro,
// em vez de falhar só quando alguém agendar uma reunião.
const dateFormat = new Intl.DateTimeFormat('pt-BR', { timeZone: config.business.timezone, weekday: 'long', day: '2-digit', month: '2-digit' });
const timeFormat = new Intl.DateTimeFormat('pt-BR', { timeZone: config.business.timezone, hour: '2-digit', minute: '2-digit' });

/** "quinta-feira, 02/10" e "14:30", no fuso da empresa (o servidor corre em UTC). */
export function formatMeeting(date) {
  return { date: dateFormat.format(date), time: timeFormat.format(date) };
}

/** Texto da confirmação. Só usa o nome se houver um contacto (não "Olá, Pizzaria!"). */
export function meetingConfirmationText({ contactName, meetingAt }) {
  const firstName = contactName?.trim().split(/\s+/)[0];
  const { date, time } = formatMeeting(meetingAt);
  return `Olá${firstName ? `, ${firstName}` : ''}! Sua reunião está confirmada para ${date} às ${time}. Em breve enviaremos o link. Até lá! 👋`;
}

const REASONS = {
  WHATSAPP_DISABLED: 'A integração com o WhatsApp está desligada.',
  WHATSAPP_NOT_READY: 'O WhatsApp da empresa não está conectado.',
  NO_PHONE: 'O negócio não tem um telefone válido para WhatsApp.',
  NOT_ON_WHATSAPP: 'O telefone do cliente não tem WhatsApp.',
};

/**
 * Envia a confirmação da reunião ao cliente (sender_type = bot: mensagem automática, com
 * sender_user_id = quem agendou). NUNCA lança: a reunião já está agendada quando isto corre;
 * a confirmação é "melhor esforço" e o resultado vai para a UI avisar o vendedor.
 * @returns {Promise<{ sent: boolean, reason?: string, message?: string, client_id?: number, content?: string }>}
 */
export async function sendMeetingConfirmation({ whatsapp, io, deal, meetingAt, userId, logger }) {
  try {
    const client = await ensureClientForDeal(deal);
    if (!client) return { sent: false, reason: 'NO_PHONE', message: REASONS.NO_PHONE };

    const content = meetingConfirmationText({ contactName: deal.contact_name, meetingAt });
    const { message } = await sendToClient({ whatsapp, io, client, content, senderType: 'bot', senderUserId: userId });
    return { sent: true, client_id: client.id, message_id: message.id, content };
  } catch (err) {
    if (!REASONS[err.code]) logger.error({ err, dealId: deal.id }, 'Falha ao enviar a confirmação de reunião');
    return { sent: false, reason: err.code ?? 'SEND_FAILED', message: REASONS[err.code] ?? 'Falha inesperada ao enviar pelo WhatsApp.' };
  }
}
