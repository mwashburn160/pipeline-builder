// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * WHO owns each org-scoped Postgres table — the map every org purge runs from.
 *
 * Platform's org purge used to write straight into ~45 tables that belong to
 * five other services. Now platform records one durable outbox leg per owning
 * service, and each service deletes ITS OWN slice through an idempotent
 * internal endpoint (`purgeOrgData(owner, orgId)` in `./org-data-purge.ts`).
 *
 * The map lives HERE, next to the schema, rather than in each service, for one
 * reason: it is what the drift guard reflects against. Every table with an
 * `org_id` column must appear under exactly one owner, or a deleted org's rows
 * outlive it — and a test can only assert that if the whole map is importable
 * in one place. It imports nothing but the schema, so a test can load it
 * without a database connection.
 *
 * `soft` tables carry `deleted_at` + `purge_after`: the purge TOMBSTONES them
 * with `purge_after = now`, so the owning service's own retention sweep
 * hard-removes them. `hard` tables have no `deleted_at` and are removed outright.
 */

import type { PgTable } from 'drizzle-orm/pg-core';
import { schema } from '../database/drizzle-schema.js';

/** A service that owns org-scoped Postgres rows. */
export type OrgDataOwner = 'platform' | 'ops-center' | 'pipeline' | 'plugin' | 'compliance' | 'message' | 'reporting';

/** One org-scoped table and its Postgres name. */
export interface OrgScopedTable {
  readonly table: PgTable;
  readonly name: string;
  /**
   * SQL column names that must never leave the owning service — not in an API
   * answer, a log, an audit entry, or the org-data EXPORT (which strips them
   * from every row). Absent = none.
   */
  readonly secretColumns?: readonly string[];
}

/** The tables one owner purges: tombstoned (`soft`) or removed (`hard`). */
export interface OrgDataSlice {
  readonly soft: readonly OrgScopedTable[];
  readonly hard: readonly OrgScopedTable[];
}

const t = (table: PgTable, name: string, secretColumns?: readonly string[]): OrgScopedTable => (
  secretColumns ? { table, name, secretColumns } : { table, name });

/**
 * Every org-scoped table, by the service that owns (writes) it. A new table with
 * an `org_id` column goes under its owner here, or the drift guard fails.
 */
