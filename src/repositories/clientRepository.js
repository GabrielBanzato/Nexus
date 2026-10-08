import { db } from '../config/database.js';
import { internationalPhone } from '../lib/country.js';

export const CLIENT_STATUSES = ['lead', 'active', 'archived'];
export const CLIENT_FIELDS = ['name', 'company', 'phone', 'email', 'status', 'responsible_id', 'lead_id', 'bot_active'];

const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

function baseQuery() {
  return db('clients as c')
    .leftJoin('users as u', 'u.id', 'c.responsible_id')
    .select('c.*', 'u.name as responsible_name');
}

export function findClientById(id) {
  return baseQuery().where('c.id', id).first();
}

export async function listClients({ status, responsibleId, q, limit, offset }) {
  const query = db('clients as c');
  if (status) query.where('c.status', status);
  if (responsibleId) query.where('c.responsible_id', responsibleId);
  if (q) {
    const term = `%${escapeLike(q)}%`;
    query.where((w) =>
      w.where('c.name', 'like', term).orWhere('c.company', 'like', term).orWhere('c.email', 'like', term).orWhere('c.phone', 'like', term),
    );
  }

  const [{ total }] = await query.clone().count({ total: '*' });
  const data = await query
    .clone()
    .leftJoin('users as u', 'u.id', 'c.responsible_id')
    .select('c.*', 'u.name as responsible_name')
    .orderBy('c.updated_at', 'desc')
    .limit(limit)
    .offset(offset);

  return { data, meta: { total: Number(total), limit, offset } };
}

export async function createClient(fields) {
  const [id] = await db('clients').insert(fields);
  return findClientById(id);
}

export async function updateClient(id, fields) {
  await db('clients').where({ id }).update(fields);
  return findClientById(id);
}

export function deleteClient(id) {
  return db('clients').where({ id }).delete();
}

// ---------------------------------------------------------------------------
// WhatsApp: identificar o cliente de uma conversa
// ---------------------------------------------------------------------------

/**
 * Formas possíveis do mesmo número, para comparar com telefones gravados à mão ou vindos do
 * Maps: com e sem DDI 55 e, no Brasil, com e sem o 9 dos celulares (contas antigas do
 * WhatsApp continuam registadas sem ele).
 */
export function phoneMatchKeys(digits) {
  if (!digits || digits.length < 8) return [];
  const national = digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits;
  const variants = new Set([national]);
  if (national.length === 10) variants.add(`${national.slice(0, 2)}9${national.slice(2)}`);
  if (national.length === 11 && national[2] === '9') variants.add(national.slice(0, 2) + national.slice(3));
  return [...variants].flatMap((v) => [v, `55${v}`]);
}

/**
 * Número no formato do WhatsApp (DDI + DDD + número) a partir de um telefone livre.
 * Com "+" já traz o DDI (empresas de fora no Maps: "+1 512-256-2426", "+61 2 9188 8501"): usa-se
 * como está. Sem "+", 10–11 dígitos = número brasileiro sem DDI → prefixa 55. null se não der.
 */
