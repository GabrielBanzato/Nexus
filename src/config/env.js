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
    adminPassword: process.env.ADMIN_PASSWORD || '',
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
});
