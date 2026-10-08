import { db } from '../config/database.js';
import { notFound } from '../lib/errors.js';
import { createOrderedBoard } from '../lib/orderedBoard.js';

// lead = "Triagem/Novo" (entrada dos leads qualificados no Radar), meeting = "Reunião Agendada",
// awaiting = "Aguardando Resposta".
export const DEAL_STAGES = ['lead', 'meeting', 'negotiation', 'awaiting', 'won', 'lost'];
export const OPEN_STAGES = ['lead', 'meeting', 'negotiation', 'awaiting'];
/**
 * Estágios abertos onde se entra sem dados extra. "meeting" exige data/hora (e dispara a
 * confirmação por WhatsApp): só via POST /api/pipeline/schedule-meeting.
 */
export const DIRECT_STAGES = OPEN_STAGES.filter((stage) => stage !== 'meeting');
/**
 * Onde um negócio pode NASCER (criar / qualificar na Triagem). Os estágios seguintes pedem dados
 * num pop-up ao entrar (dores e proposta, proposta final, fecho), por isso só se chega lá movendo.
 */
export const CREATE_STAGES = ['lead'];
export const DEAL_FIELDS = ['title', 'company', 'contact_name', 'phone', 'email', 'value', 'owner_id', 'client_id', 'expected_close_date'];
/** Respostas dos pop-ups do pipeline (editáveis depois no detalhe). */
export const DEAL_DETAIL_FIELDS = ['pains', 'proposal_offer', 'bait', 'final_proposal', 'won_scope', 'delivery_due'];
/** Mensalidade: mexe nas comissões, por isso fora do pop-up de fecho só o admin altera. */
export const DEAL_BILLING_FIELDS = ['monthly_value', 'monthly_start', 'monthly_end'];

/** Probabilidade de fecho por estágio, para a previsão ponderada do pipeline. */
export const STAGE_PROBABILITY = { lead: 0.1, meeting: 0.25, negotiation: 0.4, awaiting: 0.6, won: 1, lost: 0 };

const board = createOrderedBoard({ table: 'deals', columnField: 'stage', notFound: () => notFound('Negócio') });

const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

// Notas do negócio (activity_logs action = 'note'): contagem e a mais recente, para o cartão do quadro.
const NOTES = "FROM activity_logs n WHERE n.entity_type = 'deal' AND n.entity_id = d.id AND n.action = 'note'";

function withNames(query) {
  return query
    .leftJoin('users as o', 'o.id', 'd.owner_id')
    .leftJoin('clients as c', 'c.id', 'd.client_id')
    .select(
      'd.*',
      'o.name as owner_name',
      'c.name as client_name',
      db.raw(`(SELECT COUNT(*) ${NOTES}) AS notes_count`),
      db.raw(`(SELECT JSON_UNQUOTE(JSON_EXTRACT(n.details, '$.text')) ${NOTES} ORDER BY n.id DESC LIMIT 1) AS last_note`),
      db.raw(`(SELECT n.created_at ${NOTES} ORDER BY n.id DESC LIMIT 1) AS last_note_at`),
      // Sala de videochamada em aberto deste negócio (botão "Entrar na reunião").
      db.raw("(SELECT mt.code FROM meetings mt WHERE mt.deal_id = d.id AND mt.status <> 'ended' ORDER BY mt.id DESC LIMIT 1) AS meeting_code"),
    );
}

export function findDealById(id) {
  return withNames(db('deals as d')).where('d.id', id).first();
}

/**
 * Pipeline agrupado por estágio + totais (quantidade, valor, valor ponderado) de cada estágio.
 *
 * Hard lock de privacidade: o escopo vem de `viewer` (utilizador autenticado), não só do filtro
 * do pedido. Fora do admin é SEMPRE `WHERE owner_id = viewer.id`, qualquer que seja o `ownerId`
 * recebido. Sem `viewer` falha (fail-closed) em vez de devolver o quadro da equipe toda.
 */