export function toWhatsAppNumber(phone) {
  // Formatos locais de fora ("(857) 305-3392" dos EUA) ganham o DDI aqui, antes da regra do Brasil.
  const text = internationalPhone(phone) ?? '';
  const digits = text.replace(/\D/g, '');
  if (text.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? digits : null;
  if (!digits || digits.startsWith('0')) return null; // 0800/0300 não têm WhatsApp
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits.length >= 12 ? digits : null;
}

// Telefone só com dígitos, no SQL (os telefones são texto livre: "(11) 98765-4321").
const DIGITS = (column) => db.raw(`REGEXP_REPLACE(${column}, '[^0-9]', '')`);

/**
 * Lead da prospecção com este número e o responsável que já o trabalha: o dono do negócio
 * no pipeline ou, se ainda estiver na triagem, quem o tem na fila.
 */
function findLeadByPhone(keys) {
  return db('leads as l')
    .leftJoin('lead_triage as t', 't.lead_id', 'l.id')
    .leftJoin('deals as d', 'd.id', 't.deal_id')
    .whereIn(DIGITS('l.telefone'), keys)
    .select('l.id', 'l.nome', 'l.telefone', db.raw('COALESCE(d.owner_id, t.assigned_to) AS responsible_id'))
    .orderBy('l.atualizado_em', 'desc')
    .first();
}

/**
 * Cliente da conversa `jid`:
 *  1. já ligado ao contacto (whatsapp_jid, indexado);
 *  2. senão, pelo telefone (liga o jid ao cliente para as próximas mensagens);
 *  3. senão, se `autoCreate`, cria um cliente "lead" — aproveitando o lead da prospecção com o
 *     mesmo número (nome, lead_id e responsável), para a conversa ir para quem o trabalha.
 * @returns {Promise<{ client: object|null, created: boolean }>}
 */
export async function findOrCreateWhatsAppClient({ jid, digits, name, autoCreate }) {
  const byJid = await findClientByJid(jid);
  if (byJid) return { client: byJid, created: false };

  const keys = phoneMatchKeys(digits);
  if (keys.length) {
    const byPhone = await db('clients')
      .whereIn(DIGITS('phone'), keys)
      .orderByRaw("FIELD(status, 'active', 'lead', 'archived')")
      .orderBy('updated_at', 'desc')
      .first('id');
    if (byPhone) {
      // whereNull: nunca rouba um contacto já ligado a outro cliente.
      await db('clients').where({ id: byPhone.id }).whereNull('whatsapp_jid').update({ whatsapp_jid: jid });
      return { client: await findClientById(byPhone.id), created: false };
    }
  }

  if (!autoCreate) return { client: null, created: false };

  const lead = keys.length ? await findLeadByPhone(keys) : null;
  try {
    const client = await createClient({
      name: (lead?.nome || name || `+${digits || jid.split('@')[0]}`).slice(0, 160),
      company: lead?.nome?.slice(0, 190) ?? null,
      phone: (lead?.telefone || (digits ? `+${digits}` : null))?.slice(0, 30) ?? null,
      status: 'lead',
      responsible_id: lead?.responsible_id ?? null,
      lead_id: lead?.id ?? null,
      whatsapp_jid: jid,
    });
    return { client, created: true };
  } catch (err) {
    // Duas mensagens do mesmo número novo ao mesmo tempo: a outra já criou o cliente.
    if (err.code === 'ER_DUP_ENTRY') return { client: await findClientByJid(jid), created: false };
    throw err;
  }
}

/**
 * Cliente de um negócio, para lhe escrever no WhatsApp:
 *  1. o já associado (deal.client_id);
 *  2. senão, um cliente com o mesmo telefone (do negócio ou do lead de origem);
 *  3. senão, cria um cliente "lead" com os dados do negócio (responsável = dono do negócio).
 * Em 2 e 3 associa o cliente ao negócio (deal.client_id), para a conversa e o histórico ficarem
 * ligados — e para "Cliente Fechado" reaproveitar este cliente em vez de criar outro.
 * @returns {Promise<object|null>} null se não houver telefone nenhum
 */
export async function ensureClientForDeal(deal) {
  if (deal.client_id) {
    const linked = await findClientById(deal.client_id);
    if (linked) return linked;
  }

  let phone = deal.phone;
  if (!phone && deal.lead_id) phone = (await db('leads').where({ id: deal.lead_id }).first('telefone'))?.telefone ?? null;
  const keys = phoneMatchKeys((phone ?? '').replace(/\D/g, ''));
  if (!keys.length) return null;

  const existing = await db('clients')
    .whereIn(DIGITS('phone'), keys)
    .orderByRaw("FIELD(status, 'active', 'lead', 'archived')")
    .orderBy('updated_at', 'desc')
    .first('id');
  const clientId =
    existing?.id ??
    (
      await createClient({
        name: (deal.contact_name || deal.company || deal.title).slice(0, 160),
        company: deal.company ?? null,
        phone: phone.slice(0, 30),
        email: deal.email ?? null,
        status: 'lead',
        responsible_id: deal.owner_id ?? null,
        lead_id: deal.lead_id ?? null,
      })
    ).id;

  await db('deals').where({ id: deal.id }).update({ client_id: clientId });
  return findClientById(clientId);
}

/**
 * Cliente para abordar um lead da prospecção pela Central ("Chamar no WhatsApp"):
 *  1. um cliente já ligado ao lead ou com o mesmo telefone;
 *  2. senão, cria um cliente "lead" com os dados do lead.
 * Responsável: quem já trabalha o lead (dono do negócio / quem o tem na triagem) ou, se
 * ninguém, `fallbackResponsibleId`. Cliente existente sem responsável recebe esse mesmo.
 * `allow({ workerId, responsibleId })` decide ANTES de gravar se quem pede pode abordar (privacidade).
 * @returns {Promise<{ client: object|null, workerId: number|null, reason?: 'NOT_FOUND'|'NO_PHONE' }>}
 */
export async function ensureClientForLead(leadId, { fallbackResponsibleId, allow = () => true }) {
  const lead = await db('leads as l')
    .leftJoin('lead_triage as t', 't.lead_id', 'l.id')
    .leftJoin('deals as d', 'd.id', 't.deal_id')
    .where('l.id', leadId)
    .first('l.id', 'l.nome', 'l.telefone', db.raw('COALESCE(d.owner_id, t.assigned_to) AS worker_id'));
  if (!lead) return { client: null, workerId: null, reason: 'NOT_FOUND' };

  const workerId = lead.worker_id ?? null;
  const keys = phoneMatchKeys((lead.telefone ?? '').replace(/\D/g, ''));
  if (!keys.length || !toWhatsAppNumber(lead.telefone)) return { client: null, workerId, reason: 'NO_PHONE' };

  const existing = await db('clients')
    .where((w) => w.where('lead_id', lead.id).orWhereIn(DIGITS('phone'), keys))
    .orderByRaw("FIELD(status, 'active', 'lead', 'archived')")
    .orderBy('updated_at', 'desc')
    .first('id', 'responsible_id');
  const responsibleId = workerId ?? fallbackResponsibleId ?? null;
  if (!allow({ workerId, responsibleId: existing?.responsible_id ?? null })) return { client: null, workerId, reason: 'NOT_FOUND' };

  if (existing) {
    if (!existing.responsible_id && responsibleId) {
      await db('clients').where({ id: existing.id }).whereNull('responsible_id').update({ responsible_id: responsibleId });
    }
    return { client: await findClientById(existing.id), workerId };
  }

  const client = await createClient({
    name: lead.nome.slice(0, 160),
    company: lead.nome.slice(0, 190),
    phone: lead.telefone.slice(0, 30),
    status: 'lead',
    responsible_id: responsibleId,
    lead_id: lead.id,
  });
  return { client, workerId };
}

function findClientByJid(jid) {
  return baseQuery().where('c.whatsapp_jid', jid).first();
}
