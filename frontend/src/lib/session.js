/**
 * Sessão do usuário: token JWT guardado no localStorage.
 * A validade (exp) é checada no cliente só para UX; quem garante a segurança é o backend.
 */

const TOKEN_KEY = 'nexus:token';
export const TOKEN_STORAGE_KEY = TOKEN_KEY;
export const SESSION_EXPIRED_EVENT = 'nexus:session-expired';

// Margem para não usar um token que expira durante a requisição.
const EXPIRY_SKEW_MS = 5_000;

function decodePayload(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload));
  } catch {
    return null;
  }
}

/** Dados públicos do token válido ({ sub, role, name }) ou null. Usado pela sala de vídeo (fora do login). */
export function getTokenPayload() {
  const token = getToken();
  return token ? decodePayload(token) : null;
}

/** Timestamp (ms) de expiração do token, ou null se inválido. */
export function getTokenExpiry(token) {
  const exp = decodePayload(token)?.exp;
  return typeof exp === 'number' ? exp * 1000 : null;
}

export function isTokenValid(token) {
  const expiry = token ? getTokenExpiry(token) : null;
  return expiry !== null && expiry - EXPIRY_SKEW_MS > Date.now();
}

export function getToken() {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    return isTokenValid(token) ? token : null;
  } catch {
    return null;
  }
}

export function saveToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage bloqueado: a sessão dura só enquanto a aba estiver aberta.
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

/** Chamado quando o backend responde 401: derruba a sessão e avisa o App. */
export function notifySessionExpired() {
  clearToken();
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}
