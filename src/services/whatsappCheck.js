import { db } from '../config/database.js';
import { toWhatsAppNumber } from '../repositories/clientRepository.js';

const SPACING_MS = 1_200; // um número de cada vez, com folga: muitas consultas seguidas marcam o número da empresa
const RECHECK_AFTER_DAYS = 30;
const MAX_PER_REQUEST = 10; // a Triagem pede aos poucos (~12 s por lote) e vai mostrando

/**
 * "Este número tem WhatsApp?" para os leads, ANTES de alguém escrever a mensagem (na Triagem o
 * ícone já mostra; na Central o envio avisa). O resultado fica no lead (wa_status) e só volta a
 * ser checado depois de RECHECK_AFTER_DAYS. As consultas vão numa fila lenta, uma de cada vez.
 */
export function createWhatsAppCheck({ whatsapp, logger }) {
  let queue = Promise.resolve();
  const inflight = new Map(); // leadId → Promise

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function checkLead(lead) {
    if (inflight.has(lead.id)) return inflight.get(lead.id);
    const run = queue.then(async () => {
      const number = toWhatsAppNumber(lead.phone);
      // Sem número válido para WhatsApp (fixo 0800, vazio...): não precisa de perguntar.
      const exists = number ? await whatsapp.hasWhatsApp(number) : false;
      if (exists !== null) {
        await db('leads').where({ id: lead.id }).update({ wa_status: exists ? 'yes' : 'no', wa_checked_at: db.fn.now() });
      }
      if (number) await sleep(SPACING_MS);
      return { id: lead.id, wa_status: exists === null ? null : exists ? 'yes' : 'no' };
    });
    queue = run.catch(() => {});
    inflight.set(lead.id, run);
    run.finally(() => inflight.delete(lead.id)).catch(() => {});
    return run;
  }

  return {
    /** Checa (se ainda não se sabe, ou se é antigo) os leads pedidos. */
    async checkLeads(ids) {
      if (!whatsapp || whatsapp.getState().status !== 'ready') return { skipped: true, results: [] };
      const leads = await db('leads')
        .whereIn('id', ids.slice(0, MAX_PER_REQUEST))
        .where((w) => w.whereNull('wa_checked_at').orWhere('wa_checked_at', '<', db.raw('NOW() - INTERVAL ? DAY', [RECHECK_AFTER_DAYS])))
        .select('id', 'telefone as phone');
      const results = [];
      for (const lead of leads) results.push(await checkLead(lead));
      logger.info({ checked: results.length, without: results.filter((r) => r.wa_status === 'no').length }, 'WhatsApp: números checados');
      return { skipped: false, results };
    },

    /** O cliente tem WhatsApp? (conversa ainda sem contacto ligado). null = não deu para saber. */
    async checkClient(client) {
      if (client.whatsapp_jid) return true;
      if (!whatsapp || whatsapp.getState().status !== 'ready') return null;
      const number = toWhatsAppNumber(client.phone);
      if (!number) return false;
      const exists = await whatsapp.hasWhatsApp(number);
      if (exists !== null && client.lead_id) await markLead(client.lead_id, exists);
      return exists;
    },

    markLead,
  };
}

/** Grava no lead o que se descobriu (ex.: um envio que falhou com "não tem WhatsApp"). */
export async function markLead(leadId, exists) {
  if (!leadId) return;
  await db('leads').where({ id: leadId }).update({ wa_status: exists ? 'yes' : 'no', wa_checked_at: db.fn.now() });
}
