# Compliance Service

Per-organization rule enforcement for plugins and pipelines. The compliance service validates entity attributes against configurable rules, blocking operations that violate policies and notifying org admins of violations.

**Related docs:** [API Reference](api-reference.md) | [Environment Variables](environment-variables.md) | [Plugin Catalog](plugins/README.md)

---

## Architecture

The compliance service is a standalone microservice that integrates with plugin and pipeline services via internal HTTP calls. It follows the same patterns as other services (CrudService, Express routes, Drizzle ORM).

```
Plugin/Pipeline Service                  Compliance Service
        │                                       │
        │  POST /compliance/validate/plugin      │
        ├──────────────────────────────────────►│
        │                                       ├── Fetch org rules
        │  { blocked: true, violations: [...] } │ ├── Evaluate rule engine
        │◄──────────────────────────────────────┤ ├── Write audit log
        │                                       │ └── Notify org admins
        │  403 COMPLIANCE_VIOLATION              │
        │                                       │
```

**Design:** Fail-closed. If the compliance service is unreachable, plugin uploads and pipeline creates are rejected (HTTP 503).

---

## Endpoints

### Rules

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/compliance/rules` | List rules (filterable, paginated) |
| `GET` | `/compliance/rules/:id` | Get rule by ID |
| `GET` | `/compliance/rules/:id/history` | Rule change history |
| `POST` | `/compliance/rules` | Create rule (admin only) |
| `PUT` | `/compliance/rules/:id` | Update rule |
| `DELETE` | `/compliance/rules/:id` | Soft-delete rule |

### Validation

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/compliance/validate/plugin` | Validate plugin attributes (blocking check) |
| `POST` | `/compliance/validate/pipeline` | Validate pipeline attributes (blocking check) |
| `POST` | `/compliance/validate/plugin/dry-run` | Pre-flight check (no audit, no notification) |
| `POST` | `/compliance/validate/pipeline/dry-run` | Pre-flight check (no audit, no notification) |

---

## Rules

A compliance rule defines a check against a specific field on a plugin or pipeline entity.

### Rule Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique rule name within the org |
| `target` | `plugin` \| `pipeline` | Entity type this rule applies to |
| `severity` | `warning` \| `error` \| `critical` | Warning allows operation; error/critical blocks |
| `field` | string | Entity attribute to check (dot-notation for nested) |
| `operator` | string | Comparison operator (see below) |
| `value` | any | Expected value for comparison |
| `priority` | number | Higher priority rules evaluated first (0-10000) |
| `scope` | `org` \| `global` | Org rules apply to owning org; global rules (system org only) apply to all orgs |
| `tags` | string[] | Categorization tags (e.g., `["security", "performance"]`) |
| `effectiveFrom` | ISO date | Rule not enforced before this date |
| `effectiveUntil` | ISO date | Rule auto-expires after this date |
| `suppressNotification` | boolean | Skip notifications for this rule's violations |

### Operators

| Operator | Description | Value Type |
|----------|-------------|------------|
| `eq` / `neq` | Equals / not equals | string, number, boolean |
| `gt` / `gte` / `lt` / `lte` | Numeric comparison | number |
| `contains` / `notContains` | String or array contains | string |
| `in` / `notIn` | Value in set | array |
| `regex` | Regex pattern match (max 200 chars) | string |
| `exists` / `notExists` | Field presence check | (none) |
| `countGt` / `countLt` | Array/object count comparison | number |
| `lengthGt` / `lengthLt` | String length comparison | number |

### Computed Fields

Use `$` prefix functions for derived values:

| Function | Description | Example |
|----------|-------------|---------|
| `$count(field)` | Array length or object key count | `$count(secrets)` > 3 |
| `$length(field)` | String character length | `$length(dockerfile)` > 5000 |
| `$keys(field)` | Object keys as array | `$keys(env)` contains "AWS_SECRET" |
| `$lines(field)` | Line count of string | `$lines(dockerfile)` > 100 |

### Cross-Field Conditions

Rules can have multiple conditions evaluated together:

```json
{
  "name": "codebuild-timeout-limit",
  "target": "plugin",
  "severity": "error",
  "conditions": [
    { "field": "pluginType", "operator": "eq", "value": "CodeBuildStep" },
    { "field": "timeout", "operator": "lte", "value": 900 }
  ],
  "conditionMode": "all"
}
```

This rule blocks CodeBuildStep plugins with timeout > 900s. Both conditions must be true (`all` mode) for the rule to pass.

### Dependent Rules

Conditions can reference other rules:

```json
{
  "conditions": [
    { "dependsOnRule": "rule-id-123" },
    { "field": "computeType", "operator": "eq", "value": "LARGE" }
  ]
}
```

This rule only evaluates if `rule-id-123` passed.

---

## Examples

### Create a rule that blocks public plugins

