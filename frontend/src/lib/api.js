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

/** @returns {Promise<{ token: string, expiresIn: string, user: object }>} */
export async function login(email, password) {
  const { data } = await request('/api/auth/login', {
    auth: false,
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  return data;
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

// ---------------------------------------------------------------------------
// Equipa e operações (respostas no formato { data } / { data, meta })
// ---------------------------------------------------------------------------

/** Query string ignorando valores vazios (undefined, null, '' e false). */
function qs(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

const json = (method, body) => ({ method, body: JSON.stringify(body) });
const unwrap = (response) => response.data;

// Sessão / utilizadores
export const getMe = () => request('/api/auth/me').then(unwrap);
export const getUserDirectory = () => request('/api/users/directory').then(unwrap);
export const listUsers = (params) => request(`/api/users${qs(params)}`);
export const createUser = (body) => request('/api/auth/register', json('POST', body)).then(unwrap);
export const updateUser = (id, body) => request(`/api/users/${id}`, json('PATCH', body)).then(unwrap);

// Clientes
export const listClients = (params) => request(`/api/clients${qs(params)}`);
export const createClient = (body) => request('/api/clients', json('POST', body)).then(unwrap);
export const updateClient = (id, body) => request(`/api/clients/${id}`, json('PATCH', body)).then(unwrap);
export const deleteClient = (id) => request(`/api/clients/${id}`, { method: 'DELETE' });

// Chamados
export const listTickets = (params) => request(`/api/tickets${qs(params)}`);
export const createTicket = (body) => request('/api/tickets', json('POST', body)).then(unwrap);
export const updateTicket = (id, body) => request(`/api/tickets/${id}`, json('PATCH', body)).then(unwrap);
export const deleteTicket = (id) => request(`/api/tickets/${id}`, { method: 'DELETE' });

// Kanban
export const getKanbanBoard = (params) => request(`/api/kanban${qs(params)}`).then(unwrap);
export const createKanbanTask = (body) => request('/api/kanban/tasks', json('POST', body)).then(unwrap);
export const updateKanbanTask = (id, body) => request(`/api/kanban/tasks/${id}`, json('PATCH', body)).then(unwrap);
export const moveKanbanTask = (id, body) => request(`/api/kanban/tasks/${id}/move`, json('PATCH', body)).then(unwrap);
export const deleteKanbanTask = (id) => request(`/api/kanban/tasks/${id}`, { method: 'DELETE' });

// ---------------------------------------------------------------------------
// CRM comercial
// ---------------------------------------------------------------------------

// Triagem
export const listTriage = (params) => request(`/api/triage${qs(params)}`);
export const getTriageSummary = () => request('/api/triage/summary').then(unwrap);
export const distributeLeads = (body) => request('/api/triage/distribute', json('POST', body)).then(unwrap);
export const assignTriageLead = (leadId, assignedTo) =>
  request(`/api/triage/${leadId}/assign`, json('PATCH', { assigned_to: assignedTo })).then(unwrap);
export const decideTriageLead = (leadId, body) => request(`/api/triage/${leadId}/decision`, json('POST', body)).then(unwrap);

// Pipeline
export const getDealBoard = (params) => request(`/api/deals/board${qs(params)}`);
export const createDeal = (body) => request('/api/deals', json('POST', body)).then(unwrap);
export const updateDeal = (id, body) => request(`/api/deals/${id}`, json('PATCH', body)).then(unwrap);
export const moveDeal = (id, body) => request(`/api/deals/${id}/move`, json('PATCH', body));
export const deleteDeal = (id) => request(`/api/deals/${id}`, { method: 'DELETE' });

// Métricas
export const getPerformance = (params) => request(`/api/metrics/performance${qs(params)}`);

// Histórico (entity: 'clients' | 'tickets' | 'deals')
export const getActivity = (entity, id) => request(`/api/${entity}/${id}/activity`).then(unwrap);
export const addNote = (entity, id, text) => request(`/api/${entity}/${id}/notes`, json('POST', { text }));
