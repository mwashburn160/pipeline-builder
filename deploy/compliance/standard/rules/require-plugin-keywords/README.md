# require-plugin-keywords

Requires plugins to include at least one keyword in their spec. Keywords power catalog search and filtering.

**Target:** plugin
**Severity:** warning
**Scope:** published (opt-in via subscription)
**Priority:** 8

## Rule Logic

| Field | Operator | Value |
|-------|----------|-------|
| `$count(keywords)` | `gt` | `0` |

Uses the `$count()` computed field to verify the `keywords` array has at least one entry.

## Rationale

The plugin catalog supports keyword-based search and filtering. Plugins without keywords are effectively invisible when users browse by category. Adding even one relevant keyword (e.g. `nodejs`, `security`, `deploy`) dramatically improves discoverability.

## Remediation

Add a `keywords` array to your plugin spec:

```yaml
keywords:
  - nodejs
  - typescript
  - build
```

## Tags

`quality`, `discoverability`, `catalog`
