// GENERATED — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SPDX-License-Identifier: Apache-2.0

/** A help topic, keyed by the `docs/` file it was generated from. */
export interface HelpTopicRef {
  id: string;
  title: string;
}

/**
 * `docs/<file>.md` -> the in-app help topic generated from it.
 *
 * Lets an Ask citation (`{ id: 'authentication.md' }`) resolve to the topic
 * carrying the same content, so the reader stays in the dashboard. A doc with
 * no topic (the indexes, the contributor docs) is simply absent — callers fall
 * back to the public docs site.
 */
export const HELP_TOPIC_BY_DOC: Record<string, HelpTopicRef> = {
  'docs/organization-benefits.md': { id: 'organization-benefits', title: "Organization Benefits" },
  'docs/architecture-flow.md': { id: 'architecture-flow', title: "Architecture & Flow" },
  'docs/developer-guide.md': { id: 'developer-guide', title: "Developer Guide" },
  'docs/templates.md': { id: 'templates', title: "Templates" },
  'docs/metadata-keys.md': { id: 'metadata-keys', title: "Metadata Keys" },
  'docs/cdk-usage.md': { id: 'cdk-usage', title: "CDK Usage" },
  'docs/samples.md': { id: 'samples', title: "Samples" },
  'docs/compliance.md': { id: 'compliance', title: "Compliance" },
  'docs/audit-events.md': { id: 'audit-events', title: "Audit Events" },
  'docs/api-reference.md': { id: 'api-reference', title: "API Reference" },
  'docs/environment-variables.md': { id: 'env-variables', title: "Environment Variables" },
  'docs/aws-deployment.md': { id: 'deployment', title: "Deployment" },
  'docs/pipeline-manager.md': { id: 'cli-reference', title: "CLI Reference" },
  'docs/onboarding.md': { id: 'onboarding', title: "Onboarding an Organization" },
  'docs/plugin-publishing.md': { id: 'plugin-publishing', title: "Plugin Publishing" },
  'docs/plugin-installing.md': { id: 'plugin-installing', title: "Plugin Installing" },
  'docs/developer-portal.md': { id: 'developer-portal', title: "Developer Portal" },
  'docs/authentication.md': { id: 'authentication', title: "Authentication & SSO" },
  'docs/permissions.md': { id: 'permissions', title: "Roles & Permissions" },
  'docs/billing-providers.md': { id: 'billing-providers', title: "Billing Providers" },
  'docs/billing-bundles.md': { id: 'billing-bundles', title: "Billing Add-on Bundles" },
  'docs/billing-discounts.md': { id: 'billing-discounts', title: "Billing Discounts" },
  'docs/deploy-operations.md': { id: 'deploy-operations', title: "Deploy Operations" },
  'docs/service-mesh.md': { id: 'service-mesh', title: "Service Mesh" },
  'docs/observability-logs.md': { id: 'observability-logs', title: "Logs" },
  'docs/notifications.md': { id: 'notifications', title: "Notifications" },
  'docs/dora-metrics.md': { id: 'dora-metrics', title: "DORA Metrics" },
  'docs/stakeholder-reports.md': { id: 'stakeholder-reports', title: "Stakeholder Reports" },
  'docs/incidents-webhook.md': { id: 'incidents-webhook', title: "Incident Webhook" },
  'docs/oncall-paging.md': { id: 'oncall-paging', title: "On-call Paging" },
  'docs/support.md': { id: 'support', title: "Support" },
  'docs/runbooks/postgres-failover.md': { id: 'runbook-postgres-failover', title: "Runbook: Postgres Failover" },
  'docs/runbooks/postgres-scaling.md': { id: 'runbook-postgres-scaling', title: "Runbook: Postgres Scaling" },
  'docs/runbooks/secret-rotation.md': { id: 'runbook-secret-rotation', title: "Runbook: Secret Rotation" },
  'docs/runbooks/access-key-cutover.md': { id: 'runbook-access-keys', title: "Runbook: Access Keys & Machine Credentials" },
  'docs/runbooks/ecosystem-moderation.md': { id: 'runbook-ecosystem-moderation', title: "Runbook: Ecosystem Moderation" },
  'docs/error-handling.md': { id: 'error-handling', title: "Error Handling" },
};
