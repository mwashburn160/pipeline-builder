# block-latest-image-tag

Blocks plugins that use the `latest` Docker image tag. Using `latest` leads to non-reproducible builds because the underlying image can change without notice.

**Target:** plugin
**Severity:** error (blocking)
**Scope:** published (opt-in via subscription)
**Priority:** 90

## Rule Logic

| Field | Operator | Value |
|-------|----------|-------|
| `imageTag` | `neq` | `latest` |

The rule passes when `imageTag` is anything other than `latest`. If a plugin specifies `latest`, the upload is blocked.

## Rationale

The `latest` tag is mutable — the image it points to changes over time. This means a pipeline that worked yesterday may break today with no code changes. Pinning to a specific version (e.g. `1.2.3`, `20-alpine`) ensures deterministic, auditable builds.

## Remediation

Replace `latest` with a specific version tag in your plugin's Dockerfile or spec:

```yaml
# Before
imageTag: latest

# After
imageTag: 20-alpine
```

## Tags

`security`, `docker`, `reproducibility`
