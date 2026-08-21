// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ShieldCheck } from 'lucide-react';
import type { HelpTopic } from './types';

export const complianceTopic: HelpTopic = {
  id: 'compliance',
  title: 'Compliance',
  description: 'Per-organization rule enforcement for plugins and pipelines',
  icon: ShieldCheck,
  sections: [
    {
      id: 'overview',
      title: 'Overview',
      blocks: [
        {
          type: 'text',
          content:
            'The Compliance service enforces per-organization rules on plugins and pipelines. It validates entity attributes against configurable rules, blocks operations that violate policies, writes an audit log, and notifies org admins.',
        },
        {
          type: 'warning',
          content:
            'Fail-closed design: if the compliance service is unreachable, plugin uploads and pipeline creates are rejected (HTTP 503).',
        },
        {
          type: 'text',
          content:
            'Each organization owns its compliance. The system org does not enforce rules on other orgs — it publishes recommended rules that any org can browse, subscribe to, and customize. The one exception is the org → team hierarchy: a parent org rule marked apply-to-child-teams (propagateToChildren) is inherited by nested teams.',
        },
      ],
    },
    {
      id: 'how-it-works',
      title: 'How It Works',
      blocks: [
        {
          type: 'text',
          content:
            'When validating an entity, the engine merges two rule sets: (1) org rules the org created for itself, and (2) subscribed published rules the org opted into from the catalog. Results are cached per org+target (default 60s TTL) and invalidated on rule mutations and subscription changes.',
        },
        {
          type: 'text',
          content:
            'Inline validation (upload/create) is synchronous and blocking. Existing entities are re-evaluated asynchronously: plugin/pipeline mutations enqueue events on a Redis-backed (BullMQ) queue drained by a background worker under each event\'s tenant scope. Bulk and scheduled scans reuse the same engine to sweep an org\'s inventory on demand or on a cron.',
        },
      ],
    },
    {
      id: 'rule-schema',
      title: 'Rule Schema',
      blocks: [
        {
          type: 'table',
          headers: ['Field', 'Type', 'Description'],
          rows: [
            ['name', 'string', 'Unique name within the org'],
            ['target', 'plugin | pipeline', 'Entity type'],
            ['severity', 'warning | error | critical', 'warning = non-blocking; error/critical = blocking'],
            ['field', 'string', 'Attribute to check (dot-notation, $count(), $length())'],
            ['operator', 'enum', 'One of the operators below'],
            ['value', 'any', 'Expected value'],
            ['priority', '0–10000', 'Higher = evaluated first'],
            ['scope', 'org | published', 'Org-private or published catalog'],
            ['tags', 'string[]', 'Categorization (e.g. ["security"])'],
            ['conditions', 'array', 'Multi-field rules'],
            ['conditionMode', 'all | any', 'How conditions combine'],
          ],
        },
        {
          type: 'note',
          content:
            'A condition can depend on another rule via dependsOnRule — it is only evaluated when the referenced rule has passed, letting you chain rules conditionally.',
        },
      ],
    },
    {
      id: 'operators',
      title: 'Operators & Computed Fields',
      blocks: [
        {
          type: 'table',
          headers: ['Operator', 'Description'],
          rows: [
            ['eq / neq', 'Equals / not equals'],
            ['gt / gte / lt / lte', 'Numeric comparison'],
            ['contains / notContains', 'String or array contains'],
            ['in / notIn', 'Value in set'],
            ['regex', 'Pattern match (length capped, default 100 chars)'],
            ['exists / notExists', 'Field presence'],
            ['notEmpty', "Present and not empty ('', 0, false count as empty)"],
            ['countGt / countLt', 'Array/object count'],
            ['lengthGt / lengthLt', 'String length'],
          ],
        },
        {
          type: 'text',
          content: 'Computed field functions can be used in the field expression:',
        },
        {
          type: 'list',
          items: [
            '$count(field) — array length, e.g. $count(stages)',
            '$length(field) — string length, e.g. $length(name)',
            '$keys(field) — object keys as array, e.g. $keys(env)',
            '$lines(field) — line count, e.g. $lines(dockerfile)',
          ],
        },
        {
          type: 'code',
          language: 'json',
          content: `{
  "name": "codebuild-timeout-limit",
  "target": "plugin",
  "severity": "error",
  "conditions": [
    { "field": "pluginType", "operator": "eq", "value": "CodeBuildStep" },
    { "field": "timeout", "operator": "lte", "value": 900 }
  ],
  "conditionMode": "all"
}`,
        },
      ],
    },
    {
      id: 'scopes',
      title: 'Scopes',
      blocks: [
        {
          type: 'table',
          headers: ['Scope', 'Created By', 'Enforcement'],
          rows: [
            ['org', 'Any org', 'Owning org only'],
            ['published', 'System org', 'Orgs that subscribe (opt-in)'],
          ],
        },
        {
          type: 'text',
          content:
            'Org rules (the default) are private to the creating org — fully owned, editable, and deletable, invisible to other orgs. Published rules can only be created by the system org and appear in the catalog. Subscriptions start inactive; the team explicitly activates the ones it wants enforced and can exempt them per-entity.',
        },
        {
          type: 'note',
          content:
            'Baseline (un-tagged) published rules are free to subscribe on every tier. Published rules that belong to a curated content set (tagged set:standard / set:advanced) require the matching add-on entitlement — see Curated Content Add-ons below.',
        },
      ],
    },
    {
      id: 'content-add-ons',
      title: 'Curated Content Add-ons (Standard / Advanced)',
      blocks: [
        {
          type: 'text',
          content:
            'The published catalog includes two curated content libraries sold as billing add-ons. They monetize the content — expert-maintained rule sets — while rule authoring stays free on every tier. Both are ordinary published rules under the system org, tagged by set (set:standard / set:advanced) and gated by a feature flag.',
        },
        {
          type: 'table',
          headers: ['Add-on', 'Feature flag', 'Content', 'Price', 'Availability'],
          rows: [
            [
              'Standard Compliance',
              'compliance_standard',
              'A "CI/CD Best Practices" library (~20 rules): require review stage, no hardcoded secrets, artifact retention, resource limits, pinned deps, …',
              '$29.90/mo · $299/yr',
              'Buy on Developer / Pro / Team · included in Enterprise / Unlimited',
            ],
            [
              'Advanced Compliance',
              'compliance_advanced',
              'SOC2, PCI-DSS, and CIS framework libraries (~75 rules), each rule tagged with its framework control id — requires Standard',
              '$99.90/mo · $999/yr',
              'Buy on Developer / Pro / Team (requires Standard) · included in Enterprise / Unlimited',
            ],
            [
              'Compliance Suite (combo)',
              'both',
              'Standard + Advanced together, 30% off',
              '$90.86/mo · $908.60/yr',
              'Buy on Developer / Pro / Team (grants both at once)',
            ],
          ],
        },
        {
          type: 'note',
          content:
            'Advanced requires Standard: the purchase route rejects adding Advanced alone (400). Buy Standard first and add Advanced, or buy the Compliance Suite combo to get both in one action. Cancelling Standard while Advanced is held cascade-cancels Advanced. Enterprise / Unlimited include both, so nothing is purchased there.',
        },
        {
          type: 'text',
          content:
            'Content is a shared reference, not a per-org copy. The curated rules exist once as system-org published rows; an org holds a lightweight subscription pointer (orgId, ruleId) that references the shared rule — it never copies it. One library of 30 rules serves 10,000 orgs as 30 rows plus pointer rows, not 300,000 copies, and fixing a shared rule updates it for every subscriber. Customizing a shared rule means forking it into an editable org-scoped copy — that is authoring, and it stays free.',
        },
        {
          type: 'warning',
          content:
            'The entitlement gate covers every path that pulls a set-tagged rule into an org: subscribe, activate, bulk-activate, clone, and preview/impact all require the matching entitlement (compliance_standard / compliance_advanced). Baseline (un-tagged) published rules stay free to subscribe on every tier.',
        },
        {
          type: 'text',
          content:
            'Entitlement lifecycle (auto-subscribe / deactivate). Holding the entitlement auto-subscribes and activates the org to every rule tagged for the set, so the library begins enforcing immediately — no manual subscribe step. Losing it (cancel at period-end or a tier downgrade) deactivates the set\'s subscriptions so those rules stop enforcing; the pointers are retained, so re-buying reactivates them with no re-subscribe. Cancel means "don\'t renew" — access persists until the paid period ends, with no mid-cycle revocation, proration, or refund.',
        },
        {
          type: 'text',
          content:
            'Enforcement (/compliance/validate) is entitlement-unaware: it reads the org\'s active subscriptions plus its own authored rules and never checks the feature flag directly. Billing keeps the active set in sync by pushing entitlement changes to the compliance service (the entitlements endpoints below); the reconcile is idempotent and every activate/deactivate is audit-logged.',
        },
        {
          type: 'note',
          content:
            'Authoring stays free. These add-ons gate only the curated libraries. Creating, editing, forking, and enforcing your own org-scoped rules (compliance:write) is ungated on every tier, regardless of which add-ons you hold. See Billing Add-on Bundles for pricing and combo mechanics.',
        },
      ],
    },
    {
      id: 'enforcement',
      title: 'Enforcement',
      blocks: [
        {
          type: 'table',
          headers: ['Trigger', 'Behavior'],
          rows: [
            ['Plugin upload (POST /api/plugin/upload)', 'Blocked (403) on error or critical violations'],
            ['Pipeline create (POST /api/pipeline)', 'Blocked (403) on error or critical violations'],
          ],
        },
        {
          type: 'text',
          content:
            'Warnings are logged and returned but do not block. Blocked responses include violation details:',
        },
        {
          type: 'code',
          language: 'json',
          content: `{
  "success": false,
  "status": 403,
  "code": "COMPLIANCE_VIOLATION",
  "details": {
    "violations": [
      { "ruleName": "block-latest-version", "severity": "error", "field": "version" }
    ]
  }
}`,
        },
      ],
    },
    {
      id: 'api',
      title: 'API Endpoints',
      blocks: [
        {
          type: 'text',
          content:
            'The service exposes CRUD for rules, the published catalog and subscriptions, content-set entitlements, scans, validation, policies, exemptions, and templates/audit. Key endpoints:',
        },
        {
          type: 'table',
          headers: ['Method', 'Endpoint', 'Description'],
          rows: [
            ['GET', '/compliance/rules', 'List rules (filterable, paginated)'],
            ['POST', '/compliance/rules', 'Create rule (org authoring — ungated on every tier)'],
            ['PUT', '/compliance/rules/:id', 'Update rule'],
            ['GET', '/compliance/published-rules', 'Browse published rules (subscribed flag)'],
            ['POST', '/compliance/subscriptions', 'Subscribe to a published rule (set-tagged rules require the matching entitlement)'],
            ['PATCH', '/compliance/subscriptions/:ruleId', 'Activate/deactivate a subscription (activate is entitlement-gated for set-tagged rules)'],
            ['GET', '/compliance/subscriptions/enforced', 'Merged view of currently-enforced rules'],
            ['POST', '/compliance/subscriptions/preview/impact', 'How many existing entities a rule would fail (entitlement-gated for set-tagged rules)'],
            ['GET', '/compliance/entitlements/:orgId', "The org's active compliance content sets"],
            ['PUT', '/compliance/entitlements/:orgId', 'Sync entitled sets (service-only; billing → compliance)'],
            ['POST', '/compliance/validate/plugin', 'Validate plugin attributes (blocking)'],
            ['POST', '/compliance/validate/pipeline/dry-run', 'Pre-flight check (no audit/notification)'],
            ['POST', '/compliance/scans', "Trigger a scan ({ target: 'plugin' | 'pipeline' | 'all' })"],
            ['POST', '/compliance/scan-schedules', 'Create recurring scan ({ target, cronExpression })'],
            ['POST', '/compliance/policies', 'Create a named rule group (e.g. SOC2)'],
            ['POST', '/compliance/exemptions', 'Request an exemption for a rule + entity'],
            ['PUT', '/compliance/exemptions/:id/review', 'Approve or reject an exemption'],
            ['GET', '/compliance/audit', 'Query the audit log (by target, result, entity)'],
          ],
        },
        {
          type: 'note',
          content:
            'Cron schedules use standard 5-field format (minute hour dayOfMonth month dayOfWeek). Examples: 0 * * * * (hourly), */15 * * * * (every 15 min), 0 6 * * 1 (Monday 6am).',
        },
        {
          type: 'note',
          content:
            'The content-set entitlement gate covers subscribe, activate, bulk-activate, clone, and preview/impact for set:standard / set:advanced rules — not just subscribe. Billing pushes entitlement changes to PUT /compliance/entitlements/:orgId (service-principal only); GET returns the org\'s active sets. See Curated Content Add-ons above.',
        },
      ],
    },
    {
      id: 'examples',
      title: 'Examples & Sample Rules',
      blocks: [
        {
          type: 'text',
          content: 'Create an org-scoped rule (scope defaults to "org", private to the creating org):',
        },
        {
          type: 'code',
          language: 'bash',
          content: `curl -X POST https://localhost:8443/api/compliance/rules \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "no-public-plugins",
    "target": "plugin",
    "severity": "critical",
    "field": "accessModifier",
    "operator": "neq",
    "value": "public"
  }'`,
        },
        {
          type: 'text',
          content:
            '10 published sample rules ship in deploy/compliance/rules/ (each with rule.json + README.md), alongside five starter policies in deploy/compliance/policies/: security-baseline, production-readiness, quality-standards, naming-conventions, and cost-optimization.',
        },
        {
          type: 'code',
          language: 'bash',
          content: `# Prompted during platform init
./deploy/bin/init-platform.sh

# Or load rules + policies standalone
PLATFORM_TOKEN="$JWT" ./deploy/bin/load-compliance.sh`,
        },
      ],
    },
  ],
};
