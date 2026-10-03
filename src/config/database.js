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
    decimalNumbers: true, // DECIMAL (nota, valor) chega como number, não string
    dateStrings: ['DATE'], // DATE (ex.: previsão de fecho) chega como 'YYYY-MM-DD', sem fuso
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
        is_hidden          TINYINT(1)     NOT NULL DEFAULT 0 COMMENT 'Oculto/arquivado (soft delete)',
        hidden_at          DATETIME       NULL,
        hidden_by          INT UNSIGNED   NULL,
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
        KEY idx_leads_visiveis (is_hidden, criado_em),
        KEY idx_leads_termo_busca (termo_busca),
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

  // --- Gestão de equipe e operações -----------------------------------------
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
        bot_active      TINYINT(1)    NOT NULL DEFAULT 1 COMMENT 'IA responde no WhatsApp; 0 = um humano assumiu a conversa',
        whatsapp_jid    VARCHAR(64)   NULL COMMENT 'Contacto no WhatsApp (ex.: 5511999999999@c.us)',
        created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        UNIQUE KEY uq_clients_whatsapp (whatsapp_jid),
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

  // --- CRM comercial ---------------------------------------------------------
  {
    table: 'deals',
    sql: `
      CREATE TABLE IF NOT EXISTS deals (
        id                   INT UNSIGNED   NOT NULL AUTO_INCREMENT,
        title                VARCHAR(200)   NOT NULL,
        company              VARCHAR(190)   NULL,
        contact_name         VARCHAR(160)   NULL,
        phone                VARCHAR(30)    NULL,
        email                VARCHAR(190)   NULL,
        value                DECIMAL(12,2)  NOT NULL DEFAULT 0,
        stage                ENUM('lead', 'meeting', 'negotiation', 'awaiting', 'won', 'lost') NOT NULL DEFAULT 'lead',
        position             INT UNSIGNED   NOT NULL DEFAULT 0 COMMENT 'Ordem dentro do estágio (0 = topo)',
        owner_id             INT UNSIGNED   NULL,
        lead_id              INT UNSIGNED   NULL,
        client_id            INT UNSIGNED   NULL,
        expected_close_date  DATE           NULL,
        lost_reason          VARCHAR(255)   NULL,
        won_at               DATETIME       NULL,
        lost_at              DATETIME       NULL,
        meeting_at           DATETIME       NULL COMMENT 'Reunião agendada (UTC)',
        stage_changed_at     DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by           INT UNSIGNED   NULL,
        created_at           DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at           DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        KEY idx_deals_stage_position (stage, position),
        KEY idx_deals_owner_stage (owner_id, stage),
        -- Métricas por intervalo de datas (e por colaborador).
        KEY idx_deals_won (won_at, owner_id),
        KEY idx_deals_lost (lost_at, owner_id),
        KEY idx_deals_created (created_at, owner_id),
        KEY idx_deals_lead (lead_id),
        KEY idx_deals_client (client_id),
        CONSTRAINT chk_deals_value CHECK (value >= 0),
        CONSTRAINT fk_deals_owner FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT fk_deals_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT fk_deals_lead FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE SET NULL,
        CONSTRAINT fk_deals_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE SET NULL
      ) ENGINE = InnoDB
        DEFAULT CHARSET = utf8mb4
        COLLATE = utf8mb4_0900_ai_ci
    `,
  },
  {
    table: 'lead_triage',
    sql: `
      CREATE TABLE IF NOT EXISTS lead_triage (
        lead_id      INT UNSIGNED      NOT NULL,
        status       ENUM('pending', 'qualified', 'on_hold', 'discarded') NOT NULL DEFAULT 'pending',
        assigned_to  INT UNSIGNED      NULL,
        assigned_at  DATETIME          NULL,
        score        TINYINT UNSIGNED  NULL COMMENT 'Qualificação 0-100',
        notes        VARCHAR(1000)     NULL,
        hold_until   DATE              NULL,
        triaged_by   INT UNSIGNED      NULL,
        triaged_at   DATETIME          NULL,
        deal_id      INT UNSIGNED      NULL COMMENT 'Negócio criado ao qualificar',
        archived_at  DATETIME          NULL COMMENT 'Arquivado na Triagem (sai da vista; registo mantido)',
        archived_by  INT UNSIGNED      NULL,
        created_at   DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at   DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (lead_id),
        KEY idx_triage_status_assigned (status, assigned_to),
        KEY idx_triage_assigned_status (assigned_to, status),
        KEY idx_triage_triaged (triaged_at, triaged_by),
        KEY idx_triage_archived (archived_at),
        CONSTRAINT chk_triage_score CHECK (score IS NULL OR score <= 100),
        CONSTRAINT fk_triage_lead FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE CASCADE,
        CONSTRAINT fk_triage_assigned FOREIGN KEY (assigned_to) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT fk_triage_triaged_by FOREIGN KEY (triaged_by) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT fk_triage_deal FOREIGN KEY (deal_id) REFERENCES deals (id) ON DELETE SET NULL
      ) ENGINE = InnoDB
        DEFAULT CHARSET = utf8mb4
        COLLATE = utf8mb4_0900_ai_ci
    `,
  },
  {
    table: 'messages',
    sql: `
      CREATE TABLE IF NOT EXISTS messages (
        id              BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
        client_id       INT UNSIGNED     NOT NULL,
        sender_type     ENUM('client', 'agent', 'bot') NOT NULL,
        content         TEXT             NOT NULL,
        wa_message_id   VARCHAR(128)     NULL COMMENT 'Id no WhatsApp: evita duplicados quando a sessão reconecta',
        sender_user_id  INT UNSIGNED     NULL COMMENT 'Quem respondeu (sender_type = agent)',
        created_at      DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        UNIQUE KEY uq_messages_wa (wa_message_id),
        KEY idx_messages_client (client_id, id),
        CONSTRAINT fk_messages_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE CASCADE,
        CONSTRAINT fk_messages_sender FOREIGN KEY (sender_user_id) REFERENCES users (id) ON DELETE SET NULL
      ) ENGINE = InnoDB
        DEFAULT CHARSET = utf8mb4
        COLLATE = utf8mb4_0900_ai_ci
    `,
  },
];

