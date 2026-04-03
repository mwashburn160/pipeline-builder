-- ============================================================================
-- Complete Updated Database Schema for pipeline_builder
-- Includes ALL required columns for pipelines and plugins tables
-- ============================================================================

\connect pipeline_builder

-- ============================================================================
-- Drop existing tables (OPTIONAL - only if you want to recreate from scratch)
-- ============================================================================
-- WARNING: This will delete all data!
-- Uncomment only if you want to start fresh

-- DROP TABLE IF EXISTS plugins CASCADE;
-- DROP TABLE IF EXISTS pipelines CASCADE;

-- ============================================================================
-- Create update trigger function
-- ============================================================================

CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE 'plpgsql';

-- ============================================================================
-- PLUGINS TABLE (Complete with all columns)
-- ============================================================================

CREATE TABLE IF NOT EXISTS plugins (
    -- Identity & Audit Fields
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              VARCHAR(100) NOT NULL DEFAULT 'system',
    created_by          VARCHAR(100) NOT NULL DEFAULT 'system',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by          VARCHAR(100) NOT NULL DEFAULT 'system',
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    -- Plugin Information
    name                VARCHAR(150) NOT NULL,
    description         TEXT,
    keywords            JSONB NOT NULL DEFAULT '{}',
    category            VARCHAR(50) NOT NULL DEFAULT 'unknown',
    version             VARCHAR(20) NOT NULL DEFAULT '1.0.0',
    metadata            JSONB NOT NULL DEFAULT '{}',
    
    -- Build Configuration
    plugin_type              VARCHAR(50) NOT NULL DEFAULT 'CodeBuildStep',
    compute_type             VARCHAR(20) NOT NULL DEFAULT 'SMALL',
    timeout                  INTEGER,
    failure_behavior         VARCHAR(10) NOT NULL DEFAULT 'fail'
                             CHECK (failure_behavior IN ('fail', 'warn', 'ignore')),
    secrets                  JSONB NOT NULL DEFAULT '[]',
    dockerfile               TEXT,
    build_type           VARCHAR(20) NOT NULL DEFAULT 'build_image',
    primary_output_directory VARCHAR(28),
    
    -- Runtime Configuration
    env                 JSONB NOT NULL DEFAULT '{}',
    build_args          JSONB NOT NULL DEFAULT '{}',
    install_commands    TEXT[] NOT NULL DEFAULT '{}',
    commands            TEXT[] NOT NULL DEFAULT '{}',
    
    -- Docker Image
    image_tag           VARCHAR(128) NOT NULL UNIQUE,
    
    -- Access Control & Status
    access_modifier     VARCHAR(10) NOT NULL DEFAULT 'public' 
                        CHECK (access_modifier IN ('public', 'private')),
    is_default          BOOLEAN NOT NULL DEFAULT false,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    
    -- Soft Delete
    deleted_at          TIMESTAMPTZ,
    deleted_by          VARCHAR(100)
);

-- ============================================================================
-- PIPELINES TABLE (Complete with all columns)
-- ============================================================================

CREATE TABLE IF NOT EXISTS pipelines (
    -- Identity & Audit Fields
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              VARCHAR(100) NOT NULL DEFAULT 'system',
    created_by          VARCHAR(100) NOT NULL DEFAULT 'system',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by          VARCHAR(100) NOT NULL DEFAULT 'system',
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    -- Pipeline Information
    project             VARCHAR(100) NOT NULL,
    organization        VARCHAR(100) NOT NULL,
    description         TEXT,
    keywords            JSONB NOT NULL DEFAULT '[]',
    props               JSONB NOT NULL DEFAULT '{}',
    
    -- Access Control & Status
    access_modifier     VARCHAR(10) NOT NULL DEFAULT 'public' 
                        CHECK (access_modifier IN ('public', 'private')),
    is_default          BOOLEAN NOT NULL DEFAULT false,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    
    -- Soft Delete
    deleted_at          TIMESTAMPTZ,
    deleted_by          VARCHAR(100)
);

-- ============================================================================
-- MESSAGES TABLE (Internal messaging between organizations and system org)
-- ============================================================================

