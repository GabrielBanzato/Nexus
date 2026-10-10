import { randomBytes } from 'node:crypto';
import { db } from '../config/database.js';
import { rooms } from '../plugins/socket.js';

// Fecho por confirmar: notificação de novo a cada minuto na 1.ª meia hora, depois a cada 10 min,
// até um admin carregar em "Recebi e vi" (no app ou no botão da própria notificação). Desiste ao
// fim de 24h para um alerta esquecido não tocar para sempre.
const FAST_PHASE_MS = 30 * 60_000;
const FAST_REPEAT_MS = 60_000;
const SLOW_REPEAT_MS = 10 * 60_000;
const GIVE_UP_MS = 24 * 60 * 60_000;
const TICK_MS = 20_000;
// Toques longos: no Android o telemóvel vibra a cada repetição (o iPhone usa o padrão do sistema).
const VIBRATE = [800, 250, 800, 250, 800, 250, 1200];

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 2 });
const money = (value) => brl.format(Number(value) || 0);
const dateBr = (ymd) => (ymd ? ymd.split('-').reverse().join('/') : '—');
const firstName = (name) => (name ?? '').trim().split(/\s+/)[0] || 'Alguém';
const dealName = (deal) => deal.company || deal.title;

function publicAlert(row) {
  const details = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
  return {
    id: row.id,
    kind: row.kind,
    deal_id: row.deal_id,
    title: row.title,
    body: row.body,
    details: details ?? {},
    needs_ack: Boolean(row.needs_ack),
    acked_at: row.acked_at,
    created_at: row.created_at,
  };
}

/**
 * Avisos ao admin sobre o pipeline: cliente fechado (com o que é preciso fazer, valor e prazo —
 * insiste até ser confirmado) e negócio perdido (com o motivo). Chegam ao Nexus aberto (socket)
 * e ao telemóvel (Web Push). Quem moveu o negócio não é avisado da própria ação.
 * Nunca lança para quem chama: o negócio já foi movido.
 */
export function createAdminAlerts({ io, push, logger, now = () => Date.now() }) {
  let timer = null;

  /** Admins ativos a avisar (todos menos quem fez a ação). */
  async function recipients(actorId) {
    const query = db('users').where({ role: 'admin', is_active: true });
    if (actorId) query.whereNot('id', actorId);
    return query.pluck('id');
  }

  function pushPayload(alert, token) {
    const base = { title: alert.title, body: alert.body, tag: `alert-${alert.id}`, url: '/#/pipeline', always: true };
    if (!alert.needs_ack) return base;
    return {
      ...base,
      requireInteraction: true, // fica no ecrã até tocar
      vibrate: VIBRATE,
      actions: [{ action: 'ack', title: '✓ Recebi e vi' }],
      ackUrl: `/api/public/alerts/ack/${token}`,
    };
  }

  async function sendPush(alert, token, adminIds) {
    if (!push || !adminIds.length) return 0;
    const delivered = await push.sendToUsers(adminIds, pushPayload(alert, token));
    await db('admin_alerts')
      .where({ id: alert.id })
      .update({ push_count: db.raw('push_count + 1'), last_push_at: db.fn.now() });
    return delivered;
  }

  async function create({ kind, deal, actor, needsAck, title, body, details }) {
    try {
      const adminIds = await recipients(actor?.id);
      if (!adminIds.length) return null; // o único admin foi quem moveu
      const token = needsAck ? randomBytes(32).toString('base64url') : null;
      const [id] = await db('admin_alerts').insert({
        kind,
        deal_id: deal.id,
        actor_id: actor?.id ?? null,
        title,
        body,
        details: JSON.stringify(details),
        needs_ack: needsAck,
        ack_token: token,
      });
      const alert = publicAlert(await db('admin_alerts').where({ id }).first());
      io?.to(adminIds.map(rooms.user)).emit('alert:new', alert);
      await sendPush(alert, token, adminIds);
      logger.info({ alertId: id, kind, dealId: deal.id }, 'Aviso ao admin enviado');
      return alert;
    } catch (err) {
      logger.error({ err, kind, dealId: deal?.id }, 'Aviso ao admin: falhou');
      return null;
    }
  }

  async function acknowledge(where, userId) {
    const row = await db('admin_alerts').where(where).first();
    if (!row) return null;
    if (!row.acked_at) {
      await db('admin_alerts').where({ id: row.id }).whereNull('acked_at').update({ acked_at: db.fn.now(), acked_by: userId ?? null });
      // Fecha o alarme nos outros aparelhos/abas dos admins.
      io?.to(rooms.admins).emit('alert:acked', { id: row.id });
    }
    return publicAlert(await db('admin_alerts').where({ id: row.id }).first());
  }

  /** Reenvia os fechos ainda por confirmar (o telemóvel volta a vibrar). */
  async function tick() {
    const since = new Date(now() - GIVE_UP_MS);
    const pending = await db('admin_alerts').where({ needs_ack: true }).whereNull('acked_at').where('created_at', '>=', since);
    for (const row of pending) {
      const age = now() - new Date(row.created_at).getTime();
      const every = age < FAST_PHASE_MS ? FAST_REPEAT_MS : SLOW_REPEAT_MS;
      if (row.last_push_at && now() - new Date(row.last_push_at).getTime() < every - 1_000) continue;
      const adminIds = await recipients(row.actor_id);
      await sendPush(publicAlert(row), row.ack_token, adminIds);
    }
  }

  return {
    dealWon(deal, actor) {
      const extra = Number(deal.monthly_value) > 0 ? ` + ${money(deal.monthly_value)}/mês` : '';
      return create({
        kind: 'deal_won',
        deal,
        actor,
        needsAck: true,
        title: `🎉 ${firstName(actor?.name)} fechou ${dealName(deal)}!`,
        body: `Sistema: ${deal.won_scope}\nValor: ${money(deal.value)}${extra}\nPrazo: ${dateBr(deal.delivery_due)}`,
        details: {
          deal_title: deal.title,
          company: deal.company,
          owner_name: deal.owner_name,
          actor_name: actor?.name ?? null,
          won_scope: deal.won_scope,
          value: Number(deal.value),
          monthly_value: Number(deal.monthly_value) || 0,
          monthly_start: deal.monthly_start,
          delivery_due: deal.delivery_due,
        },
      });
    },

    dealLost(deal, actor) {
      return create({
        kind: 'deal_lost',
        deal,
        actor,
        needsAck: false,
        title: `Negócio perdido: ${dealName(deal)}`,
        body: `${firstName(actor?.name)} marcou como perdido.\nMotivo: ${deal.lost_reason}`,
        details: {
          deal_title: deal.title,
          company: deal.company,
          owner_name: deal.owner_name,
          actor_name: actor?.name ?? null,
          value: Number(deal.value),
          lost_reason: deal.lost_reason,
        },
      });
    },

    /** Fechos por confirmar (para o alarme aparecer ao abrir o Nexus). */
    async listPending() {
      const rows = await db('admin_alerts')
        .where({ needs_ack: true })
        .whereNull('acked_at')
        .where('created_at', '>=', new Date(now() - GIVE_UP_MS))
        .orderBy('id');
      return rows.map(publicAlert);
    },

    acknowledge: (id, userId) => acknowledge({ id }, userId),
    acknowledgeByToken: (token) => acknowledge({ ack_token: token }, null),

    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => tick().catch((err) => logger.error({ err }, 'Avisos ao admin: falha ao repetir')), TICK_MS);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