export async function getDealBoard({ viewer, ownerId, q } = {}) {
  if (!viewer?.id) throw new Error('getDealBoard: viewer obrigatório (isolamento por utilizador).');
  const scopedOwnerId = viewer.role === 'admin' ? ownerId : viewer.id;

  const query = withNames(db('deals as d')).orderBy('d.stage').orderBy('d.position').orderBy('d.id');
  if (scopedOwnerId) query.where('d.owner_id', scopedOwnerId);
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
 * `fields`: respostas do pop-up do estágio (dores, proposta, sistema/prazo/mensalidade...).
 * `afterMove(trx, row)` (opcional) roda no fim, na mesma transação (ex.: atualizar a triagem).
 * @returns {Promise<{ deal, from, to, clientCreatedId: number|null }>}
 */
export async function moveDeal(id, { stage, position, lostReason, fields = {} }, afterMove) {
  const { from, to, extra } = await board.move(id, { column: stage, position }, async (trx, { row, from: f, to: t }) => {
    const changes = { ...fields };
    let clientCreatedId = null;
    if (f.column !== t.column) changes.stage_changed_at = db.fn.now();

    if (t.column === 'won' && f.column !== 'won') {
      // % de comissão do contrato do vendedor NESTE momento: mudar o contrato depois não mexe
      // nas vendas já fechadas.
      const contract = row.owner_id ? await trx('user_contracts').where({ user_id: row.owner_id }).first('closing_rate') : null;
      Object.assign(changes, { won_at: db.fn.now(), lost_at: null, lost_reason: null, closing_rate: contract ? contract.closing_rate : null });
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
      Object.assign(changes, { won_at: null, lost_at: null, lost_reason: null, closing_rate: null });
    }

    if (Object.keys(changes).length) await trx('deals').where({ id }).update(changes);
    if (afterMove) await afterMove(trx, row);
    return { clientCreatedId };
  });

  return { deal: await findDealById(id), from, to, clientCreatedId: extra.clientCreatedId };
}

/**
 * Agenda (ou reagenda) a reunião: move para "Reunião Agendada" e grava `meeting_at` na mesma
 * transação. Vindo de Fechado/Perdido, o negócio é reaberto (regras do moveDeal).
 * @returns {Promise<{ deal, from, to }>}
 */
export async function scheduleMeeting(id, { meetingAt, position }) {
  const { deal, from, to } = await moveDeal(id, { stage: 'meeting', position }, async (trx) => {
    await trx('deals').where({ id }).update({ meeting_at: meetingAt });
  });
  return { deal, from, to };
}

/**
 * Remove o negócio do pipeline. Se ele nasceu de uma qualificação na Triagem, o lead volta
 * para a fila ("pendente") na mesma transação, para poder ser qualificado de novo, em vez de
 * ficar preso como "qualificado" sem negócio.
 * @returns {Promise<object>} negócio removido, com `requeued_lead_id` (ou null)
 */
export async function deleteDeal(id) {
  let requeuedLeadId = null;
  const removed = await board.remove(id, async (trx, row) => {
    if (!row.lead_id) return;
    // A FK fk_triage_deal (ON DELETE SET NULL) já zerou deal_id; aceita os dois estados.
    const requeued = await trx('lead_triage')
      .where({ lead_id: row.lead_id, status: 'qualified' })
      .where((w) => w.whereNull('deal_id').orWhere('deal_id', id))
      .update({
        status: 'pending',
        deal_id: null,
        hold_until: null,
        triaged_by: null,
        triaged_at: null,
        // Sem responsável na fila, volta para quem trabalhava o negócio. O MySQL avalia o SET
        // da esquerda para a direita, então assigned_at já vê o assigned_to novo.
        assigned_to: db.raw('COALESCE(assigned_to, ?)', [row.owner_id]),
        assigned_at: db.raw('IF(assigned_to IS NULL, NULL, COALESCE(assigned_at, NOW()))'),
      });
    if (!requeued) return;
    requeuedLeadId = row.lead_id;
    await trx('leads').where({ id: row.lead_id, status_prospeccao: 'EM_NEGOCIACAO' }).update({ status_prospeccao: 'NOVO' });
  });
  return { ...removed, requeued_lead_id: requeuedLeadId };
}
