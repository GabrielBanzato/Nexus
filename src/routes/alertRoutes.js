import { notFound } from '../lib/errors.js';
import { requireRole } from '../plugins/auth.js';
import { idParam } from './schemas.js';

const tokenParam = {
  type: 'object',
  required: ['token'],
  properties: { token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } },
};

/**
 * Botão "Recebi e vi" da notificação no telemóvel: o service worker não tem a sessão, por isso
 * confirma com o token aleatório que veio na própria notificação (só serve para este alerta).
 */
export async function publicAlertRoutes(app) {
  app.post(
    '/api/public/alerts/ack/:token',
    { schema: { params: tokenParam }, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const alert = await app.adminAlerts.acknowledgeByToken(request.params.token);
      if (!alert) throw notFound('Aviso');
      return { data: { id: alert.id, acked: true } };
    },
  );
}

/** Avisos do pipeline ao admin (fechos por confirmar). */
export default async function alertRoutes(app) {
  app.get('/api/alerts/pending', { preHandler: requireRole('admin') }, async () => ({ data: await app.adminAlerts.listPending() }));

  app.post('/api/alerts/:id/ack', { schema: { params: idParam }, preHandler: requireRole('admin') }, async (request) => {
    const alert = await app.adminAlerts.acknowledge(request.params.id, request.currentUser.id);
    if (!alert) throw notFound('Aviso');
    return { data: alert };
  });
}
