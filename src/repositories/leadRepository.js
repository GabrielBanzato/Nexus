import { db } from '../config/database.js';

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
  maps_url: 'maps_url',
  search_term: 'termo_busca',
  created_at: 'criado_em',
  updated_at: 'atualizado_em',
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
    telefone: lead.phone,
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
 * Lista leads com filtros opcionais por grupo (COM_SITE/SEM_SITE) e nicho.
 * A collation utf8mb4_0900_ai_ci torna o filtro de nicho insensível a acento e caixa.
 */
export async function findLeads({ grupo, nicho, limit = 50, offset = 0 } = {}) {
  const query = db('leads');

  if (grupo) query.where('grupo', grupo);
  // where(..., 'like') e não whereLike(): no MySQL o whereLike do Knex força COLLATE utf8_bin.
  if (nicho) query.where('nicho', 'like', `%${escapeLike(nicho)}%`);

  const [{ total }] = await query.clone().count({ total: '*' });
  const data = await query
    .clone()
    .select(API_COLUMNS)
    .orderBy([{ column: 'criado_em', order: 'desc' }, { column: 'id', order: 'desc' }])
    .limit(limit)
    .offset(offset);

  return { total: Number(total), limit, offset, data };
}
