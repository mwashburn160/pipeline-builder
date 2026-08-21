# block-latest-version

Blocks plugins whose `version` is the literal string `latest`. Using `latest` as a version makes builds non-reproducible because the underlying image bytes can change without notice.

**Target:** plugin
**Severity:** error (blocking)
**Scope:** published (opt-in via subscription)
**Priority:** 90

## Rule Logic

| Field | Operator | Value |
|-------|----------|-------|
| `version` | `neq` | `latest` |

The rule passes when `version` is anything other than `latest`. If a plugin specifies `latest`, the upload is blocked.

## Rationale

When the plugin `version` is the string `latest`, the registry tag — `<namespace>/<name>:<version>` → `<namespace>/<name>:latest` — is mutable: the image bytes pointed to by `:latest` change every time someone re-uploads with the same version. This means a pipeline that worked yesterday may break today with no code changes. Pinning to a specific semver (e.g. `1.2.3`) ensures deterministic, auditable builds.

## Remediation

Set a specific version in your plugin's `plugin-spec.yaml`:

```yaml
# Before
name: my-plugin
version: latest

# After
name: my-plugin
version: 1.2.3
```

## Tags

`security`, `docker`, `reproducibility`
