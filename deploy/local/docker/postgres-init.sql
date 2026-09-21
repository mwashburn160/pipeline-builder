-- ============================================================================
-- Complete Updated Database Schema for pipeline_builder
-- Includes ALL required columns for pipelines and plugins tables
-- ============================================================================
-- NOTE: Subscription tiers (developer | pro | team | enterprise), per-tier
-- quota limits (incl. the `seats` limit), and billing plans are NOT stored in
-- Postgres — they live in MongoDB (quota, billing, and platform services). Seat
-- enforcement is applied live at invite time against org membership. See
-- packages/api-core/src/types/quota-tiers.ts and mongodb-init.js. This file
-- carries only the pipeline_builder relational schema (pipelines, plugins, …).
-- ============================================================================

\connect pipeline_builder

-- ============================================================================
-- Application login role (what makes row-level security actually enforce)
-- ============================================================================
-- This script runs as the bootstrap superuser (POSTGRES_USER). That role OWNS
-- every object created below, and a superuser bypasses row-level security
-- unconditionally — even on tables with FORCE ROW LEVEL SECURITY. So services
-- must never connect as it. They connect as the role named by DB_USER, created
-- here as NOSUPERUSER NOBYPASSRLS, owning nothing and holding only DML grants
-- (see "Application role grants" at the end of this file). Because it is not
-- the owner, the RLS policies apply to it with or without FORCE. The superuser
-- is kept for this init script, backup/restore and manual DDL only.
--
-- The name and password come from the postgres container's environment
-- (DB_USER / DB_PASSWORD, the same values the services use), read with psql's
-- \getenv so no credential lives in this file. Init fails loudly if either is
-- missing, or if DB_USER names a superuser / BYPASSRLS role.
\getenv pb_app_user DB_USER
\getenv pb_app_password DB_PASSWORD
\if :{?pb_app_user}
\else
\set pb_app_user ''
\endif
\if :{?pb_app_password}
\else
\set pb_app_password ''
\endif
-- \gset swallows the result row so the password is never echoed to the init log.
SELECT set_config('pb.app_user', :'pb_app_user', false) AS pb_app_user_set,
       set_config('pb.app_password', :'pb_app_password', false) AS pb_app_password_set \gset
\unset pb_app_password
\unset pb_app_password_set

DO $$
DECLARE
    app_user     TEXT := current_setting('pb.app_user');
    app_password TEXT := current_setting('pb.app_password');
BEGIN
    IF app_user = '' OR app_password = '' THEN
        RAISE EXCEPTION 'postgres-init: DB_USER and DB_PASSWORD must be set in the postgres container environment (the application role cannot be created without them)';
    END IF;
    IF app_user = current_user
       OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_user AND (rolsuper OR rolbypassrls)) THEN
        RAISE EXCEPTION 'postgres-init: DB_USER (%) must be a dedicated non-superuser role, not the bootstrap superuser (%); superusers bypass row-level security', app_user, current_user;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_user) THEN
        EXECUTE format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', app_user, app_password);
    ELSE
        EXECUTE format('CREATE ROLE %I WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', app_user, app_password);
    END IF;
END $$;
SELECT set_config('pb.app_password', '', false) AS pb_app_password_cleared \gset

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

CREATE TABLE IF NOT EXISTS plugins (    -- Identity & Audit Fields
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id VARCHAR(255) NOT NULL DEFAULT '000000000000000000000001',
    created_by TEXT NOT NULL DEFAULT '000000000000000000000001',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT NOT NULL DEFAULT '000000000000000000000001',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Plugin Information
    name VARCHAR(255) NOT NULL,
    description TEXT,
    keywords JSONB NOT NULL DEFAULT '[]',
    category VARCHAR(50) NOT NULL DEFAULT 'unknown',
    version VARCHAR(50) NOT NULL DEFAULT '1.0.0',
    metadata JSONB NOT NULL DEFAULT '{}',

    -- Build Configuration
    plugin_type VARCHAR(50) NOT NULL DEFAULT 'CodeBuildStep',
    compute_type VARCHAR(50) NOT NULL DEFAULT 'SMALL',
    timeout INTEGER,
    failure_behavior VARCHAR(10) NOT NULL DEFAULT 'fail'
                             CHECK (failure_behavior IN ('fail', 'warn', 'ignore')),
    secrets JSONB NOT NULL DEFAULT '[]',
    dockerfile TEXT,
    build_type VARCHAR(20) NOT NULL DEFAULT 'build_image',
    primary_output_directory VARCHAR(28),

    -- Supply chain (set by the build worker after push + sign + SBOM attest; NULL
    -- for plugins with no image). Synth pins CodeBuild to image_digest, never the
    -- mutable name:version tag. image_source: 'built' (BuildKit provenance) vs
    -- 'uploaded' (a prebuilt image.tar the platform never saw built).
    image_digest VARCHAR(71) CONSTRAINT plugin_image_digest_check
                             CHECK (image_digest IS NULL OR image_digest ~ '^sha256:[0-9a-f]{64}$'),
    image_source VARCHAR(10) CONSTRAINT plugin_image_source_check
                             CHECK (image_source IS NULL OR image_source IN ('built', 'uploaded')),

    -- Runtime Configuration
    env JSONB NOT NULL DEFAULT '{}',
    build_args JSONB NOT NULL DEFAULT '{}',
    install_commands TEXT[] NOT NULL DEFAULT '{}',
    commands TEXT[] NOT NULL DEFAULT '{}',

    -- Developer-portal catalog metadata (ownership / lifecycle / classification)
    owner_id TEXT,
    owner_type VARCHAR(10) CHECK (owner_type IN ('user', 'team')),
    lifecycle VARCHAR(20) NOT NULL DEFAULT 'production'
                        CHECK (lifecycle IN ('experimental', 'production', 'deprecated')),
    criticality VARCHAR(10) CHECK (criticality IN ('low', 'medium', 'high', 'critical')),
    labels JSONB NOT NULL DEFAULT '{}',
    links JSONB NOT NULL DEFAULT '[]',

    -- Access Control & Status. The shared three-rung sharing ladder:
    --   private — only the author (created_by) sees or edits it
    --   org     — everyone in the owning org sees it
    --   public  — the org and its teams; from the system org, every org
    visibility VARCHAR(10) NOT NULL DEFAULT 'private'
                        CHECK (visibility IN ('private', 'org', 'public')),
    is_default BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,

    -- Soft Delete
    deleted_at TIMESTAMPTZ,
    deleted_by TEXT
);

-- ============================================================================
-- PIPELINES TABLE (Complete with all columns)
-- ============================================================================

