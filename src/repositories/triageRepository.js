import { db } from '../config/database.js';
import { conflict, notFound } from '../lib/errors.js';
import { OPEN_STAGES, createDeal, moveDeal } from './dealRepository.js';

export const TRIAGE_STATUSES = ['pending', 'qualified', 'on_hold', 'discarded'];
/** Vistas da página de Triagem: os estados + "archived" (arquivados, qualquer estado). */
export const TRIAGE_VIEWS = [...TRIAGE_STATUSES, 'archived'];
const ACTIVE_STATUSES = ['pending', 'on_hold']; // ainda ocupam a fila de alguém

const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

function baseQuery() {
  return db('lead_triage as t')
    .join('leads as l', 'l.id', 't.lead_id')
    .leftJoin('users as a', 'a.id', 't.assigned_to')
    .leftJoin('users as tb', 'tb.id', 't.triaged_by')
    .leftJoin('users as ab', 'ab.id', 't.archived_by')
    .leftJoin('deals as d', 'd.id', 't.deal_id');
}

const COLUMNS = [
  'l.id',
  'l.nome as name',
  'l.nicho as category',
  'l.endereco as address',
  'l.telefone as phone',
  'l.website',
  'l.nota as rating',
  'l.avaliacoes_qtd as reviews_count',
  'l.grupo as lead_group',
  'l.maps_url',
  'l.criado_em as created_at',
  't.status as triage_status',
  't.assigned_to',
  'a.name as assigned_to_name',
  't.assigned_at',
  't.score',
  't.notes',
  't.hold_until',
  't.triaged_by',
  'tb.name as triaged_by_name',
  't.triaged_at',
  't.deal_id',
  'd.stage as deal_stage', // null se o negócio foi apagado (ou nunca existiu)
  't.archived_at',
  'ab.name as archived_by_name',
];

function applyFilters(query, { status, assignedTo, q, nicho, grupo }) {
  // Arquivados só aparecem na vista própria; em todas as outras (e na distribuição) ficam de fora.
  if (status === 'archived') query.whereNotNull('t.archived_at');
  else {
    query.whereNull('t.archived_at');
    if (status) query.where('t.status', status);
  }
  // Leads ocultos (arquivados na Prospecção) saem da fila ativa e da distribuição.
  if (status === 'pending' || status === 'on_hold') query.where('l.is_hidden', false);
  if (assignedTo === 'none') query.whereNull('t.assigned_to');
  else if (assignedTo) query.where('t.assigned_to', assignedTo);
  if (nicho) query.where('l.nicho', 'like', `%${escapeLike(nicho)}%`);
  if (grupo) query.where('l.grupo', grupo);
  if (q) {
    const term = `%${escapeLike(q)}%`;
    query.where((w) => w.where('l.nome', 'like', term).orWhere('l.endereco', 'like', term).orWhere('l.telefone', 'like', term));
  }
  return query;
}

export function findTriageByLeadId(leadId) {
  return baseQuery().select(COLUMNS).where('t.lead_id', leadId).first();
}

export async function listTriage(filters) {
  const { limit, offset, status } = filters;
  const query = applyFilters(baseQuery(), filters);

  const [{ total }] = await query.clone().count({ total: '*' });
  const data = await query
    .clone()
    .select(COLUMNS)
    // Fila: os leads mais NOVOS primeiro (os que acabaram de sair do Radar); já triados/arquivados,
    // os mais recentes primeiro.
    .modify((qb) => {
      if (status === 'pending') qb.orderBy('l.criado_em', 'desc');
      else if (status === 'archived') qb.orderBy('t.archived_at', 'desc');
      else qb.orderBy('t.triaged_at', 'desc');
    })
    .orderBy('l.id', 'desc')
    .limit(limit)
    .offset(offset);

  return { data, meta: { total: Number(total), limit, offset } };
}

