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

    -- Spec contract (persisted from the validated spec, not just checked):
    -- required_* list the {{ pipeline.metadata.X }} / {{ pipeline.vars.X }} keys
    -- a pipeline must supply; *_types declare their coercion type. smoke_test is
    -- the spec's smoke-test declaration. network_egress is the declared outbound
    -- hostname list (spec `network.egress`), shown to consumers and diffed in review.
    required_metadata JSONB NOT NULL DEFAULT '[]',
    required_vars JSONB NOT NULL DEFAULT '[]',
    metadata_types JSONB NOT NULL DEFAULT '{}',
    vars_types JSONB NOT NULL DEFAULT '{}',
    smoke_test JSONB,
    network_egress JSONB NOT NULL DEFAULT '[]',

    -- Documentation (README stored as the source markdown AND pre-sanitized
    -- HTML, rendered once at upload so no read path renders untrusted markdown).
    readme_md TEXT,
    readme_html TEXT,
    license VARCHAR(64),                -- SPDX identifier
    changelog TEXT,
    homepage_url VARCHAR(2048),
    source_url VARCHAR(2048),
    -- icon: curated key {key, badge?}; uploaded_icon: storage keys of the
    -- re-encoded WebP renditions (never the raw upload, never SVG).
    icon JSONB,
    uploaded_icon JSONB,

    -- Catalog metadata (detected from the package, then accepted or edited):
    -- summary is the card one-liner; display_name falls back to name when NULL.
    -- metadata_sources records per descriptive field where its value came from
    -- ('spec' | 'readme' | 'dockerfile' | 'derived' | 'user').
    summary VARCHAR(160),
    display_name VARCHAR(100),
    documentation_url VARCHAR(2048),
    metadata_sources JSONB NOT NULL DEFAULT '{}',

    -- Vulnerability scan (grype over the SBOM at build; nightly rescan) and
    -- the image's effective USER. NULL = not scanned / not an image plugin.
    vuln_critical INTEGER,
    vuln_high INTEGER,
    vuln_medium INTEGER,
    vuln_low INTEGER,
    scanned_at TIMESTAMPTZ,
    run_as_root BOOLEAN,

    -- Version lifecycle. breaking: publisher-marked major that `latest`
    -- installs never cross without re-approval. frozen_at: set the moment a
    -- publish request references this version; re-upload is then refused (409).
    -- yanked_at / deprecated_at are the authoritative lifecycle timestamps
    -- (lifecycle 'yanked' / 'deprecated' mirror them for catalog filtering).
    breaking BOOLEAN NOT NULL DEFAULT false,
    frozen_at TIMESTAMPTZ,
    yanked_at TIMESTAMPTZ,
    yank_reason TEXT,
    deprecated_at TIMESTAMPTZ,
    deprecation_message TEXT,

    -- Developer-portal catalog metadata (ownership / lifecycle / classification)
    owner_id TEXT,
    owner_type VARCHAR(10) CHECK (owner_type IN ('user', 'team')),
    -- Plugins additionally carry 'yanked' (pipelines/templates do not).
    lifecycle VARCHAR(20) NOT NULL DEFAULT 'production'
                        CHECK (lifecycle IN ('experimental', 'production', 'deprecated', 'yanked')),
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
    deleted_by TEXT,

    -- Quota period (resetAt) this version's `plugins` slot was charged to at
    -- upload; NULL when none was charged or it was already refunded. Delete and
    -- purge refund conditionally on it, then clear it.
    quota_reset_at TIMESTAMPTZ
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
    -- Per-plugin runtime telemetry: the plugin an ACTION/BUILD event ran,
    -- joined at ingest from pipeline_step_manifests on (pipeline_id,
    -- stage_name, action_name). NULL for non-plugin actions / unrecorded synths.
    plugin_publisher VARCHAR(39),
    -- The publisher's id (handles change; the listing stats join on this).
    plugin_publisher_id UUID,
    plugin_name VARCHAR(255),
    plugin_version VARCHAR(50),
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

-- Per-plugin runtime reporting (success rate / duration per plugin version):
-- partial, so the bulk of non-plugin events is never indexed.
CREATE INDEX IF NOT EXISTS event_plugin_idx
    ON pipeline_events(plugin_publisher, plugin_name, plugin_version, completed_at)
    WHERE plugin_name IS NOT NULL;
-- Listing adoption / success rate (the plugin stats sweep), keyed on the publisher id.
CREATE INDEX IF NOT EXISTS event_plugin_publisher_id_idx
    ON pipeline_events(plugin_publisher_id, plugin_name, completed_at)
    WHERE plugin_publisher_id IS NOT NULL;

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
-- DESC twin for the dominant newest-first audit listing (index-only scans for
-- `ORDER BY created_at DESC LIMIT n`).
CREATE INDEX IF NOT EXISTS compliance_audit_org_created_desc_idx
    ON compliance_audit_log(org_id, created_at DESC);
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
-- PLUGIN ECOSYSTEM (docs/plans/plugin-ecosystem.md)
-- ============================================================================
-- Two kinds of table live here:
--   * ECOSYSTEM-GLOBAL (publishers, listings, listing versions, the publish
--     request queue, reviews, advisories, anonymous submissions, …): the
--     directory is instance-wide, so these carry NO org_id and are not tenant
--     scoped. Writes are gated in the service layer (system-org-only approval,
--     §3.0). Their RLS stance is set in the ROW-LEVEL SECURITY section below.
--   * ORG-SCOPED (pipeline_step_manifests, plugin_installs,
--     plugin_install_policies, plugin_advisory_deliveries): carry org_id and
--     get the standard rls_org_* policies + FORCE like every other tenant table.
-- Anonymous visitors read the directory only through the two public_* views at
-- the end of this section, as the ecosystem_public_reader role.

