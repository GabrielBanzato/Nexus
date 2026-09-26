import knex from 'knex';
import { config } from './env.js';

const REQUIRED_TABLES = ['leads', 'scrape_jobs'];

export const db = knex({
  client: 'mysql2',
  connection: {
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    charset: 'utf8mb4',
    timezone: 'Z', // datas sempre em UTC entre Node e MySQL
    decimalNumbers: true, // DECIMAL (nota) chega como number, não string
    // TINYINT(1) (tem_site) chega como boolean.
    typeCast(field, next) {
      if (field.type === 'TINY' && field.length === 1) {
        const value = field.string();
        return value === null ? null : value === '1';
      }
      return next();
    },
  },
  pool: { min: 0, max: config.db.poolMax },
  acquireConnectionTimeout: 10_000,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** O MySQL pode levar alguns segundos para aceitar conexões (ex.: container subindo). */
async function waitForConnection(logger) {
  const { connectRetries, connectRetryDelayMs, host, port } = config.db;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await db.raw('SELECT 1');
      return;
    } catch (err) {
      if (attempt >= connectRetries) {
        throw new Error(`MySQL indisponível em ${host}:${port} após ${attempt} tentativas: ${err.message}`);
      }
      logger.warn({ attempt, err: err.code || err.message }, 'Aguardando MySQL...');
      await sleep(connectRetryDelayMs);
    }
  }
}

/** O schema é versionado em db/init.sql (fonte única da verdade); aqui apenas validamos. */
async function assertSchema() {
  const rows = await db('information_schema.tables')
    .select({ name: 'table_name' })
    .whereRaw('table_schema = DATABASE()')
    .whereIn('table_name', REQUIRED_TABLES);

  const existing = new Set(rows.map((row) => row.name));
  const missing = REQUIRED_TABLES.filter((table) => !existing.has(table));
  if (missing.length) {
    throw new Error(`Tabelas ausentes no MySQL: ${missing.join(', ')}. Execute db/init.sql no banco "${config.db.database}".`);
  }
}

export async function initDatabase({ logger = console } = {}) {
  await waitForConnection(logger);
  await assertSchema();

  // Jobs que estavam em andamento quando o processo caiu não serão retomados.
  await db('scrape_jobs')
    .whereIn('status', ['PENDING', 'RUNNING'])
    .update({ status: 'FAILED', error: 'Interrompido por reinício do servidor', finished_at: db.fn.now() });

  logger.info({ host: config.db.host, database: config.db.database }, 'MySQL conectado');
}

export async function closeDatabase() {
  await db.destroy();
}
