import { sameDayAt } from '../lib/time.js';
import { rooms } from '../plugins/socket.js';
import { findClientById, toWhatsAppNumber } from '../repositories/clientRepository.js';
import { listMeetingsToRemind, meetingLink, updateMeeting } from '../repositories/meetingRepository.js';
import { clientReminderText, formatMeeting, greetingName, hostReminderText, sendMeetingMessage } from '../services/meetingNotifier.js';

export { sameDayAt }; // usado nos testes

const HOUR_MS = 60 * 60_000;
const LOOKAHEAD_MS = 36 * HOUR_MS; // basta cobrir "amanhã de manhã"

/**
 * Que lembretes uma reunião deve receber AGORA. Cada um só sai uma vez (as colunas *_sent_at
 * marcam-no, mesmo quando é dispensado):
 *  - 'day': a partir das `reminderHour` do dia da reunião. Dispensado se a reunião foi marcada
 *    já depois dessa hora (a confirmação acabou de chegar) ou se já falta menos de 1h.
 *  - 'hour': a partir de 1h antes. Dispensado se a reunião foi marcada já dentro dessa hora.
 * @returns {{ day: 'send'|'skip'|null, hour: 'send'|'skip'|null }}
 */
export function remindersDue(meeting, { now, reminderHour, timeZone }) {
  const at = new Date(meeting.scheduled_at);
  const created = new Date(meeting.created_at);
  const dayMark = sameDayAt(at, reminderHour, timeZone);
  const hourMark = new Date(at.getTime() - HOUR_MS);
  const due = { day: null, hour: null };
  if (!meeting.remind_day_sent_at && now >= dayMark) {
    due.day = created >= dayMark || now >= hourMark ? 'skip' : 'send';
  }
  if (!meeting.remind_hour_sent_at && now >= hourMark) {
    due.hour = created >= hourMark ? 'skip' : 'send';
  }
  return due;
}

/**
 * Lembretes das reuniões marcadas: no dia (de manhã) e 1h antes, ao cliente (WhatsApp, assinado
 * por quem conduz) e a quem conduz (aviso no Nexus e, se tiver telefone, no WhatsApp dele).
 * Corre a cada minuto; sobrevive a reinícios (o estado está no banco).
 */
export function createMeetingReminders({ whatsapp, io, push, logger, timeZone, reminderHour, intervalMs = 60_000 }) {
  let timer = null;
  let running = false;

  async function remind(meeting, kind) {
    const scheduledAt = new Date(meeting.scheduled_at);
    const link = meetingLink(meeting.code);
    const host = meeting.host_user_id ? { id: meeting.host_user_id, name: meeting.host_name } : null;
    const client = meeting.client_id ? await findClientById(meeting.client_id) : null;
    const clientName = client?.name ?? meeting.deal_company ?? meeting.title;

    // 1) Cliente
    let clientResult = { sent: false, reason: 'NO_CLIENT' };
    if (client) {
      const name = greetingName({ contactName: meeting.contact_name ?? client.name, company: client.company ?? meeting.deal_company });
      clientResult = await sendMeetingMessage({ whatsapp, io, client, content: clientReminderText({ kind, name, meetingAt: scheduledAt, link }), user: host, logger });
    }

    // 2) Quem conduz: aviso no Nexus (abas abertas) e no WhatsApp pessoal, se cadastrado.
    if (host && meeting.host_active) {
      io.to(rooms.user(host.id)).emit('meeting:reminder', {
        kind,
        meeting: { id: meeting.id, code: meeting.code, title: meeting.title, scheduled_at: scheduledAt, client_name: clientName, link },
        client_notified: clientResult.sent,
      });
      const time = formatMeeting(scheduledAt).time;
      push
        ?.sendToUsers([host.id], {
          title: kind === 'day' ? `Hoje às ${time}: reunião com ${clientName}` : `Em 1 hora (${time}): reunião com ${clientName}`,
          body: clientResult.sent ? 'O cliente também foi lembrado pelo WhatsApp. Toque para abrir a sala.' : 'Toque para abrir a sala.',
          url: link ?? '/',
          tag: `meeting-${meeting.id}-${kind}`,
          always: true,
        })
        .catch(() => {});
      const number = toWhatsAppNumber(meeting.host_phone);
      if (number && whatsapp?.getState().status === 'ready') {
        await whatsapp
          .sendText({ number }, hostReminderText({ kind, clientName, meetingAt: scheduledAt, link }))
          .catch((err) => logger.warn({ err: err.message, meetingId: meeting.id }, 'Lembrete: não foi possível avisar quem conduz no WhatsApp'));
      }
    }
    logger.info({ meetingId: meeting.id, kind, clientNotified: clientResult.sent, reason: clientResult.reason }, 'Lembrete de reunião enviado');
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const meetings = await listMeetingsToRemind({ now, withinMs: LOOKAHEAD_MS });
      for (const meeting of meetings) {
        const due = remindersDue(meeting, { now, reminderHour, timeZone });
        for (const kind of ['day', 'hour']) {
          if (!due[kind]) continue;
          // Marca ANTES de enviar: uma falha a meio nunca repete o lembrete a cada minuto.
          await updateMeeting(meeting.id, { [`remind_${kind}_sent_at`]: now });
          if (due[kind] === 'send') await remind(meeting, kind).catch((err) => logger.error({ err, meetingId: meeting.id, kind }, 'Lembrete de reunião falhou'));
        }
      }
    } catch (err) {
      logger.error({ err }, 'Lembretes de reunião: falha ao verificar');
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
      tick();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    tick, // testes
  };
}