/**
 * Colunas acrescentadas a tabelas que já existem em produção. CREATE TABLE IF NOT EXISTS não
 * altera tabelas existentes, por isso cada entrada verifica a coluna e só corre o ALTER se faltar
 * (idempotente; bancos novos já nascem com ela e saltam o passo).
 */
const COLUMN_MIGRATIONS = [
  {
    table: 'leads',
    column: 'is_hidden',
    name: 'leads: ocultar/arquivar (soft delete)',
    sql: `
      ALTER TABLE leads
        ADD COLUMN is_hidden TINYINT(1) NOT NULL DEFAULT 0 AFTER status_prospeccao,
        ADD COLUMN hidden_at DATETIME NULL AFTER is_hidden,
        ADD COLUMN hidden_by INT UNSIGNED NULL AFTER hidden_at,
        ADD KEY idx_leads_visiveis (is_hidden, criado_em),
        ADD KEY idx_leads_termo_busca (termo_busca)
    `,
  },
  {
    table: 'lead_triage',
    column: 'archived_at',
    name: 'lead_triage: arquivar na Triagem (soft delete)',
    sql: `
      ALTER TABLE lead_triage
        ADD COLUMN archived_at DATETIME NULL COMMENT 'Arquivado na Triagem (sai da vista; registo mantido)' AFTER deal_id,
        ADD COLUMN archived_by INT UNSIGNED NULL AFTER archived_at,
        ADD KEY idx_triage_archived (archived_at)
    `,
  },
  {
    table: 'deals',
    column: 'meeting_at',
    name: 'deals: meeting_at (Reunião Agendada)',
    sql: `ALTER TABLE deals ADD COLUMN meeting_at DATETIME NULL COMMENT 'Reunião agendada (UTC)' AFTER lost_at`,
  },
  {
    table: 'clients',
    column: 'bot_active',
    name: 'clients: bot_active (IA ativa / humano assumiu no WhatsApp)',
    sql: `
      ALTER TABLE clients
        ADD COLUMN bot_active TINYINT(1) NOT NULL DEFAULT 1
          COMMENT 'IA responde no WhatsApp; 0 = um humano assumiu a conversa' AFTER lead_id
    `,
  },
  {
    table: 'clients',
    column: 'whatsapp_jid',
    name: 'clients: whatsapp_jid (contacto no WhatsApp)',
    sql: `
      ALTER TABLE clients
        ADD COLUMN whatsapp_jid VARCHAR(64) NULL COMMENT 'Contacto no WhatsApp (ex.: 5511999999999@c.us)' AFTER bot_active,
        ADD UNIQUE KEY uq_clients_whatsapp (whatsapp_jid)
    `,
  },
];

