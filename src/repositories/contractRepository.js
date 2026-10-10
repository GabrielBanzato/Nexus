import { db } from '../config/database.js';
import { monthRange } from '../lib/time.js';

/**
 * Contratos da equipe (comissões) e mensalidades dos clientes fechados. Só o admin acede.
 *
 * Comissão do mês, por pessoa (dona do negócio):
 *  - Fecho: vendas fechadas no mês × % de fecho (o % fica fixado no negócio quando fecha:
 *    mudar o contrato depois não altera vendas antigas).
 *  - Mensalidade: mensalidades do mês MARCADAS COMO PAGAS × % de mensalidade (o % fica fixado
 *    no pagamento). As ainda por pagar aparecem à parte, como "previsto".
 *    Com `monthly_months` no contrato, só os primeiros N meses de cada cliente dão comissão.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const commission = (amount, rate) => round2((Number(amount) * Number(rate || 0)) / 100);
const monthDate = (ym) => `${ym}-01`;
/** Meses entre o 1.º mês da mensalidade e `ym` (0 = primeiro mês). */
const monthIndex = (startDate, ym) => {
  const [sy, sm] = startDate.slice(0, 7).split('-').map(Number);
  const [y, m] = ym.split('-').map(Number);
  return (y - sy) * 12 + (m - sm);
};

const CONTRACT_COLUMNS = ['closing_rate', 'monthly_rate', 'monthly_months', 'notes'];
const EMPTY_CONTRACT = { closing_rate: 0, monthly_rate: 0, monthly_months: null, notes: null, configured: false };

/** Todos os membros (ativos primeiro) com o contrato de cada um (ou o vazio). */
export async function listContracts() {
  const rows = await db('users as u')
    .leftJoin('user_contracts as c', 'c.user_id', 'u.id')
    .select('u.id as user_id', 'u.name', 'u.role', 'u.is_active', 'c.closing_rate', 'c.monthly_rate', 'c.monthly_months', 'c.notes', 'c.updated_at', db.raw('c.user_id IS NOT NULL AS configured'))
    .orderBy([{ column: 'u.is_active', order: 'desc' }, { column: 'u.name' }]);
  return rows.map((r) => ({
    ...r,
    configured: Boolean(r.configured),
    closing_rate: r.configured ? Number(r.closing_rate) : 0,
    monthly_rate: r.configured ? Number(r.monthly_rate) : 0,
  }));
}

export async function upsertContract(userId, fields, updatedBy) {
  const row = { user_id: userId, updated_by: updatedBy };
  for (const key of CONTRACT_COLUMNS) if (fields[key] !== undefined) row[key] = fields[key];
  await db('user_contracts').insert(row).onConflict('user_id').merge();
  return (await listContracts()).find((c) => c.user_id === userId);
}

/**
 * Mensalidades do mês `ym`: negócios fechados com mensalidade em curso nesse mês, mais qualquer
 * pagamento já registado no mês (mesmo que o negócio tenha sido reaberto/terminado depois).
 */
export async function listSubscriptions(ym) {
  const month = monthDate(ym);
  const deals = await db('deals as d')
    .leftJoin('users as o', 'o.id', 'd.owner_id')
    .leftJoin('deal_payments as p', function joinPayment() {
      this.on('p.deal_id', 'd.id').andOn('p.month', db.raw('?', [month]));
    })
    .where((w) =>
      w
        .where((active) =>
          active
            .where('d.stage', 'won')
            .where('d.monthly_value', '>', 0)
            .where('d.monthly_start', '<=', month)
            .where((end) => end.whereNull('d.monthly_end').orWhere('d.monthly_end', '>=', month)),
        )
        .orWhereNotNull('p.id'),
    )
    .select(
      'd.id as deal_id',
      'd.title',
      'd.company',
      'd.client_id',
      'd.owner_id',
      'o.name as owner_name',
      'd.monthly_value',
      'd.monthly_start',
      'd.monthly_end',
      'd.stage',
      'p.id as payment_id',
      'p.amount as paid_amount',
      'p.commission_rate as paid_rate',
      'p.paid_at',
    )
    .orderBy([{ column: 'o.name' }, { column: 'd.company' }, { column: 'd.title' }]);
  return deals.map((d) => ({
    ...d,
    month: ym,
    month_number: d.monthly_start ? monthIndex(d.monthly_start, ym) + 1 : null,
    paid: Boolean(d.payment_id),
  }));
}

