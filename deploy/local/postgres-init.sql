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
    version             VARCHAR(20) NOT NULL DEFAULT '1.0.0',
    metadata            JSONB NOT NULL DEFAULT '{}',
    
    -- Build Configuration
    plugin_type              VARCHAR(50) NOT NULL DEFAULT 'CodeBuildStep',
    compute_type             VARCHAR(20) NOT NULL DEFAULT 'SMALL',
    dockerfile               TEXT,
    primary_output_directory VARCHAR(28),
    
    -- Runtime Configuration
    env                 JSONB NOT NULL DEFAULT '{}',
    install_commands    VARCHAR(512)[] NOT NULL DEFAULT '{}',
    commands            VARCHAR(512)[] NOT NULL DEFAULT '{}',
    
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
-- Add missing columns to existing tables (if tables already exist)
-- ============================================================================

-- Plugins table - add missing columns
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS deleted_by VARCHAR(100);
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS dockerfile VARCHAR(100);

-- Pipelines table - add missing columns
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS pipeline_name VARCHAR(150);
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS deleted_by VARCHAR(100);

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
    
CREATE INDEX IF NOT EXISTS idx_plugins_is_active 
    ON plugins(is_active) WHERE deleted_at IS NULL;
    
CREATE INDEX IF NOT EXISTS idx_plugins_image_tag 
    ON plugins(image_tag) WHERE deleted_at IS NULL;

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
\echo '=== INDEXES ==='
SELECT 
    schemaname,
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename IN ('plugins', 'pipelines')
ORDER BY tablename, indexname;

\echo ''
\echo '=== TRIGGERS ==='
SELECT 
    trigger_name,
    event_manipulation,
    event_object_table,
    action_statement
FROM information_schema.triggers
WHERE event_object_table IN ('plugins', 'pipelines')
ORDER BY event_object_table, trigger_name;

\echo ''
\echo '=== SCHEMA UPDATE COMPLETE ==='
