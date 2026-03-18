# require-pipeline-naming-convention

Enforces a consistent naming convention for pipelines: lowercase letters, digits, and hyphens only, between 3 and 64 characters, starting with a letter.

**Target:** pipeline
**Severity:** warning
**Scope:** published (opt-in via subscription)
**Priority:** 20

## Rule Logic

| Field | Operator | Value |
|-------|----------|-------|
| `name` | `regex` | `^[a-z][a-z0-9-]{2,63}$` |

## Rationale

Consistent naming makes pipelines easier to find, sort, and reference in scripts and IaC. This convention aligns with AWS resource naming constraints and DNS-safe identifiers.

## Examples

| Name | Result |
|------|--------|
| `my-build-pipeline` | pass |
| `api-deploy-v2` | pass |
| `My Pipeline` | fail (uppercase, spaces) |
| `ab` | fail (too short) |
| `123-start` | fail (starts with digit) |

## Tags

`naming`, `convention`, `quality`
