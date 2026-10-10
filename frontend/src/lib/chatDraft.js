/**
 * Ponte "Chamar no WhatsApp" → Central de Atendimento: quem chama guarda a conversa e o texto
 * da abordagem e navega para #/atendimento; a Central abre essa conversa com o texto no campo
 * (a pessoa revê e envia; nada sai sozinho). Em memória: só vale para a navegação seguinte.
 */
let pending = null;

export function openChatWithDraft(conversation, draft) {
  pending = { conversation, draft };
  window.location.hash = '/atendimento';
}

/** Pedido pendente (null se não houver). Lido no 1.º render da Central; consumido num efeito. */
export const peekPendingChat = () => pending;

export function clearPendingChat() {
  pending = null;
}
