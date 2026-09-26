import { getToken, notifySessionExpired } from './session.js';

// Vazio = mesma origem (proxy do Vite em dev / Nginx no Docker encaminham /api ao backend).
const API_URL = import.meta.env.VITE_API_URL ?? '';

const CONNECTION_ERROR = 'Não foi possível conectar ao backend. Verifique se o servidor está no ar.';

/**
 * fetch com JSON, token JWT e tratamento de erro padronizado.
 * Em 401 numa rota protegida, encerra a sessão (o App volta para a tela de login).
 */
async function request(path, { auth = true, headers, ...options } = {}) {
  const token = auth ? getToken() : null;
  if (auth && !token) {
    notifySessionExpired();
    throw Object.assign(new Error('Sessão expirada.'), { status: 401 });
  }

  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error(CONNECTION_ERROR);
  }

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401 && auth) notifySessionExpired();
    const error = new Error(body.message || body.error || `O servidor respondeu com erro ${response.status}.`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** @returns {Promise<{ token: string, expiresIn: string }>} */
export function login(senha) {
  return request('/api/login', { auth: false, method: 'POST', body: JSON.stringify({ senha }) });
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

export function fetchLeads({ nicho, grupo, limit, offset, signal }) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (nicho) params.set('nicho', nicho);
  if (grupo) params.set('grupo', grupo);
  return request(`/api/leads?${params}`, { signal });
}

/** Busca todas as páginas que batem com os filtros (usado na exportação CSV). */
export async function fetchAllLeads({ nicho, grupo }) {
  const pageSize = 500; // máximo aceito pela API
  const all = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchLeads({ nicho, grupo, limit: pageSize, offset });
    all.push(...page.data);
    if (page.data.length < pageSize || all.length >= page.total) return all;
  }
}

/**
 * PATCH /api/leads/:id/status
 * `statusAtual` torna a troca condicional: responde 409 (com o lead atual em error.body.lead)
 * se outra pessoa já tiver alterado o status.
 */
export function updateLeadStatus(id, status, { statusAtual } = {}) {
  return request(`/api/leads/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify(statusAtual ? { status, statusAtual } : { status }),
    // Garante que a requisição conclua mesmo se o navegador trocar de aba para o WhatsApp.
    keepalive: true,
  });
}

// ---------------------------------------------------------------------------
// Scraper
// ---------------------------------------------------------------------------

export function startScrape({ termo, maxResultados }) {
  return request('/api/scrape', { method: 'POST', body: JSON.stringify({ termo, maxResultados }) });
}

export function fetchScrapeJob(jobId) {
  return request(`/api/scrape/${jobId}`);
}