export const ORG_DATA_OWNERSHIP: Readonly<Record<OrgDataOwner, OrgDataSlice>> = {
  // Platform's own Postgres data: the support contacts it designates
  // (platform's support-contacts controller).
  'platform': {
    soft: [],
    hard: [
      t(schema.supportContact, 'support_contacts'),
    ],
  },
  // The operations control plane: dashboards, the org's alert rules and alert
  // routing, and the routing's delivery health (moved out of platform).
  'ops-center': {
    soft: [
      t(schema.dashboard, 'dashboards'),
      t(schema.orgAlertDestination, 'org_alert_destinations'),
      t(schema.orgAlertRule, 'org_alert_rules'),
    ],
    hard: [
      t(schema.alertDestinationStatus, 'alert_destination_status'),
    ],
  },
  'pipeline': {
    soft: [
      t(schema.pipeline, 'pipelines'),
      t(schema.pipelineTemplate, 'pipeline_templates'),
    ],
    hard: [
      t(schema.pipelineRegistry, 'pipeline_registry'),
      t(schema.pipelineStepManifest, 'pipeline_step_manifests'),
      // Per-pipeline security state: what synth was told per step, and the
      // pipeline's own artifact-scan reports (findings name the org's code).
      t(schema.pipelineStepLookup, 'pipeline_step_lookups'),
      t(schema.pipelineSecurityReport, 'pipeline_security_reports'),
      t(schema.pipelinePluginResolution, 'pipeline_plugin_resolution'),
      // Cross-account runners (their reach-me URLs are org secrets) and the
      // run requests delivered to them.
      t(schema.pipelineRunner, 'pipeline_runners'),
      t(schema.pipelineRunRequest, 'pipeline_run_requests'),
      // The org's run-request signing keys (HARD: purge removes the rows, key
      // material and all — never tombstoned) and its key mode.
      t(schema.pipelineRunnerSigningKey, 'pipeline_runner_signing_keys', ['private_key_enc']),
      t(schema.pipelineRunnerKeySettings, 'pipeline_runner_key_settings'),
    ],
  },
  'plugin': {
    soft: [
      t(schema.plugin, 'plugins'),
    ],
    hard: [
      // The org-scoped half of the ecosystem. The instance-wide directory
      // (publishers, listings, reviews) carries no org_id and outlives the org.
      t(schema.pluginInstall, 'plugin_installs'),
      t(schema.pluginInstallPolicy, 'plugin_install_policies'),
      t(schema.pluginAdvisoryDelivery, 'plugin_advisory_deliveries'),
      t(schema.pluginSecurityNotificationPref, 'plugin_security_notification_prefs'),
      // Written for the system org only (never purged) — listed so the drift
      // guard holds, not because a tenant has rows.
      t(schema.pluginKeptSetupImage, 'plugin_kept_setup_images'),
      // The org's toolchain canary membership, default and default history.
      t(schema.toolchainRollout, 'toolchain_rollout'),
      t(schema.orgToolchainDefault, 'org_toolchain_default'),
      t(schema.orgToolchainDefaultHistory, 'org_toolchain_default_history'),
    ],
  },
  'compliance': {
    soft: [
      t(schema.compliancePolicy, 'compliance_policies'),
      t(schema.complianceRule, 'compliance_rules'),
    ],
    hard: [
      t(schema.complianceRuleHistory, 'compliance_rule_history'),
      t(schema.complianceAuditLog, 'compliance_audit_log'),
      t(schema.complianceExemption, 'compliance_exemptions'),
      t(schema.complianceRuleSubscription, 'compliance_rule_subscriptions'),
      t(schema.complianceScan, 'compliance_scans'),
      t(schema.complianceScanSchedule, 'compliance_scan_schedules'),
      t(schema.complianceNotificationPreference, 'compliance_notification_preferences'),
      t(schema.complianceNotificationLog, 'compliance_notification_log'),
    ],
  },
  'message': {
    soft: [
      t(schema.message, 'messages'),
      // Support cases ride the retention sweep like any other tenant record;
      // the conversation itself lives in `messages`.
      t(schema.supportCase, 'support_cases'),
    ],
    hard: [
      // Attachment METADATA rows. The MinIO blobs are reclaimed by the
      // message service's separate blob-purge leg (key prefix `<orgId>/`).
      t(schema.messageAttachment, 'message_attachments'),
      // The per-org case-number counter (a recreated org restarts at case 1) and
      // staff-only case notes (the one support table a tenant never reads).
      t(schema.supportCaseCounter, 'support_case_counters'),
      t(schema.supportCaseNote, 'support_case_notes'),
    ],
  },
  'reporting': {
    soft: [
      // Published runs are the frozen evidence of what an org told its
      // stakeholders — tombstoned, not dropped, so they keep the retention window.
      t(schema.reportDefinition, 'report_definitions'),
      t(schema.reportRun, 'report_runs'),
      t(schema.reportRecipient, 'report_recipients'),
    ],
    hard: [
      t(schema.pipelineEvent, 'pipeline_events'),
      t(schema.deploymentOutcome, 'deployment_outcomes'),
      t(schema.incident, 'incidents'),
      t(schema.ingestHealth, 'ingest_health'),
      t(schema.doraSettings, 'dora_settings'),
      // HARD-deleted, never tombstoned: a soft-deleted link row is still a live
      // token to the public route's hash lookup.
      t(schema.reportShareLink, 'report_share_links'),
      t(schema.doraDeployment, 'dora_deployments'),
      t(schema.executionDailyRollup, 'execution_daily_rollups'),
      t(schema.pluginVulnExposure, 'plugin_vuln_exposure'),
    ],
  },
};

/** Every org-scoped table name, across every owner — what the drift guard checks. */
export const ORG_SCOPED_TABLE_NAMES: ReadonlySet<string> = new Set(
  Object.values(ORG_DATA_OWNERSHIP).flatMap((s) => [...s.soft, ...s.hard].map((x) => x.name)),
);

/** Every org-scoped table, across every owner (the read-only export walks these). */
export function allOrgScopedTables(): OrgScopedTable[] {
  return Object.values(ORG_DATA_OWNERSHIP).flatMap((s) => [...s.soft, ...s.hard]);
}

/**
 * One exported row without the table's {@link OrgScopedTable.secretColumns}.
 * Rows read through drizzle carry camelCase keys, raw SQL rows snake_case, so
 * both spellings of each column are dropped.
 */
export function redactSecretColumns<R extends Record<string, unknown>>(scoped: OrgScopedTable, row: R): Partial<R> {
  if (!scoped.secretColumns?.length) return row;
  const drop = new Set(scoped.secretColumns.flatMap((c) => [c, c.replace(/_([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase())]));
  return Object.fromEntries(Object.entries(row).filter(([k]) => !drop.has(k))) as Partial<R>;
}
