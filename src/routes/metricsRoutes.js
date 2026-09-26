import { badRequest } from '../lib/errors.js';
import { isManager } from '../plugins/auth.js';
import { getPerformance } from '../repositories/metricsRepository.js';

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366 * 3;

const schema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      from: { type: 'string', format: 'date' },
      to: { type: 'string', format: 'date' },
      user_id: { type: 'integer', minimum: 1 },
    },
  },
};

/** 'YYYY-MM-DD' → meia-noite UTC. `to` é inclusivo (vira o início do dia seguinte). */
function parseRange({ from, to }) {
  const today = new Date(new Date().toISOString().slice(0, 10));
  const end = to ? new Date(`${to}T00:00:00Z`) : today;
  const start = from ? new Date(`${from}T00:00:00Z`) : new Date(end.getTime() - 29 * DAY_MS);
  if (start > end) throw badRequest('A data inicial deve ser anterior ou igual à final.');
  if ((end - start) / DAY_MS > MAX_RANGE_DAYS) throw badRequest('Intervalo máximo: 3 anos.');
  return { start, endExclusive: new Date(end.getTime() + DAY_MS) };
}

export default async function metricsRoutes(app) {
  /**
   * Desempenho comercial. Controlo de acesso:
   *  - admin/partner: visão da equipa; `user_id` foca o overview num colaborador.
   *  - agent: overview e leaderboard só com os próprios números (com a posição real no ranking).
   */
  app.get('/api/metrics/performance', { schema }, async (request) => {
    const user = request.currentUser;
    const { start, endExclusive } = parseRange(request.query);
    const manager = isManager(user);

    const data = await getPerformance({
      from: start,
      to: endExclusive,
      userId: manager ? request.query.user_id : user.id,
      leaderboardUserId: manager ? undefined : user.id,
    });

    return {
      data,
      meta: {
        from: start.toISOString().slice(0, 10),
        to: new Date(endExclusive.getTime() - DAY_MS).toISOString().slice(0, 10),
        scope: manager ? (request.query.user_id ? 'user' : 'team') : 'self',
      },
    };
  });
}