/** Contagem por estado (no escopo informado) e carga pendente por responsável. */
export async function getTriageSummary({ assignedTo } = {}) {
  // Na fila ativa (pendente/em espera) não contam leads ocultos na Prospecção.
  const visibleInQueue = (qb) =>
    qb.where((w) => w.whereNotIn('t.status', ACTIVE_STATUSES).orWhere('l.is_hidden', false));

  const byStatus = db('lead_triage as t')
    .join('leads as l', 'l.id', 't.lead_id')
    .modify(visibleInQueue)
    .select(db.raw("IF(t.archived_at IS NULL, t.status, 'archived') AS status"))
    .count({ total: '*' })
    .groupByRaw("IF(t.archived_at IS NULL, t.status, 'archived')");
  if (assignedTo) byStatus.where('t.assigned_to', assignedTo);

  const counts = Object.fromEntries(TRIAGE_VIEWS.map((s) => [s, 0]));
  for (const row of await byStatus) counts[row.status] = Number(row.total);

  const [{ total: unassigned }] = await db('lead_triage as t')
    .join('leads as l', 'l.id', 't.lead_id')
    .where({ 't.status': 'pending', 'l.is_hidden': false })
    .whereNull('t.assigned_to')
    .whereNull('t.archived_at')
    .count({ total: '*' });

  const workload = await db('users as u')
    .leftJoin('lead_triage as t', function joinActive() {
      this.on('t.assigned_to', 'u.id').andOnIn('t.status', ACTIVE_STATUSES).andOnNull('t.archived_at');
    })
    .leftJoin('leads as l', 'l.id', 't.lead_id')
    .where('u.is_active', true)
    .groupBy('u.id', 'u.name', 'u.role')
    .select('u.id', 'u.name', 'u.role', db.raw('SUM(l.is_hidden = 0) AS open'))
    .orderBy('u.name');

  return {
    counts,
    unassigned: Number(unassigned),
    workload: workload.map((w) => ({ ...w, open: Number(w.open) })),
  };
}

/**
 * Distribui leads pendentes sem responsável entre os membros escolhidos.
 *  - balanced:    cada lead vai para quem tem menos leads ativos na fila (equilibra a carga).
 *  - round_robin: alterna na ordem dos membros, ignorando a carga atual.
 * @returns {Promise<{ assigned: number, perUser: Record<number, number> }>}
 */
export function distributeLeads({ userIds, limit, nicho, grupo, strategy }) {
  return db.transaction(async (trx) => {
    const candidates = applyFilters(
      trx('lead_triage as t').join('leads as l', 'l.id', 't.lead_id'),
      { status: 'pending', assignedTo: 'none', nicho, grupo },
    )
      .select('t.lead_id')
      .orderBy('l.criado_em', 'asc')
      .limit(limit)
      .forUpdate(); // evita que duas distribuições simultâneas peguem os mesmos leads

    const leadIds = (await candidates).map((row) => row.lead_id);
    if (!leadIds.length) return { assigned: 0, perUser: {} };

    const loadRows = await trx('lead_triage as t')
      .join('leads as l', 'l.id', 't.lead_id')
      .select('t.assigned_to')
      .count({ total: '*' })
      .whereIn('t.assigned_to', userIds)
      .whereIn('t.status', ACTIVE_STATUSES)
      .whereNull('t.archived_at')
      .where('l.is_hidden', false)
      .groupBy('t.assigned_to');
    const load = new Map(userIds.map((id) => [id, 0]));
    for (const row of loadRows) load.set(row.assigned_to, Number(row.total));

    const buckets = new Map(userIds.map((id) => [id, []]));
    leadIds.forEach((leadId, index) => {
      let userId;
      if (strategy === 'round_robin') {
        userId = userIds[index % userIds.length];
      } else {
        userId = userIds.reduce((best, id) => (load.get(id) < load.get(best) ? id : best), userIds[0]);
      }
      buckets.get(userId).push(leadId);
      load.set(userId, load.get(userId) + 1);
    });

    const perUser = {};
    for (const [userId, ids] of buckets) {
      if (!ids.length) continue;
      await trx('lead_triage').whereIn('lead_id', ids).update({ assigned_to: userId, assigned_at: db.fn.now() });
      perUser[userId] = ids.length;
    }
    return { assigned: leadIds.length, perUser };
  });
}

