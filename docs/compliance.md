---
layout: default
title: Compliance
---

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

**Each organization owns its compliance.** The system org does not enforce rules on other organizations. Instead, it publishes recommended rules that any organization can browse, subscribe to, and customize. Independent organizations relate as peers via this catalog. The one exception is the org → team hierarchy: a parent organization's rule marked **apply to child teams** (`propagateToChildren`) is inherited and enforced on its nested teams.

When validating an entity, the engine merges two rule sets:
1. **Org rules** — rules the org created for itself
2. **Subscribed published rules** — rules the org opted into from the published catalog

Results are cached per org+target (configurable TTL, default 60s). Caches are invalidated automatically on rule mutations and subscription changes.

Inline validation (upload/create) is synchronous and blocking. Existing entities are re-evaluated asynchronously: plugin/pipeline mutations enqueue events on a Redis-backed (BullMQ) queue that a background worker drains under each event's own tenant scope, so already-deployed entities stay continuously checked without slowing down the request path. Bulk and scheduled scans reuse the same engine to sweep an org's entire inventory on demand or on a cron.

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
| `GET` | `/compliance/published-rules` | Browse published rules (filterable, includes `subscribed` flag) |
| `GET` | `/compliance/subscriptions` | List org's subscriptions (with rule details) |
| `POST` | `/compliance/subscriptions` | Subscribe to a published rule |
| `POST` | `/compliance/subscriptions/clone` | Clone a published rule into an editable org rule |
| `POST` | `/compliance/subscriptions/auto-subscribe` | Subscribe to all published rules (inactive; used at org onboarding) |
| `PATCH` | `/compliance/subscriptions/:ruleId` | Activate or deactivate a subscription (`{ isActive: boolean }`) |
| `POST` | `/compliance/subscriptions/bulk` | Activate/deactivate many subscriptions at once (`{ ruleIds, isActive }`) |
| `GET` | `/compliance/subscriptions/enforced` | Merged view of all currently-enforced rules (org + active subscriptions) |
| `POST` | `/compliance/subscriptions/preview/impact` | See how many of the org's existing entities a rule would fail, with samples — before enabling it |
| `POST` | `/compliance/subscriptions/preview` | Dry-run a rule against caller-supplied sample attributes |
| `POST` | `/compliance/subscriptions/:ruleId/pin` | Pin a subscription to the rule's current version |
| `DELETE` | `/compliance/subscriptions/:ruleId/pin` | Unpin (follow latest published version) |
| `DELETE` | `/compliance/subscriptions/:ruleId` | Unsubscribe |

### Scans

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/compliance/scans` | List scans (filterable by target, status) |
| `GET` | `/compliance/scans/:id` | Get scan by ID |
| `POST` | `/compliance/scans` | Trigger a scan (`{ target: 'plugin' \| 'pipeline' \| 'all' }`) |
| `POST` | `/compliance/scans/:id/cancel` | Cancel a running scan |

### Scan Schedules

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/compliance/scan-schedules` | List recurring scan schedules |
| `POST` | `/compliance/scan-schedules` | Create schedule (`{ target, cronExpression }`) |
| `PUT` | `/compliance/scan-schedules/:id` | Update schedule target or cron |
| `PATCH` | `/compliance/scan-schedules/:id/active` | Toggle active (`{ isActive: boolean }`) |
| `DELETE` | `/compliance/scan-schedules/:id` | Deactivate schedule |

Cron expressions use standard 5-field format (`minute hour dayOfMonth month dayOfWeek`). Examples: `0 * * * *` (hourly), `*/15 * * * *` (every 15 min), `0 6 * * 1` (Monday 6am).

### Validation

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/compliance/validate/plugin` | Validate plugin attributes (blocking) |
| `POST` | `/compliance/validate/pipeline` | Validate pipeline attributes (blocking) |
| `POST` | `/compliance/validate/plugin/dry-run` | Pre-flight check (no audit/notification) |
| `POST` | `/compliance/validate/pipeline/dry-run` | Pre-flight check (no audit/notification) |

### Policies

Policies are named groups of rules (e.g. SOC2, Security Baseline) so a team can manage a whole compliance standard as one unit.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/compliance/policies` | List policies (filterable, paginated) |
| `GET` | `/compliance/policies/:id` | Get policy by ID |
| `POST` | `/compliance/policies` | Create policy |
| `PUT` | `/compliance/policies/:id` | Update policy |
| `DELETE` | `/compliance/policies/:id` | Delete policy |

### Exemptions

