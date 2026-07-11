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
export * from './schema/message.js';
export * from './schema/compliance.js';
export * from './schema/dashboard.js';
export * from './schema/alert.js';

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
import { message } from './schema/message.js';
import { pipeline, pipelineRegistry, pipelineEvent } from './schema/pipeline.js';
import { plugin } from './schema/plugin.js';

/**
 * Complete Drizzle schema export
 */
export const schema = {
  plugin,
  pipeline,
  message,
  pipelineRegistry,
  pipelineEvent,
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
} as const;
