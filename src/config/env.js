// Carrega o .env (se existir) antes de qualquer outro módulo ler process.env.
try {
  process.loadEnvFile();
} catch {
  // Sem .env: segue com variáveis do ambiente / defaults.
}

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = Object.freeze({
  server: {
    port: toInt(process.env.PORT, 3000),
    host: process.env.HOST || '0.0.0.0',
    logLevel: process.env.LOG_LEVEL || 'info',
    // true quando atrás do Nginx: usa X-Forwarded-For como IP real (rate limit do login).
    trustProxy: process.env.TRUST_PROXY === 'true',
  },
  auth: {
    // Usados só para criar o primeiro admin quando a tabela users está vazia.
    adminEmail: (process.env.ADMIN_EMAIL || 'admin@nexus.local').trim().toLowerCase(),
    adminName: process.env.ADMIN_NAME || 'Administrador',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    bcryptRounds: toInt(process.env.BCRYPT_ROUNDS, 12),
    jwtSecret: process.env.JWT_SECRET || '',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  },
  db: {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: toInt(process.env.MYSQL_PORT, 3306),
    user: process.env.MYSQL_USER || 'nexus',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'nexus',
    poolMax: toInt(process.env.MYSQL_POOL_MAX, 10),
    connectRetries: toInt(process.env.MYSQL_CONNECT_RETRIES, 20),
    connectRetryDelayMs: toInt(process.env.MYSQL_CONNECT_RETRY_DELAY_MS, 3000),
  },
  scraper: {
    headless: process.env.SCRAPER_HEADLESS !== 'false',
    maxResults: toInt(process.env.SCRAPER_MAX_RESULTS, 50),
  },
  app: {
    // Endereço público do painel (sem / no fim): monta o link da sala enviado ao cliente.
    // Ex.: https://nexus.suaempresa.com.br — sem ele, a confirmação de reunião vai sem link.
    publicUrl: (process.env.PUBLIC_APP_URL || '').replace(/\/$/, ''),
  },
  meet: {
    // WebRTC P2P (vídeo direto entre navegadores): ótimo até 3 pessoas. Acima disso cada um
    // teria de enviar um vídeo por participante; aí o certo é um SFU (ex.: LiveKit).
    maxParticipants: toInt(process.env.MEET_MAX_PARTICIPANTS, 3),
    // STUN descobre o IP público; o TURN (coturn) retransmite quando a rede bloqueia o P2P.
    stunUrls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',').map((s) => s.trim()).filter(Boolean),
    // Ex.: turn:turn.suaempresa.com.br:3478?transport=udp,turn:turn.suaempresa.com.br:3478?transport=tcp
    turnUrls: (process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean),
    // Mesmo segredo do coturn (--static-auth-secret): credenciais temporárias por sessão.
    turnSecret: process.env.TURN_SECRET || '',
  },
  business: {
    // Fuso da empresa: datas nas mensagens aos clientes (ex.: confirmação de reunião).
    // O servidor/Docker corre em UTC; sem isto a hora sairia 3h adiantada.
    timezone: process.env.BUSINESS_TIMEZONE || 'America/Sao_Paulo',
  },
  ai: {
    // Assistente que SUGERE respostas na Central (nunca envia sozinho). Requer o Ollama.
    enabled: process.env.AI_ENABLED === 'true',
    ollamaUrl: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
    // Escolhido por benchmark (CPU, 2 threads): único candidato com 8/8 nas regras de atendimento.
    // Mais rápido e um pouco pior: qwen3:1.7b. Nunca a tag "qwen3.5:2b" (= q8_0, 2,7 GB).
    model: process.env.AI_MODEL || 'qwen3.5:2b-q4_K_M',
    // Threads de CPU para gerar (0 = o Ollama decide). No VPS de 2 vCPU: 2.
    numThread: toInt(process.env.AI_NUM_THREAD, 0),
    // Espera o cliente parar de escrever (várias mensagens curtas seguidas) antes de sugerir.
    debounceMs: toInt(process.env.AI_DEBOUNCE_MS, 6_000),
    historyLimit: toInt(process.env.AI_HISTORY_LIMIT, 10),
    timeoutMs: toInt(process.env.AI_TIMEOUT_MS, 90_000),
  },
  whatsapp: {
    // Desligado por padrão: sobe um Chrome dedicado e exige ler o QR Code no painel.
    enabled: process.env.WHATSAPP_ENABLED === 'true',
    // Sessão autenticada (equivale a estar logado no WhatsApp): guardar fora do Git, em volume.
    sessionDir: process.env.WHATSAPP_SESSION_DIR || '.wwebjs_auth',
    headless: process.env.WHATSAPP_HEADLESS !== 'false',
    // Número desconhecido: cria um cliente "lead" (true) ou ignora a mensagem (false).
    autoCreateClients: process.env.WHATSAPP_AUTO_CREATE_CLIENTS !== 'false',
  },
});
