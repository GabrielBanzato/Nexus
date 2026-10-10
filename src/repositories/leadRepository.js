import { db } from '../config/database.js';
import { internationalPhone } from '../lib/country.js';

/**
 * Leads e clientes de fora gravados antes do DDI automático ficaram com o telefone local
 * ("(857) 305-3392"), que o envio tratava como brasileiro (55 857... = um número no Ceará).
 * Corre em cada arranque e só mexe no que precisa:
 *  - leads: telefone com DDI pelo país do endereço/formato;
 *  - clientes: o mesmo telefone; se o contacto de WhatsApp já tinha sido ligado ao número
 *    brasileiro errado, desliga-o (volta a ser ligado ao número certo no próximo envio).
 * @returns {Promise<{ leads: number, clients: number, wrongContacts: number }>}
 */
export async function fixForeignPhones() {
  const result = { leads: 0, clients: 0, wrongContacts: 0 };
  const leads = await db('leads').whereNotNull('telefone').whereNot('telefone', 'like', '+%').select('id', 'telefone', 'endereco');
  for (const lead of leads) {
    const fixed = internationalPhone(lead.telefone, lead.endereco);
    if (!fixed || fixed === lead.telefone) continue;
    await db('leads').where({ id: lead.id }).update({ telefone: fixed, atualizado_em: db.raw('atualizado_em') });
    result.leads += 1;
  }

  const clients = await db('clients as c')
    .leftJoin('leads as l', 'l.id', 'c.lead_id')
    .whereNotNull('c.phone')
    .whereNot('c.phone', 'like', '+%')
    .select('c.id', 'c.phone', 'c.whatsapp_jid', 'l.endereco');
  for (const client of clients) {
    const fixed = internationalPhone(client.phone, client.endereco);
    if (!fixed || fixed === client.phone) continue;
    const local = client.phone.replace(/\D/g, '');
    const wrongJid = client.whatsapp_jid === `55${local}@c.us`;
    await db('clients')
      .where({ id: client.id })
      .update({ phone: fixed, ...(wrongJid && { whatsapp_jid: null }), updated_at: db.raw('updated_at') });
    result.clients += 1;
    if (wrongJid) result.wrongContacts += 1;
  }
  return result;
}

const normalizeText = (value) =>
  (value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Telefone é o identificador mais confiável; sem ele, usa nome + endereço.
 */
export function buildDedupeKey({ name, address, phone }) {
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length >= 8) return `tel:${digits}`;
  return `na:${normalizeText(name)}|${normalizeText(address)}`.slice(0, 255);
}

// Colunas do banco (pt-BR) -> campos da API (contrato consumido pelo frontend).
const API_COLUMNS = {
  id: 'id',
  name: 'nome',
  category: 'nicho',
  address: 'endereco',
  phone: 'telefone',
  website: 'website',
  rating: 'nota',
  reviews_count: 'avaliacoes_qtd',
  tem_site: 'tem_site',
  lead_group: 'grupo',
  status_prospeccao: 'status_prospeccao',
  is_hidden: 'is_hidden',
  hidden_at: 'hidden_at',
  wa_status: 'wa_status',
  maps_url: 'maps_url',
  search_term: 'termo_busca',
  created_at: 'criado_em',
  updated_at: 'atualizado_em',
};

const prefixColumns = (alias) => Object.fromEntries(Object.entries(API_COLUMNS).map(([key, column]) => [key, `${alias}.${column}`]));

/**
 * Estado do lead no CRM (lead_triage + negócio): deal_stage é null sem negócio vivo
 * (nunca qualificado, ou negócio apagado do pipeline).
 */
const CRM_COLUMNS = {
  triage_status: 't.status',
  triage_archived_at: 't.archived_at',
  deal_id: 'd.id',
  deal_stage: 'd.stage',
};

/**
 * Insere ou atualiza (upsert) um lead já classificado.
 * Numa nova varredura, atualiza os dados do Maps mas preserva o status_prospeccao
 * definido pela equipe de vendas.
 * @returns {Promise<{ created: boolean }>}
 */
export async function upsertLead(lead) {
  const chaveDedupe = buildDedupeKey(lead);
  const exists = await db('leads').where({ chave_dedupe: chaveDedupe }).first('id');

  const scrapedFields = {
    nome: lead.name,
    nicho: lead.category,
    endereco: lead.address,
    // Empresas de fora ficam com o DDI ("(857) 305-3392" de Boston → "+1 857-305-3392"). A chave de
    // deduplicação continua a usar o telefone como veio do Maps (buildDedupeKey acima).
    telefone: internationalPhone(lead.phone, lead.address),
    website: lead.website,
    nota: lead.rating,
    avaliacoes_qtd: lead.reviewsCount,
    grupo: lead.leadGroup,
    maps_url: lead.mapsUrl,
    termo_busca: lead.searchTerm,
  };

  await db('leads')
    .insert({ ...scrapedFields, chave_dedupe: chaveDedupe })
    .onConflict('chave_dedupe')
    .merge({ ...scrapedFields, atualizado_em: db.fn.now() });

  // Todo lead novo entra na fila de triagem (INSERT IGNORE: não mexe na triagem existente).
  if (!exists) {
    await db.raw('INSERT IGNORE INTO lead_triage (lead_id) SELECT id FROM leads WHERE chave_dedupe = ?', [chaveDedupe]);
  }

  return { created: !exists };
}