/** Marca a mensalidade de `ym` como paga (fixa o % do vendedor neste momento). */
export async function recordPayment(dealId, ym, { amount, recordedBy }) {
  const deal = await db('deals').where({ id: dealId }).first('id', 'owner_id', 'monthly_value');
  if (!deal) return null;
  const contract = deal.owner_id ? await db('user_contracts').where({ user_id: deal.owner_id }).first('monthly_rate') : null;
  await db('deal_payments')
    .insert({
      deal_id: dealId,
      month: monthDate(ym),
      amount: amount ?? deal.monthly_value,
      commission_rate: contract ? contract.monthly_rate : null,
      recorded_by: recordedBy,
    })
    .onConflict(['deal_id', 'month'])
    .merge(['amount']);
  return (await listSubscriptions(ym)).find((s) => s.deal_id === dealId) ?? null;
}

export function removePayment(dealId, ym) {
  return db('deal_payments').where({ deal_id: dealId, month: monthDate(ym) }).delete();
}

/**
 * Quanto pagar a cada pessoa no mês `ym` (fechos + mensalidades pagas) e o previsto se os
 * clientes em falta pagarem.
 */
export async function monthStatement(ym, timeZone) {
  const { from, to } = monthRange(ym, timeZone);
  const contracts = await listContracts();
  const byUser = new Map(contracts.map((c) => [c.user_id, c]));

  const closings = await db('deals as d')
    .leftJoin('user_contracts as c', 'c.user_id', 'd.owner_id')
    .where('d.stage', 'won')
    .where('d.won_at', '>=', from)
    .where('d.won_at', '<', to)
    .whereNotNull('d.owner_id')
    .select('d.id as deal_id', 'd.title', 'd.company', 'd.owner_id', 'd.value', 'd.monthly_value', 'd.won_at', db.raw('COALESCE(d.closing_rate, c.closing_rate, 0) AS rate'))
    .orderBy('d.won_at');

  const subscriptions = (await listSubscriptions(ym)).filter((s) => s.owner_id);

  const people = new Map();
  const person = (userId) => {
    if (!people.has(userId)) {
      const c = byUser.get(userId) ?? { user_id: userId, name: '—', role: null, is_active: false, ...EMPTY_CONTRACT };
      people.set(userId, { user: { id: userId, name: c.name, role: c.role, is_active: c.is_active }, contract: c, closings: [], monthly: [] });
    }
    return people.get(userId);
  };
  // Toda a equipa ativa aparece (mesmo sem nada no mês), exceto admins sem contrato.
  for (const c of contracts) if (c.is_active && (c.role !== 'admin' || c.configured)) person(c.user_id);

  for (const d of closings) {
    const rate = Number(d.rate);
    person(d.owner_id).closings.push({ ...d, value: Number(d.value), rate, commission: commission(d.value, rate) });
  }

  for (const s of subscriptions) {
    const p = person(s.owner_id);
    const limit = p.contract.monthly_months;
    const eligible = limit == null || (s.month_number ?? 1) <= limit;
    const rate = eligible ? Number(s.paid ? (s.paid_rate ?? p.contract.monthly_rate) : p.contract.monthly_rate) : 0;
    const amount = Number(s.paid ? s.paid_amount : s.monthly_value);
    p.monthly.push({
      deal_id: s.deal_id,
      title: s.title,
      company: s.company,
      month_number: s.month_number,
      amount,
      paid: s.paid,
      paid_at: s.paid_at,
      eligible,
      rate,
      commission: commission(amount, rate),
    });
  }

  const rows = [...people.values()].map((p) => {
    const closing = round2(p.closings.reduce((sum, d) => sum + d.commission, 0));
    const monthlyPaid = round2(p.monthly.filter((m) => m.paid).reduce((sum, m) => sum + m.commission, 0));
    const monthlyPending = round2(p.monthly.filter((m) => !m.paid).reduce((sum, m) => sum + m.commission, 0));
    return {
      ...p,
      totals: {
        sold: round2(p.closings.reduce((sum, d) => sum + d.value, 0)),
        closing,
        monthly_paid: monthlyPaid,
        monthly_pending: monthlyPending,
        to_pay: round2(closing + monthlyPaid),
      },
    };
  });
  rows.sort((a, b) => b.totals.to_pay - a.totals.to_pay || a.user.name.localeCompare(b.user.name));

  const sum = (key) => round2(rows.reduce((total, r) => total + r.totals[key], 0));
  const received = round2(subscriptions.filter((s) => s.paid).reduce((total, s) => total + Number(s.paid_amount), 0));
  const expected = round2(subscriptions.reduce((total, s) => total + Number(s.paid ? s.paid_amount : s.monthly_value), 0));
  return {
    month: ym,
    people: rows,
    totals: {
      sold: sum('sold'),
      closing: sum('closing'),
      monthly_paid: sum('monthly_paid'),
      monthly_pending: sum('monthly_pending'),
      to_pay: sum('to_pay'),
      subscriptions_received: received,
      subscriptions_expected: expected,
    },
  };
}
