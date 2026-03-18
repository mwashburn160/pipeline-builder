# recommended-compute-type

Recommends using the standard small compute type (`BUILD_GENERAL1_SMALL`) for pipelines. This is a published rule that orgs can subscribe to for cost governance.

**Target:** pipeline
**Severity:** warning
**Scope:** published (opt-in via subscription)
**Priority:** 5

## Rule Logic

| Field | Operator | Value |
|-------|----------|-------|
| `computeType` | `eq` | `BUILD_GENERAL1_SMALL` |

## Rationale

Larger compute types (MEDIUM, LARGE, 2XLARGE) cost significantly more per build minute. Most build and test workloads run efficiently on small instances. This rule helps teams identify pipelines that may be over-provisioned.

## How to Subscribe

This is a **published** rule — it is not enforced by default. Organizations opt in by subscribing:

```
POST /api/compliance/subscriptions
{ "ruleId": "<rule-id>" }
```

Once subscribed, the rule is evaluated alongside the org's own rules.

## Tags

`cost`, `compute`, `optimization`
