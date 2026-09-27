-- =============================================================================
-- Nexus: schema MySQL 8
-- Executado automaticamente pelo container MySQL na PRIMEIRA inicialização
-- (volume vazio), dentro do banco definido em MYSQL_DATABASE.
-- Para rodar manualmente: mysql -u <user> -p <database> < db/init.sql
-- =============================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- -----------------------------------------------------------------------------
-- Leads extraídos do Google Maps
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  id                 INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  nome               VARCHAR(255)   NOT NULL,
  nicho              VARCHAR(150)   NULL COMMENT 'Categoria do Google Maps (ex: Pizzaria)',
  endereco           VARCHAR(500)   NULL,
  telefone           VARCHAR(30)    NULL,
  website            VARCHAR(500)   NULL,
  nota               DECIMAL(2,1)   NULL COMMENT '0.0 a 5.0',
  avaliacoes_qtd     INT UNSIGNED   NULL,
  -- Derivado do website: impossível ficar inconsistente.
  tem_site           TINYINT(1)     AS (website IS NOT NULL AND website <> '') STORED,
  grupo              ENUM('COM_SITE', 'SEM_SITE') NOT NULL,
  status_prospeccao  ENUM('NOVO', 'CONTATADO', 'EM_NEGOCIACAO', 'FECHADO', 'DESCARTADO')
                     NOT NULL DEFAULT 'NOVO',
  is_hidden          TINYINT(1)     NOT NULL DEFAULT 0 COMMENT 'Oculto/arquivado (soft delete)',
  hidden_at          DATETIME       NULL,
  hidden_by          INT UNSIGNED   NULL,

  -- Metadados da extração
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
  -- _ai_ci = sem distinção de acento e caixa: "mecanica" encontra "Mecânica".
  COLLATE = utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Jobs de varredura (acompanhamento do POST /api/scrape)
-- -----------------------------------------------------------------------------
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
  COLLATE = utf8mb4_0900_ai_ci;

-- =============================================================================
-- Gestão de equipe e operações
-- (ordem importa: tabelas referenciadas por FK vêm antes)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Utilizadores (roles: admin, partner, agent). Nunca apagados: desativados.
-- -----------------------------------------------------------------------------
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
  COLLATE = utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Clientes conquistados
-- -----------------------------------------------------------------------------
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
  COLLATE = utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Chamados / tickets
-- -----------------------------------------------------------------------------
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
  CONSTRAINT fk_tickets_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_tickets_assigned_to FOREIGN KEY (assigned_to) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_tickets_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE SET NULL
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Quadro Kanban (posições densas por coluna: 0 = topo)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kanban_tasks (
  id              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  title           VARCHAR(200)  NOT NULL,
  description     TEXT          NULL,
  column_name     ENUM('todo', 'in_progress', 'review', 'done') NOT NULL DEFAULT 'todo',
  position        INT UNSIGNED  NOT NULL DEFAULT 0,
  responsible_id  INT UNSIGNED  NULL,
  created_by      INT UNSIGNED  NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_kanban_column_position (column_name, position),
  KEY idx_kanban_responsible (responsible_id),
  CONSTRAINT fk_kanban_responsible FOREIGN KEY (responsible_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_kanban_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Logs de atividade (auditoria)
-- -----------------------------------------------------------------------------
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
  COLLATE = utf8mb4_0900_ai_ci;

-- =============================================================================
-- CRM comercial
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Pipeline de negociação (posições densas por estágio: 0 = topo)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deals (
  id                   INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  title                VARCHAR(200)   NOT NULL,
  company              VARCHAR(190)   NULL,
  contact_name         VARCHAR(160)   NULL,
  phone                VARCHAR(30)    NULL,
  email                VARCHAR(190)   NULL,
  value                DECIMAL(12,2)  NOT NULL DEFAULT 0,
  stage                ENUM('lead', 'negotiation', 'awaiting', 'won', 'lost') NOT NULL DEFAULT 'lead',
  position             INT UNSIGNED   NOT NULL DEFAULT 0,
  owner_id             INT UNSIGNED   NULL,
  lead_id              INT UNSIGNED   NULL,
  client_id            INT UNSIGNED   NULL,
  expected_close_date  DATE           NULL,
  lost_reason          VARCHAR(255)   NULL,
  won_at               DATETIME       NULL,
  lost_at              DATETIME       NULL,
  stage_changed_at     DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by           INT UNSIGNED   NULL,
  created_at           DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_deals_stage_position (stage, position),
  KEY idx_deals_owner_stage (owner_id, stage),
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
  COLLATE = utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Triagem de leads (1:1 com leads; todo lead entra na fila como 'pending')
-- -----------------------------------------------------------------------------
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
  COLLATE = utf8mb4_0900_ai_ci;
