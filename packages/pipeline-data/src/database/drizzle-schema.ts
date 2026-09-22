// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

//
// Barrel for the Drizzle schema. The table/type definitions live in per-domain
// files under `./schema/*`; this module re-exports every one of them so the
// public API is byte-identical to the previous single-file schema. Existing
// `import { ... } from '.../drizzle-schema'` sites and the aggregate `schema`
// object below both continue to resolve exactly as before.
//

export * from './schema/plugin.js';
export * from './schema/pipeline.js';
export * from './schema/pipeline-template.js';
export * from './schema/message.js';
export * from './schema/message-attachment.js';
export * from './schema/compliance.js';
export * from './schema/dashboard.js';
export * from './schema/alert.js';
export * from './schema/ecosystem.js';

import { orgAlertDestination, orgAlertRule } from './schema/alert.js';
import {
  compliancePolicy,
  complianceRule,
  complianceRuleHistory,
  complianceAuditLog,
  complianceExemption,
  complianceRuleSubscription,
  complianceScan,
  complianceScanSchedule,
  complianceNotificationPreference,
  complianceNotificationLog,
  complianceRole,
  complianceReport,
  complianceReportSchedule,
} from './schema/compliance.js';
import { dashboard, dashboardPanel } from './schema/dashboard.js';
import {
  publisher,
  pluginListing,
  pluginListingVersion,
  pluginAdvisory,
  ecosystemAutoApprovalRule,
  pluginPublishRequest,
  ecosystemReservedName,
  ecosystemSetting,
  ecosystemCollection,
  pluginReview,
  pluginReviewReply,
  pluginReviewReport,
  pluginReviewVote,
  pluginReviewHistory,
  pluginStats,
  pluginSubmission,
  ecosystemSearchMiss,
  ecosystemNotificationQueue,
  pipelineStepManifest,
  pluginInstall,
  pluginInstallPolicy,
  pluginAdvisoryDelivery,
} from './schema/ecosystem.js';
import { messageAttachment } from './schema/message-attachment.js';
import { message } from './schema/message.js';
import { pipelineTemplate } from './schema/pipeline-template.js';
import { pipeline, pipelineRegistry, pipelineEvent, deploymentOutcome, ingestHealth, incident, doraSettings } from './schema/pipeline.js';
import { plugin } from './schema/plugin.js';

/**
 * Complete Drizzle schema export
 */
export const schema = {
  plugin,
  pipeline,
  pipelineTemplate,
  message,
  messageAttachment,
  pipelineRegistry,
  pipelineEvent,
  // DORA post-deploy outcome markers + per-org ingestion health
  deploymentOutcome,
  ingestHealth,
  // Production incidents (webhook-ingested) → automated post-deploy CFR + MTTR
  incident,
  // Per-org DORA overrides (incident correlation window)
  doraSettings,
  // Observability dashboards (user-editable replacement for code-defined dashboards)
  dashboard,
  dashboardPanel,
  // Per-org alert notification destinations (multi-tenant alerting)
  orgAlertDestination,
  // per-org operator-authored alert rules  materialized into Prom YAML.
  orgAlertRule,
  // Compliance tables
  compliancePolicy,
  complianceRule,
  complianceRuleHistory,
  complianceAuditLog,
  complianceExemption,
  complianceRuleSubscription,
  complianceScan,
  complianceScanSchedule,
  complianceNotificationPreference,
  complianceNotificationLog,
  complianceRole,
  complianceReport,
  complianceReportSchedule,
  // Plugin ecosystem — instance-wide directory (no org_id; service-layer gated)
  publisher,
  pluginListing,
  pluginListingVersion,
  pluginAdvisory,
  ecosystemAutoApprovalRule,
  pluginPublishRequest,
  ecosystemReservedName,
  ecosystemSetting,
  ecosystemCollection,
  pluginReview,
  pluginReviewReply,
  pluginReviewReport,
  pluginReviewVote,
  pluginReviewHistory,
  pluginStats,
  pluginSubmission,
  ecosystemSearchMiss,
  ecosystemNotificationQueue,
  // Plugin ecosystem — org-scoped (org_id + RLS; in the org cascade)
  pipelineStepManifest,
  pluginInstall,
  pluginInstallPolicy,
  pluginAdvisoryDelivery,
  // (The public_listings / public_listed_versions views are exported from
  // ./schema/ecosystem but are not tables, so they are not listed here.)
} as const;