CREATE TABLE IF NOT EXISTS messages (
    -- Identity & Audit Fields
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              VARCHAR(255) NOT NULL DEFAULT 'system',
    created_by          TEXT NOT NULL DEFAULT 'system',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by          TEXT NOT NULL DEFAULT 'system',
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Threading
    thread_id           UUID,

    -- Message Routing
    recipient_org_id    VARCHAR(255) NOT NULL,

    -- Message Content
    message_type        VARCHAR(20) NOT NULL DEFAULT 'conversation'
                        CHECK (message_type IN ('conversation', 'announcement')),
    subject             VARCHAR(500) NOT NULL,
    content             TEXT NOT NULL,

    -- Status
    is_read             BOOLEAN NOT NULL DEFAULT false,
    priority            VARCHAR(20) NOT NULL DEFAULT 'normal'
                        CHECK (priority IN ('normal', 'high', 'urgent')),

    -- Access Control & Status
    access_modifier     VARCHAR(10) NOT NULL DEFAULT 'private'
                        CHECK (access_modifier IN ('public', 'private')),
    is_default          BOOLEAN NOT NULL DEFAULT false,
    is_active           BOOLEAN NOT NULL DEFAULT true,

    -- Soft Delete
    deleted_at          TIMESTAMPTZ,
    deleted_by          TEXT
);

-- ============================================================================
-- PIPELINE REGISTRY TABLE (Maps deployed CodePipeline ARNs to org IDs)
-- ============================================================================