export async function assignLead(leadId, userId) {
  const updated = await db('lead_triage')
    .where({ lead_id: leadId })
    .update({ assigned_to: userId, assigned_at: userId ? db.fn.now() : null });
  if (!updated) throw notFound('Lead');
  return findTriageByLeadId(leadId);
}

/**
 * Atribuição em massa: só mexe em leads ainda na fila (pendente/em espera); os já
 * qualificados/descartados são ignorados. @returns {Promise<{ assigned: number }>}
 */
export async function assignLeads(leadIds, userId) {
  const assigned = await db('lead_triage')
    .whereIn('lead_id', leadIds)
    .whereIn('status', ACTIVE_STATUSES)
    .whereNull('archived_at')
    .update({ assigned_to: userId, assigned_at: userId ? db.fn.now() : null });
  return { assigned };
}

/**
 * Regista a decisão de triagem. "qualified" cria o negócio no pipeline na mesma transação
 * (se a triagem falhar, o negócio não fica órfão). Qualificado é definitivo: daí em diante
 * o lead é trabalhado no pipeline.
 */
export async function decideLead(leadId, { status, notes, score, holdUntil, deal }, user) {
  const triageFields = {
    status,
    notes: notes ?? null,
    score: score ?? null,
    hold_until: status === 'on_hold' ? holdUntil ?? null : null,
    triaged_by: user.id,
    triaged_at: db.fn.now(),
  };

  const lockAndCheck = async (trx) => {
    const row = await trx('lead_triage').where({ lead_id: leadId }).forUpdate().first();
    if (!row) throw notFound('Lead');
    if (row.archived_at) throw conflict('Este lead está arquivado; restaure-o ou requalifique-o.');
    if (row.status === 'qualified') throw conflict('Este lead já foi qualificado; continue o trabalho no pipeline.');
    return row;
  };

  if (status === 'qualified') {
    const lead = await db('leads').where({ id: leadId }).first();
    if (!lead) throw notFound('Lead');
    const triage = await db('lead_triage').where({ lead_id: leadId }).first();

    const created = await createDeal(
      {
        title: deal?.title ?? lead.nome,
        company: lead.nome,
        phone: lead.telefone,
        value: deal?.value ?? 0,
        owner_id: deal?.owner_id ?? triage?.assigned_to ?? user.id,
        expected_close_date: deal?.expected_close_date ?? null,
        stage: deal?.stage ?? 'lead',
        lead_id: leadId,
        created_by: user.id,
      },
      async (trx, dealId) => {
        await lockAndCheck(trx);
        await trx('lead_triage').where({ lead_id: leadId }).update({ ...triageFields, deal_id: dealId });
        await trx('leads').where({ id: leadId }).update({ status_prospeccao: 'EM_NEGOCIACAO' });
      },
    );
    return { triage: await findTriageByLeadId(leadId), deal: created };
  }

  await db.transaction(async (trx) => {
    await lockAndCheck(trx);
    await trx('lead_triage').where({ lead_id: leadId }).update(triageFields);
    if (status === 'discarded') await trx('leads').where({ id: leadId }).update({ status_prospeccao: 'DESCARTADO' });
  });
  return { triage: await findTriageByLeadId(leadId), deal: null };
}

/**
 * Requalificar: põe o lead de volta na 1.ª coluna do pipeline ("Triagem/Novo"), no topo.
 *  - Sem negócio (apagado ou nunca criado): cria um novo a partir dos dados do lead.
 *  - Negócio "Perdido": reabre o mesmo negócio (mantém histórico, notas e valor).
 *  - Negócio aberto ou ganho: 409 — já está no pipeline / já é cliente.
 * Em todos os casos a triagem fica "qualificada" e sai do arquivo, na mesma transação.
 * @returns {Promise<{ triage, deal, reopened: boolean }>}
 */
