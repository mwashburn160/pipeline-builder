-- ============================================================================
-- Complete Database Schema for pipeline_builder
-- ============================================================================

\connect pipeline_builder

-- Create update trigger function
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE 'plpgsql';

-- PLUGINS TABLE
CREATE TABLE IF NOT EXISTS plugins (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              VARCHAR(100) NOT NULL DEFAULT 'system',
    created_by          VARCHAR(100) NOT NULL DEFAULT 'system',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by          VARCHAR(100) NOT NULL DEFAULT 'system',
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    name                VARCHAR(150) NOT NULL,
    description         TEXT,
    keywords            JSONB NOT NULL DEFAULT '{}',
    version             VARCHAR(20) NOT NULL DEFAULT '1.0.0',
    metadata            JSONB NOT NULL DEFAULT '{}',
    plugin_type              VARCHAR(50) NOT NULL DEFAULT 'CodeBuildStep',
    compute_type             VARCHAR(20) NOT NULL DEFAULT 'SMALL',
    dockerfile               TEXT,
    primary_output_directory VARCHAR(28),
    env                 JSONB NOT NULL DEFAULT '{}',
    install_commands    VARCHAR(512)[] NOT NULL DEFAULT '{}',
    commands            VARCHAR(512)[] NOT NULL DEFAULT '{}',
    image_tag           VARCHAR(128) NOT NULL UNIQUE,
    access_modifier     VARCHAR(10) NOT NULL DEFAULT 'public'
                        CHECK (access_modifier IN ('public', 'private')),
    is_default          BOOLEAN NOT NULL DEFAULT false,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    deleted_at          TIMESTAMPTZ,
    deleted_by          VARCHAR(100)
);

-- PIPELINES TABLE
CREATE TABLE IF NOT EXISTS pipelines (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              VARCHAR(100) NOT NULL DEFAULT 'system',
    created_by          VARCHAR(100) NOT NULL DEFAULT 'system',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by          VARCHAR(100) NOT NULL DEFAULT 'system',
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    project             VARCHAR(100) NOT NULL,
    organization        VARCHAR(100) NOT NULL,
    description         TEXT,
    keywords            JSONB NOT NULL DEFAULT '[]',
    props               JSONB NOT NULL DEFAULT '{}',
    access_modifier     VARCHAR(10) NOT NULL DEFAULT 'public'
                        CHECK (access_modifier IN ('public', 'private')),
    is_default          BOOLEAN NOT NULL DEFAULT false,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    deleted_at          TIMESTAMPTZ,
    deleted_by          VARCHAR(100)
);

-- MESSAGES TABLE
CREATE TABLE IF NOT EXISTS messages (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              VARCHAR(255) NOT NULL DEFAULT 'system',
    created_by          TEXT NOT NULL DEFAULT 'system',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by          TEXT NOT NULL DEFAULT 'system',
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    thread_id           UUID,
    recipient_org_id    VARCHAR(255) NOT NULL,
    message_type        VARCHAR(20) NOT NULL DEFAULT 'conversation'
                        CHECK (message_type IN ('conversation', 'announcement')),
    subject             VARCHAR(500) NOT NULL,
    content             TEXT NOT NULL,
    is_read             BOOLEAN NOT NULL DEFAULT false,
    priority            VARCHAR(20) NOT NULL DEFAULT 'normal'
                        CHECK (priority IN ('normal', 'high', 'urgent')),
    access_modifier     VARCHAR(10) NOT NULL DEFAULT 'private'
                        CHECK (access_modifier IN ('public', 'private')),
    is_default          BOOLEAN NOT NULL DEFAULT false,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    deleted_at          TIMESTAMPTZ,
    deleted_by          TEXT
);

-- Add missing columns to existing tables (idempotent)
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS deleted_by VARCHAR(100);
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS dockerfile VARCHAR(100);
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS pipeline_name VARCHAR(150);
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS deleted_by VARCHAR(100);

-- Triggers
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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_plugins_org_id ON plugins(org_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_plugins_name ON plugins(name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_plugins_name_version ON plugins(name, version) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_plugins_access_modifier ON plugins(access_modifier) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_plugins_is_default ON plugins(name, is_default) WHERE is_default = true AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_plugins_is_active ON plugins(is_active) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_plugins_image_tag ON plugins(image_tag) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pipelines_org_id ON pipelines(org_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pipelines_project ON pipelines(project) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pipelines_organization ON pipelines(organization) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pipelines_project_org ON pipelines(project, organization) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pipelines_access_modifier ON pipelines(access_modifier) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pipelines_is_default ON pipelines(project, organization, is_default) WHERE is_default = true AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pipelines_is_active ON pipelines(is_active) WHERE deleted_at IS NULL;

-- Messages indexes
CREATE INDEX IF NOT EXISTS message_org_id_idx ON messages(org_id);
CREATE INDEX IF NOT EXISTS message_recipient_org_id_idx ON messages(recipient_org_id);
CREATE INDEX IF NOT EXISTS message_thread_id_idx ON messages(thread_id);
CREATE INDEX IF NOT EXISTS message_message_type_idx ON messages(message_type);
CREATE INDEX IF NOT EXISTS message_created_at_idx ON messages(created_at);
CREATE INDEX IF NOT EXISTS message_active_idx ON messages(is_active);
CREATE INDEX IF NOT EXISTS message_is_read_idx ON messages(is_read);
CREATE INDEX IF NOT EXISTS message_recipient_active_created_idx ON messages(recipient_org_id, is_active, created_at);
CREATE INDEX IF NOT EXISTS message_org_active_idx ON messages(org_id, is_active);
