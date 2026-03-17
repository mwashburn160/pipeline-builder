# Compliance Service

Per-organization rule enforcement for plugins and pipelines. Validates entity attributes against configurable rules, blocks operations that violate policies, and notifies org admins.

**Design:** Fail-closed — if the compliance service is unreachable, plugin uploads and pipeline creates are rejected (HTTP 503).

---

## How It Works

```
Plugin/Pipeline Service                  Compliance Service
        │                                       │
        │  POST /compliance/validate/plugin      │
        ├──────────────────────────────────────►  │
        │                                       ├── Fetch org rules + subscribed rules
        │  { blocked: true, violations: [...] } │ ├── Evaluate rule engine
        │◄──────────────────────────────────────┤ ├── Write audit log
        │                                       │ └── Notify org admins
        │  403 COMPLIANCE_VIOLATION              │
```

**Each organization owns its compliance.** The system org does not enforce rules on sub-organizations. Instead, the system org publishes recommended rules that sub-orgs can browse, subscribe to, and customize.

When validating an entity, the engine merges two rule sets:
1. **Org rules** — rules the org created for itself
2. **Subscribed published rules** — rules the org opted into from the published catalog

Results are cached per org+target (configurable TTL, default 60s). Caches are invalidated automatically on rule mutations and subscription changes.

---

## API Endpoints

### Rules CRUD

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/compliance/rules` | List rules (filterable, paginated) |
| `GET` | `/compliance/rules/:id` | Get rule by ID |
| `GET` | `/compliance/rules/:id/history` | Rule change history |
| `POST` | `/compliance/rules` | Create rule |
| `PUT` | `/compliance/rules/:id` | Update rule |
| `DELETE` | `/compliance/rules/:id` | Soft-delete rule |

### Published Catalog & Subscriptions

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/compliance/published-rules` | Browse published rules (includes `subscribed` flag) |
| `GET` | `/compliance/subscriptions` | List org's active subscriptions |
| `POST` | `/compliance/subscriptions` | Subscribe to a published rule |
| `DELETE` | `/compliance/subscriptions/:ruleId` | Unsubscribe |

### Validation

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/compliance/validate/plugin` | Validate plugin attributes (blocking) |
| `POST` | `/compliance/validate/pipeline` | Validate pipeline attributes (blocking) |
| `POST` | `/compliance/validate/plugin/dry-run` | Pre-flight check (no audit/notification) |
| `POST` | `/compliance/validate/pipeline/dry-run` | Pre-flight check (no audit/notification) |

---

## Rule Schema

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique name within the org |
| `target` | `plugin` \| `pipeline` | Entity type |
| `severity` | `warning` \| `error` \| `critical` | `warning` = non-blocking; `error`/`critical` = blocking |
| `field` | string | Attribute to check (supports dot-notation and `$count()`, `$length()`) |
| `operator` | enum | One of the operators below |
| `value` | any | Expected value |
| `priority` | 0–10000 | Higher = evaluated first |
| `scope` | `org` \| `published` | See [Scopes](#scopes) |
| `tags` | string[] | Categorization (e.g. `["security"]`) |
| `conditions` | array | Multi-field rules (see [Conditions](#cross-field-conditions)) |
| `conditionMode` | `all` \| `any` | How conditions combine |

### Operators

| Operator | Description |
|----------|-------------|
| `eq` / `neq` | Equals / not equals |
| `gt` / `gte` / `lt` / `lte` | Numeric comparison |
| `contains` / `notContains` | String or array contains |
| `in` / `notIn` | Value in set |
| `regex` | Pattern match (max 200 chars) |
| `exists` / `notExists` | Field presence |
| `countGt` / `countLt` | Array/object count |
| `lengthGt` / `lengthLt` | String length |

### Computed Fields

| Function | Example |
|----------|---------|
| `$count(field)` | `$count(stages)` — array length |
| `$length(field)` | `$length(name)` — string length |
| `$keys(field)` | `$keys(env)` — object keys as array |
| `$lines(field)` | `$lines(dockerfile)` — line count |

### Cross-Field Conditions

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

Conditions can also reference other rules via `dependsOnRule`.

---

## Scopes

| Scope | Created By | Enforcement |
|-------|-----------|-------------|
| `org` | Any org | Owning org only |
| `published` | System org | Orgs that subscribe (opt-in) |

The system org **publishes** recommended rules but does not enforce them. Each sub-organization decides which published rules to adopt by subscribing. Subscribed rules can be exempted per-entity, giving orgs full control over their compliance posture.

---

## Enforcement

| Trigger | Behavior |
|---------|----------|
| Plugin upload (`POST /api/plugin/upload`) | Blocked (403) if `error` or `critical` violations |
| Pipeline create (`POST /api/pipeline`) | Blocked (403) if `error` or `critical` violations |

Warnings are logged and returned but do not block. Blocked responses include violation details:

```json
{
  "success": false,
  "status": 403,
  "code": "COMPLIANCE_VIOLATION",
  "details": {
    "violations": [{ "ruleName": "block-latest-image-tag", "severity": "error", "field": "imageTag" }]
  }
}
```

---

## Examples

### Create a rule

```bash
curl -X POST https://localhost:8443/api/compliance/rules \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "no-public-plugins",
    "target": "plugin",
    "severity": "critical",
    "field": "accessModifier",
    "operator": "neq",
    "value": "public"
  }'