/**
 * Mudanças no tipo de uma coluna existente (ex.: valores de um ENUM). `pending(columnType)` diz se
 * o banco ainda está no formato antigo; os passos podem ser repetidos sem efeito colateral caso
 * um boot anterior tenha parado a meio (DDL no MySQL não é transacional).
 */
const TYPE_MIGRATIONS = [
  {
    table: 'deals',
    column: 'stage',
    name: 'deals: estágios Triagem/Novo, Em Negociação, Aguardando Resposta, Fechado, Perdido',
    pending: (type) => type.includes("'qualification'"),
    steps: [
      // 1) ENUM com os valores antigos e novos, para poder remapear.
      `ALTER TABLE deals MODIFY stage ENUM('lead', 'qualification', 'proposal', 'negotiation', 'awaiting', 'won', 'lost') NOT NULL DEFAULT 'lead'`,
      // 2) Qualificação volta à triagem; proposta enviada = aguardando resposta.
      `UPDATE deals SET stage = 'lead', updated_at = updated_at WHERE stage = 'qualification'`,
      `UPDATE deals SET stage = 'awaiting', updated_at = updated_at WHERE stage = 'proposal'`,
      // 3) Estágios fundidos ficam com posições densas outra vez (0..n-1), como o quadro espera.
      `UPDATE deals d
         JOIN (SELECT id, ROW_NUMBER() OVER (PARTITION BY stage ORDER BY position, id) - 1 AS pos FROM deals) x ON x.id = d.id
          SET d.position = x.pos, d.updated_at = d.updated_at`,
      // 4) ENUM final.
      `ALTER TABLE deals MODIFY stage ENUM('lead', 'negotiation', 'awaiting', 'won', 'lost') NOT NULL DEFAULT 'lead'`,
    ],
  },
  {
    // Corre depois da anterior (cada entrada relê o tipo): bancos antigos ganham os dois passos.
    table: 'deals',
    column: 'stage',
    name: 'deals: estágio Reunião Agendada',
    pending: (type) => !type.includes("'meeting'"),
    steps: [`ALTER TABLE deals MODIFY stage ENUM('lead', 'meeting', 'negotiation', 'awaiting', 'won', 'lost') NOT NULL DEFAULT 'lead'`],
  },
];

async function columnType(table, column) {
  const row = await db('information_schema.columns')
    .select({ type: 'column_type' })
    .whereRaw('table_schema = DATABASE()')
    .where({ table_name: table, column_name: column })
    .first();
  return row?.type ?? null;
}

// Idempotentes; rodam em todo boot, depois das tabelas.
const POST_MIGRATIONS = [
  {
    name: 'lead_triage: todo lead existente entra na fila',
    sql: 'INSERT IGNORE INTO lead_triage (lead_id) SELECT id FROM leads',
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

  for (const { table, column, name, sql } of COLUMN_MIGRATIONS) {
    if (await db.schema.hasColumn(table, column)) continue;
    try {
      await db.raw(sql);
      logger.info(`Auto-migration: ${name}`);
    } catch (err) {
      throw new Error(`Falha na migração "${name}": ${err.message}`);
    }
  }

  for (const { table, column, name, pending, steps } of TYPE_MIGRATIONS) {
    const type = await columnType(table, column);
    if (!type || !pending(type)) continue;
    try {
      for (const sql of steps) await db.raw(sql);
      logger.info(`Auto-migration: ${name}`);
    } catch (err) {
      throw new Error(`Falha na migração "${name}": ${err.message}`);
    }
  }

  for (const { name, sql } of POST_MIGRATIONS) {
    const [result] = await db.raw(sql);
    if (result?.affectedRows) logger.info({ rows: result.affectedRows }, `Auto-migration: ${name}`);
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
