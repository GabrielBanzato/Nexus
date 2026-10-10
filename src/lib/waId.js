/**
 * Id "serializado" de uma mensagem do WhatsApp ("true_158965480575081@lid_3EB0A1B2...").
 * Versões recentes do WhatsApp Web deixaram de preencher `id._serialized` (fica undefined): o
 * Nexus gravava as mensagens sem id e o "visto" nunca as encontrava. Monta-se a partir das partes.
 * @returns {string|null}
 */
export function serializeMessageId(id) {
  if (!id) return null;
  if (typeof id === 'string') return id;
  if (id._serialized) return id._serialized;
  if (!id.id) return null;
  const jid = (w) => (!w ? '' : typeof w === 'string' ? w : w._serialized ?? (w.user && w.server ? `${w.user}@${w.server}` : String(w)));
  const participant = jid(id.participant);
  return `${Boolean(id.fromMe)}_${jid(id.remote)}_${id.id}${participant ? `_${participant}` : ''}`;
}
