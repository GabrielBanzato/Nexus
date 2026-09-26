export const LEAD_GROUPS = Object.freeze({
  COM_SITE: 'COM_SITE',
  SEM_SITE: 'SEM_SITE',
});

/**
 * Classifica o lead pela presença de website.
 * Retorna um novo objeto com `website` normalizado e `leadGroup` preenchido.
 */
export function classifyLead(lead) {
  const website = typeof lead.website === 'string' ? lead.website.trim() : '';

  return {
    ...lead,
    website: website || null,
    leadGroup: website ? LEAD_GROUPS.COM_SITE : LEAD_GROUPS.SEM_SITE,
  };
}