Exemptions waive a specific rule for a specific entity, with an approval workflow so the waiver is auditable.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/compliance/exemptions` | List exemptions (filterable) |
| `POST` | `/compliance/exemptions` | Request an exemption for a rule + entity |
| `POST` | `/compliance/exemptions/bulk` | Request exemptions for multiple entities |
| `PUT` | `/compliance/exemptions/:id/review` | Approve or reject an exemption |
| `DELETE` | `/compliance/exemptions/:id` | Revoke an exemption |

### Templates & Audit

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/compliance/templates` | List built-in rule templates |
| `POST` | `/compliance/templates/apply` | Instantiate a template as an org rule |
| `GET` | `/compliance/audit` | Query the audit log (filterable by target, result, entity) |

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
| `regex` | Pattern match (pattern length capped, default 100 chars; configurable via `COMPLIANCE_MAX_REGEX_LENGTH`) |
| `exists` / `notExists` | Field presence |
| `notEmpty` | Field present and not empty (`''`, `0`, `false` count as empty) |
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

A condition can also depend on another rule via `dependsOnRule` — the rule is only evaluated when the referenced rule has passed, letting you chain rules conditionally.

---

## Scopes

| Scope | Created By | Enforcement |
|-------|-----------|-------------|
| `org` | Any org | Owning org only |
| `published` | System org | Orgs that subscribe (opt-in) |

**Org rules:** Any organization can create its own rules with `scope: "org"` (the default). These are private to that org — fully owned, editable, and deletable by the org. No other org can see or be affected by them.

**Published rules:** Only the system org can create rules with `scope: "published"`. These appear in the published catalog for teams to browse and subscribe to. Subscriptions start inactive — the team explicitly activates the ones they want enforced. Subscribed rules can be exempted per-entity, giving teams full control over their compliance posture.

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
    "violations": [{ "ruleName": "block-latest-version", "severity": "error", "field": "version" }]
  }
}
```

---

## Examples

### Create an org-scoped rule

Any org can create its own rules. Scope defaults to `"org"` (private to the creating org):

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
    "attributes": { "name": "my-plugin", "accessModifier": "public", "version": "latest" }
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

10 sample rules are included in `deploy/compliance/rules/`, each with a `rule.json` and `README.md`:

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

All sample rules are `published` scope — teams browse the catalog and subscribe to the ones they want to enforce.

Five starter policies (named rule groups) ship alongside them in `deploy/compliance/policies/`: `security-baseline`, `production-readiness`, `quality-standards`, `naming-conventions`, and `cost-optimization`. `load-compliance.sh` loads both the rules and these policy templates.

Load them during init or standalone:

```bash
./deploy/bin/init-platform.sh                           # prompted during init
PLATFORM_TOKEN="$JWT" ./deploy/bin/load-compliance.sh   # standalone (rules + policies)
```

Add your own by creating `deploy/compliance/rules/<name>/rule.json` + `README.md`.

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
| `COMPLIANCE_SERVICE_HOST` | `compliance` | Hostname (used by plugin/pipeline services to reach compliance) |
| `COMPLIANCE_SERVICE_PORT` | `3000` | Port |
| `CACHE_TTL_COMPLIANCE_RULES` | `60` | Active rules cache TTL (seconds) |
| `COMPLIANCE_AUDIT_RETENTION_DAYS` | `180` | Audit log retention (daily prune) |
| `COMPLIANCE_MAX_REGEX_LENGTH` | `100` | Max length of a user-supplied `regex` pattern |
| `COMPLIANCE_MAX_ATTRIBUTE_DEPTH` | `10` | Max nesting depth of entity attributes evaluated |
| `COMPLIANCE_MAX_ATTRIBUTE_KEYS` | `100` | Max number of attribute keys evaluated |
| `COMPLIANCE_SCAN_CONCURRENCY` | `10` | Concurrent entities evaluated per bulk scan |
| `COMPLIANCE_SCAN_PROGRESS_BATCH_SIZE` | `10` | Scan progress flush batch size |
| `REDIS_HOST` | `redis` | Redis host (BullMQ async re-validation queue) |
| `REDIS_PORT` | `6379` | Redis port |
| `MESSAGE_SERVICE_HOST` | `message` | Message service (notifications) |
| `PLUGIN_SERVICE_HOST` | `plugin` | Plugin service (bulk scans) |
| `PIPELINE_SERVICE_HOST` | `pipeline` | Pipeline service (bulk scans) |

---

## Deployment

| Environment | Configuration |
|-------------|---------------|
| Local | `deploy/local/docker/docker-compose.yml` — `compliance` service |
| Minikube | `deploy/local/minikube/k8s/compliance.yaml` |
| AWS EC2 | `deploy/aws/ec2/k8s/compliance.yaml` |
| AWS EKS | `deploy/aws/eks/k8s/compliance.yaml` |

Nginx proxies `/api/compliance` to the compliance service in all environments.