CREATE TABLE IF NOT EXISTS pipelines (    -- Identity & Audit Fields
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id VARCHAR(255) NOT NULL DEFAULT '000000000000000000000001',
    created_by TEXT NOT NULL DEFAULT '000000000000000000000001',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT NOT NULL DEFAULT '000000000000000000000001',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Pipeline Information
    project VARCHAR(255) NOT NULL,
    organization VARCHAR(255) NOT NULL,
    pipeline_name VARCHAR(255),
    description TEXT,
    keywords JSONB NOT NULL DEFAULT '[]',
    props JSONB NOT NULL DEFAULT '{}',

    -- Developer-portal catalog metadata (ownership / lifecycle / classification)
    owner_id TEXT,
    owner_type VARCHAR(10) CHECK (owner_type IN ('user', 'team')),
    lifecycle VARCHAR(20) NOT NULL DEFAULT 'production'
                        CHECK (lifecycle IN ('experimental', 'production', 'deprecated')),
    criticality VARCHAR(10) CHECK (criticality IN ('low', 'medium', 'high', 'critical')),
    labels JSONB NOT NULL DEFAULT '{}',
    links JSONB NOT NULL DEFAULT '[]',

    -- Access Control & Status. The shared three-rung sharing ladder:
    --   private — only the author (created_by) sees or edits it
    --   org     — everyone in the owning org sees it
    --   public  — the org and its teams; from the system org, every org
    visibility VARCHAR(10) NOT NULL DEFAULT 'private'
                        CHECK (visibility IN ('private', 'org', 'public')),
    is_default BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,

    -- Soft Delete
    deleted_at TIMESTAMPTZ,
    deleted_by TEXT
);

-- ============================================================================
-- PIPELINE TEMPLATES TABLE (Golden-path parameterized starters)
-- ============================================================================

CREATE TABLE IF NOT EXISTS pipeline_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id VARCHAR(255) NOT NULL DEFAULT '000000000000000000000001',
    created_by TEXT NOT NULL DEFAULT '000000000000000000000001',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT NOT NULL DEFAULT '000000000000000000000001',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    name VARCHAR(255) NOT NULL,
    description TEXT,
    keywords JSONB NOT NULL DEFAULT '[]',
    category VARCHAR(50) NOT NULL DEFAULT 'general',

    -- Template body (BuilderProps with {{ vars.* }} placeholders) + input contract
    props JSONB NOT NULL DEFAULT '{}',
    inputs JSONB NOT NULL DEFAULT '[]',

    -- Developer-portal catalog metadata
    owner_id TEXT,
    owner_type VARCHAR(10) CHECK (owner_type IN ('user', 'team')),
    lifecycle VARCHAR(20) NOT NULL DEFAULT 'production'
                        CHECK (lifecycle IN ('experimental', 'production', 'deprecated')),
    criticality VARCHAR(10) CHECK (criticality IN ('low', 'medium', 'high', 'critical')),
    labels JSONB NOT NULL DEFAULT '{}',
    links JSONB NOT NULL DEFAULT '[]',

    -- Access Control & Status. The shared three-rung sharing ladder:
    --   private — only the author (created_by) sees or edits it
    --   org     — everyone in the owning org sees it
    --   public  — shared beyond the org (parent org's teams; the system org's
    --             public templates are the golden-path catalog every org sees)
    visibility VARCHAR(10) NOT NULL DEFAULT 'private'
                        CHECK (visibility IN ('private', 'org', 'public')),
    is_default BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,

    -- Soft Delete
    deleted_at TIMESTAMPTZ,
    deleted_by TEXT
);

CREATE INDEX IF NOT EXISTS pipeline_template_org_id_idx ON pipeline_templates(org_id);
CREATE INDEX IF NOT EXISTS pipeline_template_active_idx ON pipeline_templates(is_active);
CREATE INDEX IF NOT EXISTS pipeline_template_category_idx ON pipeline_templates(category);
CREATE INDEX IF NOT EXISTS pipeline_template_org_visibility_active_idx ON pipeline_templates(org_id, visibility, is_active);
-- Drives the "my private drafts" leg of the visibility predicate.
CREATE INDEX IF NOT EXISTS pipeline_template_created_by_idx ON pipeline_templates(org_id, created_by);
CREATE INDEX IF NOT EXISTS pipeline_template_owner_idx ON pipeline_templates(org_id, owner_id);
CREATE INDEX IF NOT EXISTS pipeline_template_lifecycle_idx ON pipeline_templates(org_id, lifecycle);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_template_name_org_unique ON pipeline_templates(name, org_id);

-- ============================================================================
-- MESSAGES TABLE (Internal messaging between organizations and system org)
-- ============================================================================

CREATE TABLE IF NOT EXISTS messages (    -- Identity & Audit Fields
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id VARCHAR(255) NOT NULL DEFAULT '000000000000000000000001',
    created_by TEXT NOT NULL DEFAULT '000000000000000000000001',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT NOT NULL DEFAULT '000000000000000000000001',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Threading
    thread_id UUID,

    -- Message Routing
    recipient_org_id VARCHAR(255) NOT NULL,

    -- Optional per-user targeting WITHIN the recipient org (NULL = whole org
    -- sees it). Enforced in buildMessageConditions against the viewer's userId.
    recipient_user_id VARCHAR(255),

    -- Message Content
    message_type VARCHAR(20) NOT NULL DEFAULT 'conversation'
                        CHECK (message_type IN ('conversation', 'announcement')),
    -- Logical channel/inbox bucket (e.g. 'support', 'help'). NULL for
    -- org-to-org conversations that don't belong to a channel.
    channel VARCHAR(50),
    subject VARCHAR(500) NOT NULL,
    content TEXT NOT NULL,
    -- Set when the author edits the content after sending (NULL = never edited).
    -- Distinct from updated_at (which also moves on read-receipt/system updates).
    edited_at TIMESTAMPTZ,

    -- Status
    -- read_by is the per-participant read-receipt map: orgId → ISO timestamp.
    -- Empty {} means nobody has read it yet.
    read_by JSONB NOT NULL DEFAULT '{}'::jsonb,
    priority VARCHAR(20) NOT NULL DEFAULT 'normal'
                        CHECK (priority IN ('normal', 'high', 'urgent')),

    -- Messages carry NO sharing rung: visibility is the bespoke sender /
    -- recipient / broadcast predicate (plus per-user recipient_user_id
    -- narrowing) in buildMessageConditions. The sharing column this replaced
    -- was written as a hardcoded 'private' and never read.
    is_default BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,

    -- Soft Delete
    deleted_at TIMESTAMPTZ,
    deleted_by TEXT
);

-- ============================================================================
-- PIPELINE REGISTRY TABLE (Maps deployed CodePipeline ARNs to org IDs)
-- ============================================================================