CREATE TABLE IF NOT EXISTS pipeline_registry (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_id         UUID NOT NULL,
    org_id              VARCHAR(255) NOT NULL,
    pipeline_arn        VARCHAR(512) NOT NULL UNIQUE,
    pipeline_name       VARCHAR(255) NOT NULL,
    account_id          VARCHAR(12),
    region              VARCHAR(30),
    project             VARCHAR(255),
    organization        VARCHAR(255),
    last_deployed       TIMESTAMPTZ,
    stack_name          VARCHAR(255),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- PIPELINE EVENTS TABLE (Execution and build events for reporting)
-- ============================================================================

CREATE TABLE IF NOT EXISTS pipeline_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_id         UUID,
    org_id              VARCHAR(255) NOT NULL,
    event_source        VARCHAR(50) NOT NULL
                        CHECK (event_source IN ('codepipeline', 'codebuild', 'plugin-build')),
    event_type          VARCHAR(50) NOT NULL
                        CHECK (event_type IN ('PIPELINE', 'STAGE', 'ACTION', 'BUILD')),
    status              VARCHAR(20) NOT NULL,
    pipeline_arn        VARCHAR(512),
    execution_id        VARCHAR(255),
    stage_name          VARCHAR(255),
    action_name         VARCHAR(255),
    error_message       TEXT,
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    duration_ms         INTEGER,
    detail              JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- Add missing columns to existing tables (if tables already exist)
-- ============================================================================

-- Plugins table - add missing columns
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS category VARCHAR(50) NOT NULL DEFAULT 'unknown';
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS deleted_by VARCHAR(100);
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS dockerfile TEXT;
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS build_type VARCHAR(20) NOT NULL DEFAULT 'build_image';

-- Pipelines table - add missing columns
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS pipeline_name VARCHAR(150);
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS deleted_by VARCHAR(100);

-- ============================================================================
-- ADMIN AUDIT LOG TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             TEXT NOT NULL,
    user_email          TEXT,
    org_id              VARCHAR(255),
    action              VARCHAR(50) NOT NULL,
    target_type         VARCHAR(50) NOT NULL,
    target_id           VARCHAR(255),
    target_name         VARCHAR(255),
    detail              JSONB DEFAULT '{}',
    ip_address          VARCHAR(45),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS admin_audit_user_idx ON admin_audit_log(user_id);
CREATE INDEX IF NOT EXISTS admin_audit_action_idx ON admin_audit_log(action);
CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON admin_audit_log(created_at);
CREATE INDEX IF NOT EXISTS admin_audit_org_created_idx ON admin_audit_log(org_id, created_at);

-- ============================================================================
-- Triggers for automatic updated_at timestamp
-- ============================================================================

DROP TRIGGER IF EXISTS update_plugins_modtime ON plugins;
CREATE TRIGGER update_plugins_modtime 
    BEFORE UPDATE ON plugins 
    FOR EACH ROW 
    EXECUTE PROCEDURE update_modified_column();

DROP TRIGGER IF EXISTS update_pipelines_modtime ON pipelines;
CREATE TRIGGER update_pipelines_modtime
    BEFORE UPDATE ON pipelines
    FOR EACH ROW
    EXECUTE PROCEDURE update_modified_column();

DROP TRIGGER IF EXISTS update_messages_modtime ON messages;
CREATE TRIGGER update_messages_modtime
    BEFORE UPDATE ON messages
    FOR EACH ROW
    EXECUTE PROCEDURE update_modified_column();

DROP TRIGGER IF EXISTS update_pipeline_registry_modtime ON pipeline_registry;
CREATE TRIGGER update_pipeline_registry_modtime
    BEFORE UPDATE ON pipeline_registry
    FOR EACH ROW
    EXECUTE PROCEDURE update_modified_column();

-- ============================================================================
-- Indexes for Performance
-- ============================================================================

-- Plugins indexes
CREATE INDEX IF NOT EXISTS idx_plugins_org_id
    ON plugins(org_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_plugins_name
    ON plugins(name) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_plugins_name_version
    ON plugins(name, version) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_plugins_access_modifier
    ON plugins(access_modifier) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_plugins_is_default
    ON plugins(name, is_default) WHERE is_default = true AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_plugins_category
    ON plugins(category);

CREATE INDEX IF NOT EXISTS idx_plugins_is_active
    ON plugins(is_active) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_plugins_image_tag
    ON plugins(image_tag) WHERE deleted_at IS NULL;

-- Plugins composite indexes (matching Drizzle schema)
CREATE INDEX IF NOT EXISTS plugin_org_access_idx
    ON plugins(org_id, access_modifier);

CREATE INDEX IF NOT EXISTS idx_plugins_org_created
    ON plugins(org_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_plugins_org_name
    ON plugins(org_id, name) WHERE deleted_at IS NULL;

-- Plugins unique constraint (required for ON CONFLICT upsert in plugin upload)
CREATE UNIQUE INDEX IF NOT EXISTS plugin_name_version_org_unique
    ON plugins(name, version, org_id);

-- Plugins version format check
DO $$ BEGIN
    ALTER TABLE plugins ADD CONSTRAINT plugin_version_check
        CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Pipelines indexes
CREATE INDEX IF NOT EXISTS idx_pipelines_org_id
    ON pipelines(org_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pipelines_project
    ON pipelines(project) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pipelines_organization
    ON pipelines(organization) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pipelines_project_org
    ON pipelines(project, organization) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pipelines_access_modifier
    ON pipelines(access_modifier) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pipelines_is_default
    ON pipelines(project, organization, is_default)
    WHERE is_default = true AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pipelines_is_active
    ON pipelines(is_active) WHERE deleted_at IS NULL;

-- Pipelines composite indexes (matching Drizzle schema)
CREATE INDEX IF NOT EXISTS pipeline_org_access_idx
    ON pipelines(org_id, access_modifier);

CREATE INDEX IF NOT EXISTS idx_pipelines_org_created
    ON pipelines(org_id, created_at DESC) WHERE deleted_at IS NULL;

-- Pipelines unique constraint (required for ON CONFLICT upsert in pipeline create)
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_project_org_unique
    ON pipelines(project, organization, org_id);

-- Pipeline Registry indexes
CREATE INDEX IF NOT EXISTS registry_pipeline_id_idx
    ON pipeline_registry(pipeline_id);

CREATE INDEX IF NOT EXISTS registry_org_id_idx
    ON pipeline_registry(org_id);

CREATE INDEX IF NOT EXISTS registry_org_region_idx
    ON pipeline_registry(org_id, region);

-- Pipeline Events indexes
CREATE INDEX IF NOT EXISTS event_pipeline_id_idx
    ON pipeline_events(pipeline_id);

CREATE INDEX IF NOT EXISTS event_org_id_idx
    ON pipeline_events(org_id);

CREATE INDEX IF NOT EXISTS event_type_idx
    ON pipeline_events(event_type);

CREATE INDEX IF NOT EXISTS event_status_idx
    ON pipeline_events(status);

CREATE INDEX IF NOT EXISTS event_pipeline_arn_idx
    ON pipeline_events(pipeline_arn);

CREATE INDEX IF NOT EXISTS event_execution_id_idx
    ON pipeline_events(execution_id);

CREATE INDEX IF NOT EXISTS event_created_at_idx
    ON pipeline_events(created_at);

CREATE INDEX IF NOT EXISTS event_org_type_created_idx
    ON pipeline_events(org_id, event_type, created_at);

CREATE INDEX IF NOT EXISTS event_org_source_status_idx
    ON pipeline_events(org_id, event_source, status);

-- Messages indexes
CREATE INDEX IF NOT EXISTS message_org_id_idx
    ON messages(org_id);

CREATE INDEX IF NOT EXISTS message_recipient_org_id_idx
    ON messages(recipient_org_id);

CREATE INDEX IF NOT EXISTS message_thread_id_idx
    ON messages(thread_id);

CREATE INDEX IF NOT EXISTS message_message_type_idx
    ON messages(message_type);

CREATE INDEX IF NOT EXISTS message_created_at_idx
    ON messages(created_at);

CREATE INDEX IF NOT EXISTS message_active_idx
    ON messages(is_active);

CREATE INDEX IF NOT EXISTS message_is_read_idx
    ON messages(is_read);

CREATE INDEX IF NOT EXISTS message_recipient_active_created_idx
    ON messages(recipient_org_id, is_active, created_at);

CREATE INDEX IF NOT EXISTS message_org_active_idx
    ON messages(org_id, is_active);

-- ============================================================================
-- COMPLIANCE POLICIES TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS compliance_policies (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              VARCHAR(255) NOT NULL DEFAULT 'system',
    created_by          TEXT NOT NULL DEFAULT 'system',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by          TEXT NOT NULL DEFAULT 'system',
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    name                VARCHAR(255) NOT NULL,
    description         TEXT,
    version             VARCHAR(50) NOT NULL DEFAULT '1.0.0',
    is_template         BOOLEAN NOT NULL DEFAULT false,

    access_modifier     VARCHAR(10) NOT NULL DEFAULT 'private',
    is_default          BOOLEAN NOT NULL DEFAULT false,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    deleted_at          TIMESTAMPTZ,
    deleted_by          TEXT
);

CREATE INDEX IF NOT EXISTS compliance_policy_org_active_idx
    ON compliance_policies(org_id, is_active);
CREATE INDEX IF NOT EXISTS compliance_policy_template_idx
    ON compliance_policies(is_template);
CREATE UNIQUE INDEX IF NOT EXISTS compliance_policy_name_org_version_unique
    ON compliance_policies(org_id, name, version);

-- ============================================================================
-- COMPLIANCE RULES TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS compliance_rules (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                  VARCHAR(255) NOT NULL DEFAULT 'system',
    created_by              TEXT NOT NULL DEFAULT 'system',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by              TEXT NOT NULL DEFAULT 'system',
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    name                    VARCHAR(255) NOT NULL,
    description             TEXT,
    policy_id               UUID REFERENCES compliance_policies(id) ON DELETE SET NULL,
    priority                INTEGER NOT NULL DEFAULT 0,
    target                  VARCHAR(20) NOT NULL,
    severity                VARCHAR(10) NOT NULL DEFAULT 'error',

    tags                    JSONB NOT NULL DEFAULT '[]',

    effective_from          TIMESTAMPTZ,
    effective_until         TIMESTAMPTZ,

    scope                   VARCHAR(10) NOT NULL DEFAULT 'org',
    forked_from_rule_id     UUID,
    suppress_notification   BOOLEAN NOT NULL DEFAULT false,

    field                   VARCHAR(100),
    operator                VARCHAR(20),
    value                   JSONB,

    conditions              JSONB,
    condition_mode          VARCHAR(5) DEFAULT 'all',

    access_modifier         VARCHAR(10) NOT NULL DEFAULT 'private',
    is_default              BOOLEAN NOT NULL DEFAULT false,
    is_active               BOOLEAN NOT NULL DEFAULT true,
    deleted_at              TIMESTAMPTZ,
    deleted_by              TEXT
);

CREATE INDEX IF NOT EXISTS compliance_rule_org_target_active_idx
    ON compliance_rules(org_id, target, is_active);
CREATE INDEX IF NOT EXISTS compliance_rule_org_policy_idx
    ON compliance_rules(org_id, policy_id);
CREATE INDEX IF NOT EXISTS compliance_rule_priority_idx
    ON compliance_rules(priority);
CREATE INDEX IF NOT EXISTS compliance_rule_scope_idx
    ON compliance_rules(scope);
CREATE INDEX IF NOT EXISTS compliance_rule_effective_from_idx
    ON compliance_rules(effective_from);
CREATE UNIQUE INDEX IF NOT EXISTS compliance_rule_name_org_unique
    ON compliance_rules(org_id, name);

-- ============================================================================
-- COMPLIANCE RULE HISTORY TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS compliance_rule_history (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id             UUID NOT NULL REFERENCES compliance_rules(id) ON DELETE CASCADE,
    org_id              VARCHAR(255) NOT NULL,
    change_type         VARCHAR(20) NOT NULL,
    previous_state      JSONB,
    changed_by          TEXT NOT NULL,
    changed_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS compliance_rule_history_rule_changed_idx
    ON compliance_rule_history(rule_id, changed_at);
CREATE INDEX IF NOT EXISTS compliance_rule_history_org_changed_idx
    ON compliance_rule_history(org_id, changed_at);
CREATE INDEX IF NOT EXISTS compliance_rule_history_rule_id_idx
    ON compliance_rule_history(rule_id);

-- ============================================================================
-- COMPLIANCE AUDIT LOG TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS compliance_audit_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              VARCHAR(255) NOT NULL,
    user_id             TEXT NOT NULL,
    target              VARCHAR(20) NOT NULL,
    action              VARCHAR(20) NOT NULL,
    entity_id           VARCHAR(255),
    entity_name         VARCHAR(255),
    result              VARCHAR(10) NOT NULL,
    violations          JSONB DEFAULT '[]',
    rule_count          INTEGER NOT NULL,
    scan_id             UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS compliance_audit_org_created_idx
    ON compliance_audit_log(org_id, created_at);
CREATE INDEX IF NOT EXISTS compliance_audit_org_target_result_idx
    ON compliance_audit_log(org_id, target, result);
CREATE INDEX IF NOT EXISTS compliance_audit_scan_id_idx
    ON compliance_audit_log(scan_id);

-- ============================================================================
-- COMPLIANCE EXEMPTIONS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS compliance_exemptions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              VARCHAR(255) NOT NULL,
    rule_id             UUID NOT NULL REFERENCES compliance_rules(id) ON DELETE CASCADE,
    entity_type         VARCHAR(20) NOT NULL,
    entity_id           UUID NOT NULL,
    entity_name         VARCHAR(255),
    reason              TEXT NOT NULL,
    approved_by         TEXT,
    rejection_reason    TEXT,
    status              VARCHAR(20) NOT NULL DEFAULT 'pending',
    expires_at          TIMESTAMPTZ,
    created_by          TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by          TEXT NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS compliance_exemption_org_rule_entity_unique
    ON compliance_exemptions(org_id, rule_id, entity_id);
CREATE INDEX IF NOT EXISTS compliance_exemption_org_status_idx
    ON compliance_exemptions(org_id, status);
CREATE INDEX IF NOT EXISTS compliance_exemption_expires_at_idx
    ON compliance_exemptions(expires_at);
CREATE INDEX IF NOT EXISTS compliance_exemption_entity_id_idx
    ON compliance_exemptions(entity_id);

-- ============================================================================
-- COMPLIANCE RULE SUBSCRIPTIONS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS compliance_rule_subscriptions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              VARCHAR(255) NOT NULL,
    rule_id             UUID NOT NULL REFERENCES compliance_rules(id) ON DELETE CASCADE,
    subscribed_by       TEXT NOT NULL,
    subscribed_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    pinned_version      JSONB,
    unsubscribed_at     TIMESTAMPTZ,
    unsubscribed_by     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS compliance_rule_sub_org_rule_unique
    ON compliance_rule_subscriptions(org_id, rule_id);
CREATE INDEX IF NOT EXISTS compliance_rule_sub_org_active_idx
    ON compliance_rule_subscriptions(org_id, is_active);
CREATE INDEX IF NOT EXISTS compliance_rule_sub_rule_idx
    ON compliance_rule_subscriptions(rule_id);

-- ============================================================================
-- COMPLIANCE SCANS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS compliance_scans (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                  VARCHAR(255) NOT NULL,
    target                  VARCHAR(20) NOT NULL,
    filter                  JSONB,
    status                  VARCHAR(20) NOT NULL DEFAULT 'pending',
    triggered_by            VARCHAR(20) NOT NULL,
    user_id                 TEXT NOT NULL,
    total_entities          INTEGER NOT NULL DEFAULT 0,
    processed_entities      INTEGER NOT NULL DEFAULT 0,
    pass_count              INTEGER NOT NULL DEFAULT 0,
    warn_count              INTEGER NOT NULL DEFAULT 0,
    block_count             INTEGER NOT NULL DEFAULT 0,
    started_at              TIMESTAMPTZ,
    completed_at            TIMESTAMPTZ,
    cancelled_at            TIMESTAMPTZ,
    cancelled_by            TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS compliance_scan_org_created_idx
    ON compliance_scans(org_id, created_at);
CREATE INDEX IF NOT EXISTS compliance_scan_org_status_idx
    ON compliance_scans(org_id, status);

-- ============================================================================
-- COMPLIANCE SCAN SCHEDULES TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS compliance_scan_schedules (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              VARCHAR(255) NOT NULL,
    target              VARCHAR(20) NOT NULL,
    cron_expression     VARCHAR(100) NOT NULL,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    last_run_at         TIMESTAMPTZ,
    next_run_at         TIMESTAMPTZ,
    created_by          TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by          TEXT NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS compliance_scan_schedule_active_next_idx
    ON compliance_scan_schedules(is_active, next_run_at);
CREATE INDEX IF NOT EXISTS compliance_scan_schedule_org_idx
    ON compliance_scan_schedules(org_id);

-- Compliance triggers
DROP TRIGGER IF EXISTS update_compliance_policies_modtime ON compliance_policies;
CREATE TRIGGER update_compliance_policies_modtime
    BEFORE UPDATE ON compliance_policies
    FOR EACH ROW
    EXECUTE PROCEDURE update_modified_column();

DROP TRIGGER IF EXISTS update_compliance_rules_modtime ON compliance_rules;
CREATE TRIGGER update_compliance_rules_modtime
    BEFORE UPDATE ON compliance_rules
    FOR EACH ROW
    EXECUTE PROCEDURE update_modified_column();

DROP TRIGGER IF EXISTS update_compliance_exemptions_modtime ON compliance_exemptions;
CREATE TRIGGER update_compliance_exemptions_modtime
    BEFORE UPDATE ON compliance_exemptions
    FOR EACH ROW
    EXECUTE PROCEDURE update_modified_column();

DROP TRIGGER IF EXISTS update_compliance_scan_schedules_modtime ON compliance_scan_schedules;
CREATE TRIGGER update_compliance_scan_schedules_modtime
    BEFORE UPDATE ON compliance_scan_schedules
    FOR EACH ROW
    EXECUTE PROCEDURE update_modified_column();

-- ============================================================================
-- Verify Schema
-- ============================================================================

\echo ''
\echo '=== PLUGINS TABLE STRUCTURE ==='
SELECT 
    column_name,
    data_type,
    character_maximum_length,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_name = 'plugins'
ORDER BY ordinal_position;

\echo ''
\echo '=== PIPELINES TABLE STRUCTURE ==='
SELECT 
    column_name,
    data_type,
    character_maximum_length,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_name = 'pipelines'
ORDER BY ordinal_position;

\echo ''
\echo '=== MESSAGES TABLE STRUCTURE ==='
SELECT
    column_name,
    data_type,
    character_maximum_length,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_name = 'messages'
ORDER BY ordinal_position;

\echo ''
\echo '=== INDEXES ==='
SELECT 
    schemaname,
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename IN ('plugins', 'pipelines', 'messages', 'pipeline_registry', 'pipeline_events',
    'compliance_policies', 'compliance_rules', 'compliance_scans', 'compliance_exemptions')
ORDER BY tablename, indexname;

\echo ''
\echo '=== PIPELINE REGISTRY TABLE STRUCTURE ==='
SELECT
    column_name,
    data_type,
    character_maximum_length,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_name = 'pipeline_registry'
ORDER BY ordinal_position;

\echo ''
\echo '=== PIPELINE EVENTS TABLE STRUCTURE ==='
SELECT
    column_name,
    data_type,
    character_maximum_length,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_name = 'pipeline_events'
ORDER BY ordinal_position;

\echo ''
\echo '=== TRIGGERS ==='
SELECT
    trigger_name,
    event_manipulation,
    event_object_table,
    action_statement
FROM information_schema.triggers
WHERE event_object_table IN ('plugins', 'pipelines', 'messages', 'pipeline_registry')
ORDER BY event_object_table, trigger_name;

\echo ''
\echo '=== SCHEMA UPDATE COMPLETE ==='