```bash
curl -X POST https://localhost:8443/api/compliance/rules \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-org-id: my-org" \
  -d '{
    "name": "no-public-plugins",
    "target": "plugin",
    "severity": "critical",
    "field": "accessModifier",
    "operator": "neq",
    "value": "public",
    "description": "Plugins must not be public"
  }'
```

### Create a rule that warns on large compute types

```bash
curl -X POST https://localhost:8443/api/compliance/rules \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-org-id: my-org" \
  -d '{
    "name": "warn-large-compute",
    "target": "plugin",
    "severity": "warning",
    "field": "computeType",
    "operator": "eq",
    "value": "LARGE",
    "tags": ["cost"]
  }'
```

### Pre-flight validation (dry-run)

```bash
curl -X POST https://localhost:8443/api/compliance/validate/plugin/dry-run \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-org-id: my-org" \
  -d '{
    "attributes": {
      "name": "my-plugin",
      "pluginType": "CodeBuildStep",
      "computeType": "LARGE",
      "accessModifier": "public"
    }
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "passed": false,
    "blocked": true,
    "violations": [
      {
        "ruleId": "...",
        "ruleName": "no-public-plugins",
        "field": "accessModifier",
        "operator": "neq",
        "expectedValue": "public",
        "actualValue": "public",
        "severity": "critical",
        "message": "Field \"accessModifier\" failed neq check"
      }
    ],
    "warnings": [],
    "rulesEvaluated": 2,
    "rulesSkipped": 0,
    "exemptionsApplied": []
  }
}
```

---

## Enforcement

Compliance checks are enforced at two points:

| Trigger | Endpoint Modified | Behavior |
|---------|-------------------|----------|
| Plugin upload | `POST /api/plugin/upload` | Blocked with 403 if violations with severity `error` or `critical` |
| Pipeline create | `POST /api/pipeline` | Blocked with 403 if violations with severity `error` or `critical` |

Warnings are logged but do not block the operation.

### Error Response

When a compliance violation blocks an operation:

```json
{
  "success": false,
  "status": 403,
  "error": "Plugin upload blocked by compliance rules",
  "code": "COMPLIANCE_VIOLATION",
  "details": {
    "violations": [
      {
        "ruleId": "...",
        "ruleName": "no-public-plugins",
        "severity": "critical",
        "message": "..."
      }
    ]
  }
}
```

---

## Entity Event Integration

The compliance service receives entity lifecycle events (create/update/delete) from plugin and pipeline services via the `EntityEventEmitter` system. This enables:

- **Drift detection:** when rules change, existing entities can be re-evaluated
- **Audit enrichment:** every entity mutation is logged with compliance context
- **Cache invalidation:** compliance status cached on entities is refreshed

Events are fire-and-forget — entity mutations are never blocked by event processing failures.

---

## Database Tables

| Table | Purpose |
|-------|---------|
| `compliance_policies` | Named rule groups (e.g., "SOC2", "Security Baseline") |
| `compliance_rules` | Individual rule definitions |
| `compliance_rule_history` | Change tracking for rules (versioning/rollback) |
| `compliance_audit_log` | Every compliance check result (pass/warn/block) |
| `compliance_exemptions` | Per-entity exemptions from specific rules |
| `compliance_scans` | Bulk scan tracking |
| `compliance_scan_schedules` | Cron-based recurring scans |
| `compliance_notification_preferences` | Per-org notification settings |
| `compliance_notification_log` | Notification delivery history |
| `compliance_roles` | Compliance-specific RBAC (viewer/editor/admin) |
| `compliance_reports` | Generated compliance reports |
| `compliance_report_schedules` | Recurring report generation |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPLIANCE_SERVICE_HOST` | `compliance` | Hostname for compliance service (used by plugin/pipeline services) |
| `COMPLIANCE_SERVICE_PORT` | `3000` | Port for compliance service |
| `MESSAGE_SERVICE_HOST` | `message` | Message service for notifications |
| `MESSAGE_SERVICE_PORT` | `3000` | Message service port |
| `PLUGIN_SERVICE_HOST` | `plugin` | Plugin service (for bulk scans) |
| `PIPELINE_SERVICE_HOST` | `pipeline` | Pipeline service (for bulk scans) |
| `COMPLIANCE_AUDIT_RETENTION_DAYS` | `90` | Days to retain audit log entries |
| `COMPLIANCE_RATE_LIMIT` | `100` | Max validation requests per minute per org |

---

## Deployment

The compliance service is deployed alongside other services in all environments:

| Environment | Configuration |
|-------------|---------------|
| Local | `deploy/local/docker-compose.yml` — `compliance` service |
| Minikube | `deploy/minikube/k8s/compliance.yaml` |
| EC2 | Uses same K8s manifest via minikube |
| Fargate | Add ECS service + Cloud Map registration |

Nginx routes are configured in all four nginx configs to proxy `/api/compliance` to the compliance service.
