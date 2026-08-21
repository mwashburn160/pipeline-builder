# require-plugin-version-semver

Requires plugin versions to follow semantic versioning (SemVer) format: `MAJOR.MINOR.PATCH`. This blocks uploads with non-standard version strings.

**Target:** plugin
**Severity:** error (blocking)
**Scope:** published (opt-in via subscription)
**Priority:** 50

## Rule Logic

| Field | Operator | Value |
|-------|----------|-------|
| `version` | `regex` | `^\d+\.\d+\.\d+$` |

## Rationale

Semantic versioning enables automated dependency resolution and makes it clear when breaking changes are introduced. Non-standard versions (e.g. `v1`, `latest`, `2024-01-15`) break tooling and make it impossible to reason about compatibility.

## Examples

| Version | Result |
|---------|--------|
| `1.0.0` | pass |
| `12.3.45` | pass |
| `v1.0.0` | fail (leading `v`) |
| `1.0` | fail (missing patch) |
| `latest` | fail |

## Tags

`versioning`, `quality`, `semver`
