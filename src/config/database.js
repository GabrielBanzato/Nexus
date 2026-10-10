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
        wa_status          ENUM('yes', 'no') NULL COMMENT 'Tem WhatsApp? (checado no WhatsApp; NULL = ainda não)',
        wa_checked_at      DATETIME       NULL,
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
        phone          VARCHAR(30)   NULL COMMENT 'WhatsApp do membro (lembretes de reunião)',
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
        status          ENUM('lead', 'active', 'on_hold', 'archived') NOT NULL DEFAULT 'lead' COMMENT 'active = cliente (aba Clientes); on_hold = em espera',
        hold_until      DATE          NULL COMMENT 'Em espera: retomar a partir deste dia',
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
        pains                TEXT           NULL COMMENT 'Em Negociação: dores do cliente',
        proposal_offer       TEXT           NULL COMMENT 'Em Negociação: proposta real',
        bait                 TEXT           NULL COMMENT 'Em Negociação: isca do vendedor',
        final_proposal       TEXT           NULL COMMENT 'Aguardando Resposta: proposta final apresentada',
        won_scope            TEXT           NULL COMMENT 'Cliente Fechado: sistema a fazer',
        delivery_due         DATE           NULL COMMENT 'Cliente Fechado: prazo de entrega',
        monthly_value        DECIMAL(12,2)  NOT NULL DEFAULT 0 COMMENT 'Mensalidade combinada (0 = sem mensalidade)',
        monthly_start        DATE           NULL COMMENT '1.º mês da mensalidade (dia 1)',
        monthly_end          DATE           NULL COMMENT 'Último mês da mensalidade (dia 1); NULL = em curso',
        closing_rate         DECIMAL(5,2)   NULL COMMENT '% de comissão do fecho (fixada ao fechar)',
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
    table: 'meetings',
    sql: `
      CREATE TABLE IF NOT EXISTS meetings (
        id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        code          VARCHAR(32)   NOT NULL COMMENT 'Código da sala no link (aleatório, difícil de adivinhar)',
        title         VARCHAR(200)  NOT NULL,
        deal_id       INT UNSIGNED  NULL,
        client_id     INT UNSIGNED  NULL,
        host_user_id  INT UNSIGNED  NULL COMMENT 'Quem conduz (responsável pelo negócio/cliente)',
        scheduled_at  DATETIME      NULL,
        status        ENUM('scheduled', 'live', 'ended') NOT NULL DEFAULT 'scheduled',
        remind_day_sent_at  DATETIME NULL COMMENT 'Lembrete do dia enviado (ou dispensado)',
        remind_hour_sent_at DATETIME NULL COMMENT 'Lembrete de 1h antes enviado (ou dispensado)',
        nex_insights  JSON          NULL COMMENT 'Nex: dores, dúvidas, objeções, sinais e dica da reunião',
        nex_updated_at DATETIME     NULL,
        started_at    DATETIME      NULL,
        ended_at      DATETIME      NULL,
        created_by    INT UNSIGNED  NULL,
        created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        UNIQUE KEY uq_meetings_code (code),
        KEY idx_meetings_deal (deal_id, status),
        KEY idx_meetings_client (client_id, status),
        KEY idx_meetings_host_status (host_user_id, status, scheduled_at),
        CONSTRAINT fk_meetings_deal FOREIGN KEY (deal_id) REFERENCES deals (id) ON DELETE SET NULL,
        CONSTRAINT fk_meetings_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE SET NULL,
        CONSTRAINT fk_meetings_host FOREIGN KEY (host_user_id) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT fk_meetings_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
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
        ack             TINYINT UNSIGNED NULL COMMENT 'Estado no WhatsApp: 1 enviada, 2 entregue, 3 lida, 4 ouvida',
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
  {
    table: 'app_settings',
    sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        name        VARCHAR(64)   NOT NULL,
        value       TEXT          NOT NULL,
        updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (name)
      ) ENGINE = InnoDB
        DEFAULT CHARSET = utf8mb4
        COLLATE = utf8mb4_0900_ai_ci
        COMMENT = 'Configurações geradas pelo próprio sistema (ex.: chaves VAPID das notificações)'
    `,
  },
  {
    table: 'push_subscriptions',
    sql: `
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        user_id       INT UNSIGNED  NOT NULL,
        endpoint      VARCHAR(512)  NOT NULL COMMENT 'URL do serviço de push do navegador/aparelho',
        p256dh        VARCHAR(255)  NOT NULL,
        auth          VARCHAR(64)   NOT NULL,
        user_agent    VARCHAR(255)  NULL,
        created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_used_at  DATETIME      NULL,

        PRIMARY KEY (id),
        UNIQUE KEY uq_push_endpoint (endpoint),
        KEY idx_push_user (user_id),
        CONSTRAINT fk_push_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE = InnoDB
        DEFAULT CHARSET = utf8mb4
        COLLATE = utf8mb4_0900_ai_ci
    `,
  },
  {
    table: 'user_contracts',
    sql: `
      CREATE TABLE IF NOT EXISTS user_contracts (
        user_id         INT UNSIGNED       NOT NULL,
        closing_rate    DECIMAL(5,2)       NOT NULL DEFAULT 0 COMMENT '% sobre o valor de cada venda fechada',
        monthly_rate    DECIMAL(5,2)       NOT NULL DEFAULT 0 COMMENT '% sobre cada mensalidade paga pelo cliente',
        monthly_months  SMALLINT UNSIGNED  NULL COMMENT 'Quantos meses de mensalidade dão comissão (NULL = enquanto o cliente pagar)',
        notes           VARCHAR(500)       NULL,
        updated_by      INT UNSIGNED       NULL,
        created_at      DATETIME           NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME           NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (user_id),
        CONSTRAINT chk_contract_rates CHECK (closing_rate BETWEEN 0 AND 100 AND monthly_rate BETWEEN 0 AND 100),
        CONSTRAINT fk_contract_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT fk_contract_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
      ) ENGINE = InnoDB
        DEFAULT CHARSET = utf8mb4
        COLLATE = utf8mb4_0900_ai_ci
    `,
  },
  {
    table: 'deal_payments',
    sql: `
      CREATE TABLE IF NOT EXISTS deal_payments (
        id               INT UNSIGNED   NOT NULL AUTO_INCREMENT,
        deal_id          INT UNSIGNED   NOT NULL,
        month            DATE           NOT NULL COMMENT 'Mês da mensalidade (dia 1)',
        amount           DECIMAL(12,2)  NOT NULL,
        commission_rate  DECIMAL(5,2)   NULL COMMENT '% do vendedor no momento do registo',
        paid_at          DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        recorded_by      INT UNSIGNED   NULL,

        PRIMARY KEY (id),
        UNIQUE KEY uq_payment_deal_month (deal_id, month),
        KEY idx_payment_month (month),
        CONSTRAINT chk_payment_amount CHECK (amount >= 0),
        CONSTRAINT fk_payment_deal FOREIGN KEY (deal_id) REFERENCES deals (id) ON DELETE CASCADE,
        CONSTRAINT fk_payment_recorded_by FOREIGN KEY (recorded_by) REFERENCES users (id) ON DELETE SET NULL
      ) ENGINE = InnoDB
        DEFAULT CHARSET = utf8mb4
        COLLATE = utf8mb4_0900_ai_ci
    `,
  },
  {
    table: 'goals',
    sql: `
      CREATE TABLE IF NOT EXISTS goals (
        id           INT UNSIGNED   NOT NULL AUTO_INCREMENT,
        title        VARCHAR(160)   NOT NULL,
        metric       ENUM('won_value', 'won_count', 'meetings', 'new_mrr') NOT NULL,
        target       DECIMAL(14,2)  NOT NULL,
        scope        ENUM('individual', 'group') NOT NULL DEFAULT 'individual' COMMENT 'individual = cada um bate a sua; group = a soma de todos',
        starts_on    DATE           NOT NULL,
        ends_on      DATE           NOT NULL COMMENT 'Inclusivo',
        reward       VARCHAR(500)   NULL,
        created_by   INT UNSIGNED   NULL,
        archived_at  DATETIME       NULL,
        created_at   DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at   DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        KEY idx_goals_period (archived_at, ends_on),
        CONSTRAINT chk_goals_target CHECK (target > 0),
        CONSTRAINT chk_goals_period CHECK (ends_on >= starts_on),
        CONSTRAINT fk_goals_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
      ) ENGINE = InnoDB
        DEFAULT CHARSET = utf8mb4
        COLLATE = utf8mb4_0900_ai_ci
    `,
  },
  {
    table: 'goal_members',
    sql: `
      CREATE TABLE IF NOT EXISTS goal_members (
        goal_id  INT UNSIGNED  NOT NULL,
        user_id  INT UNSIGNED  NOT NULL,

        PRIMARY KEY (goal_id, user_id),
        KEY idx_goal_members_user (user_id),
        CONSTRAINT fk_goal_members_goal FOREIGN KEY (goal_id) REFERENCES goals (id) ON DELETE CASCADE,
        CONSTRAINT fk_goal_members_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE = InnoDB
        DEFAULT CHARSET = utf8mb4
        COLLATE = utf8mb4_0900_ai_ci
    `,
  },
  {
    table: 'admin_alerts',
    sql: `
      CREATE TABLE IF NOT EXISTS admin_alerts (
        id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        kind          ENUM('deal_won', 'deal_lost') NOT NULL,
        deal_id       INT UNSIGNED  NULL,
        actor_id      INT UNSIGNED  NULL COMMENT 'Quem moveu o negócio (não é alarmado)',
        title         VARCHAR(200)  NOT NULL,
        body          TEXT          NOT NULL,
        details       JSON          NULL,
        needs_ack     TINYINT(1)    NOT NULL DEFAULT 0 COMMENT '1 = repete a notificação até um admin confirmar',
        ack_token     CHAR(43)      NULL COMMENT 'Confirmação pelo botão da notificação (sem sessão)',
        acked_at      DATETIME      NULL,
        acked_by      INT UNSIGNED  NULL,
        push_count    INT UNSIGNED  NOT NULL DEFAULT 0,
        last_push_at  DATETIME      NULL,
        created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        UNIQUE KEY uq_alert_token (ack_token),
        KEY idx_alerts_pending (needs_ack, acked_at, created_at),
        CONSTRAINT fk_alerts_deal FOREIGN KEY (deal_id) REFERENCES deals (id) ON DELETE SET NULL,
        CONSTRAINT fk_alerts_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT fk_alerts_acked_by FOREIGN KEY (acked_by) REFERENCES users (id) ON DELETE SET NULL
      ) ENGINE = InnoDB
        DEFAULT CHARSET = utf8mb4
        COLLATE = utf8mb4_0900_ai_ci
    `,
  },
  {
    // Nex nas reuniões: o que cada um disse (Whisper), em pedaços de ~15s.
    table: 'meeting_transcripts',
    sql: `
      CREATE TABLE IF NOT EXISTS meeting_transcripts (
        id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        meeting_id    INT UNSIGNED  NOT NULL,
        speaker_role  ENUM('staff', 'guest') NOT NULL COMMENT 'staff = vendedor/equipe; guest = cliente',
        speaker_name  VARCHAR(80)   NOT NULL,
        offset_ms     INT UNSIGNED  NOT NULL COMMENT 'Desde a entrada de quem transcreve (ordem da conversa)',
        text          TEXT          NOT NULL,
        created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      
        PRIMARY KEY (id),
        KEY idx_transcripts_meeting (meeting_id, offset_ms),
        CONSTRAINT fk_transcripts_meeting FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE CASCADE
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
  {
    table: 'users',
    column: 'phone',
    name: 'users: phone (WhatsApp do membro, para lembretes)',
    sql: `ALTER TABLE users ADD COLUMN phone VARCHAR(30) NULL COMMENT 'WhatsApp do membro (lembretes de reunião)' AFTER is_active`,
  },
  {
    table: 'meetings',
    column: 'remind_day_sent_at',
    name: 'meetings: lembretes (dia e 1h antes)',
    sql: `
      ALTER TABLE meetings
        ADD COLUMN remind_day_sent_at DATETIME NULL COMMENT 'Lembrete do dia enviado (ou dispensado)' AFTER status,
        ADD COLUMN remind_hour_sent_at DATETIME NULL COMMENT 'Lembrete de 1h antes enviado (ou dispensado)' AFTER remind_day_sent_at
    `,
  },
  {
    table: 'clients',
    column: 'hold_until',
    name: 'clients: hold_until (em espera até)',
    sql: "ALTER TABLE clients ADD COLUMN hold_until DATE NULL COMMENT 'Em espera: retomar a partir deste dia' AFTER status",
  },
  {
    table: 'messages',
    column: 'ack',
    name: 'messages: ack (enviada / entregue / lida no WhatsApp)',
    sql: "ALTER TABLE messages ADD COLUMN ack TINYINT UNSIGNED NULL COMMENT 'Estado no WhatsApp: 1 enviada, 2 entregue, 3 lida, 4 ouvida' AFTER sender_user_id",
  },
  {
    table: 'deals',
    column: 'pains',
    name: 'deals: dados de negociação, fecho (sistema, prazo) e mensalidade',
    sql: `
      ALTER TABLE deals
        ADD COLUMN pains TEXT NULL COMMENT 'Em Negociação: dores do cliente' AFTER meeting_at,
        ADD COLUMN proposal_offer TEXT NULL COMMENT 'Em Negociação: proposta real' AFTER pains,
        ADD COLUMN bait TEXT NULL COMMENT 'Em Negociação: isca do vendedor' AFTER proposal_offer,
        ADD COLUMN final_proposal TEXT NULL COMMENT 'Aguardando Resposta: proposta final apresentada' AFTER bait,
        ADD COLUMN won_scope TEXT NULL COMMENT 'Cliente Fechado: sistema a fazer' AFTER final_proposal,
        ADD COLUMN delivery_due DATE NULL COMMENT 'Cliente Fechado: prazo de entrega' AFTER won_scope,
        ADD COLUMN monthly_value DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT 'Mensalidade combinada (0 = sem mensalidade)' AFTER delivery_due,
        ADD COLUMN monthly_start DATE NULL COMMENT '1.º mês da mensalidade (dia 1)' AFTER monthly_value,
        ADD COLUMN monthly_end DATE NULL COMMENT 'Último mês da mensalidade (dia 1); NULL = em curso' AFTER monthly_start,
        ADD COLUMN closing_rate DECIMAL(5,2) NULL COMMENT '% de comissão do fecho (fixada ao fechar)' AFTER monthly_end
    `,
  },
  {
    table: 'leads',
    column: 'wa_status',
    name: 'leads: wa_status (o número tem WhatsApp?)',
    sql: `
      ALTER TABLE leads
        ADD COLUMN wa_status ENUM('yes', 'no') NULL COMMENT 'Tem WhatsApp? (checado no WhatsApp; NULL = ainda não)' AFTER hidden_by,
        ADD COLUMN wa_checked_at DATETIME NULL AFTER wa_status
    `,
  },
  {
    table: 'meetings',
    column: 'nex_insights',
    name: 'meetings: nex_insights (pontos da reunião anotados pelo Nex)',
    sql: `
      ALTER TABLE meetings
        ADD COLUMN nex_insights JSON NULL COMMENT 'Nex: dores, dúvidas, objeções, sinais e dica da reunião' AFTER remind_hour_sent_at,
        ADD COLUMN nex_updated_at DATETIME NULL AFTER nex_insights
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

TYPE_MIGRATIONS.push({
  table: 'clients',
  column: 'status',
  name: 'clients: estado "Em espera" (on_hold)',
  pending: (type) => !type.includes("'on_hold'"),
  steps: ["ALTER TABLE clients MODIFY status ENUM('lead', 'active', 'on_hold', 'archived') NOT NULL DEFAULT 'lead' COMMENT 'active = cliente (aba Clientes); on_hold = em espera'"],
});

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
  {
    // Contactos arquivados na Central antes de a Triagem acompanhar: o lead deles vai para
    // "Arquivados" também. (Restaurar na Triagem tira o contacto de Arquivado, por isso repetir
    // isto a cada arranque não desfaz nada.)
    name: 'lead_triage: arquivar os leads cujo contacto está arquivado na Central',
    sql: `UPDATE lead_triage t JOIN clients c ON c.lead_id = t.lead_id
          SET t.archived_at = NOW() WHERE c.status = 'archived' AND t.archived_at IS NULL`,
  },
  {
    // Mensagens enviadas pela Central antes de a Prospecção acompanhar: o lead fica "Contatado".
    // Só uma vez (marca na tabela de controlo): depois, quem desmarcar à mão não é desfeito.
    name: 'leads: "Contatado" na Prospecção para quem já recebeu mensagem pela Central',
    once: true,
    sql: `UPDATE leads l SET l.status_prospeccao = 'CONTATADO'
          WHERE l.status_prospeccao = 'NOVO' AND EXISTS (
            SELECT 1 FROM clients c JOIN messages m ON m.client_id = c.id
            WHERE c.lead_id = l.id AND m.sender_type IN ('agent', 'bot'))`,
  },
  {
    // Avisos de sistema do WhatsApp gravados como mensagens antes do filtro (whatsappInbox.SYSTEM_TYPES).
    name: 'messages: apagar avisos de sistema do WhatsApp ("[e2e_notification]" e afins)',
    sql: `DELETE FROM messages WHERE content IN ('[e2e_notification]', '[notification]', '[notification_template]', '[gp2]', '[protocol]',
          '[ciphertext]', '[broadcast_notification]', '[debug]', '[unknown]', '[pinned_message]')`,
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

  // `once`: correções de dados que só podem correr uma vez (repetidas, desfariam escolhas manuais).
  await db.raw(`CREATE TABLE IF NOT EXISTS schema_data_migrations (
    name   VARCHAR(190) NOT NULL PRIMARY KEY,
    ran_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci`);
  const ran = new Set(await db('schema_data_migrations').pluck('name'));
  for (const { name, sql, once } of POST_MIGRATIONS) {
    if (once && ran.has(name)) continue;
    const [result] = await db.raw(sql);
    if (once) await db('schema_data_migrations').insert({ name }).onConflict('name').ignore();
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
