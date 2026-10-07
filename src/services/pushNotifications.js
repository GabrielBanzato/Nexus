import webpush from 'web-push';
import { db } from '../config/database.js';

const SETTING_PUBLIC = 'vapid_public_key';
const SETTING_PRIVATE = 'vapid_private_key';
const GONE = new Set([404, 410]); // inscrição cancelada/expirada no aparelho

/**
 * Notificações no telemóvel/computador (Web Push), para o app instalado (PWA) e navegadores.
 *
 * As chaves VAPID (identificam este servidor junto dos serviços de push da Google, Apple e
 * Mozilla) vêm de VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY ou, sem elas, são geradas no 1.º arranque e
 * guardadas em app_settings — trocá-las invalidaria todas as inscrições, por isso ficam fixas.
 *
 * Nunca lança para quem chama: notificação é "melhor esforço" (a mensagem/lembrete já existe).
 */
export function createPushService({ logger, subject, publicKey: envPublic, privateKey: envPrivate }) {
  let publicKey = null;
  let privateKey = null;
  // Contacto exigido pelos serviços de push; a Apple recusa endereços inválidos (ex.: @*.local),
  // por isso é calculado a cada envio: o endereço do painel assim que for conhecido.
  const contact = () => (typeof subject === 'function' ? subject() : subject);
  let enabled = false;

  async function loadKeys() {
    if (envPublic && envPrivate) return { publicKey: envPublic, privateKey: envPrivate };
    const read = async () => {
      const rows = await db('app_settings').whereIn('name', [SETTING_PUBLIC, SETTING_PRIVATE]);
      const map = Object.fromEntries(rows.map((r) => [r.name, r.value]));
      return map[SETTING_PUBLIC] && map[SETTING_PRIVATE] ? { publicKey: map[SETTING_PUBLIC], privateKey: map[SETTING_PRIVATE] } : null;
    };
    const existing = await read();
    if (existing) return existing;
    const generated = webpush.generateVAPIDKeys();
    // INSERT IGNORE: com dois arranques ao mesmo tempo, fica o par de quem gravou primeiro.
    await db('app_settings')
      .insert([
        { name: SETTING_PUBLIC, value: generated.publicKey },
        { name: SETTING_PRIVATE, value: generated.privateKey },
      ])
      .onConflict('name')
      .ignore();
    logger.info('Notificações: chaves VAPID geradas e guardadas no banco');
    return read();
  }

  async function sendOne(row, payload) {
    try {
      await webpush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload, {
        TTL: 60 * 60, // sem rede durante 1h: descarta (um lembrete de "daqui a 1h" já não serve)
        urgency: 'high',
        vapidDetails: { subject: contact(), publicKey, privateKey },
      });
      await db('push_subscriptions').where({ id: row.id }).update({ last_used_at: db.fn.now() });
      return true;
    } catch (err) {
      if (GONE.has(err.statusCode)) {
        await db('push_subscriptions').where({ id: row.id }).delete();
      } else {
        logger.warn({ err: err.message, status: err.statusCode, userId: row.user_id }, 'Notificações: falha ao enviar');
      }
      return false;
    }
  }

  return {
    async init() {
      try {
        const keys = await loadKeys();
        publicKey = keys.publicKey;
        privateKey = keys.privateKey;
        enabled = true;
      } catch (err) {
        logger.error({ err }, 'Notificações: desligadas (não foi possível preparar as chaves VAPID)');
      }
    },

    isEnabled: () => enabled,
    publicKey: () => publicKey,

    /** Guarda (ou move para este utilizador) a inscrição de um aparelho. */
    async subscribe(userId, { endpoint, keys }, userAgent) {
      await db('push_subscriptions')
        .insert({ user_id: userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, user_agent: userAgent?.slice(0, 255) ?? null })
        .onConflict('endpoint')
        .merge(['user_id', 'p256dh', 'auth', 'user_agent']);
    },

    unsubscribe(userId, endpoint) {
      return db('push_subscriptions').where({ user_id: userId, endpoint }).delete();
    },

    /**
     * Envia a todos os aparelhos destes utilizadores (ativos).
     * @param {number[]} userIds
     * @param {{ title: string, body?: string, url?: string, tag?: string, always?: boolean }} message
     *        `always`: mostra mesmo com o Nexus aberto à frente (por padrão o app aberto já avisa).
     * @returns {Promise<number>} quantos aparelhos receberam
     */
    async sendToUsers(userIds, message) {
      if (!enabled) return 0;
      const ids = [...new Set(userIds.filter(Boolean))];
      if (!ids.length) return 0;
      try {
        const rows = await db('push_subscriptions as p')
          .join('users as u', 'u.id', 'p.user_id')
          .where('u.is_active', true)
          .whereIn('p.user_id', ids)
          .select('p.*');
        const payload = JSON.stringify(message);
        const results = await Promise.all(rows.map((row) => sendOne(row, payload)));
        return results.filter(Boolean).length;
      } catch (err) {
        logger.error({ err }, 'Notificações: falha ao enviar');
        return 0;
      }
    },

    async sendToAdmins(message) {
      if (!enabled) return 0;
      const admins = await db('users').where({ role: 'admin', is_active: true }).pluck('id').catch(() => []);
      return this.sendToUsers(admins, message);
    },
  };
}