CREATE TABLE IF NOT EXISTS pipeline_registry (    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_id UUID NOT NULL,
    org_id VARCHAR(255) NOT NULL,
    pipeline_name VARCHAR(255) NOT NULL,
    region VARCHAR(30),
    project VARCHAR(255),
    organization VARCHAR(255),
    last_deployed TIMESTAMPTZ,
    stack_name VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- PIPELINE EVENTS TABLE (Execution and build events for reporting)
-- ============================================================================

CREATE TABLE IF NOT EXISTS pipeline_events (    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_id UUID,
    org_id VARCHAR(255) NOT NULL,
    event_source VARCHAR(50) NOT NULL
                        CHECK (event_source IN ('codepipeline', 'codebuild', 'plugin-build')),
    event_type VARCHAR(50) NOT NULL
                        CHECK (event_type IN ('PIPELINE', 'STAGE', 'ACTION', 'BUILD')),
    status VARCHAR(20) NOT NULL,
    execution_id VARCHAR(255),
    stage_name VARCHAR(255),
    action_name VARCHAR(255),
    error_message TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,
    -- DORA deploy-attribution (nullable; populated at ingest when present).
    -- `environment` marks a real deployment; commit_sha/ref capture the source.
    commit_sha VARCHAR(255),
    commit_ref VARCHAR(255),
    environment VARCHAR(255),
    -- DORA true-lead-time attribution: oldest unshipped commit time +
    -- shipped-commit count. Nullable; unresolvable sources leave them NULL.
    commit_timestamp TIMESTAMPTZ,
    commit_count INTEGER,
    detail JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- Developer-portal catalog indexes (plugins + pipelines)
-- ============================================================================
-- owner = "my services" view, lifecycle = catalog filter. The catalog columns
-- and their enum CHECKs are declared in the CREATE TABLE statements above.
CREATE INDEX IF NOT EXISTS plugin_owner_idx ON plugins(org_id, owner_id);
CREATE INDEX IF NOT EXISTS plugin_lifecycle_idx ON plugins(org_id, lifecycle);
CREATE INDEX IF NOT EXISTS pipeline_owner_idx ON pipelines(org_id, owner_id);
CREATE INDEX IF NOT EXISTS pipeline_lifecycle_idx ON pipelines(org_id, lifecycle);

-- ============================================================================
-- DASHBOARDS + DASHBOARD PANELS (user-editable observability dashboards)
-- ============================================================================
--
-- Mirror of the drizzle schema in
-- packages/pipeline-data/src/database/drizzle-schema.ts. The drizzle migration
-- is the runtime source of truth for the platform service; this block exists
-- so a fresh deploy that hasn't run the migration yet still has the tables
-- present (matches what we do for plugins, pipelines, compliance, etc.).

CREATE TABLE IF NOT EXISTS dashboards (    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id VARCHAR(255) NOT NULL DEFAULT '000000000000000000000001',
    created_by TEXT NOT NULL DEFAULT '000000000000000000000001',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT NOT NULL DEFAULT '000000000000000000000001',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    name VARCHAR(150) NOT NULL,
    description TEXT,

    -- react-grid-layout coordinate set keyed by panel id.
    layout_json JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Visibility ladder: private → just creator, org → same-org members,
    -- public → every authenticated user (used for the 5 default dashboards).
    visibility VARCHAR(10) NOT NULL DEFAULT 'private'
                    CHECK (visibility IN ('private', 'org', 'public')),

    deleted_at TIMESTAMPTZ,
    deleted_by TEXT
);

-- Listing is org-scoped and visibility-filtered, so both columns get indexed.
CREATE INDEX IF NOT EXISTS dashboard_org_visibility_idx
    ON dashboards(org_id, visibility) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS dashboard_created_by_idx
    ON dashboards(created_by) WHERE deleted_at IS NULL;

-- Same-org duplicate-name guard (soft-deleted rows excluded so reuse works).
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_org_name_unique
    ON dashboards(org_id, name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS dashboard_panels (    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    -- Catalog key, validated server-side against platform/src/observability/catalog.ts
    query_key VARCHAR(100) NOT NULL,
    -- 'stat' | 'line' | 'table' | 'stacked-bar' (renderer falls back to 'line' on unknown)
    viz_kind VARCHAR(30) NOT NULL DEFAULT 'line',
    title VARCHAR(200) NOT NULL,
    -- Tailwind col-span tier (1-12; only 3/4/6/8/9/12 are renderable)
    span INTEGER NOT NULL DEFAULT 6,
    group_by VARCHAR(50),
    format VARCHAR(20),
    -- 0-based render order within the dashboard
    position INTEGER NOT NULL DEFAULT 0
);

-- The render path is "fetch all panels for dashboard X in order".
CREATE INDEX IF NOT EXISTS dashboard_panel_dashboard_position_idx
    ON dashboard_panels(dashboard_id, position);

-- updated_at trigger (matches the pattern other tables use)
DROP TRIGGER IF EXISTS update_dashboards_modtime ON dashboards;
CREATE TRIGGER update_dashboards_modtime
    BEFORE UPDATE ON dashboards
    FOR EACH ROW
    EXECUTE PROCEDURE update_modified_column();

-- ============================================================================
-- per-org operator-authored alert rules.
-- ============================================================================
-- Materialized into a Prometheus rule_files YAML via the platform endpoint
-- GET /api/observability/alert-rules/materialized.yml. Tenancy gate: the
-- API rejects expressions that don't substring-contain org_id="<orgId>".
CREATE TABLE IF NOT EXISTS org_alert_rules (    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id VARCHAR(255) NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    name VARCHAR(100) NOT NULL,
    expr TEXT NOT NULL,
    for_duration VARCHAR(20) NOT NULL DEFAULT '5m',
    severity VARCHAR(20) NOT NULL DEFAULT 'warning'
                    CHECK (severity IN ('warning', 'critical')),
    summary TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',

    enabled BOOLEAN NOT NULL DEFAULT true,

    deleted_at TIMESTAMPTZ,
    deleted_by TEXT
);

CREATE INDEX IF NOT EXISTS org_alert_rule_org_enabled_idx
    ON org_alert_rules(org_id, enabled) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS org_alert_rule_org_name_uq
    ON org_alert_rules(org_id, name) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS update_org_alert_rules_modtime ON org_alert_rules;
CREATE TRIGGER update_org_alert_rules_modtime
    BEFORE UPDATE ON org_alert_rules
    FOR EACH ROW
    EXECUTE PROCEDURE update_modified_column();

-- ============================================================================
-- ORG ALERT DESTINATIONS (multi-tenant alerting routing table)
-- ============================================================================
--
-- Mirror of drizzle schema in
-- packages/pipeline-data/src/database/drizzle-schema.ts. Routes Alertmanager
-- webhooks tagged with `tenancy=org` to the destinations each org has
-- configured.

CREATE TABLE IF NOT EXISTS org_alert_destinations (    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id VARCHAR(255) NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Channel + target. Slack: webhook URL. Webhook: HTTPS URL. In-app: ignored.
    channel VARCHAR(20) NOT NULL
                    CHECK (channel IN ('slack', 'webhook', 'in-app', 'email')),
    target TEXT NOT NULL DEFAULT '',
    label VARCHAR(100) NOT NULL,

    min_severity VARCHAR(10) NOT NULL DEFAULT 'warning'
                    CHECK (min_severity IN ('warning', 'critical')),
    enabled BOOLEAN NOT NULL DEFAULT true,

    deleted_at TIMESTAMPTZ,
    deleted_by TEXT
);

CREATE INDEX IF NOT EXISTS org_alert_destination_org_idx
    ON org_alert_destinations(org_id, enabled) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS update_org_alert_destinations_modtime ON org_alert_destinations;
CREATE TRIGGER update_org_alert_destinations_modtime
    BEFORE UPDATE ON org_alert_destinations
    FOR EACH ROW
    EXECUTE PROCEDURE update_modified_column();

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

CREATE INDEX IF NOT EXISTS idx_plugins_visibility
    ON plugins(visibility) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_plugins_is_default
    ON plugins(name, is_default) WHERE is_default = true AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_plugins_category
    ON plugins(category);

CREATE INDEX IF NOT EXISTS idx_plugins_is_active
    ON plugins(is_active) WHERE deleted_at IS NULL;


-- Plugins composite indexes (matching Drizzle schema)
CREATE INDEX IF NOT EXISTS plugin_org_visibility_active_idx
    ON plugins(org_id, visibility, is_active);

-- Drives the "my private drafts" leg of the visibility predicate.
CREATE INDEX IF NOT EXISTS plugin_created_by_idx
    ON plugins(org_id, created_by);

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

CREATE INDEX IF NOT EXISTS idx_pipelines_visibility
    ON pipelines(visibility) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pipelines_is_default
    ON pipelines(project, organization, is_default)
    WHERE is_default = true AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pipelines_is_active
    ON pipelines(is_active) WHERE deleted_at IS NULL;

-- Pipelines composite indexes (matching Drizzle schema)
CREATE INDEX IF NOT EXISTS pipeline_org_visibility_active_idx
    ON pipelines(org_id, visibility, is_active);

-- Drives the "my private drafts" leg of the visibility predicate.
CREATE INDEX IF NOT EXISTS pipeline_created_by_idx
    ON pipelines(org_id, created_by);

CREATE INDEX IF NOT EXISTS idx_pipelines_org_created
    ON pipelines(org_id, created_at DESC) WHERE deleted_at IS NULL;

-- Pipelines unique constraint (required for ON CONFLICT upsert in pipeline create)
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_project_org_unique
    ON pipelines(project, organization, org_id);

-- Pipeline Registry indexes
-- pipeline_id is UNIQUE — the registry upsert uses ON CONFLICT (pipeline_id),
-- which requires a unique index to match against.
CREATE UNIQUE INDEX IF NOT EXISTS registry_pipeline_id_idx
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

CREATE INDEX IF NOT EXISTS event_execution_id_idx
    ON pipeline_events(execution_id);

CREATE INDEX IF NOT EXISTS event_created_at_idx
    ON pipeline_events(created_at);

CREATE INDEX IF NOT EXISTS event_org_type_created_idx
    ON pipeline_events(org_id, event_type, created_at);

CREATE INDEX IF NOT EXISTS event_org_source_status_idx
    ON pipeline_events(org_id, event_source, status);

-- DORA deploy-scoped reads (partial: only PIPELINE events tagged with an
-- environment). event_type is included because the events Lambda tags every
-- event of a deployed pipeline (STAGE/ACTION too), so it restores selectivity.
CREATE INDEX IF NOT EXISTS event_env_type_started_idx
    ON pipeline_events(environment, event_type, started_at)
    WHERE environment IS NOT NULL;

-- started_at range scans: every Category-1 report and the default run-based
-- DORA path filters event_type='PIPELINE' AND started_at BETWEEN ... joined on
-- pipeline_id, but event_org_type_created_idx is on created_at, not started_at.
-- This composite serves the join-driven scan by pipeline_id. Matches the drizzle
-- event_pipeline_type_started_idx.
CREATE INDEX IF NOT EXISTS event_pipeline_type_started_idx
    ON pipeline_events(pipeline_id, event_type, started_at);

-- DORA deploy-basis scan: deployment frequency / deploy-time CFR /
-- lead time group deploy-stage events by environment over a completed_at window.
CREATE INDEX IF NOT EXISTS event_org_env_completed_idx
    ON pipeline_events(org_id, environment, completed_at);

-- Idempotency dedup for at-least-once EventBridge/SQS re-deliveries (and BullMQ
-- plugin-build re-runs): the partial UNIQUE index used as the ON CONFLICT DO
-- NOTHING arbiter in reporting-service.ingestEvents and recordBuildEvent. Without
-- it, ON CONFLICT DO NOTHING has no constraint to match and silently inserts
-- duplicates. COALESCE the nullable parts because Postgres treats NULLs as
-- DISTINCT in a unique index — PIPELINE/STAGE/BUILD events leave stage_name/
-- action_name (and plugin-build, pipeline_id) NULL, so a plain unique index never
-- dedups them. Must match the drizzle `event_dedup_idx` expression index.
CREATE UNIQUE INDEX IF NOT EXISTS event_dedup_idx
    ON pipeline_events (
        coalesce(pipeline_id::text, ''),
        execution_id,
        event_type,
        status,
        coalesce(stage_name, ''),
        coalesce(action_name, '')
    )
    WHERE execution_id IS NOT NULL;

-- ============================================================================
-- DEPLOYMENT OUTCOMES (manual post-deploy failed/restored markers — DORA)
-- ============================================================================
-- Feeds the post-deploy Change Failure Rate component and real MTTR
-- (restored − deployed). Correlated to a deploy execution by execution_id.
CREATE TABLE IF NOT EXISTS deployment_outcomes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    execution_id VARCHAR(255) NOT NULL,
    org_id VARCHAR(255) NOT NULL,
    environment VARCHAR(255),
    outcome VARCHAR(20) NOT NULL CHECK (outcome IN ('failed', 'restored')),
    at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS deployment_outcomes_org_env_idx
    ON deployment_outcomes(org_id, environment);
CREATE INDEX IF NOT EXISTS deployment_outcomes_execution_idx
    ON deployment_outcomes(execution_id);
-- Idempotent re-marking: one row per (execution, outcome) — a duplicate POST is
-- an upsert (refreshes `at`), a failed→restored pair stays two rows.
CREATE UNIQUE INDEX IF NOT EXISTS deployment_outcomes_execution_outcome_unique
    ON deployment_outcomes(execution_id, outcome);

-- ============================================================================
-- INGEST HEALTH (per-org events-Lambda forwarded/dropped/last-seen — DORA)
-- ============================================================================
CREATE TABLE IF NOT EXISTS ingest_health (
    org_id VARCHAR(255) PRIMARY KEY,
    last_event_at TIMESTAMPTZ,
    forwarded BIGINT,
    dropped BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- INCIDENTS (production incidents webhooked from PagerDuty/Datadog/Alertmanager
-- — automated post-deploy CFR + real MTTR — DORA)
-- ============================================================================
-- Ingested via POST /api/reports/incidents (machine `reporting:ingest` scope).
-- DORA correlates each incident to the most recent successful deploy to its
-- `environment` with completed_at <= opened_at within DORA_INCIDENT_WINDOW_HOURS,
-- turning it into a post-deploy failure (CFR) and a real recovery time
-- (resolved_at - opened_at) for MTTR. incident_id is UNIQUE PER ORG so a later
-- resolve re-post is an idempotent upsert (updates resolved_at).
CREATE TABLE IF NOT EXISTS incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id VARCHAR(255) NOT NULL,
    org_id VARCHAR(255) NOT NULL,
    environment VARCHAR(255) NOT NULL,
    opened_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ,
    severity VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS incidents_org_env_opened_idx
    ON incidents(org_id, environment, opened_at);
-- Idempotent upsert / dedup: one row per (org, incident_id). A resolve re-post
-- updates resolved_at instead of inserting a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS incidents_org_incident_unique
    ON incidents(org_id, incident_id);

-- ============================================================================
-- DORA SETTINGS (per-org overrides for DORA computation)
-- ============================================================================
-- One row per org. `incident_window_hours` overrides the global
-- DORA_INCIDENT_WINDOW_HOURS used to correlate an ingested incident to the most
-- recent successful deploy (a NULL/absent row falls back to the env default).
-- Set self-serve by an org admin via PUT /api/reports/settings/incidents.
CREATE TABLE IF NOT EXISTS dora_settings (
    org_id VARCHAR(255) PRIMARY KEY,
    incident_window_hours INTEGER,
    -- Per-org retention overrides (days). NULL => use the global env
    -- default (REPORTING_EVENT_RETENTION_DAYS / REPORTING_DORA_RETENTION_DAYS).
    -- event_retention_days governs standard events (pipeline_events WHERE
    -- environment IS NULL); dora_retention_days governs the DORA source (deploy
    -- stages + deployment_outcomes + incidents). This table is never purged.
    event_retention_days INTEGER,
    dora_retention_days INTEGER,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Messages indexes
CREATE INDEX IF NOT EXISTS message_org_id_idx
    ON messages(org_id);

CREATE INDEX IF NOT EXISTS message_recipient_org_id_idx
    ON messages(recipient_org_id);

CREATE INDEX IF NOT EXISTS message_thread_id_idx
    ON messages(thread_id);

CREATE INDEX IF NOT EXISTS message_message_type_idx
    ON messages(message_type);

CREATE INDEX IF NOT EXISTS message_channel_idx
    ON messages(channel);

CREATE INDEX IF NOT EXISTS message_created_at_idx
    ON messages(created_at);

CREATE INDEX IF NOT EXISTS message_active_idx
    ON messages(is_active);

CREATE INDEX IF NOT EXISTS message_read_by_idx
    ON messages USING GIN (read_by);

CREATE INDEX IF NOT EXISTS message_recipient_active_created_idx
    ON messages(recipient_org_id, is_active, created_at);

-- Composite index for per-user targeted inbox lookups.
CREATE INDEX IF NOT EXISTS message_recipient_user_idx
    ON messages(recipient_org_id, recipient_user_id, is_active);
-- ============================================================================
-- Message Attachments — file/image blobs live in S3-compatible object storage
-- (MinIO); this table holds metadata + the storage key only. message_id is NULL
-- for a pending upload (uploaded but not yet attached to a sent message).
-- ============================================================================
CREATE TABLE IF NOT EXISTS message_attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id VARCHAR(255) NOT NULL,
    message_id UUID,
    uploaded_by TEXT NOT NULL,
    filename VARCHAR(255) NOT NULL,
    content_type VARCHAR(128) NOT NULL,
    size_bytes INTEGER NOT NULL,
    storage_key VARCHAR(512) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS message_attachment_message_id_idx
    ON message_attachments(message_id);
CREATE INDEX IF NOT EXISTS message_attachment_org_id_idx
    ON message_attachments(org_id);
CREATE INDEX IF NOT EXISTS message_org_active_idx
    ON messages(org_id, is_active);

-- ============================================================================
-- COMPLIANCE POLICIES TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS compliance_policies (    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id VARCHAR(255) NOT NULL DEFAULT '000000000000000000000001',
    created_by TEXT NOT NULL DEFAULT '000000000000000000000001',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT NOT NULL DEFAULT '000000000000000000000001',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    name VARCHAR(255) NOT NULL,
    description TEXT,
    version VARCHAR(50) NOT NULL DEFAULT '1.0.0',
    is_template BOOLEAN NOT NULL DEFAULT false,

    is_default BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    deleted_at TIMESTAMPTZ,
    deleted_by TEXT
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

CREATE TABLE IF NOT EXISTS compliance_rules (    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id VARCHAR(255) NOT NULL DEFAULT '000000000000000000000001',
    created_by TEXT NOT NULL DEFAULT '000000000000000000000001',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT NOT NULL DEFAULT '000000000000000000000001',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    name VARCHAR(255) NOT NULL,
    description TEXT,
    policy_id UUID REFERENCES compliance_policies(id) ON DELETE SET NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    target VARCHAR(20) NOT NULL,
    severity VARCHAR(10) NOT NULL DEFAULT 'error',

    tags JSONB NOT NULL DEFAULT '[]',

    effective_from TIMESTAMPTZ,
    effective_until TIMESTAMPTZ,

    scope VARCHAR(10) NOT NULL DEFAULT 'org',
    forked_from_rule_id UUID,
    suppress_notification BOOLEAN NOT NULL DEFAULT false,

    -- Org -> team hierarchy: enforce this parent rule on descendant team orgs.
    propagate_to_children BOOLEAN NOT NULL DEFAULT false,

    field VARCHAR(100),
    operator VARCHAR(20),
    value JSONB,

    conditions JSONB,
    condition_mode VARCHAR(5) DEFAULT 'all',

    is_default BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    deleted_at TIMESTAMPTZ,
    deleted_by TEXT
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

-- Partial GIN index backing the set-tag containment query (findPublishedRuleIdsBySetTag)
-- for the compliance content add-ons (set:standard / set:advanced). Curated published
-- catalog only, so the index stays small.
CREATE INDEX IF NOT EXISTS compliance_rule_published_tags_gin_idx
    ON compliance_rules USING gin (tags jsonb_path_ops) WHERE scope = 'published';

-- Per-org watermark for the billing->compliance entitlement sync (PUT /entitlements/:orgId).
-- Billing stamps each push with occurredAt; the route skips any push not strictly newer,
-- so out-of-order deliveries can't revert a newer entitlement state. Sync metadata only.
CREATE TABLE IF NOT EXISTS compliance_entitlement_watermark (
    org_id TEXT PRIMARY KEY,
    last_occurred_at TIMESTAMPTZ NOT NULL
);

-- ============================================================================
-- COMPLIANCE RULE HISTORY TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS compliance_rule_history (    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id UUID NOT NULL REFERENCES compliance_rules(id) ON DELETE CASCADE,
    org_id VARCHAR(255) NOT NULL,
    change_type VARCHAR(20) NOT NULL,
    previous_state JSONB,
    changed_by TEXT NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
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

CREATE TABLE IF NOT EXISTS compliance_audit_log (    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id VARCHAR(255) NOT NULL,
    user_id TEXT NOT NULL,
    target VARCHAR(20) NOT NULL,
    action VARCHAR(20) NOT NULL,
    entity_id VARCHAR(255),
    entity_name VARCHAR(255),
    result VARCHAR(10) NOT NULL,
    violations JSONB DEFAULT '[]',
    rule_count INTEGER NOT NULL,
    scan_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
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

CREATE TABLE IF NOT EXISTS compliance_exemptions (    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id VARCHAR(255) NOT NULL,
    rule_id UUID NOT NULL REFERENCES compliance_rules(id) ON DELETE CASCADE,
    entity_type VARCHAR(20) NOT NULL,
    entity_id UUID NOT NULL,
    entity_name VARCHAR(255),
    reason TEXT NOT NULL,
    approved_by TEXT,
    rejection_reason TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    expires_at TIMESTAMPTZ,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
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

CREATE TABLE IF NOT EXISTS compliance_rule_subscriptions (    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id VARCHAR(255) NOT NULL,
    rule_id UUID NOT NULL REFERENCES compliance_rules(id) ON DELETE CASCADE,
    subscribed_by TEXT NOT NULL,
    subscribed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN NOT NULL DEFAULT true,
    pinned_version JSONB,
    unsubscribed_at TIMESTAMPTZ,
    unsubscribed_by TEXT
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

CREATE TABLE IF NOT EXISTS compliance_scans (    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id VARCHAR(255) NOT NULL,
    target VARCHAR(20) NOT NULL,
    filter JSONB,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    triggered_by VARCHAR(20) NOT NULL,
    user_id TEXT NOT NULL,
    total_entities INTEGER NOT NULL DEFAULT 0,
    processed_entities INTEGER NOT NULL DEFAULT 0,
    pass_count INTEGER NOT NULL DEFAULT 0,
    warn_count INTEGER NOT NULL DEFAULT 0,
    block_count INTEGER NOT NULL DEFAULT 0,
    -- True when a scan stopped early at a per-scan cap, so the counts above
    -- are a subset rather than the full entity universe. Shown in the UI.
    truncated BOOLEAN NOT NULL DEFAULT FALSE,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    cancelled_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS compliance_scan_org_created_idx
    ON compliance_scans(org_id, created_at);
CREATE INDEX IF NOT EXISTS compliance_scan_org_status_idx
    ON compliance_scans(org_id, status);

-- ============================================================================
-- COMPLIANCE SCAN SCHEDULES TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS compliance_scan_schedules (    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id VARCHAR(255) NOT NULL,
    target VARCHAR(20) NOT NULL,
    cron_expression VARCHAR(100) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_run_at TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
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

-- ============================================================================
-- COMPLIANCE NOTIFICATION PREFERENCES (one row per org)
-- ============================================================================

CREATE TABLE IF NOT EXISTS compliance_notification_preferences (    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id VARCHAR(255) NOT NULL UNIQUE,
    notify_on_block BOOLEAN NOT NULL DEFAULT true,
    notify_on_warning BOOLEAN NOT NULL DEFAULT false,
    email_enabled BOOLEAN NOT NULL DEFAULT false,
    digest_mode VARCHAR(20) NOT NULL DEFAULT 'immediate', -- immediate | daily | weekly
    digest_schedule VARCHAR(100),
    last_digest_at TIMESTAMPTZ,
    target_users JSONB, -- null = all org admins
    webhook_url VARCHAR(500),
    webhook_secret VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER trigger_compliance_notification_preferences_updated
    BEFORE UPDATE ON compliance_notification_preferences
    FOR EACH ROW EXECUTE FUNCTION update_modified_column();

-- ============================================================================
-- COMPLIANCE NOTIFICATION LOG (delivery history + retry queue)
-- ============================================================================

CREATE TABLE IF NOT EXISTS compliance_notification_log (    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id VARCHAR(255) NOT NULL,
    channel VARCHAR(20) NOT NULL, -- in-app | webhook | digest
    status VARCHAR(20) NOT NULL, -- sent | failed | pending
    payload JSONB NOT NULL,
    webhook_response_code INTEGER,
    webhook_error TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMPTZ,
    related_audit_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS compliance_notification_org_created_idx
    ON compliance_notification_log (org_id, created_at);
CREATE INDEX IF NOT EXISTS compliance_notification_status_retry_idx
    ON compliance_notification_log (status, next_retry_at);
CREATE INDEX IF NOT EXISTS compliance_notification_related_audit_idx
    ON compliance_notification_log (related_audit_id);

-- ============================================================================
-- COMPLIANCE ROLES (per-org compliance RBAC: viewer/editor/admin)
-- ============================================================================

CREATE TABLE IF NOT EXISTS compliance_roles (    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id VARCHAR(255) NOT NULL,
    user_id TEXT NOT NULL,
    role VARCHAR(30) NOT NULL -- compliance-viewer | compliance-editor | compliance-admin
                CHECK (role IN ('compliance-viewer', 'compliance-editor', 'compliance-admin')),
    granted_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS compliance_role_org_user_unique
    ON compliance_roles (org_id, user_id);
CREATE INDEX IF NOT EXISTS compliance_role_org_role_idx
    ON compliance_roles (org_id, role);

CREATE TRIGGER trigger_compliance_roles_updated
    BEFORE UPDATE ON compliance_roles
    FOR EACH ROW EXECUTE FUNCTION update_modified_column();

-- ============================================================================
-- COMPLIANCE REPORTS (generated report snapshots)
-- ============================================================================

CREATE TABLE IF NOT EXISTS compliance_reports (    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id VARCHAR(255) NOT NULL,
    report_type VARCHAR(30) NOT NULL, -- summary | detailed | audit-trail | comparison
    target VARCHAR(20) NOT NULL, -- plugin | pipeline | all
    date_from TIMESTAMPTZ,
    date_to TIMESTAMPTZ,
    compare_from TIMESTAMPTZ,
    compare_to TIMESTAMPTZ,
    data JSONB NOT NULL,
    format VARCHAR(10) NOT NULL DEFAULT 'json', -- json | csv
    generated_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS compliance_report_org_created_idx
    ON compliance_reports (org_id, created_at);

-- ============================================================================
-- COMPLIANCE REPORT SCHEDULES (cron-driven recurring report generation)
-- ============================================================================

CREATE TABLE IF NOT EXISTS compliance_report_schedules (    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id VARCHAR(255) NOT NULL,
    report_type VARCHAR(30) NOT NULL, -- summary | detailed
    target VARCHAR(20) NOT NULL, -- plugin | pipeline | all
    format VARCHAR(10) NOT NULL DEFAULT 'json',
    cron_expression VARCHAR(100) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_run_at TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ,
    deliver_to JSONB NOT NULL DEFAULT '[]', -- array of userIds to notify
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS compliance_report_schedule_active_next_idx
    ON compliance_report_schedules (is_active, next_run_at);
CREATE INDEX IF NOT EXISTS compliance_report_schedule_org_idx
    ON compliance_report_schedules (org_id);

CREATE TRIGGER trigger_compliance_report_schedules_updated
    BEFORE UPDATE ON compliance_report_schedules
    FOR EACH ROW EXECUTE FUNCTION update_modified_column();

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

-- ============================================================================
-- Soft-delete retention: purge_after deadline + tombstone-only purge index
-- ============================================================================
-- Stamped alongside deleted_at when a row is soft-deleted; the per-service
-- retention sweep (createSoftDeletePurgeScheduler) hard-deletes tombstones once
-- purge_after has passed. Declared here (rather than inline in each CREATE
-- TABLE) so the whole soft-delete retention surface reads as one block. Each
-- partial index (WHERE deleted_at IS NOT NULL) covers only tombstones, so the
-- sweep's `deleted_at IS NOT NULL AND purge_after < now` scan never touches
-- live rows. Index names match the Drizzle schema (packages/pipeline-data).

ALTER TABLE plugins                ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ;
ALTER TABLE pipelines              ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ;
ALTER TABLE pipeline_templates     ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ;
ALTER TABLE dashboards             ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ;
ALTER TABLE org_alert_destinations ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ;
ALTER TABLE org_alert_rules        ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ;
ALTER TABLE compliance_policies    ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ;
ALTER TABLE compliance_rules       ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ;
ALTER TABLE messages               ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS plugin_purge_idx                ON plugins(purge_after)                WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS pipeline_purge_idx              ON pipelines(purge_after)              WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS pipeline_template_purge_idx     ON pipeline_templates(purge_after)     WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS dashboard_purge_idx             ON dashboards(purge_after)             WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS org_alert_destination_purge_idx ON org_alert_destinations(purge_after) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS org_alert_rule_purge_idx        ON org_alert_rules(purge_after)        WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS compliance_policy_purge_idx     ON compliance_policies(purge_after)    WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS compliance_rule_purge_idx       ON compliance_rules(purge_after)       WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_purge_idx               ON messages(purge_after)               WHERE deleted_at IS NOT NULL;

-- ============================================================================
-- ROW-LEVEL SECURITY (multi-tenancy defense-in-depth)
-- ============================================================================
--
-- RLS is enabled on every user-data table so that any future query that
-- forgets `WHERE org_id = $1` in application code fails closed instead of
-- leaking cross-tenant data. Today the app filters by org_id at the
-- application layer; this block is the second line of defense.
--
-- Enforcement model:
-- - All tables are owned by the bootstrap superuser that runs this script.
--   Services connect as the separate DB_USER application role (created at
--   the top of this file: NOSUPERUSER, NOBYPASSRLS, not an owner), so every
--   policy below applies to every service query.
-- - `FORCE ROW LEVEL SECURITY` (set on every table below) additionally
--   subjects the OWNER to the policies. It is defense-in-depth only: the
--   bootstrap role is a superuser, and superusers bypass RLS regardless.
-- - Policies use a session GUC `app.org_id` (set per-request by the
--   application layer) to scope visible rows. The `app.is_sysadmin` GUC
--   (set to 'true' for sysadmin requests) allows cross-org reads.
-- - Every query path must run inside a transaction that does
--   `SET LOCAL app.org_id = $1` (and `app.is_sysadmin = 'true'` for
--   sysadmin requests) — `withTenantTx` in packages/pipeline-data.
--
-- Helper functions for policy expressions

CREATE OR REPLACE FUNCTION current_org_id()
RETURNS VARCHAR AS $$
BEGIN
    -- `true` second arg = return NULL if the GUC is unset, rather than error.
    -- Means policies behave as "block" (NULL = won't match any org_id) when
    -- the request didn't set the context, which is the right fail-closed
    -- default once FORCE is on.
    RETURN current_setting('app.org_id', true);
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION current_is_sysadmin()
RETURNS BOOLEAN AS $$
BEGIN
    RETURN COALESCE(current_setting('app.is_sysadmin', true), 'false') = 'true';
END;
$$ LANGUAGE plpgsql STABLE;

-- Org-scoped policy applied to every user-data table that carries an
-- `org_id` column directly. Reads allowed when-- - caller is sysadmin (`app.is_sysadmin = 'true'`), OR
-- - row's `org_id` matches `app.org_id`, OR
-- - row's `org_id` is 'system' (the system-org content visibility rule
-- mirrored from the app-layer convention  keeps shared defaults
-- visible to every authenticated org).
-- Writes are gated on the same predicate via WITH CHECK.

DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN
        SELECT unnest(ARRAY[
            -- NOTE: `messages` + `message_attachments` are intentionally ABSENT
            -- here  they get a dedicated policy (with a RECIPIENT carve-out)
            -- below, because the generic sender-only scope would block a
            -- recipient org from reading a message addressed to it.
            'plugins', 'pipelines',
            'pipeline_registry', 'pipeline_events',
            'deployment_outcomes', 'ingest_health', 'incidents', 'dora_settings',
            'dashboards', 'org_alert_destinations', 'org_alert_rules',
            'compliance_policies', 'compliance_rules', 'compliance_rule_history',
            'compliance_audit_log', 'compliance_exemptions', 'compliance_rule_subscriptions',
            'compliance_scans', 'compliance_scan_schedules',
            'compliance_notification_preferences', 'compliance_notification_log',
            'compliance_roles', 'compliance_reports', 'compliance_report_schedules'
        ])
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        -- Drop + recreate so re-running this init script stays idempotent
        -- (CREATE POLICY would error on the second run).
        EXECUTE format('DROP POLICY IF EXISTS rls_org_scope ON %I', t);
        EXECUTE format(            'CREATE POLICY rls_org_scope ON %I '
            'USING (current_is_sysadmin() OR org_id = current_org_id() OR org_id = ''000000000000000000000001'') '
            'WITH CHECK (current_is_sysadmin() OR org_id = current_org_id())',
            t
        );
    END LOOP;
END $$;

-- Messaging tables carry BOTH a sender (`org_id`) and a recipient
-- (`recipient_org_id`), so the generic sender-only scope above would block a
-- recipient org from reading a message addressed TO it whenever the sender is
-- neither the reader nor the system org (i.e. org<->org, same-account
-- messaging). These dedicated policies add the RECIPIENT carve-out (and the
-- '*' broadcast-announcement carve-out). Per-user targeting
-- (`recipient_user_id`) is deliberately NOT enforced here  RLS is org-grained
-- (there is no per-user session GUC); the app-layer `buildMessageConditions`
-- narrows a recipient-visible row down to the specific target user. Writes stay
-- gated to the caller's own org (WITH CHECK), unchanged.
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_scope ON messages;
CREATE POLICY rls_org_scope ON messages
    USING (
        current_is_sysadmin()
        OR org_id = current_org_id()
        OR org_id = '000000000000000000000001'
        OR recipient_org_id = current_org_id()
        OR recipient_org_id = '*'
    )
    WITH CHECK (current_is_sysadmin() OR org_id = current_org_id());

-- `message_attachments` follows its parent message's visibility. The uploader
-- org (`org_id`) always sees its own rows  including still-PENDING uploads,
-- whose `message_id` is NULL, for which the EXISTS below is false. A recipient
-- sees an attachment IFF it can see the linked message (recipient org, or a '*'
-- broadcast). The subquery is itself filtered by `messages`' policy above, so it
-- can only confirm a message the caller is already permitted to read.
ALTER TABLE message_attachments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_scope ON message_attachments;
CREATE POLICY rls_org_scope ON message_attachments
    USING (
        current_is_sysadmin()
        OR org_id = current_org_id()
        OR org_id = '000000000000000000000001'
        OR EXISTS (
            SELECT 1 FROM messages m
            WHERE m.id = message_attachments.message_id
              AND (m.recipient_org_id = current_org_id() OR m.recipient_org_id = '*')
        )
    )
    WITH CHECK (current_is_sysadmin() OR org_id = current_org_id());

-- `dashboard_panels` doesn't have an `org_id` column  it inherits scoping
-- from its parent `dashboards` row. Policy joins through the FK.
ALTER TABLE dashboard_panels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_scope ON dashboard_panels;
CREATE POLICY rls_org_scope ON dashboard_panels
    USING (        current_is_sysadmin()
        OR EXISTS (            SELECT 1 FROM dashboards d
            WHERE d.id = dashboard_panels.dashboard_id
              AND (d.org_id = current_org_id() OR d.org_id = '000000000000000000000001')
        )
    )
    WITH CHECK (        current_is_sysadmin()
        OR EXISTS (            SELECT 1 FROM dashboards d
            WHERE d.id = dashboard_panels.dashboard_id
              AND d.org_id = current_org_id()
        )
    );

-- Low-write tables. These have a single tight write path (DashboardService +
-- dashboard-seeder running as sysadmin, plus org-alerting CRUD which already
-- routes through withTenantTx). Any code path that forgot to set tenant context
-- hard-fails here in CI / dev.
ALTER TABLE dashboards FORCE ROW LEVEL SECURITY;
ALTER TABLE dashboard_panels FORCE ROW LEVEL SECURITY;
ALTER TABLE org_alert_destinations FORCE ROW LEVEL SECURITY;
ALTER TABLE org_alert_rules FORCE ROW LEVEL SECURITY;

-- Mid-volume tables: messages + pipeline_registry + compliance_*. All
-- readers/writers route through service-layer withTenantTx (CrudService base +
-- message-service + pipeline-registry-service + compliance-rule-service +
-- scan-executor/scheduler). Background scanners and the scheduler establish
-- sysadmin scope before touching any of these.
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
ALTER TABLE message_attachments FORCE ROW LEVEL SECURITY;
ALTER TABLE pipeline_registry FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN
        SELECT unnest(ARRAY[
            'compliance_policies', 'compliance_rules', 'compliance_rule_history',
            'compliance_audit_log', 'compliance_exemptions', 'compliance_rule_subscriptions',
            'compliance_scans', 'compliance_scan_schedules',
            'compliance_notification_preferences', 'compliance_notification_log',
            'compliance_roles', 'compliance_reports', 'compliance_report_schedules'
        ])
    LOOP
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    END LOOP;
END $$;

-- Hot-path tables: they sit on the request critical path (every plugin/pipeline
-- read + every CodePipeline event ingest). Writers:
--   * `plugins` + `pipelines`: routed through CrudService (withTenantTx on every
--     method); the few non-CRUD specialty paths (plugin-service deployVersion +
--     pipeline-service createAsDefault) also wrap in withTenantTx. JWT-peek
--     middleware populates the per-request org context.
--   * `pipeline_events`:
--     1. EventBridge / Lambda → POST /reports/events → ingestEvents() runs
--        under runWithTenantContext({isSysAdmin:true}) because a batch can
--        span multiple orgs (resolved from pipeline_registry per event).
--     2. Plugin build worker → recordBuildEvent() runs inside the worker
--        handler's runWithTenantContext({orgId}) scope.
ALTER TABLE plugins FORCE ROW LEVEL SECURITY;
ALTER TABLE pipelines FORCE ROW LEVEL SECURITY;
ALTER TABLE pipeline_events FORCE ROW LEVEL SECURITY;
ALTER TABLE deployment_outcomes FORCE ROW LEVEL SECURITY;
ALTER TABLE ingest_health FORCE ROW LEVEL SECURITY;
ALTER TABLE incidents FORCE ROW LEVEL SECURITY;
ALTER TABLE dora_settings FORCE ROW LEVEL SECURITY;

-- Audit data lives in MongoDB (`audit_events`), not in Postgres.

\echo ''
\echo '=== RLS POLICIES INSTALLED ==='
\echo 'FORCE enabled on every user-data table (22/22):'
\echo ' - dashboards, dashboard_panels, org_alert_destinations, org_alert_rules'
\echo ' - messages, pipeline_registry, all compliance_* tables'
\echo ' - plugins, pipelines, pipeline_events (hot path)'

-- ============================================================================
-- Application role grants
-- ============================================================================
-- DML only: no CREATE on the schema, no TRUNCATE/REFERENCES/TRIGGER, no
-- ownership — so the role can neither bypass RLS nor alter the schema. Schema
-- changes ship in this file (run as the bootstrap superuser). The DEFAULT
-- PRIVILEGES cover objects the bootstrap role creates later (manual DDL), so a
-- new table is usable by the services without a hand-written GRANT.
DO $$
DECLARE
    app_user TEXT := current_setting('pb.app_user');
BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), app_user);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', app_user);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', app_user);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', app_user);
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', app_user);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', current_user, app_user);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', current_user, app_user);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I', current_user, app_user);
END $$;

\echo ''
\echo '=== APPLICATION ROLE ==='
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
FROM pg_roles
WHERE rolname = current_setting('pb.app_user');

\echo ''
\echo '=== SCHEMA UPDATE COMPLETE ==='
