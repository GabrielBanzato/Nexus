import { db } from '../config/database.js';
import { notFound } from '../lib/errors.js';
import { createOrderedBoard } from '../lib/orderedBoard.js';

export const DEAL_STAGES = ['lead', 'qualification', 'proposal', 'negotiation', 'won', 'lost'];
export const OPEN_STAGES = ['lead', 'qualification', 'proposal', 'negotiation'];
export const DEAL_FIELDS = ['title', 'company', 'contact_name', 'phone', 'email', 'value', 'owner_id', 'client_id', 'expected_close_date'];

/** Probabilidade de fecho por estágio, para a previsão ponderada do pipeline. */
export const STAGE_PROBABILITY = { lead: 0.1, qualification: 0.25, proposal: 0.5, negotiation: 0.75, won: 1, lost: 0 };

const board = createOrderedBoard({ table: 'deals', columnField: 'stage', notFound: () => notFound('Negócio') });

const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

function withNames(query) {
  return query
    .leftJoin('users as o', 'o.id', 'd.owner_id')
    .leftJoin('clients as c', 'c.id', 'd.client_id')
    .select('d.*', 'o.name as owner_name', 'c.name as client_name');
}

export function findDealById(id) {
  return withNames(db('deals as d')).where('d.id', id).first();
}

/** Pipeline agrupado por estágio + totais (quantidade, valor, valor ponderado) de cada estágio. */
export async function getDealBoard({ ownerId, q } = {}) {
  const query = withNames(db('deals as d')).orderBy('d.stage').orderBy('d.position').orderBy('d.id');
  if (ownerId) query.where('d.owner_id', ownerId);
  if (q) {
    const term = `%${escapeLike(q)}%`;
    query.where((w) => w.where('d.title', 'like', term).orWhere('d.company', 'like', term).orWhere('d.contact_name', 'like', term));
  }

  const deals = await query;
  const grouped = Object.fromEntries(DEAL_STAGES.map((stage) => [stage, []]));
  for (const deal of deals) grouped[deal.stage].push(deal);

  const totals = Object.fromEntries(
    DEAL_STAGES.map((stage) => {
      const value = grouped[stage].reduce((sum, d) => sum + Number(d.value), 0);
      return [stage, { count: grouped[stage].length, value, weighted: value * STAGE_PROBABILITY[stage] }];
    }),
  );
  return { board: grouped, totals };
}

/** Cria o negócio (sempre num estágio aberto). `afterInsert` roda na mesma transação. */
export async function createDeal({ stage = 'lead', position, ...fields }, afterInsert) {
  const id = await board.insert(fields, { column: stage, position }, afterInsert);
  return findDealById(id);
}

export async function updateDeal(id, fields) {
  await db('deals').where({ id }).update(fields);
  return findDealById(id);
}

/**
 * Move no pipeline (drag-and-drop). Efeitos de estágio, na mesma transação:
 *  - → won:  won_at; cria o cliente conquistado (ou reativa o associado); lead → FECHADO.
 *  - → lost: lost_at + motivo.
 *  - won/lost → estágio aberto: reabre (limpa carimbos e motivo).
 * @returns {Promise<{ deal, from, to, clientCreatedId: number|null }>}
 */
export async function moveDeal(id, { stage, position, lostReason }) {
  const { from, to, extra } = await board.move(id, { column: stage, position }, async (trx, { row, from: f, to: t }) => {
    const changes = {};
    let clientCreatedId = null;
    if (f.column !== t.column) changes.stage_changed_at = db.fn.now();

    if (t.column === 'won' && f.column !== 'won') {
      Object.assign(changes, { won_at: db.fn.now(), lost_at: null, lost_reason: null });
      let clientId = row.client_id;
      if (clientId) {
        await trx('clients').where({ id: clientId }).update({ status: 'active' });
      } else {
        [clientId] = await trx('clients').insert({
          name: row.contact_name || row.company || row.title,
          company: row.company,
          phone: row.phone,
          email: row.email,
          status: 'active',
          responsible_id: row.owner_id,
          lead_id: row.lead_id,
        });
        clientCreatedId = clientId;
      }
      changes.client_id = clientId;
      if (row.lead_id) await trx('leads').where({ id: row.lead_id }).update({ status_prospeccao: 'FECHADO' });
    } else if (t.column === 'lost' && f.column !== 'lost') {
      Object.assign(changes, { lost_at: db.fn.now(), won_at: null, lost_reason: lostReason ?? null });
    } else if (t.column === 'lost' && lostReason !== undefined) {
      changes.lost_reason = lostReason;
    } else if (OPEN_STAGES.includes(t.column) && !OPEN_STAGES.includes(f.column)) {
      Object.assign(changes, { won_at: null, lost_at: null, lost_reason: null });
    }

    if (Object.keys(changes).length) await trx('deals').where({ id }).update(changes);
    return { clientCreatedId };
  });

  return { deal: await findDealById(id), from, to, clientCreatedId: extra.clientCreatedId };
}

export function deleteDeal(id) {
  return board.remove(id);
}
