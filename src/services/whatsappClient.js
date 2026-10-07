import { lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import QRCode from 'qrcode';
import wwebjs from 'whatsapp-web.js';

const { Client, LocalAuth } = wwebjs; // pacote CommonJS: importa-se o default

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/**
 * Estados da sessão:
 *  idle → initializing → qr (à espera da leitura) → authenticated → ready
 *  disconnected / auth_failure / error → nova tentativa automática, com espera crescente.
 */
export const WHATSAPP_STATUSES = ['idle', 'initializing', 'qr', 'authenticated', 'ready', 'disconnected', 'auth_failure', 'error'];

/**
 * Windows limita caminhos a 260 caracteres (MAX_PATH) e o Chrome grava o cache do WhatsApp Web
 * até ~150 caracteres abaixo da pasta da sessão (session\Default\Service Worker\CacheStorage\...).
 * Acima do limite o armazenamento falha, o WhatsApp Web faz logout/recarga em ciclo e o
 * whatsapp-web.js só diz "Execution context was destroyed". Medido: base de 157 caracteres
 * falha sempre; bases curtas funcionam sempre. Linux/Docker não têm este limite.
 */
const WINDOWS_MAX_SESSION_DIR = 100;

const CHROME_LOCKS = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

/**
 * Apaga as travas do Chrome deixadas na sessão. O Chrome grava nelas o nome da máquina que abriu
 * o perfil; no Docker, cada novo container (redeploy, reinício do VPS) tem outro hostname, e o
 * Chrome recusa abrir "um perfil em uso noutro computador" (Code: 21) — mesmo sem ninguém a
 * usá-lo. Só este processo usa a sessão e o navegador anterior já foi fechado (destroyClient),
 * por isso as travas que restam são sempre restos de um arranque anterior.
 * @returns {number} quantas travas foram removidas
 */
export function clearStaleChromeLocks(dataPath) {
  let removed = 0;
  let entries = [];
  try {
    entries = readdirSync(dataPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  // LocalAuth: um perfil por clientId em <dataPath>/session[-<clientId>].
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('session')) continue;
    for (const lock of CHROME_LOCKS) {
      const path = join(dataPath, entry.name, lock);
      try {
        lstatSync(path); // lstat: SingletonLock é um link simbólico para "host-pid", que não existe
      } catch {
        continue; // não há trava
      }
      rmSync(path, { force: true });
      removed += 1;
    }
  }
  return removed;
}

/** Pasta da sessão, absoluta e criada. Lança erro com a solução se o caminho não vai funcionar. */
function resolveSessionDir(dir) {
  const absolute = resolve(dir);
  if (process.platform === 'win32' && absolute.length > WINDOWS_MAX_SESSION_DIR) {
    throw Object.assign(
      new Error(
        `caminho da sessão longo demais para o Windows (${absolute.length} caracteres; máximo ${WINDOWS_MAX_SESSION_DIR}). ` +
          'Defina WHATSAPP_SESSION_DIR com uma pasta curta, ex.: C:\\nexus-whatsapp',
      ),
      { permanent: true },
    );
  }
  mkdirSync(absolute, { recursive: true });
  return absolute;
}

/**
 * Motor do WhatsApp Web (whatsapp-web.js + Puppeteer). Só trata da sessão; o que fazer com as
 * mensagens fica com `onMessage` (ver whatsappInbox.js).
 *
 * A sessão autenticada fica em `sessionDir` (LocalAuth): reinícios do servidor não pedem QR
 * de novo. Só pode haver UMA instância a usar a mesma sessão.
 *
 * @param {object} options
 * @param {string} options.sessionDir
 * @param {boolean} [options.headless=true]
 * @param {(msg: import('whatsapp-web.js').Message) => Promise<void>} options.onMessage
 * @param {(msg: import('whatsapp-web.js').Message) => Promise<void>} [options.onOwnMessage]
 *        Mensagem enviada pelo número da empresa FORA do Nexus (ex.: vendedor no telemóvel).
 * @param {(state: object) => void} [options.onState] Chamado a cada mudança de estado.
 * @param {{ info: Function, warn: Function, error: Function }} options.logger
 */
export function createWhatsAppClient({
  sessionDir,
  headless = true,
  onMessage,
  onOwnMessage,
  onState,
  onSessionReset,
  logger,
  readyStallMs = 3 * 60_000,
  maxStuckRestarts = 2,
}) {
  let client = null;
  let stopped = true;
  let retryTimer = null;
  let attempts = 0;
  // Vigia do "QR lido, a sincronizar..." eterno: autenticou mas o 'ready' nunca chega.
  let readyWatch = null;
  let stuckRestarts = 0;

  // Envios do próprio Nexus, para o 'message_create' não os confundir com o vendedor no telemóvel.
  // O evento pode chegar ANTES de sendMessage resolver (texto em curso) ou DEPOIS (id já conhecido).
  // O texto fica reconhecido ainda um minuto depois do envio: às vezes o WhatsApp Web não devolve
  // o id da mensagem enviada (ver sendText) e o evento chega depois.
  const sendingBodies = new Map(); // texto → nº de envios em curso
  const recentBodies = new Map(); // texto → expira em (ms)
  const sentIds = new Map(); // id → expira em (ms)
  const SENT_ID_TTL_MS = 5 * 60_000;
  const RECENT_BODY_TTL_MS = 60_000;
  const isOwnSend = (msg) => {
    const now = Date.now();
    for (const [id, expires] of sentIds) if (expires < now) sentIds.delete(id);
    for (const [body, expires] of recentBodies) if (expires < now) recentBodies.delete(body);
    return sentIds.has(msg.id?._serialized) || sendingBodies.has(msg.body) || recentBodies.has(msg.body);
  };

  /**
   * Id da mensagem que acabámos de enviar, procurado na conversa: em conversas com contactos
   * "@lid" o sendMessage do whatsapp-web.js (1.34.7) envia mas devolve undefined (procura a
   * mensagem por uma chave com o id antigo do contacto). Melhor esforço: null se não achar.
   */
  async function findSentMessageId(chatId, text) {
    try {
      const chat = await client.getChatById(chatId);
      const recent = await chat.fetchMessages({ limit: 10, fromMe: true });
      return recent.reverse().find((m) => m.body === text)?.id?._serialized ?? null;
    } catch (err) {
      logger.warn({ err: err.message, chatId }, 'WhatsApp: não foi possível obter o id da mensagem enviada');
      return null;
    }
  }

  const state = { status: 'idle', qr: null, qr_updated_at: null, phone: null, error: null, since: new Date() };

  const setState = (patch) => {
    Object.assign(state, patch, { since: new Date() });
    onState?.(getState());
  };

  /** Cópia do estado. `qr` é um data URL (PNG) pronto para <img src>, ou null. */
  const getState = () => ({ ...state });

  async function destroyClient() {
    clearTimeout(readyWatch);
    readyWatch = null;
    const current = client;
    client = null;
    try {
      await current?.destroy();
    } catch (err) {
      logger.warn({ err }, 'WhatsApp: falha ao fechar o navegador da sessão anterior');
    }
  }

  function scheduleRetry() {
    if (stopped || retryTimer) return;
    const delay = Math.min(RETRY_BASE_MS * 2 ** attempts, RETRY_MAX_MS);
    attempts += 1;
    logger.warn({ delay, attempts }, 'WhatsApp: nova tentativa de ligação agendada');
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      await destroyClient();
      if (!stopped) boot();
    }, delay);
  }

  /** Apaga a sessão guardada (o próximo arranque pede QR Code). */
  function wipeSession() {
    try {
      const dataPath = resolveSessionDir(sessionDir);
      for (const entry of readdirSync(dataPath, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('session')) rmSync(join(dataPath, entry.name), { recursive: true, force: true });
      }
    } catch (err) {
      logger.error({ err }, 'WhatsApp: não foi possível apagar a sessão');
    }
  }

  /**
   * Autenticou mas não ficou pronto: o WhatsApp Web às vezes fica preso no ecrã de
   * sincronização depois de um reinício (whatsapp-web.js nunca emite 'ready'). Reinicia o
   * navegador com a mesma sessão; se voltar a prender maxStuckRestarts vezes seguidas, a sessão
   * está estragada: apaga-a e pede o QR Code de novo (avisa via onSessionReset).
   */
  async function onReadyStalled() {
    if (stopped || state.status === 'ready') return;
    stuckRestarts += 1;
    clearTimeout(retryTimer);
    retryTimer = null;
    await destroyClient();
    if (stuckRestarts > maxStuckRestarts) {
      logger.warn({ stuckRestarts }, 'WhatsApp: continua preso a sincronizar; a apagar a sessão para ler o QR de novo');
      stuckRestarts = 0;
      wipeSession();
      onSessionReset?.('stuck_syncing');
    } else {
      logger.warn({ stuckRestarts }, 'WhatsApp: preso a sincronizar; a reiniciar a ligação');
    }
    if (!stopped) boot();
  }

  /** (Re)arma o vigia: sem progresso em readyStallMs depois de autenticar → onReadyStalled. */
  function armReadyWatch(current) {
    clearTimeout(readyWatch);
    readyWatch = setTimeout(() => {
      if (client === current) onReadyStalled();
    }, readyStallMs);
    readyWatch.unref?.();
  }

  function boot() {
    setState({ status: 'initializing', qr: null, error: null });

    let dataPath;
    try {
      dataPath = resolveSessionDir(sessionDir);
    } catch (err) {
      // Falha só o WhatsApp; a API continua no ar. Erro de configuração não se resolve
      // sozinho: sem novas tentativas (só geravam ruído no log).
      logger.error({ err, sessionDir }, 'WhatsApp: pasta da sessão inválida');
      setState({ status: 'error', error: `Pasta da sessão: ${err.message}` });
      if (!err.permanent) scheduleRetry();
      return;
    }

    // Sessão vinda de outro container (redeploy): sem isto o Chrome recusa abrir o perfil.
    const cleared = clearStaleChromeLocks(dataPath);
    if (cleared) logger.info({ cleared }, 'WhatsApp: travas antigas do Chrome removidas da sessão');

    const current = new Client({
      authStrategy: new LocalAuth({ dataPath }),
      puppeteer: {
        headless,
        // Mesmos argumentos do scraper: container sem root e /dev/shm pequeno.
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
    });
    client = current;

    // Eventos de um cliente antigo (já substituído numa nova tentativa) são ignorados.
    const live = (handler) => (...args) => (client === current ? handler(...args) : undefined);

    current.on('qr', live(async (qr) => {
      // O WhatsApp renova o QR a cada ~20s; o painel pede sempre o mais recente.
      setState({ status: 'qr', qr: await QRCode.toDataURL(qr, { margin: 1, width: 320 }), qr_updated_at: new Date() });
    }));
    current.on('authenticated', live(() => {
      setState({ status: 'authenticated', qr: null, qr_updated_at: null });
      armReadyWatch(current);
    }));
    // Progresso da sincronização (telemóvel com muitas conversas demora): enquanto avança, espera.
    current.on('loading_screen', live((percent) => {
      if (state.status === 'authenticated') armReadyWatch(current);
      logger.info({ percent }, 'WhatsApp: a sincronizar');
    }));
    current.on('ready', live(() => {
      clearTimeout(readyWatch);
      readyWatch = null;
      stuckRestarts = 0;
      attempts = 0;
      setState({ status: 'ready', qr: null, qr_updated_at: null, phone: current.info?.wid?.user ?? null, error: null });
      logger.info({ phone: state.phone }, 'WhatsApp: sessão pronta');
    }));
    current.on('auth_failure', live((message) => {
      setState({ status: 'auth_failure', qr: null, error: String(message) });
      scheduleRetry();
    }));
    // Inclui "LOGOUT" (sessão encerrada no telemóvel): o LocalAuth apaga a sessão e o próximo
    // arranque volta a pedir QR Code.
    current.on('disconnected', live((reason) => {
      setState({ status: 'disconnected', qr: null, phone: null, error: String(reason) });
      scheduleRetry();
    }));
    current.on('message', live((msg) => {
      Promise.resolve(onMessage(msg)).catch((err) =>
        logger.error({ err, messageId: msg.id?._serialized }, 'WhatsApp: falha ao processar mensagem recebida'),
      );
    }));
    // 'message_create' dispara também para o que o número da empresa envia. Interessa só o que
    // NÃO saiu do Nexus: é um humano a responder pelo telemóvel → a IA tem de se calar.
    current.on('message_create', live((msg) => {
      if (!msg.fromMe || !onOwnMessage || isOwnSend(msg)) return;
      Promise.resolve(onOwnMessage(msg)).catch((err) =>
        logger.error({ err, messageId: msg.id?._serialized }, 'WhatsApp: falha ao processar mensagem enviada pelo telemóvel'),
      );
    }));

    current.initialize().catch(
      live((err) => {
        logger.error({ err }, 'WhatsApp: falha ao iniciar a sessão');
        setState({ status: 'error', qr: null, error: err.message });
        scheduleRetry();
      }),
    );
  }

  return {
    getState,

    /** Arranca em segundo plano (não bloqueia o boot da API: o Chrome leva alguns segundos). */
    start() {
      if (!stopped) return;
      stopped = false;
      attempts = 0;
      boot();
    },

    async stop() {
      stopped = true;
      clearTimeout(retryTimer);
      retryTimer = null;
      await destroyClient();
      setState({ status: 'idle', qr: null, qr_updated_at: null, phone: null, error: null });
    },

    /**
     * Reinício de manutenção (ex.: todo dia às 7h): fecha o Chrome e abre de novo com a mesma
     * sessão (sem QR). Se em `readyTimeoutMs` não voltar a ficar conectado, a sessão está
     * estragada: apaga-a e arranca de novo, já a mostrar um QR Code para ligar o número outra vez.
     * Sem número ligado (a pedir QR) não faz nada: não há sessão a renovar.
     * @returns {Promise<'ready'|'qr'|'reset'|'skipped'>}
     */
    async restart({ readyTimeoutMs = 3 * 60_000, pollMs = 2_000 } = {}) {
      if (stopped || state.status === 'qr') return 'skipped';
      logger.info({ status: state.status }, 'WhatsApp: reinício diário da ligação');
      clearTimeout(retryTimer);
      retryTimer = null;
      attempts = 0;
      await destroyClient();
      boot();

      const deadline = Date.now() + readyTimeoutMs;
      while (Date.now() < deadline && !stopped) {
        if (state.status === 'ready') return 'ready';
        // A sessão caiu sozinha (ex.: desligada no telemóvel) e já pede QR: nada a apagar.
        if (state.status === 'qr') return 'qr';
        await new Promise((r) => setTimeout(r, pollMs));
      }
      if (stopped) return 'skipped';
      if (state.status === 'ready') return 'ready';

      logger.warn({ status: state.status, error: state.error }, 'WhatsApp: não voltou depois do reinício; a apagar a sessão para ler o QR de novo');
      clearTimeout(retryTimer);
      retryTimer = null;
      attempts = 0;
      await destroyClient();
      wipeSession();
      setState({ status: 'disconnected', qr: null, phone: null, error: 'A ligação não voltou no reinício diário: leia o QR Code de novo.' });
      boot();
      return 'reset';
    },

    /**
     * Envia um texto. Destino: `jid` da conversa, ou `number` (DDI + DDD + número, só dígitos)
     * quando o cliente nunca falou connosco — aí o WhatsApp resolve o id real da conta.
     * Se o sendMessage não lançar, a mensagem SAIU: mesmo sem id devolvido, não é erro (senão a
     * Central diria "não enviada" e o "Tentar de novo" mandava-a duas vezes).
     * @returns {Promise<{ chatId: string, waMessageId: string|null }>}
     * @throws erro com `code` WHATSAPP_NOT_READY | NOT_ON_WHATSAPP
     */
    async sendText({ jid, number }, text) {
      if (!client || state.status !== 'ready') {
        throw Object.assign(new Error('O WhatsApp não está ligado.'), { code: 'WHATSAPP_NOT_READY' });
      }
      let chatId = jid;
      if (!chatId) {
        const numberId = number ? await client.getNumberId(number) : null;
        if (!numberId) throw Object.assign(new Error('Este número não tem WhatsApp.'), { code: 'NOT_ON_WHATSAPP' });
        chatId = numberId._serialized;
      }
      sendingBodies.set(text, (sendingBodies.get(text) ?? 0) + 1);
      try {
        const sent = await client.sendMessage(chatId, text);
        let waMessageId = sent?.id?._serialized ?? null;
        if (!waMessageId) {
          waMessageId = await findSentMessageId(chatId, text);
          logger.warn({ chatId, found: Boolean(waMessageId) }, 'WhatsApp: mensagem enviada sem id devolvido (contacto @lid)');
        }
        if (waMessageId) sentIds.set(waMessageId, Date.now() + SENT_ID_TTL_MS);
        return { chatId, waMessageId };
      } finally {
        recentBodies.set(text, Date.now() + RECENT_BODY_TTL_MS);
        const n = sendingBodies.get(text) - 1;
        if (n > 0) sendingBodies.set(text, n);
        else sendingBodies.delete(text);
      }
    },

    /** "a digitar..." na conversa do cliente (melhor esforço: falhar aqui não importa). */
    async sendTyping(jid) {
      if (!client || state.status !== 'ready' || !jid) return;
      try {
        const chat = await client.getChatById(jid);
        await chat.sendStateTyping();
      } catch (err) {
        logger.warn({ err: err.message, jid }, 'WhatsApp: não foi possível mostrar "a digitar"');
      }
    },

    /** Desliga o número ligado (apaga a sessão) e arranca de novo, já a mostrar um QR novo. */
    async logout() {
      if (!client || state.status !== 'ready') return false;
      const current = client;
      client = null; // a partir daqui os eventos deste cliente são ignorados (ver live())
      try {
        await current.logout(); // fecha o navegador e apaga a sessão do LocalAuth
      } finally {
        await current.destroy().catch(() => {}); // pode já estar fechado
      }
      clearTimeout(retryTimer);
      retryTimer = null;
      attempts = 0;
      setState({ status: 'disconnected', qr: null, phone: null, error: 'LOGOUT' });
      if (!stopped) boot();
      return true;
    },
  };
}