-- Trigram matching on listing names ("terafrom" -> terraform). pg_trgm is a
-- trusted extension, so the bootstrap owner can create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Publisher: an org's public identity (one per root org). owner_org_id is NULL
-- for the platform-owned `community` publisher that anonymous submissions land
-- under. Deliberately NOT named org_id: a publisher outlives its org (the org's
-- purge marks listings `unmaintained`, §3.6; installed versions keep resolving
-- from public/*), so it is not part of the org cascade.
CREATE TABLE IF NOT EXISTS publishers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_org_id VARCHAR(255) UNIQUE,
    handle VARCHAR(39) NOT NULL UNIQUE
                        CHECK (handle ~ '^[a-z0-9][a-z0-9-]*$'),
    display_name VARCHAR(255) NOT NULL,
    description TEXT,
    homepage_url VARCHAR(2048),
    tier VARCHAR(20) NOT NULL DEFAULT 'community'
                        CHECK (tier IN ('official', 'verified', 'community', 'unverified')),
    verified_at TIMESTAMPTZ,
    -- Verified publisher downgraded below Team: tier stays until this passes (N29).
    verified_grace_until TIMESTAMPTZ,
    terms_version VARCHAR(50),
    terms_accepted_at TIMESTAMPTZ,
    suspended_at TIMESTAMPTZ,
    suspend_reason TEXT,
    -- W7 roll-ups (stats sweep): run-weighted 30-day success rate and the
    -- install-weighted mean health score of its listings (NULL: none).
    success_rate_30d DOUBLE PRECISION,
    health_score INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Listing: a plugin NAME published by a publisher. Reviews, installs, stats and
-- search attach here; the per-version records are plugin_listing_versions.
CREATE TABLE IF NOT EXISTS plugin_listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    publisher_id UUID NOT NULL REFERENCES publishers(id),
    name VARCHAR(255) NOT NULL,
    category VARCHAR(50) NOT NULL DEFAULT 'unknown',
    summary VARCHAR(300),
    description TEXT,
    readme_html TEXT,
    license VARCHAR(64),
    homepage_url VARCHAR(2048),
    source_url VARCHAR(2048),
    icon JSONB,
    uploaded_icon JSONB,
    keywords JSONB NOT NULL DEFAULT '[]',
    state VARCHAR(20) NOT NULL DEFAULT 'listed'
                        CHECK (state IN ('listed', 'unmaintained', 'suspended', 'transferred')),
    -- Publisher pause (D14): no new installs; existing installs keep resolving.
    paused_at TIMESTAMPTZ,
    featured BOOLEAN NOT NULL DEFAULT false,
    latest_version VARCHAR(50),
    -- Maintained by plugin_listings_search_vector_update() below; never written
    -- by the application.
    search_vector TSVECTOR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS plugin_listing_publisher_name_unique
    ON plugin_listings(publisher_id, name);
CREATE INDEX IF NOT EXISTS plugin_listing_state_category_idx
    ON plugin_listings(state, category);
CREATE INDEX IF NOT EXISTS plugin_listing_updated_at_idx
    ON plugin_listings(updated_at);
CREATE INDEX IF NOT EXISTS plugin_listing_search_vector_idx
    ON plugin_listings USING gin (search_vector);
CREATE INDEX IF NOT EXISTS plugin_listing_name_trgm_idx
    ON plugin_listings USING gin (name gin_trgm_ops);

-- Weighted full-text vector: name A, keywords + category B, summary C, README
-- (tags stripped) + description D. A trigger rather than a generated column
-- because flattening the keywords JSONB array needs a set-returning function.
-- The 'english' config must match the one the search route passes to
-- websearch_to_tsquery.
CREATE OR REPLACE FUNCTION plugin_listings_search_vector_update()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A')
        || setweight(to_tsvector('english',
               coalesce(NEW.category, '') || ' ' ||
               coalesce((SELECT string_agg(k, ' ') FROM jsonb_array_elements_text(coalesce(NEW.keywords, '[]'::jsonb)) AS k), '')
           ), 'B')
        || setweight(to_tsvector('english', coalesce(NEW.summary, '')), 'C')
        || setweight(to_tsvector('english',
               coalesce(regexp_replace(NEW.readme_html, '<[^>]*>', ' ', 'g'), '') || ' ' ||
               coalesce(NEW.description, '')
           ), 'D');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS plugin_listings_search_vector_trigger ON plugin_listings;
CREATE TRIGGER plugin_listings_search_vector_trigger
    BEFORE INSERT OR UPDATE ON plugin_listings
    FOR EACH ROW
    EXECUTE PROCEDURE plugin_listings_search_vector_update();

-- A version published to a listing: the copy in the read-only public/*
-- namespace (§3.3). spec_snapshot freezes the resolved plugin record at
-- approval, so consumers keep synthesizing after the publisher org's own
-- plugins row is deleted or purged (§3.6); source_plugin_id is provenance only
-- (no FK: the org row is soft-deleted and purged on its own schedule).
CREATE TABLE IF NOT EXISTS plugin_listing_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID NOT NULL REFERENCES plugin_listings(id) ON DELETE CASCADE,
    source_plugin_id UUID,
    version VARCHAR(50) NOT NULL
                        CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$'),
    image_digest VARCHAR(71)
                        CHECK (image_digest IS NULL OR image_digest ~ '^sha256:[0-9a-f]{64}$'),
    image_repository VARCHAR(512),      -- public/<handle>/<name>
    spec_snapshot JSONB NOT NULL DEFAULT '{}',
    breaking BOOLEAN NOT NULL DEFAULT false,
    paused_at TIMESTAMPTZ,
    yanked_at TIMESTAMPTZ,
    yank_reason TEXT,
    deprecated_at TIMESTAMPTZ,
    deprecation_message TEXT,
    changelog TEXT,
    vuln_critical INTEGER,
    vuln_high INTEGER,
    scanned_at TIMESTAMPTZ,
    -- Base image config `created`, recorded at publish (W7 freshness), NULL = unknown.
    base_image_created_at TIMESTAMPTZ,
    published_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_by TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS plugin_listing_version_unique
    ON plugin_listing_versions(listing_id, version);
-- GC guard + digest lookups (§3.3: a public/* image is GC'd only when yanked
-- > 180 days and unreferenced).
CREATE INDEX IF NOT EXISTS plugin_listing_version_digest_idx
    ON plugin_listing_versions(image_digest);

-- Security advisories (W8). Declared before the request queue, which points at
-- the advisory a security-fix request remediates.
CREATE TABLE IF NOT EXISTS plugin_advisories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID NOT NULL REFERENCES plugin_listings(id),
    publisher_id UUID NOT NULL REFERENCES publishers(id),
    affected_range VARCHAR(255) NOT NULL,   -- semver range
    fixed_version VARCHAR(50),
    severity VARCHAR(10) NOT NULL
                        CHECK (severity IN ('critical', 'high', 'medium', 'low')),
    summary VARCHAR(300) NOT NULL,
    details_md TEXT,
    details_html TEXT,
    cve_ids TEXT[] NOT NULL DEFAULT '{}',
    state VARCHAR(20) NOT NULL DEFAULT 'draft'
                        CHECK (state IN ('draft', 'published', 'withdrawn')),
    source VARCHAR(20) NOT NULL
                        CHECK (source IN ('publisher', 'moderator', 'cve_rescan', 'review')),
    created_by TEXT NOT NULL,
    published_by TEXT,
    published_at TIMESTAMPTZ,
    withdrawn_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS plugin_advisory_listing_state_idx
    ON plugin_advisories(listing_id, state);
CREATE INDEX IF NOT EXISTS plugin_advisory_publisher_idx
    ON plugin_advisories(publisher_id);

-- Auto-approval rules (§3.0.1): enabling one needs a second approver.
CREATE TABLE IF NOT EXISTS ecosystem_auto_approval_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT false,
    conditions JSONB NOT NULL DEFAULT '{}',
    created_by TEXT NOT NULL,
    approved_by TEXT,
    -- A proposed enable/widening awaiting a SECOND manager (never the proposer):
    -- {requestedBy, requestedAt, enabled, name, conditions}. Disabling applies at once.
    pending_change JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The single queue the Ecosystem console works from (§3.1). digest is the image
-- digest pinned at submit (G25): approval publishes exactly it, or fails closed.
-- plugin_id has no FK for the same reason as source_plugin_id above.
CREATE TABLE IF NOT EXISTS plugin_publish_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    publisher_id UUID NOT NULL REFERENCES publishers(id),
    listing_id UUID REFERENCES plugin_listings(id),
    plugin_id UUID,
    version VARCHAR(50),
    digest VARCHAR(71)
                        CHECK (digest IS NULL OR digest ~ '^sha256:[0-9a-f]{64}$'),
    kind VARCHAR(20) NOT NULL
                        CHECK (kind IN ('new_listing', 'new_version', 'listing_update', 'yank', 'unpause',
                                        'transfer', 'claim', 'profile_change', 'advisory', 'verify',
                                        'moderation', 'submission')),
    security_fix_advisory_id UUID REFERENCES plugin_advisories(id),
    payload JSONB NOT NULL DEFAULT '{}',
    status VARCHAR(30) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'pending_second_approval', 'approved', 'rejected', 'withdrawn')),
    lane VARCHAR(10) NOT NULL DEFAULT 'standard'
                        CHECK (lane IN ('standard', 'security')),
    submitted_by TEXT NOT NULL,
    submitted_org_id VARCHAR(255),
    first_approved_by TEXT,
    decided_by TEXT,
    second_approved_by TEXT,
    reason TEXT,
    auto_rule_id UUID REFERENCES ecosystem_auto_approval_rules(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS plugin_publish_request_status_created_idx
    ON plugin_publish_requests(status, created_at);
CREATE INDEX IF NOT EXISTS plugin_publish_request_publisher_idx
    ON plugin_publish_requests(publisher_id, created_at);
-- At most ONE open request of a kind per (publisher, listing, version). A
-- new_listing has no listing_id yet, so the requested name (payload->>'name')
-- stands in for it; COALESCE because NULLs are DISTINCT in a unique index.
-- Advisory drafts are exempt: a listing can carry several at once.
-- Must match the drizzle `plugin_publish_request_open_unique` expression index.
CREATE UNIQUE INDEX IF NOT EXISTS plugin_publish_request_open_unique
    ON plugin_publish_requests (
        publisher_id,
        kind,
        coalesce(listing_id::text, payload->>'name', ''),
        coalesce(version, '')
    )
    WHERE status IN ('pending', 'pending_second_approval') AND kind <> 'advisory';

-- Names held back from handles/listings (Official/Verified reservations,
-- confusables). publisher_id = the publisher the name is reserved FOR, if any.
CREATE TABLE IF NOT EXISTS ecosystem_reserved_names (
    name VARCHAR(255) PRIMARY KEY,
    reason TEXT,
    publisher_id UUID REFERENCES publishers(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Instance-wide ecosystem knobs (flags, SLA, thresholds) — key/value.
CREATE TABLE IF NOT EXISTS ecosystem_settings (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Curated directory collections ("Featured", "Security scanners", …).
CREATE TABLE IF NOT EXISTS ecosystem_collections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(100) NOT NULL UNIQUE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    listing_ids JSONB NOT NULL DEFAULT '[]',
    position INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Reviews (§5). author_org_id feeds the integrity rules (no self-review, per-org
-- rate limit, verified use) and is NEVER exposed. GDPR user deletion anonymizes:
-- author_user_id and the body go NULL, the rating stays.
CREATE TABLE IF NOT EXISTS plugin_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID NOT NULL REFERENCES plugin_listings(id) ON DELETE CASCADE,
    version VARCHAR(50),
    rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    title VARCHAR(120),
    body_md TEXT,
    body_html TEXT,
    author_user_id TEXT,
    author_org_id VARCHAR(255),
    -- The author's display name, snapshotted at write time: the ONLY author
    -- field ever shown (never the org, G15). NULL once anonymized.
    author_display_name VARCHAR(100),
    verified_use BOOLEAN NOT NULL DEFAULT false,
    status VARCHAR(10) NOT NULL DEFAULT 'published'
                        CHECK (status IN ('published', 'held', 'removed')),
    -- Why a held review is held (G16): reports, a burst on the listing, the
    -- link filter, a security report, or a moderator.
    hold_reason VARCHAR(20)
                        CHECK (hold_reason IN ('reports', 'burst', 'filter', 'security', 'moderator')),
    -- The moderator's hold / removal reason (a removal's is shown to the author).
    moderation_reason TEXT,
    helpful_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS plugin_review_listing_author_unique
    ON plugin_reviews(listing_id, author_user_id);
CREATE INDEX IF NOT EXISTS plugin_review_listing_status_created_idx
    ON plugin_reviews(listing_id, status, created_at);
-- Per-org daily review cap.
CREATE INDEX IF NOT EXISTS plugin_review_author_org_created_idx
    ON plugin_reviews(author_org_id, created_at);
-- Moderation queue (held reviews, newest activity first).
CREATE INDEX IF NOT EXISTS plugin_review_status_updated_idx
    ON plugin_reviews(status, updated_at);

-- One public publisher reply per review.
CREATE TABLE IF NOT EXISTS plugin_review_replies (
    review_id UUID PRIMARY KEY REFERENCES plugin_reviews(id) ON DELETE CASCADE,
    publisher_id UUID NOT NULL REFERENCES publishers(id),
    author_user_id TEXT,
    body_md TEXT NOT NULL,
    body_html TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS plugin_review_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id UUID NOT NULL REFERENCES plugin_reviews(id) ON DELETE CASCADE,
    reporter_user_id TEXT NOT NULL,
    -- 'security' reports never post publicly: they hold the review and open a
    -- private advisory draft (W8).
    category VARCHAR(20) NOT NULL DEFAULT 'abuse'
                        CHECK (category IN ('spam', 'abuse', 'off_topic', 'security')),
    reason TEXT,
    -- Set when a moderator releases or removes the review (the report is handled).
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS plugin_review_report_unique
    ON plugin_review_reports(review_id, reporter_user_id);
-- Open reports (the moderation queue's "reported" half).
CREATE INDEX IF NOT EXISTS plugin_review_report_open_idx
    ON plugin_review_reports(review_id) WHERE resolved_at IS NULL;

-- One "helpful" vote per user per review.
CREATE TABLE IF NOT EXISTS plugin_review_votes (
    review_id UUID NOT NULL REFERENCES plugin_reviews(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (review_id, user_id)
);

-- Edit history: the PRIOR content, appended on every review edit.
CREATE TABLE IF NOT EXISTS plugin_review_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id UUID NOT NULL REFERENCES plugin_reviews(id) ON DELETE CASCADE,
    version VARCHAR(50),
    rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    title VARCHAR(120),
    body_md TEXT,
    edited_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS plugin_review_history_review_idx
    ON plugin_review_history(review_id, edited_at);

-- Denormalized per-listing stats, recomputed by a job. active_org_count is
-- shown only when >= 5 (the public view enforces it).
CREATE TABLE IF NOT EXISTS plugin_stats (
    listing_id UUID PRIMARY KEY REFERENCES plugin_listings(id) ON DELETE CASCADE,
    rating_bayes DOUBLE PRECISION,
    rating_count INTEGER NOT NULL DEFAULT 0,
    dist JSONB NOT NULL DEFAULT '{}',
    recent_rating DOUBLE PRECISION,
    install_count INTEGER NOT NULL DEFAULT 0,
    active_org_count INTEGER NOT NULL DEFAULT 0,
    success_rate_30d DOUBLE PRECISION,
    health_score DOUBLE PRECISION,
    -- Per-component health scores + weights (W7) for the breakdown panel.
    health_breakdown JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Anonymous submissions (§4). The email is kept hashed (rate limits, claim
-- matching) and encrypted (takedown notices only), and purged at
-- email_purge_after (90 days after a decision). Nothing here is ever listed.
CREATE TABLE IF NOT EXISTS plugin_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status VARCHAR(30) NOT NULL DEFAULT 'pending_verification'
                        CHECK (status IN ('pending_verification', 'pending_review', 'publishing', 'gate_failed',
                                          'approved', 'rejected', 'expired', 'claimed')),
    email_hash VARCHAR(64),
    email_enc TEXT,
    verify_token_hash VARCHAR(64),
    verify_expires_at TIMESTAMPTZ,
    verified_at TIMESTAMPTZ,
    -- sha256 of the status token (verify response + N1/N3/N4 emails only).
    status_token_hash VARCHAR(64),
    name VARCHAR(255) NOT NULL,
    version VARCHAR(50) NOT NULL,
    spec JSONB NOT NULL DEFAULT '{}',
    -- Accept-or-edit catalog values + provenance (§3.1a) and the Dockerfile, as submitted.
    catalog JSONB NOT NULL DEFAULT '{"values": {}, "sources": {}}',
    dockerfile TEXT,
    artifact_key VARCHAR(1024),
    quarantine_image_ref VARCHAR(1024),
    gate_report JSONB,
    heuristics JSONB,
    listing_id UUID REFERENCES plugin_listings(id),
    decided_by TEXT,
    reason TEXT,
    client_ip_hash VARCHAR(64),
    expires_at TIMESTAMPTZ NOT NULL,
    decided_at TIMESTAMPTZ,
    email_purge_after TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS plugin_submission_status_created_idx
    ON plugin_submissions(status, created_at);
-- Per-email / per-IP daily rate limits.
CREATE INDEX IF NOT EXISTS plugin_submission_email_created_idx
    ON plugin_submissions(email_hash, created_at);
CREATE INDEX IF NOT EXISTS plugin_submission_ip_created_idx
    ON plugin_submissions(client_ip_hash, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS plugin_submission_verify_token_unique
    ON plugin_submissions(verify_token_hash) WHERE verify_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS plugin_submission_status_token_unique
    ON plugin_submissions(status_token_hash) WHERE status_token_hash IS NOT NULL;

-- Zero-result search log (drives "what are people looking for"). No user data.
CREATE TABLE IF NOT EXISTS ecosystem_search_misses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    query VARCHAR(200) NOT NULL,
    category VARCHAR(50),
    -- Repeats of one (query, category) folded by the maintenance sweep.
    hits INTEGER NOT NULL DEFAULT 1 CHECK (hits >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ecosystem_search_miss_created_idx
    ON ecosystem_search_misses(created_at);

-- Notification digest/batching queue (§5b). event is the N-number (N1..N29);
-- rows sharing a digest_key are coalesced into one email at deliver_after.
CREATE TABLE IF NOT EXISTS ecosystem_notification_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_user_id TEXT,
    recipient_org_id VARCHAR(255),
    event VARCHAR(8) NOT NULL CHECK (event ~ '^N([1-9]|1[0-9]|2[0-9])$'),
    digest_key VARCHAR(255),
    payload JSONB NOT NULL DEFAULT '{}',
    deliver_after TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The dispatcher's scan: undelivered rows that are due.
CREATE INDEX IF NOT EXISTS ecosystem_notification_due_idx
    ON ecosystem_notification_queue(deliver_after) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS ecosystem_notification_digest_idx
    ON ecosystem_notification_queue(digest_key) WHERE delivered_at IS NULL;

-- ---------------------------------------------------------------------------
-- Org-scoped ecosystem tables
-- ---------------------------------------------------------------------------

-- Step manifest (W0.1): which plugin each (pipeline, stage, action) runs,
-- recorded at synth. Event ingest joins on it to stamp pipeline_events.plugin_*.
-- plugin_publisher is NULL for an own-org plugin.
CREATE TABLE IF NOT EXISTS pipeline_step_manifests (
    pipeline_id UUID NOT NULL,
    org_id VARCHAR(255) NOT NULL,
    stage_name VARCHAR(255) NOT NULL,
    action_name VARCHAR(255) NOT NULL,
    plugin_publisher VARCHAR(39),
    -- The listing publisher's id (NULL for an own-org plugin): what cross-org stats join on.
    plugin_publisher_id UUID,
    plugin_name VARCHAR(255) NOT NULL,
    plugin_version VARCHAR(50) NOT NULL,
    image_digest VARCHAR(71),
    image_repository VARCHAR(512),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (pipeline_id, stage_name, action_name)
);

CREATE INDEX IF NOT EXISTS pipeline_step_manifest_org_idx
    ON pipeline_step_manifests(org_id);
-- public/* GC guard: "does any manifest still reference this digest?"
CREATE INDEX IF NOT EXISTS pipeline_step_manifest_digest_idx
    ON pipeline_step_manifests(image_digest);
-- "Installing orgs" / verified-use lookups by plugin.
CREATE INDEX IF NOT EXISTS pipeline_step_manifest_plugin_idx
    ON pipeline_step_manifests(plugin_publisher, plugin_name);
CREATE INDEX IF NOT EXISTS pipeline_step_manifest_publisher_id_idx
    ON pipeline_step_manifests(plugin_publisher_id, plugin_name);

-- An org's install of a listing (§3.2). Official listings are installed
-- implicitly (virtual, no row); a row here is an explicit install or override.
CREATE TABLE IF NOT EXISTS plugin_installs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id VARCHAR(255) NOT NULL,
    listing_id UUID NOT NULL REFERENCES plugin_listings(id) ON DELETE CASCADE,
    version_policy VARCHAR(10) NOT NULL DEFAULT 'minor'
                        CHECK (version_policy IN ('pinned', 'patch', 'minor', 'latest')),
    pinned_version VARCHAR(50),
    resolved_version VARCHAR(50),
    status VARCHAR(20) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'pending_approval', 'denied')),
    installed_by TEXT NOT NULL,
    approved_by TEXT,
    decided_at TIMESTAMPTZ,
    -- A member's pending, approval-gated change of this install (upgrade /
    -- version policy): { version, versionPolicy, requestedBy, requestedAt, note }.
    pending_change JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT plugin_install_pinned_check
        CHECK (version_policy <> 'pinned' OR pinned_version IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS plugin_install_org_listing_unique
    ON plugin_installs(org_id, listing_id);
-- "Installing orgs" fan-out for N8/N13/N14/N21/N26.
CREATE INDEX IF NOT EXISTS plugin_install_listing_status_idx
    ON plugin_installs(listing_id, status);

-- Org consumption policy (§3.2). One row per org; absent = the defaults below.
-- None of these safety controls is plan-gated (§3.7).
CREATE TABLE IF NOT EXISTS plugin_install_policies (
    org_id VARCHAR(255) PRIMARY KEY,
    allowed_tiers TEXT[] NOT NULL DEFAULT '{official,verified}',
    require_approval_tiers TEXT[] NOT NULL DEFAULT '{community,unverified}',
    secrets_allowed_tiers TEXT[] NOT NULL DEFAULT '{official,verified}',
    block_on_advisory VARCHAR(10) NOT NULL DEFAULT 'critical'
                        CHECK (block_on_advisory IN ('critical', 'high', 'never')),
    official_installs VARCHAR(10) NOT NULL DEFAULT 'implicit'
                        CHECK (official_installs IN ('implicit', 'explicit')),
    blocked_listings JSONB NOT NULL DEFAULT '[]',   -- [{publisher, name}]
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT plugin_install_policy_tiers_check CHECK (
        allowed_tiers <@ ARRAY['official', 'verified', 'community', 'unverified']::TEXT[]
        AND require_approval_tiers <@ ARRAY['official', 'verified', 'community', 'unverified']::TEXT[]
        AND secrets_allowed_tiers <@ ARRAY['official', 'verified', 'community', 'unverified']::TEXT[]
    )
);

-- N21 idempotency: one delivery per (advisory, installing org), so a retried
-- fan-out never notifies an org twice. Org-scoped (hard-removed with the org).
CREATE TABLE IF NOT EXISTS plugin_advisory_deliveries (
    advisory_id UUID NOT NULL REFERENCES plugin_advisories(id) ON DELETE CASCADE,
    org_id VARCHAR(255) NOT NULL,
    delivered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (advisory_id, org_id)
);

CREATE INDEX IF NOT EXISTS plugin_advisory_delivery_org_idx
    ON plugin_advisory_deliveries(org_id);

-- updated_at maintenance
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'publishers', 'plugin_listings', 'plugin_advisories', 'ecosystem_auto_approval_rules',
        'ecosystem_settings', 'ecosystem_collections', 'plugin_reviews', 'plugin_review_replies',
        'plugin_stats', 'plugin_submissions', 'pipeline_step_manifests', 'plugin_installs',
        'plugin_install_policies'
    ]
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS update_%s_modtime ON %I', t, t);
        EXECUTE format('CREATE TRIGGER update_%s_modtime BEFORE UPDATE ON %I '
                       'FOR EACH ROW EXECUTE PROCEDURE update_modified_column()', t, t);
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Ecosystem seed rows (W0.8 / W1)
-- ---------------------------------------------------------------------------
-- The Official catalog publisher (§3.1: tier official, owned by the system org
-- 000000000000000000000001, the same literal the RLS policies use) and the
-- platform-owned `community` publisher anonymous submissions land under (§4,
-- no owner org). The plugin service re-asserts the Official row at boot, so a
-- non-default SYSTEM_ORG_ID is corrected there. Existing rows are never touched.
INSERT INTO publishers (handle, owner_org_id, display_name, description, tier, verified_at)
VALUES ('pipeline-builder', '000000000000000000000001', 'Pipeline Builder',
        'The Official plugin catalog, maintained with the platform.', 'official', CURRENT_TIMESTAMP)
ON CONFLICT (handle) DO NOTHING;
INSERT INTO publishers (handle, owner_org_id, display_name, description, tier)
VALUES ('community', NULL, 'Community', 'Anonymous public submissions, reviewed by the system org.', 'unverified')
ON CONFLICT (handle) DO NOTHING;

-- The two seeded auto-approval rules (§3.0.3, W1). Fixed ids so the service
-- can recognise them; enabled from the start (a seed is not a manager's
-- decision, so it needs no second approver). Every rule ALSO passes the fixed
-- safety checks in the plugin service: signed, SBOM attested and scanned, no
-- new critical/high vulnerabilities, no new secrets / egress hosts / required
-- inputs, no non-root -> root change, digest pinned at submit.
INSERT INTO ecosystem_auto_approval_rules (id, name, enabled, conditions, created_by, approved_by)
VALUES
    ('00000000-0000-4000-8000-00000000a001', 'Verified updates', true,
     '{"seeded": "verified_updates", "requestKinds": ["new_version", "listing_update"], "publisherTiers": ["verified"], "bumps": ["patch", "minor"], "textOnlyListingUpdates": true}',
     'system', 'system'),
    ('00000000-0000-4000-8000-00000000a002', 'Official catalog', true,
     '{"seeded": "official_catalog", "requestKinds": ["new_version", "listing_update"], "publisherTiers": ["official"], "bumps": ["patch", "minor"], "submitterServiceAccount": "official-catalog-loader", "textOnlyListingUpdates": true, "maxPerListingPerDay": 1, "maxPerDay": 50, "instanceFlag": "OFFICIAL_AUTO_APPROVAL_ENABLED"}',
     'system', 'system')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Public read path (§6a, G28)
-- ---------------------------------------------------------------------------
-- The anonymous directory API connects as ecosystem_public_reader (created in
-- "Ecosystem public reader role" at the end of this file), which holds SELECT on
-- these two views and NOTHING else. The views are owned by the bootstrap role
-- and are NOT security_invoker, so they read the base tables with the owner's
-- rights; the reader never touches a base table. security_barrier stops a
-- caller-supplied (leaky) function in a WHERE clause from being evaluated
-- before the view's own row filter. Column lists are explicit (never SELECT *):
-- no org ids, no user ids, no env values / build args / commands / Dockerfile.

CREATE OR REPLACE VIEW public_listings WITH (security_barrier = true) AS
SELECT
    l.id,
    p.handle AS publisher_handle,
    p.display_name AS publisher_display_name,
    p.tier AS publisher_tier,
    p.verified_at AS publisher_verified_at,
    l.name,
    l.category,
    l.summary,
    l.description,
    l.readme_html,
    l.license,
    l.homepage_url,
    l.source_url,
    l.icon,
    l.uploaded_icon,
    l.keywords,
    l.featured,
    l.latest_version,
    l.paused_at,
    l.search_vector,
    l.created_at,
    l.updated_at,
    s.rating_bayes,
    COALESCE(s.rating_count, 0) AS rating_count,
    s.dist AS rating_dist,
    s.recent_rating,
    COALESCE(s.install_count, 0) AS install_count,
    CASE WHEN s.active_org_count >= 5 THEN s.active_org_count END AS active_org_count,
    s.success_rate_30d,
    s.health_score,
    -- 'listed' or 'unmaintained' (still public, shown with a banner, §3.6).
    l.state,
    s.health_breakdown
FROM plugin_listings l
JOIN publishers p ON p.id = l.publisher_id
LEFT JOIN plugin_stats s ON s.listing_id = l.id
WHERE l.state IN ('listed', 'unmaintained')
  AND p.suspended_at IS NULL;

CREATE OR REPLACE VIEW public_listed_versions WITH (security_barrier = true) AS
SELECT
    v.id,
    v.listing_id,
    p.handle AS publisher_handle,
    l.name,
    v.version,
    v.image_digest,
    v.image_repository,
    v.breaking,
    v.deprecated_at,
    v.changelog,
    v.vuln_critical,
    v.vuln_high,
    v.scanned_at,
    v.published_at,
    -- Public subset of the frozen spec only.
    v.spec_snapshot->>'pluginType' AS plugin_type,
    v.spec_snapshot->>'computeType' AS compute_type,
    v.spec_snapshot->'secrets' AS secrets,
    v.spec_snapshot->'requiredMetadata' AS required_metadata,
    v.spec_snapshot->'requiredVars' AS required_vars,
    v.spec_snapshot->'networkEgress' AS network_egress,
    (v.spec_snapshot->>'runAsRoot')::boolean AS run_as_root,
    v.spec_snapshot->>'license' AS license,
    v.spec_snapshot->>'readmeHtml' AS readme_html,
    -- Yanked versions stay VISIBLE (marked) so the directory can show them, but
    -- the yank reason is not public. Nothing resolves through this view.
    (v.yanked_at IS NOT NULL) AS yanked,
    v.deprecation_message,
    v.spec_snapshot->>'imageSource' AS image_source,
    v.base_image_created_at
FROM plugin_listing_versions v
JOIN plugin_listings l ON l.id = v.listing_id
JOIN publishers p ON p.id = l.publisher_id
WHERE l.state IN ('listed', 'unmaintained')
  AND p.suspended_at IS NULL
  AND v.paused_at IS NULL;

-- Published advisories on listed listings (W8), public columns only: no
-- publisher/org ids, no author, no draft or withdrawn rows.
CREATE OR REPLACE VIEW public_advisories WITH (security_barrier = true) AS
SELECT
    a.id,
    a.listing_id,
    p.handle AS publisher_handle,
    l.name,
    a.severity,
    a.summary,
    a.details_html,
    a.cve_ids,
    a.affected_range,
    a.fixed_version,
    a.published_at
FROM plugin_advisories a
JOIN plugin_listings l ON l.id = a.listing_id
JOIN publishers p ON p.id = l.publisher_id
WHERE a.state = 'published'
  AND l.state IN ('listed', 'unmaintained')
  AND p.suspended_at IS NULL;

-- Published reviews of public listings (W4), public columns only: the author's
-- display name (never the user or org id, G15), the verified-use badge, and the
-- publisher's reply. Held and removed reviews never appear.
CREATE OR REPLACE VIEW public_reviews WITH (security_barrier = true) AS
SELECT
    r.id,
    r.listing_id,
    p.handle AS publisher_handle,
    l.name,
    r.version,
    r.rating,
    r.title,
    r.body_html,
    r.author_display_name,
    r.verified_use,
    r.helpful_count,
    EXISTS (SELECT 1 FROM plugin_review_history h WHERE h.review_id = r.id) AS edited,
    r.created_at,
    r.updated_at,
    p.display_name AS publisher_display_name,
    rr.body_html AS reply_body_html,
    rr.created_at AS reply_created_at,
    rr.updated_at AS reply_updated_at
FROM plugin_reviews r
JOIN plugin_listings l ON l.id = r.listing_id
JOIN publishers p ON p.id = l.publisher_id
LEFT JOIN plugin_review_replies rr ON rr.review_id = r.id
WHERE r.status = 'published'
  AND l.state IN ('listed', 'unmaintained')
  AND l.paused_at IS NULL
  AND p.suspended_at IS NULL;

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

-- Policies are split by COMMAND. A single `FOR ALL` policy applies its USING
-- clause to UPDATE and DELETE too, so every read carve-out (system-org content,
-- a message's recipient, a broadcast) silently became a WRITE carve-out: any
-- org could DELETE the system org's rows, or a message addressed to it. Reads
-- keep their carve-outs (FOR SELECT); INSERT / UPDATE / DELETE are own-org only.
--
-- `pb_reset_policies(t)` drops every policy on a table before it is re-created,
-- so re-running this script is idempotent and a renamed policy can never linger
-- beside its replacement (permissive policies OR together — a stale one would
-- re-open whatever the new set closes). Dropped again at the end of this block.
CREATE OR REPLACE FUNCTION pb_reset_policies(tbl TEXT) RETURNS VOID AS $$
DECLARE
    p TEXT;
BEGIN
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = tbl LOOP
        EXECUTE format('DROP POLICY %I ON %I', p, tbl);
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Org-scoped policies for every user-data table that carries an `org_id`
-- column directly. Reads allowed when
-- - caller is sysadmin (`app.is_sysadmin = 'true'`), OR
-- - row's `org_id` matches `app.org_id`, OR
-- - row's `org_id` is the system org (the system-org content visibility rule
--   mirrored from the app-layer convention keeps shared defaults visible to
--   every authenticated org).
-- Writes (INSERT / UPDATE / DELETE) allowed only for sysadmin or the row's own
-- org, on both the old row (USING) and the new one (WITH CHECK).
DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN
        SELECT unnest(ARRAY[
            -- NOTE: `messages`, `message_attachments`, `dashboard_panels` and
            -- `pipeline_templates` are intentionally ABSENT here — they get
            -- dedicated policies below (recipient carve-out, parent-join scope,
            -- and the public-only system catalog respectively).
            'plugins', 'pipelines',
            'pipeline_registry', 'pipeline_events',
            'deployment_outcomes', 'ingest_health', 'incidents', 'dora_settings',
            'dashboards', 'org_alert_destinations', 'org_alert_rules',
            'compliance_policies', 'compliance_rules', 'compliance_rule_history',
            'compliance_audit_log', 'compliance_exemptions', 'compliance_rule_subscriptions',
            'compliance_scans', 'compliance_scan_schedules',
            'compliance_notification_preferences', 'compliance_notification_log',
            'compliance_roles', 'compliance_reports', 'compliance_report_schedules',
            'compliance_entitlement_watermark',
            -- Plugin ecosystem, org-scoped half (the global half is below).
            'pipeline_step_manifests', 'plugin_installs', 'plugin_install_policies',
            'plugin_advisory_deliveries'
        ])
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        PERFORM pb_reset_policies(t);
        EXECUTE format(
            'CREATE POLICY rls_org_read ON %I FOR SELECT '
            'USING (current_is_sysadmin() OR org_id = current_org_id() OR org_id = ''000000000000000000000001'')',
            t
        );
        EXECUTE format(
            'CREATE POLICY rls_org_insert ON %I FOR INSERT '
            'WITH CHECK (current_is_sysadmin() OR org_id = current_org_id())',
            t
        );
        EXECUTE format(
            'CREATE POLICY rls_org_update ON %I FOR UPDATE '
            'USING (current_is_sysadmin() OR org_id = current_org_id()) '
            'WITH CHECK (current_is_sysadmin() OR org_id = current_org_id())',
            t
        );
        EXECUTE format(
            'CREATE POLICY rls_org_delete ON %I FOR DELETE '
            'USING (current_is_sysadmin() OR org_id = current_org_id())',
            t
        );
    END LOOP;
END $$;

-- `pipeline_templates` rides the three-rung visibility ladder: another org's
-- template is only ever visible at the `public` rung, so the system-org read
-- carve-out is limited to the system org's PUBLIC templates (the golden-path
-- catalog) rather than every system row. A team reading its parent's public
-- templates goes through the sysadmin-scoped widened read (CrudService.runRead),
-- as for every catalog entity. Writes are own-org only.
ALTER TABLE pipeline_templates ENABLE ROW LEVEL SECURITY;
SELECT pb_reset_policies('pipeline_templates');
CREATE POLICY rls_org_read ON pipeline_templates FOR SELECT
    USING (
        current_is_sysadmin()
        OR org_id = current_org_id()
        OR (org_id = '000000000000000000000001' AND visibility = 'public')
    );
CREATE POLICY rls_org_insert ON pipeline_templates FOR INSERT
    WITH CHECK (current_is_sysadmin() OR org_id = current_org_id());
CREATE POLICY rls_org_update ON pipeline_templates FOR UPDATE
    USING (current_is_sysadmin() OR org_id = current_org_id())
    WITH CHECK (current_is_sysadmin() OR org_id = current_org_id());
CREATE POLICY rls_org_delete ON pipeline_templates FOR DELETE
    USING (current_is_sysadmin() OR org_id = current_org_id());

-- Messaging tables carry BOTH a sender (`org_id`) and a recipient
-- (`recipient_org_id`), so the generic sender-only scope above would block a
-- recipient org from reading a message addressed TO it whenever the sender is
-- neither the reader nor the system org (i.e. org<->org, same-account
-- messaging). The READ policy adds the RECIPIENT carve-out (and the '*'
-- broadcast-announcement carve-out). Per-user targeting (`recipient_user_id`)
-- is deliberately NOT enforced here — RLS is org-grained (there is no per-user
-- session GUC); the app-layer `buildMessageConditions` narrows a
-- recipient-visible row down to the specific target user.
--
-- Writes: the SENDER org owns the row (insert / update / delete). A RECIPIENT
-- org may UPDATE a message addressed to it — that is how read receipts
-- (`read_by`) are stamped — but only the columns the guard trigger below
-- allows: nothing a recipient can do changes who sent it, to whom, or what it
-- says. A recipient can never DELETE the row.
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
SELECT pb_reset_policies('messages');
CREATE POLICY rls_org_read ON messages FOR SELECT
    USING (
        current_is_sysadmin()
        OR org_id = current_org_id()
        OR org_id = '000000000000000000000001'
        OR recipient_org_id = current_org_id()
        OR recipient_org_id = '*'
    );
CREATE POLICY rls_org_insert ON messages FOR INSERT
    WITH CHECK (current_is_sysadmin() OR org_id = current_org_id());
CREATE POLICY rls_org_update ON messages FOR UPDATE
    USING (current_is_sysadmin() OR org_id = current_org_id())
    WITH CHECK (current_is_sysadmin() OR org_id = current_org_id());
-- The participant leg: the recipient org (or anyone, for a '*' broadcast).
-- WITH CHECK keeps the new row addressed to the caller; the trigger below pins
-- every other column.
CREATE POLICY rls_recipient_update ON messages FOR UPDATE
    USING (recipient_org_id = current_org_id() OR recipient_org_id = '*')
    WITH CHECK (recipient_org_id = current_org_id() OR recipient_org_id = '*');
CREATE POLICY rls_org_delete ON messages FOR DELETE
    USING (current_is_sysadmin() OR org_id = current_org_id());

-- Column guard for the participant UPDATE leg. When the caller is neither a
-- sysadmin nor the sender org, the update may only:
--   * stamp read state (`read_by`, `updated_at`, `updated_by`), or
--   * soft-delete the row as part of deleting a thread whose ROOT the caller's
--     org owns (`is_active`, `deleted_at`, `deleted_by`, `purge_after` — the
--     sender of a conversation removes the whole thread, replies included).
-- Anything else — content, subject, sender, recipient, targeting, priority — is
-- refused with an error rather than silently applied.
CREATE OR REPLACE FUNCTION messages_participant_update_guard() RETURNS TRIGGER AS $$
BEGIN
    IF current_is_sysadmin() OR OLD.org_id = current_org_id() THEN
        RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - ARRAY['read_by', 'updated_at', 'updated_by'])
         = (to_jsonb(OLD) - ARRAY['read_by', 'updated_at', 'updated_by']) THEN
        RETURN NEW;
    END IF;
    IF NEW.thread_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM messages r WHERE r.id = NEW.thread_id AND r.org_id = current_org_id())
       AND (to_jsonb(NEW) - ARRAY['read_by', 'updated_at', 'updated_by', 'is_active', 'deleted_at', 'deleted_by', 'purge_after'])
         = (to_jsonb(OLD) - ARRAY['read_by', 'updated_at', 'updated_by', 'is_active', 'deleted_at', 'deleted_by', 'purge_after'])
    THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'messages: a participant may only update read state on a message it did not send'
        USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_participant_update_guard ON messages;
CREATE TRIGGER messages_participant_update_guard
    BEFORE UPDATE ON messages
    FOR EACH ROW EXECUTE FUNCTION messages_participant_update_guard();

-- `message_attachments` follows its parent message's visibility. The uploader
-- org (`org_id`) always sees its own rows — including still-PENDING uploads,
-- whose `message_id` is NULL, for which the EXISTS below is false. A recipient
-- sees an attachment IFF it can see the linked message (recipient org, or a '*'
-- broadcast). The subquery is itself filtered by `messages`' policy above, so it
-- can only confirm a message the caller is already permitted to read. Writes
-- are the uploader org's only.
ALTER TABLE message_attachments ENABLE ROW LEVEL SECURITY;
SELECT pb_reset_policies('message_attachments');
CREATE POLICY rls_org_read ON message_attachments FOR SELECT
    USING (
        current_is_sysadmin()
        OR org_id = current_org_id()
        OR org_id = '000000000000000000000001'
        OR EXISTS (
            SELECT 1 FROM messages m
            WHERE m.id = message_attachments.message_id
              AND (m.recipient_org_id = current_org_id() OR m.recipient_org_id = '*')
        )
    );
CREATE POLICY rls_org_insert ON message_attachments FOR INSERT
    WITH CHECK (current_is_sysadmin() OR org_id = current_org_id());
CREATE POLICY rls_org_update ON message_attachments FOR UPDATE
    USING (current_is_sysadmin() OR org_id = current_org_id())
    WITH CHECK (current_is_sysadmin() OR org_id = current_org_id());
CREATE POLICY rls_org_delete ON message_attachments FOR DELETE
    USING (current_is_sysadmin() OR org_id = current_org_id());

-- `dashboard_panels` doesn't have an `org_id` column — it inherits scoping
-- from its parent `dashboards` row. Policy joins through the FK. Reads see the
-- system org's panels; writes only the caller's own dashboards' panels.
ALTER TABLE dashboard_panels ENABLE ROW LEVEL SECURITY;
SELECT pb_reset_policies('dashboard_panels');
CREATE POLICY rls_org_read ON dashboard_panels FOR SELECT
    USING (
        current_is_sysadmin()
        OR EXISTS (
            SELECT 1 FROM dashboards d
            WHERE d.id = dashboard_panels.dashboard_id
              AND (d.org_id = current_org_id() OR d.org_id = '000000000000000000000001')
        )
    );
CREATE POLICY rls_org_insert ON dashboard_panels FOR INSERT
    WITH CHECK (
        current_is_sysadmin()
        OR EXISTS (SELECT 1 FROM dashboards d WHERE d.id = dashboard_panels.dashboard_id AND d.org_id = current_org_id())
    );
CREATE POLICY rls_org_update ON dashboard_panels FOR UPDATE
    USING (
        current_is_sysadmin()
        OR EXISTS (SELECT 1 FROM dashboards d WHERE d.id = dashboard_panels.dashboard_id AND d.org_id = current_org_id())
    )
    WITH CHECK (
        current_is_sysadmin()
        OR EXISTS (SELECT 1 FROM dashboards d WHERE d.id = dashboard_panels.dashboard_id AND d.org_id = current_org_id())
    );
CREATE POLICY rls_org_delete ON dashboard_panels FOR DELETE
    USING (
        current_is_sysadmin()
        OR EXISTS (SELECT 1 FROM dashboards d WHERE d.id = dashboard_panels.dashboard_id AND d.org_id = current_org_id())
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
-- Pipeline templates route through CrudService (withTenantTx) like pipelines;
-- the entitlement watermark is written only by the billing sync under sysadmin.
ALTER TABLE pipeline_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE compliance_entitlement_watermark FORCE ROW LEVEL SECURITY;

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

-- Plugin ecosystem, org-scoped half: synth (step manifests), the install and
-- consumption-policy routes, and the advisory fan-out all run under
-- withTenantTx; the fan-out and ingest join run as sysadmin (cross-org).
ALTER TABLE pipeline_step_manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE plugin_installs FORCE ROW LEVEL SECURITY;
ALTER TABLE plugin_install_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE plugin_advisory_deliveries FORCE ROW LEVEL SECURITY;

-- Plugin ecosystem, GLOBAL half. These tables have no org_id: the directory is
-- instance-wide, and who may write what (system-org approval, publisher
-- managers, review authors) is enforced in the service layer, not by tenant
-- scope. RLS is still ENABLED on them, with one permissive policy naming ONLY
-- the application role (DB_USER), so:
--   * the services read/write them freely, with or without tenant context;
--   * any OTHER non-owner role — ecosystem_public_reader in particular, even if
--     a stray GRANT ever reached it — sees zero rows. The public directory
--     reads them only through the public_* views (owner rights).
-- They are deliberately NOT FORCEd: the public_* views read them as the owner,
-- and FORCE would subject the owner to a policy that doesn't name it (the
-- bootstrap superuser bypasses RLS anyway; a non-superuser owner would not).
DO $$
DECLARE
    app_user TEXT := current_setting('pb.app_user');
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'publishers', 'plugin_listings', 'plugin_listing_versions', 'plugin_publish_requests',
        'ecosystem_auto_approval_rules', 'ecosystem_reserved_names', 'ecosystem_settings',
        'ecosystem_collections', 'plugin_reviews', 'plugin_review_replies', 'plugin_review_reports',
        'plugin_review_votes', 'plugin_review_history', 'plugin_stats', 'plugin_advisories',
        'plugin_submissions', 'ecosystem_search_misses', 'ecosystem_notification_queue'
    ]
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        PERFORM pb_reset_policies(t);
        EXECUTE format(
            'CREATE POLICY rls_ecosystem_app ON %I AS PERMISSIVE FOR ALL TO %I '
            'USING (true) WITH CHECK (true)',
            t, app_user
        );
    END LOOP;
END $$;

-- Install-time helper only; the application role must not keep it.
DROP FUNCTION pb_reset_policies(TEXT);

-- Audit data lives in MongoDB (`audit_events`), not in Postgres.

\echo ''
\echo '=== RLS POLICIES INSTALLED ==='
\echo 'FORCE + org scope (SELECT carve-outs; own-org INSERT/UPDATE/DELETE) on every tenant table (33/33):'
\echo ' - dashboards, dashboard_panels, org_alert_destinations, org_alert_rules'
\echo ' - messages (+ recipient read-state update), message_attachments, pipeline_registry'
\echo ' - pipeline_templates, all compliance_* tables incl. compliance_entitlement_watermark'
\echo ' - plugins, pipelines, pipeline_events, DORA tables (hot path)'
\echo ' - pipeline_step_manifests, plugin_installs, plugin_install_policies, plugin_advisory_deliveries'
\echo 'App-role-only policy (no FORCE) on the 18 ecosystem-global tables'

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

-- ============================================================================
-- Ecosystem public reader role (anonymous plugin directory, §6a G28)
-- ============================================================================
-- The public directory API connects as ecosystem_public_reader. It may read the
-- two public_* views and nothing else: no base-table grant, no DML, no
-- sequences, and it is never named in ALTER DEFAULT PRIVILEGES (so tables
-- created later don't reach it either). The ecosystem-global tables' RLS policy
-- names only the app role, so even a stray base-table GRANT would return zero
-- rows to it; the org-scoped tables fail closed for it (no app.org_id).
--
-- The password comes from ECOSYSTEM_PUBLIC_READER_PASSWORD (read with \getenv,
-- like DB_PASSWORD above). The role is OPTIONAL: when the variable is unset,
-- creation is skipped with a NOTICE and the public directory stays off. An
-- existing role is still (re)locked to the view-only grants below.
\getenv pb_reader_password ECOSYSTEM_PUBLIC_READER_PASSWORD
\if :{?pb_reader_password}
\else
\set pb_reader_password ''
\endif
SELECT set_config('pb.reader_password', :'pb_reader_password', false) AS pb_reader_password_set \gset
\unset pb_reader_password
\unset pb_reader_password_set

DO $$
DECLARE
    reader_password TEXT := current_setting('pb.reader_password');
BEGIN
    IF current_setting('pb.app_user') = 'ecosystem_public_reader' THEN
        RAISE EXCEPTION 'postgres-init: DB_USER must not be ecosystem_public_reader (the view-only public directory role)';
    END IF;
    IF reader_password = '' THEN
        RAISE NOTICE 'postgres-init: ECOSYSTEM_PUBLIC_READER_PASSWORD is unset; not creating/updating ecosystem_public_reader (public plugin directory disabled)';
    ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecosystem_public_reader') THEN
        EXECUTE format('ALTER ROLE ecosystem_public_reader WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD %L', reader_password);
    ELSE
        EXECUTE format('CREATE ROLE ecosystem_public_reader WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD %L', reader_password);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecosystem_public_reader') THEN
        -- Start from nothing on every run, then grant exactly the views.
        REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ecosystem_public_reader;
        REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ecosystem_public_reader;
        EXECUTE format('GRANT CONNECT ON DATABASE %I TO ecosystem_public_reader', current_database());
        GRANT USAGE ON SCHEMA public TO ecosystem_public_reader;
        GRANT SELECT ON public_listings, public_listed_versions, public_advisories, public_reviews TO ecosystem_public_reader;
    END IF;
END $$;
SELECT set_config('pb.reader_password', '', false) AS pb_reader_password_cleared \gset

\echo ''
\echo '=== SCHEMA UPDATE COMPLETE ==='
