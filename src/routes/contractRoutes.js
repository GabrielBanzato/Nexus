import { config } from '../config/env.js';
import { notFound } from '../lib/errors.js';
import { requireRole } from '../plugins/auth.js';
import { logActivity } from '../repositories/activityLogRepository.js';
import { listContracts, listSubscriptions, monthStatement, recordPayment, removePayment, upsertContract } from '../repositories/contractRepository.js';
import { dateKeyIn } from '../lib/time.js';

const monthKey = { type: 'string', pattern: '^20\\d{2}-(0[1-9]|1[0-2])$' }; // 'YYYY-MM'
const rate = { type: 'number', minimum: 0, maximum: 100 };
const currentMonth = () => dateKeyIn(new Date(), config.business.timezone).slice(0, 7);

const monthQuery = { querystring: { type: 'object', additionalProperties: false, properties: { month: monthKey } } };

const contractSchema = {
  params: { type: 'object', required: ['userId'], properties: { userId: { type: 'integer', minimum: 1 } } },
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      closing_rate: rate,
      monthly_rate: rate,
      monthly_months: { type: ['integer', 'null'], minimum: 1, maximum: 600 },
      notes: { type: ['string', 'null'], maxLength: 500 },
    },
  },
};

const paymentParams = {
  type: 'object',
  required: ['dealId', 'month'],
  properties: { dealId: { type: 'integer', minimum: 1 }, month: monthKey },
};

const paymentSchema = {
  params: paymentParams,
  body: {
    type: ['object', 'null'],
    additionalProperties: false,
    properties: { amount: { type: 'number', minimum: 0, maximum: 9_999_999.99 } },
  },
};

/** Painel do admin: contratos (comissões) da equipe e mensalidades dos clientes. */
export default async function contractRoutes(app) {
  app.addHook('preHandler', requireRole('admin'));

  app.get('/api/contracts', async () => ({ data: await listContracts() }));

  app.put('/api/contracts/:userId', { schema: contractSchema }, async (request) => {
    const { userId } = request.params;
    const exists = (await listContracts()).some((c) => c.user_id === userId);
    if (!exists) throw notFound('Usuário');
    const contract = await upsertContract(userId, request.body, request.currentUser.id);
    await logActivity(request, { action: 'contract.update', entityType: 'user', entityId: userId, details: request.body });
    return { data: contract };
  });

  /** Quanto pagar a cada um no mês (fechos + mensalidades pagas) e o previsto. */
  app.get('/api/commissions', { schema: monthQuery }, async (request) => ({
    data: await monthStatement(request.query.month ?? currentMonth(), config.business.timezone),
  }));

  app.get('/api/subscriptions', { schema: monthQuery }, async (request) => {
    const month = request.query.month ?? currentMonth();
    return { data: await listSubscriptions(month), meta: { month } };
  });

  // Marcar / desmarcar a mensalidade de um mês como paga pelo cliente.
  app.put('/api/subscriptions/:dealId/payments/:month', { schema: paymentSchema }, async (request) => {
    const { dealId, month } = request.params;
    const row = await recordPayment(dealId, month, { amount: request.body?.amount, recordedBy: request.currentUser.id });
    if (!row) throw notFound('Negócio');
    await logActivity(request, { action: 'payment.record', entityType: 'deal', entityId: dealId, details: { month, amount: row.paid_amount } });
    return { data: row };
  });

  app.delete('/api/subscriptions/:dealId/payments/:month', { schema: { params: paymentParams } }, async (request, reply) => {
    const { dealId, month } = request.params;
    const removed = await removePayment(dealId, month);
    if (!removed) throw notFound('Pagamento');
    await logActivity(request, { action: 'payment.remove', entityType: 'deal', entityId: dealId, details: { month } });
    return reply.code(204).send();
  });
}
