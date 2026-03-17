# restrict-public-access

Blocks plugins from being set to public access. Public plugins are visible to all organizations and should go through an explicit review process.

**Target:** plugin
**Severity:** error (blocking)
**Scope:** published (opt-in via subscription)
**Priority:** 80

## Rule Logic

| Field | Operator | Value |
|-------|----------|-------|
| `accessModifier` | `neq` | `public` |

## Rationale

Public plugins are shared across the entire platform. Publishing a plugin publicly without review could:
- Expose proprietary build logic
- Distribute vulnerable or malicious images
- Create supply chain risks for other organizations

This rule ensures plugins remain private by default. Organizations that want to enforce this subscribe to the rule; those with a public plugin marketplace workflow can skip it.

## Remediation

Keep your plugin's access modifier as `private` or `protected`. To publish publicly, request an exemption and go through your organization's review process.

## Tags

`security`, `access-control`, `governance`
