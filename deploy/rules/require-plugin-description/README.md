# require-plugin-description

Ensures every plugin has a non-empty description field so users can understand what it does before adding it to a pipeline.

**Target:** plugin
**Severity:** warning
**Scope:** published (opt-in via subscription)
**Priority:** 10

## Rule Logic

| Field | Operator | Value |
|-------|----------|-------|
| `description` | `exists` | — |

## Rationale

Plugins without descriptions create confusion when browsing the catalog. This rule produces a warning (non-blocking) to nudge plugin authors toward better documentation without preventing uploads.

## Tags

`quality`, `documentation`
