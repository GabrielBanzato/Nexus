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
