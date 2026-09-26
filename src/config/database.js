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

  // --- Gestão de equipa e operações -----------------------------------------
  // Ordem importa: tabelas referenciadas por FK vêm antes.
  {
    table: 'users',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id             INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        name           VARCHAR(120)  NOT NULL,
        email          VARCHAR(190)  NOT NULL,
        password_hash  CHAR(60)      NOT NULL COMMENT 'bcrypt',
        role           ENUM('admin', 'partner', 'agent') NOT NULL DEFAULT 'agent',
        is_active      TINYINT(1)    NOT NULL DEFAULT 1,
        last_login_at  DATETIME      NULL,
        created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        UNIQUE KEY uq_users_email (email),
        KEY idx_users_role_active (role, is_active)
      ) ENGINE = InnoDB
        DEFAULT CHARSET = utf8mb4
        COLLATE = utf8mb4_0900_ai_ci
    `,
  },
  {
    table: 'clients',
    sql: `
      CREATE TABLE IF NOT EXISTS clients (
        id              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        name            VARCHAR(160)  NOT NULL,
        company         VARCHAR(190)  NULL,
        phone           VARCHAR(30)   NULL,
        email           VARCHAR(190)  NULL,
        status          ENUM('lead', 'active', 'archived') NOT NULL DEFAULT 'lead',
        responsible_id  INT UNSIGNED  NULL,
        lead_id         INT UNSIGNED  NULL COMMENT 'Lead de prospecção que originou o cliente',
        created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        KEY idx_clients_status (status),
        KEY idx_clients_responsible (responsible_id),
        KEY idx_clients_lead (lead_id),
        KEY idx_clients_company (company),
        CONSTRAINT fk_clients_responsible FOREIGN KEY (responsible_id) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT fk_clients_lead FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE SET NULL
      ) ENGINE = InnoDB
        DEFAULT CHARSET = utf8mb4
        COLLATE = utf8mb4_0900_ai_ci
    `,
  },
  {
    table: 'tickets',
    sql: `
      CREATE TABLE IF NOT EXISTS tickets (
        id           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        title        VARCHAR(200)  NOT NULL,
        description  TEXT          NULL,
        status       ENUM('open', 'in_progress', 'resolved', 'closed') NOT NULL DEFAULT 'open',
        priority     ENUM('low', 'medium', 'high', 'urgent') NOT NULL DEFAULT 'medium',
        created_by   INT UNSIGNED  NOT NULL,
        assigned_to  INT UNSIGNED  NULL,
        client_id    INT UNSIGNED  NULL,
        resolved_at  DATETIME      NULL,
        created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        KEY idx_tickets_status_priority (status, priority),
        KEY idx_tickets_assigned_status (assigned_to, status),
        KEY idx_tickets_client (client_id),
        KEY idx_tickets_created_by (created_by),
        -- Utilizadores nunca são apagados (são desativados), por isso RESTRICT no autor.
        CONSTRAINT fk_tickets_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT fk_tickets_assigned_to FOREIGN KEY (assigned_to) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT fk_tickets_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE SET NULL
      ) ENGINE = InnoDB
        DEFAULT CHARSET = utf8mb4
        COLLATE = utf8mb4_0900_ai_ci
    `,
  },
  {
    table: 'kanban_tasks',
    sql: `
      CREATE TABLE IF NOT EXISTS kanban_tasks (
        id              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        title           VARCHAR(200)  NOT NULL,
        description     TEXT          NULL,
        column_name     ENUM('todo', 'in_progress', 'review', 'done') NOT NULL DEFAULT 'todo',
        position        INT UNSIGNED  NOT NULL DEFAULT 0 COMMENT 'Ordem dentro da coluna (0 = topo)',
        responsible_id  INT UNSIGNED  NULL,
        created_by      INT UNSIGNED  NULL,
        created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        -- Sem UNIQUE em (column_name, position): o reordenamento desloca várias linhas no mesmo UPDATE.
        KEY idx_kanban_column_position (column_name, position),
        KEY idx_kanban_responsible (responsible_id),
        CONSTRAINT fk_kanban_responsible FOREIGN KEY (responsible_id) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT fk_kanban_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
      ) ENGINE = InnoDB
        DEFAULT CHARSET = utf8mb4
        COLLATE = utf8mb4_0900_ai_ci
    `,
  },
  {
    table: 'activity_logs',
    sql: `
      CREATE TABLE IF NOT EXISTS activity_logs (
        id           BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
        user_id      INT UNSIGNED     NULL,
        action       VARCHAR(64)      NOT NULL COMMENT 'ex: ticket.update, kanban.move',
        entity_type  VARCHAR(32)      NULL,
        entity_id    INT UNSIGNED     NULL,
        details      JSON             NULL,
        ip           VARCHAR(45)      NULL,
        created_at   DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        KEY idx_logs_user_created (user_id, created_at),
        KEY idx_logs_entity (entity_type, entity_id),
        KEY idx_logs_action_created (action, created_at),
        CONSTRAINT fk_logs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
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
