# Plan: k8s + Fargate workload hardening

## Goal

Bring the platform-app workloads up to a `restricted` Pod Security Standard
baseline — `runAsNonRoot: true`, `readOnlyRootFilesystem: true`,
explicit emptyDir mounts for the writable paths each container actually
needs — and apply the same constraints to the Fargate ECS task
definitions. Today the `securityContext` blocks vary per workload and
several core workloads (plugin, registry, nginx, every Fargate task) ship
with writable root filesystems and no non-root constraint.

## Why this is its own plan, not a single PR

The audit pass listed these as one-liners, but applying them blindly will
break workloads. Each container has a different set of writable paths:
nginx wants `/var/cache/nginx`, the registry needs `/var/lib/registry`
(PVC, already mounted), buildkitd needs `/run/user/1000/buildkit`, the
plugin container needs `/app/tmp`/`/app/uploads`/`$TMPDIR`. Per-workload
validation — happy-path build, init-container coexistence, rolling
restart, OOM recovery — is the work. One PR per workload keeps blast
radius small and rollback obvious.

## Recommendation

**Ship per-workload, with a soak window between PRs.** Order by blast
radius: hardening nginx is the most impactful (it's the ingress) but also
the riskiest (it forks workers as root and writes logs to disk). Lead
with the plugin pod (most defensive-value because user code runs there)
and end with nginx (most operationally sensitive).

## Scope (4 PRs)

### PR-H1: Plugin pod hardening (~200 LoC YAML + soak)
- Files: `deploy/minikube/k8s/plugin.yaml`, `deploy/aws/ec2/k8s/plugin.yaml`
- Add to plugin container:
  - `runAsNonRoot: true`, `runAsUser: 1000`, `runAsGroup: 1000`
  - `readOnlyRootFilesystem: true`
  - `seccompProfile: { type: RuntimeDefault }`
- Add emptyDir mounts to satisfy node runtime's writable needs:
  - `/tmp` (already wired via `TMPDIR=/tmp` env + emptyDir)
  - `/home/node/.npm` if npm runs at startup (verify; if not, skip)
- Buildkitd sidecar already runs as 1000 + `Unconfined` seccomp + SETUID/SETGID
  — **do not touch**. The comments in plugin.yaml explain why those caps must stay.
- Verify: full plugin upload → buildkit build → publish flow on minikube
- `automountServiceAccountToken: false` already landed in the deploy review

### PR-H2: Registry pod hardening (~150 LoC YAML)
- Files: `deploy/minikube/k8s/registry.yaml`, `deploy/aws/ec2/k8s/registry.yaml`
- Init container `fix-permissions` keeps `runAsUser: 0` (necessary to chown the PVC)
- Main `registry` container:
  - `runAsNonRoot: true`, `runAsUser: 1000`, `runAsGroup: 1000`
  - `readOnlyRootFilesystem: true`
  - `capabilities: { drop: ["ALL"] }` (currently missing — only `allowPrivilegeEscalation: false` is set)
- The `registry:2` binary writes to `/var/lib/registry` (PVC) and reads
  TLS material from a mounted Secret; both work fine with read-only `/`.
- Verify: push → pull cycle, including the JWT token-auth handshake

### PR-H3: Nginx pod hardening (~250 LoC YAML, riskier)
- Files: `deploy/minikube/k8s/nginx.yaml`, `deploy/aws/ec2/k8s/nginx.yaml`
- **Image swap**: `nginx:1.27` → `nginxinc/nginx-unprivileged:1.27`. The
  upstream unprivileged image runs as UID 101 and binds to 8080/8443 by
  default — no `NET_BIND_SERVICE`, `CHOWN`, `SETUID`, `SETGID` needed.
- Drop all those capabilities → `capabilities: { drop: ["ALL"] }`, no `add:`
- `runAsNonRoot: true`, `runAsUser: 101`, `readOnlyRootFilesystem: true`
- emptyDir mounts: `/var/cache/nginx`, `/var/run`, `/tmp`
- Update the nginx config path references if the unprivileged image uses
  a different prefix (`/etc/nginx` vs `/etc/nginx/conf.d`)
- Verify: TLS termination on 8443, all upstream routes (`/api/*`,
  `/image-registry/*`, etc.), `/health` probe, JS-templated upstream
  resolution in init container

### PR-H4: Fargate ECS task definitions (~300 LoC YAML)
- File: `deploy/aws/fargate/stacks/04-services.yaml`
- For each container in each task:
  - `ReadonlyRootFilesystem: true`
  - `User: "1000:1000"` where the image supports it (skip for postgres/mongo
    where the init logic legitimately needs root)
  - Volumes block with ephemeral storage mounts for the writable paths each
    service needs — same paths we identified per-workload in PR-H1/2/3
- Fargate sizing: `ephemeralStorage.sizeInGiB` may need bumping per task
  if the writable-path volumes were previously implicitly covered by the
  root filesystem. Default is 20 GiB; cheap to bump.
- Verify: full task replacement, log streams continue, no `EROFS` errors
  in CloudWatch

## Per-workload validation checklist

Each PR runs through:

1. **Happy path** — the workload's primary job completes end-to-end
2. **Init coexistence** — init containers run first, succeed, hand off
3. **Restart** — `kubectl rollout restart deploy/<name>` lands cleanly
4. **OOM recovery** — kill a pod, ensure it comes back without manual
   intervention (no stale write requiring root cleanup)
5. **Probe stability** — readiness/liveness probes pass over 10-minute window
6. **emptyDir sizing** — observe disk usage, set `sizeLimit` to ~2× peak

## Non-goals

- Hardening postgres/mongo/redis. These are stateful, run upstream images
  that legitimately need root for init, and have their own RBAC for the
  attack surface. Skip unless we see a specific exploit path.
- Switching to a PodSecurityPolicy / PodSecurityAdmission enforcement.
  Per-workload `securityContext` is enough; cluster-level enforcement
  can come after all workloads pass the bar.
- AppArmor / SELinux profiles. `seccompProfile: RuntimeDefault` is the
  defense-in-depth tier we're targeting.
- Network policy changes (already covered by `networkpolicy.yaml`).

## Risks

| Risk | Mitigation |
|---|---|
| Nginx image swap changes config paths or worker behavior | Soak in minikube 1 week before EC2; revert by tag if probes flap |
| Plugin container needs writable paths we didn't identify | Read-only filesystem surfaces `EROFS` loudly; add mounts iteratively |
| Fargate task storage limit too low after switch | Default 20 GiB is generous; bump per-task if CloudWatch shows pressure |
| Hardening hides a bug that was relying on writable `/` | That's the point — find and fix it; track in a separate issue |

## Size estimate

| PR | LoC | Risk |
|---|---|---|
| H1 — Plugin pod | 200 | Low (user-code is already sandboxed via buildkit) |
| H2 — Registry pod | 150 | Low (well-understood writable paths) |
| H3 — Nginx pod | 250 | Medium (image swap; ingress impact if probes flap) |
| H4 — Fargate tasks | 300 | Medium (different platform, harder to roll back fast) |
| **Total** | **~900 LoC** YAML across 4 PRs over ~3 weeks (1 PR/week + soak) |