export async function requalifyLead(leadId, user) {
  const current = await db('lead_triage as t')
    .leftJoin('deals as d', 'd.id', 't.deal_id')
    .select('t.*', 'd.id as live_deal_id', 'd.stage as deal_stage')
    .where('t.lead_id', leadId)
    .first();
  if (!current) throw notFound('Lead');
  if (current.deal_stage === 'won') throw conflict('Este lead já virou cliente (negócio ganho); não há o que requalificar.');
  if (OPEN_STAGES.includes(current.deal_stage)) throw conflict('Este lead já está no pipeline, num estágio em aberto.');

  const triageFields = {
    status: 'qualified',
    hold_until: null,
    archived_at: null,
    archived_by: null,
    triaged_by: user.id,
    triaged_at: db.fn.now(),
  };

  // Revalida com lock: se outro pedido mexeu no vínculo entretanto, desfaz tudo (sem negócio duplicado).
  const lockAndCheck = async (trx) => {
    const row = await trx('lead_triage').where({ lead_id: leadId }).forUpdate().first();
    if (!row) throw notFound('Lead');
    if ((row.deal_id ?? null) !== (current.deal_id ?? null)) {
      throw conflict('Este lead acabou de ser alterado por outra pessoa; atualize a página.');
    }
  };
  const markQualified = async (trx, dealId) => {
    await trx('lead_triage').where({ lead_id: leadId }).update({ ...triageFields, deal_id: dealId });
    await trx('leads').where({ id: leadId }).update({ status_prospeccao: 'EM_NEGOCIACAO' });
  };

  if (current.live_deal_id) {
    const { deal } = await moveDeal(current.live_deal_id, { stage: 'lead', position: 0 }, async (trx, row) => {
      if (row.stage !== 'lost') throw conflict('O negócio deste lead já foi reaberto por outra pessoa.');
      await lockAndCheck(trx);
      await markQualified(trx, row.id);
    });
    return { triage: await findTriageByLeadId(leadId), deal, reopened: true };
  }

  const lead = await db('leads').where({ id: leadId }).first();
  if (!lead) throw notFound('Lead');
  const deal = await createDeal(
    {
      title: lead.nome,
      company: lead.nome,
      phone: lead.telefone,
      value: 0,
      owner_id: current.assigned_to ?? user.id,
      stage: 'lead',
      position: 0, // topo da coluna, para ser visto logo
      lead_id: leadId,
      created_by: user.id,
    },
    async (trx, dealId) => {
      await lockAndCheck(trx);
      await markQualified(trx, dealId);
    },
  );
  return { triage: await findTriageByLeadId(leadId), deal, reopened: false };
}

/**
 * Arquivar: tira o lead de todas as vistas da Triagem (e da distribuição) sem apagar nada —
 * estado, notas, negócio e histórico ficam intactos. Reversível com restoreLead.
 */
export async function archiveLead(leadId, userId) {
  const updated = await db('lead_triage')
    .where({ lead_id: leadId })
    .whereNull('archived_at')
    .update({ archived_at: db.fn.now(), archived_by: userId });
  if (!updated) {
    const exists = await db('lead_triage').where({ lead_id: leadId }).first('lead_id');
    throw exists ? conflict('Este lead já está arquivado.') : notFound('Lead');
  }
  return findTriageByLeadId(leadId);
}

/** Desarquivar: o lead volta à vista do seu estado (fila, espera, qualificados...). */
export async function restoreLead(leadId) {
  const updated = await db('lead_triage')
    .where({ lead_id: leadId })
    .whereNotNull('archived_at')
    .update({ archived_at: null, archived_by: null });
  if (!updated) {
    const exists = await db('lead_triage').where({ lead_id: leadId }).first('lead_id');
    throw exists ? conflict('Este lead não está arquivado.') : notFound('Lead');
  }
  return findTriageByLeadId(leadId);
}