```

### Dry-run validation

```bash
curl -X POST https://localhost:8443/api/compliance/validate/plugin/dry-run \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "attributes": { "name": "my-plugin", "accessModifier": "public", "imageTag": "latest" }
  }'
```

### Subscribe to a published rule

```bash
curl -X POST https://localhost:8443/api/compliance/subscriptions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "ruleId": "<published-rule-id>" }'
```

---

## Sample Rules

10 sample rules are included in `deploy/rules/`, each with a `rule.json` and `README.md`:

| Rule | Target | Severity |
|------|--------|----------|
| `require-plugin-description` | plugin | warning |
| `block-latest-image-tag` | plugin | error |
| `require-pipeline-naming-convention` | pipeline | warning |
| `max-pipeline-stages` | pipeline | warning |
| `require-plugin-version-semver` | plugin | error |
| `require-plugin-keywords` | plugin | warning |
| `enforce-pipeline-timeout` | pipeline | error |
| `recommended-compute-type` | pipeline | warning |
| `block-privileged-plugins` | plugin | critical |
| `restrict-public-access` | plugin | error |

All sample rules are `published` scope — sub-organizations browse the catalog and subscribe to the ones they want to enforce.

Load them during init or standalone:

```bash
./deploy/bin/init-platform.sh                              # prompted during init
PLATFORM_TOKEN="$JWT" ./deploy/bin/load-compliance-rules.sh  # standalone
```

Add your own by creating `deploy/rules/<name>/rule.json` + `README.md`.

---

## Database Tables

| Table | Purpose |
|-------|---------|
| `compliance_rules` | Rule definitions |
| `compliance_rule_subscriptions` | Org subscriptions to published rules |
| `compliance_rule_history` | Rule change audit trail |
| `compliance_policies` | Named rule groups (SOC2, Security Baseline) |
| `compliance_audit_log` | Every check result (pass/warn/block) |
| `compliance_exemptions` | Per-entity exemptions from rules |
| `compliance_scans` | Bulk scan tracking |
| `compliance_scan_schedules` | Recurring scan schedules |
| `compliance_notification_preferences` | Per-org notification config |
| `compliance_notification_log` | Notification delivery history |
| `compliance_roles` | Compliance RBAC (viewer/editor/admin) |
| `compliance_reports` | Generated reports |
| `compliance_report_schedules` | Recurring report schedules |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPLIANCE_SERVICE_HOST` | `compliance` | Hostname (used by plugin/pipeline services) |
| `COMPLIANCE_SERVICE_PORT` | `3000` | Port |
| `COMPLIANCE_RULES_CACHE_TTL_SECONDS` | `60` | Active rules cache TTL |
| `COMPLIANCE_AUDIT_RETENTION_DAYS` | `90` | Audit log retention |
| `COMPLIANCE_RATE_LIMIT` | `100` | Max validations per minute per org |
| `MESSAGE_SERVICE_HOST` | `message` | Message service (notifications) |
| `PLUGIN_SERVICE_HOST` | `plugin` | Plugin service (bulk scans) |
| `PIPELINE_SERVICE_HOST` | `pipeline` | Pipeline service (bulk scans) |

---

## Deployment

| Environment | Configuration |
|-------------|---------------|
| Local | `deploy/local/docker-compose.yml` — `compliance` service |
| Minikube | `deploy/minikube/k8s/compliance.yaml` |
| EC2 | Same K8s manifest via minikube |

Nginx proxies `/api/compliance` to the compliance service in all environments.
