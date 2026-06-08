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
            'The service exposes CRUD for rules, the published catalog and subscriptions, scans, validation, policies, exemptions, and templates/audit. Key endpoints:',
        },
        {
          type: 'table',
          headers: ['Method', 'Endpoint', 'Description'],
          rows: [
            ['GET', '/compliance/rules', 'List rules (filterable, paginated)'],
            ['POST', '/compliance/rules', 'Create rule'],
            ['PUT', '/compliance/rules/:id', 'Update rule'],
            ['GET', '/compliance/published-rules', 'Browse published rules (subscribed flag)'],
            ['POST', '/compliance/subscriptions', 'Subscribe to a published rule'],
            ['PATCH', '/compliance/subscriptions/:ruleId', 'Activate/deactivate a subscription'],
            ['GET', '/compliance/subscriptions/enforced', 'Merged view of currently-enforced rules'],
            ['POST', '/compliance/subscriptions/preview/impact', 'How many existing entities a rule would fail'],
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
