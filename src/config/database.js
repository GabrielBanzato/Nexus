import knex from 'knex';
import { config } from './env.js';

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

// ---------------------------------------------------------------------------
// Schema (auto-migration)
// Idempotente: CREATE TABLE IF NOT EXISTS pode rodar em todo boot, inclusive com
// várias instâncias subindo ao mesmo tempo. Mantenha em sincronia com db/init.sql.
// ---------------------------------------------------------------------------

const SCHEMA = [
  {
    table: 'leads',
    sql: `
      CREATE TABLE IF NOT EXISTS leads (
        id                 INT UNSIGNED   NOT NULL AUTO_INCREMENT,
        nome               VARCHAR(255)   NOT NULL,
        nicho              VARCHAR(150)   NULL COMMENT 'Categoria do Google Maps (ex: Pizzaria)',
        endereco           VARCHAR(500)   NULL,
        telefone           VARCHAR(30)    NULL,
        website            VARCHAR(500)   NULL,
        nota               DECIMAL(2,1)   NULL COMMENT '0.0 a 5.0',
        avaliacoes_qtd     INT UNSIGNED   NULL,
        tem_site           TINYINT(1)     AS (website IS NOT NULL AND website <> '') STORED,
        grupo              ENUM('COM_SITE', 'SEM_SITE') NOT NULL,
        status_prospeccao  ENUM('NOVO', 'CONTATADO', 'EM_NEGOCIACAO', 'FECHADO', 'DESCARTADO')
                           NOT NULL DEFAULT 'NOVO',
        maps_url           VARCHAR(1000)  NULL,
        termo_busca        VARCHAR(255)   NULL,
        chave_dedupe       VARCHAR(255)   NOT NULL COMMENT 'tel:<digitos> ou na:<nome>|<endereco> normalizados',
        criado_em          DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        atualizado_em      DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        UNIQUE KEY uq_leads_chave_dedupe (chave_dedupe),
        KEY idx_leads_grupo_status (grupo, status_prospeccao),
        KEY idx_leads_nicho (nicho),
        KEY idx_leads_criado_em (criado_em),
        CONSTRAINT chk_leads_nota CHECK (nota IS NULL OR nota BETWEEN 0 AND 5)
      ) ENGINE = InnoDB
        DEFAULT CHARSET = utf8mb4
        COLLATE = utf8mb4_0900_ai_ci
    `,
  },
  {
    table: 'scrape_jobs',
    sql: `
      CREATE TABLE IF NOT EXISTS scrape_jobs (
        id            CHAR(36)      NOT NULL,
        search_term   VARCHAR(255)  NOT NULL,
        max_results   INT UNSIGNED  NOT NULL,
        status        ENUM('PENDING', 'RUNNING', 'DONE', 'FAILED') NOT NULL DEFAULT 'PENDING',
        found         INT UNSIGNED  NOT NULL DEFAULT 0,
        inserted      INT UNSIGNED  NOT NULL DEFAULT 0,
        updated       INT UNSIGNED  NOT NULL DEFAULT 0,
        error         TEXT          NULL,
        created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        started_at    DATETIME      NULL,
        finished_at   DATETIME      NULL,

        PRIMARY KEY (id),
        KEY idx_scrape_jobs_status (status)
      ) ENGINE = InnoDB
        DEFAULT CHARSET = utf8mb4
        COLLATE = utf8mb4_0900_ai_ci
    `,
  },
];

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

async function listExistingTables(tables) {
  const rows = await db('information_schema.tables')
    .select({ name: 'table_name' })
    .whereRaw('table_schema = DATABASE()')
    .whereIn('table_name', tables);
  return new Set(rows.map((row) => row.name));
}

/**
 * Cria as tabelas que ainda não existem. Tabelas existentes não são alteradas
 * (CREATE TABLE IF NOT EXISTS não adiciona colunas novas a uma tabela antiga).
 */
async function migrate(logger) {
  const tables = SCHEMA.map((entry) => entry.table);
  const before = await listExistingTables(tables);

  for (const { table, sql } of SCHEMA) {
    try {
      await db.raw(sql);
    } catch (err) {
      // Ex.: usuário sem permissão de CREATE. Aqui sim o erro é fatal: sem tabela a API não funciona.
      throw new Error(`Falha ao criar a tabela "${table}": ${err.message}`);
    }
  }

  const created = tables.filter((table) => !before.has(table));
  if (created.length) {
    logger.info({ tables: created }, 'Auto-migration: tabelas criadas');
  } else {
    logger.info('Auto-migration: schema já estava atualizado');
  }
}

export async function initDatabase({ logger = console } = {}) {
  await waitForConnection(logger);
  await migrate(logger);

  // Jobs que estavam em andamento quando o processo caiu não serão retomados.
  await db('scrape_jobs')
    .whereIn('status', ['PENDING', 'RUNNING'])
    .update({ status: 'FAILED', error: 'Interrompido por reinício do servidor', finished_at: db.fn.now() });

  logger.info({ host: config.db.host, database: config.db.database }, 'MySQL conectado');
}

export async function closeDatabase() {
  await db.destroy();
}
