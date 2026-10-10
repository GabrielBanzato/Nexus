import { describeContext } from '../ai/prompt.js';
import { db } from '../config/database.js';
import { detectCountry } from '../lib/country.js';

/**
 * Ficha do cliente para o Nex (sugestões no WhatsApp e reuniões): lead de origem (ramo,
 * endereço, site, Google), negociação mais recente (etapa, dores, proposta...), consultor e país.
 * @param {object} client linha de clients (com responsible_name)
 * @param {{ timeZone?: string, dealId?: number }} [opts] dealId: a negociação desta reunião
 * @returns {Promise<{ text: string, lang: 'pt'|'en'|'es', deal: object|null }>}
 */
export async function clientContext(client, { timeZone, dealId } = {}) {
  const dealFields = ['id', 'stage', 'meeting_at', 'pains', 'proposal_offer', 'bait', 'final_proposal', 'lost_reason'];
  const [lead, deal] = await Promise.all([
    client.lead_id ? db('leads').where({ id: client.lead_id }).first('nicho', 'endereco', 'website', 'nota', 'avaliacoes_qtd') : null,
    dealId
      ? db('deals').where({ id: dealId }).first(dealFields)
      : db('deals')
          .where((w) => {
            w.where({ client_id: client.id });
            if (client.lead_id) w.orWhere({ lead_id: client.lead_id });
          })
          .orderBy('updated_at', 'desc')
          .first(dealFields),
  ]);
  const country = detectCountry({ address: lead?.endereco, phone: client.phone });
  return {
    text: describeContext({ client, lead, deal, consultant: client.responsible_name, country, timeZone }),
    lang: country.lang,
    deal: deal ?? null,
  };
}
