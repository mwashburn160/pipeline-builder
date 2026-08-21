# block-privileged-plugins

Blocks plugins that request privileged Docker mode. Running containers in privileged mode grants full host access and is a critical security risk.

**Target:** plugin
**Severity:** critical (blocking)
**Scope:** published (opt-in via subscription)
**Priority:** 100

## Rule Logic

| Field | Operator | Value |
|-------|----------|-------|
| `privileged` | `neq` | `true` |

## Rationale

Privileged containers can:
- Access all host devices
- Bypass Linux security modules (AppArmor, SELinux)
- Mount the host filesystem
- Escape the container entirely

This is the highest-severity rule in the sample set. It's published (not global) because some organizations may have legitimate use cases for privileged builds (e.g. Docker-in-Docker for image building).

## Remediation

Most plugins don't need privileged mode. If your plugin builds Docker images, consider using:
- **kaniko** — builds images without Docker daemon
- **buildah** — rootless container builds
- **BuildKit** — supports rootless mode

## Tags

`security`, `docker`, `hardening`