export const PROSPECT_STATUSES = ['NOVO', 'CONTATADO', 'EM_NEGOCIACAO', 'FECHADO', 'DESCARTADO'];

export async function findLeadById(id) {
  return db('leads').select(API_COLUMNS).where({ id }).first();
}

/**
 * Atualiza o status de prospecção.
 * Com `expectedStatus`, a troca é condicional (compare-and-set): se outro vendedor já
 * mudou o lead, nada é sobrescrito e o resultado indica conflito com o estado atual.
 * @returns {Promise<{ lead?: object, notFound?: true, conflict?: true }>}
 */
export async function updateLeadStatus(id, status, expectedStatus) {
  const query = db('leads').where({ id });
  if (expectedStatus) query.andWhere('status_prospeccao', expectedStatus);
  const affected = await query.update({ status_prospeccao: status });

  const lead = await findLeadById(id);
  if (!lead) return { notFound: true };
  if (!affected && lead.status_prospeccao !== status) return { conflict: true, lead };
  return { lead };
}

const escapeLike =(value) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * Oculta (arquiva) ou restaura um lead. Soft delete: nada é apagado, o lead some só da
 * vista principal e pode voltar a qualquer momento (histórico, triagem e negócios intactos).
 */
export async function setLeadHidden(id, hidden, userId) {
  const updated = await db('leads')
    .where({ id })
    .update({ is_hidden: hidden, hidden_at: hidden ? db.fn.now() : null, hidden_by: hidden ? userId : null });
  return updated ? findLeadById(id) : null;
}

/** Pesquisas do Radar que geraram leads (para o filtro "Pesquisa"), mais recentes primeiro. */
export async function listSearchTerms() {
  const rows = await db('leads')
    .whereNotNull('termo_busca')
    .groupBy('termo_busca')
    .select('termo_busca as term')
    .count({ total: '*' })
    .select(db.raw('SUM(is_hidden = 0) AS visible'), db.raw('MAX(atualizado_em) AS last_seen'))
    .orderBy('last_seen', 'desc')
    .limit(100);
  return rows.map((r) => ({ term: r.term, total: Number(r.total), visible: Number(r.visible), last_seen: r.last_seen }));
}

/**
 * Lista leads com filtros opcionais.
 *  - visibilidade: 'ativos' (padrão) | 'ocultos'
 *  - contato:      'todos' | 'contatados' (qualquer status além de NOVO) | 'nao_contatados' (NOVO)
 *  - busca:        termo exato da pesquisa do Radar que gerou/atualizou o lead
 *  - grupo / nicho
 * A collation utf8mb4_0900_ai_ci torna o filtro de nicho insensível a acento e caixa.
 */
export async function findLeads({ grupo, nicho, contato, visibilidade = 'ativos', busca, limit = 50, offset = 0 } = {}) {
  const query = db('leads as l');

  query.where('l.is_hidden', visibilidade === 'ocultos');
  if (contato === 'contatados') query.whereNot('l.status_prospeccao', 'NOVO');
  if (contato === 'nao_contatados') query.where('l.status_prospeccao', 'NOVO');
  if (busca) query.where('l.termo_busca', busca);
  if (grupo) query.where('l.grupo', grupo);
  // where(..., 'like') e não whereLike(): no MySQL o whereLike do Knex força COLLATE utf8_bin.
  if (nicho) query.where('l.nicho', 'like', `%${escapeLike(nicho)}%`);

  const [{ total }] = await query.clone().count({ total: '*' });
  const data = await query
    .clone()
    // Estado no CRM, para o card decidir entre "Qualificar", "Requalificar" ou nenhum.
    .leftJoin('lead_triage as t', 't.lead_id', 'l.id')
    .leftJoin('deals as d', 'd.id', 't.deal_id')
    .select({ ...prefixColumns('l'), ...CRM_COLUMNS })
    // Mensagem enviada pela Central (a mesma marca da Triagem: faixa verde, "Mensagem enviada há X").
    .select(
      db.raw(`(SELECT MAX(m.created_at) FROM clients c JOIN messages m ON m.client_id = c.id
                WHERE c.lead_id = l.id AND m.sender_type IN ('agent', 'bot')) AS contacted_at`),
    )
    .orderBy([{ column: 'l.criado_em', order: 'desc' }, { column: 'l.id', order: 'desc' }])
    .limit(limit)
    .offset(offset);

  return { total: Number(total), limit, offset, data };
}
