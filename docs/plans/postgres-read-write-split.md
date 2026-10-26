# Splitting Postgres reads from writes

Scope: Postgres. Mongo is out of scope and should not be changed in the same effort.

## Status

**Every phase is built.** Two things could not be done from a workstation and
are called out below rather than quietly skipped.

| Phase | What | Status |
|---|---|---|
| A | Write-path resource floor, 1 → 4 CPU ladder, saturation alerts | **BUILT** |
| 0 | Pre-flight audit | **0a BUILT** (table in that section). **0b NOT DONE** — needs live read traffic |
| 1 | Replica infrastructure | **BUILT** |
| 1a | StatefulSet conversion of the primary | **DELETED** by decision D1 — no longer exists |
| 2 | pgbouncer read pool | **BUILT** |
| 3 | Read connection, `withTenantTxRead`, routing decision, kill switch | **BUILT** |
| 4 | Redis write pin + first call sites opted in | **BUILT** |
| 5 | Lag circuit, replication alerts, scaling procedure | **BUILT** |
| 6 | Backups off the standby, restore warning | **BUILT** |

### What is NOT implemented

Nine items, separated by WHY, because "not done" and "decided against" need
different follow-ups.

**Cannot be done from a workstation:**

1. **0b, the read-load profile.** Needs production read traffic to say which
   call sites are worth moving. The instrumentation exists
   (`postgres_read_routed_total{target,reason}`, the `pb_replication_*` series);
   the measurement does not. Consequence: Phase 4's opt-in is *reasoned*, not
   measured.
2. **The minikube rehearsal.** No cluster was running, so nothing here has been
   applied to a live Kubernetes target. The seeding path, the exec probes, the
   hostPath PV binding, the KEDA `ScaledObject` and the rung controller's PATCH
   are verified by contract test and by construction — not by observation.

**Decided against, with reasons:**

3. **Phase 3's "readiness must not report healthy on a dead read pool".**
   REJECTED. If the replica died, every service pod would go NotReady and the
   whole application would go down — when the correct behaviour is precisely
   what happens now: serve from the primary. A degraded-but-correct condition
   must not fail readiness. The lag circuit already fails closed, so the
   condition is handled; it is merely quiet.
4. ~~**Phase 5's `cl_waiting` read-pool scale-up trigger.**~~ **DONE.** The
   metric names were verified empirically rather than guessed: the pinned
   exporter image was run against a real pgbouncer and `/metrics` read. Worth
   recording, because `cl_waiting` is **not a metric name** — it is a
   `SHOW POOLS` column, and the exporter renames it:

   | What it is | Verified metric |
   |---|---|
   | clients queued for a server connection | `pgbouncer_pools_client_waiting_connections{database,user}` |
   | how long the oldest has waited | `pgbouncer_pools_client_maxwait_seconds{database,user}` |
   | per-pool usage against its cap | `pgbouncer_databases_current_connections{name}` / `_max_connections{name}` |

   `name` is the pgbouncer ALIAS (`pipeline_builder_read`) and `database` the
   real dbname, so filtering the wrong one catches the write pool too. Shipped
   as `PostgresReadPoolQueuing` and `PostgresReadPoolExhausted`, with six
   promtool cases including the uncapped-pool case (pgbouncer reports
   `max_connections = 0` for unlimited, and `x/0` is `+Inf`, which is `> 0.9`
   and would page forever without the `> 0` guard).

   **k8s only.** docker runs no pgbouncer-exporter at all — a pre-existing gap
   on that target, not one read-splitting introduced. So the hoped-for
   "scale-up signal that works on docker" did not materialise; closing it means
   adding that exporter to compose.

5. **Phase 5's "a seeding path that does not run against the primary."** NOT
   done, and this is the weakest part of adopting automatic scale-out. The plan
   said automation needs three things — a long cooldown, a hard ceiling, and a
   clone path that does not load the primary (cascading replication, or a
   volume snapshot). The first two are implemented; the third is not, so a
   KEDA scale-up still runs `pg_basebackup` against a primary that is by
   definition under pressure. The 10-minute stabilization and one-clone-per-15-
   minutes policy bound the damage rather than removing it.

**Known gaps, recorded rather than fixed:**

6. **The app-side lag gauge is unobservable when idle.** `maybeSampleLag` runs
   only from the read path, so with no reads there is no sample, no
   `postgres_replica_lag_seconds` series, and `PostgresReadCircuitOpen`
   (`max(...) == 1`) cannot fire. Mitigated, and deliberately so: lag is also
   measured from the PRIMARY's side by
   `pb_replication_client_replay_lag_bytes`, which is independent of
   application traffic. Treat the exporter metric as the safety net and the
   app-side gauge as supplementary.
7. **Read-pool sizing is coincidental, not derived.**
   `DB_READ_MAX_POOL_SIZE=10` is per service PROCESS; pgbouncer caps the
   standby at `max_db_connections=25`. Across ~10 services at multiple replicas
   each, client demand far exceeds that. Not a correctness bug — pooling is what
   absorbs it — but the two numbers were never reconciled against each other.
   **Now OBSERVABLE** rather than resolved: `PostgresReadPoolExhausted` reports
   the pool at its cap and `PostgresReadPoolQueuing` reports clients waiting,
   which is the pair that tells "raise the pool" apart from "the standby is
   slow". Deriving the numbers from measured concurrency still wants 0b.
8. **~5% of tenant transactions are read-routed** — 13 call sites of 280, all
   in one file. The complexity is fully live while the benefit is near zero.
   That follows from item 1, and it is the reason to do 0b before anything else.
9. **No failover.** The standby is a promotion candidate and nothing promotes
   it: no manager, no `pg_ctl promote`, no fencing. If the primary dies, writes
   stop until a human acts. This work buys read offload and a warm copy — NOT
   availability. Worth stating plainly so "replica" is not read as "HA"; the
   plan's own Open Decision 4 raises it as the higher-value separate project.

### What is deliberately NOT done

- **0b, the read-load profile.** It needs production read traffic to say which
  call sites are worth moving. The instrumentation that produces it is in
  (`postgres_read_routed_total{target,reason}`, and the `pb_replication_*`
  series), but the measurement itself is not a thing a workstation can fake.
  Until it exists, Phase 4's opt-in list is reasoned rather than measured —
  `analytics-queries.ts` was chosen because it satisfies all three of the
  "leave it on the primary" exclusions by construction, not because it was
  observed to be hot.
- **The minikube rehearsal.** No cluster was running. Nothing here has been
  applied to a live Kubernetes target, so the seeding path, the probe
  behaviour and the in-place resize are verified by contract test and by
  construction, not by observation. The volume-adoption risk that made this
  the scariest step is gone (D1), but "it parses and the contracts pass" is
  not "it came up".

### It ships inert

`DB_READ_HOST` is empty in all four `.env.example` files, so
`isReadReplicaConfigured()` is false everywhere and **every read still goes to
the primary** — including the 13 analytics queries that now call
`withTenantTxRead`. The standby workload *is* deployed on every target, so
replication, the slots and the alerts are live and observable; only the read
routing waits on an operator setting the host. A contract test asserts
`DB_READ_HOST=""` on every target precisely so this cannot be enabled by
accident before someone has read the runbook.

## Why this is cheaper here than it usually is

Three properties of the current design do most of the work, and all were
verified against the code rather than assumed:

**Every tenant read already runs inside a transaction.** RLS is enforced through
transaction-scoped GUCs — `database/tenancy.ts` sets them with
`set_config(key, value, true)` (the trailing `true` is `is_local`, i.e. `SET
LOCAL`) inside `withTenantTx`. A query outside that transaction returns zero
rows. There is no loose read path to retrofit: the transaction is already the
unit of work.

**pgbouncer runs `pool_mode = transaction`**, so the transaction is already the
pooling unit too. A read-only transaction can be handed to a different upstream
without dragging session state along.

**The routing surface is one function.** 57 files reach the database through
`withTenantTx`; only 5 touch the `db` proxy directly. A read-only variant of
that single helper covers nearly every tenant read in the product.

There is also a working template for the connection itself:
`database/public-reader.ts` already runs a separate small pool, as a distinct
role (`ecosystem_public_reader`), through its own pgbouncer pool.

## What exists today

- One Postgres **Deployment**, `replicas: 1`, `strategy: Recreate`, on a
  ReadWriteOnce `pb-ebs` PVC, started with `-c max_connections=200`. No
  replication is configured anywhere — no `wal_level` tuning, no replication
  role, no standby.
- pgbouncer, `pool_mode = transaction`, **2 replicas**, with pools split **per
  quota tier** (`pipeline_builder`, `_developer`, `_pro`, `_unlimited`, plus
  `_public` for the directory reader).
- One `Connection` class and a singleton `db` proxy in
  `database/postgres-connection.ts`.

Postgres is the data-tier single point of failure. Redis stopped being one when
Sentinel HA landed on both AWS targets; Postgres never got the same treatment.

## The hazard that decides the whole design

Replication is asynchronous. The failure mode is **read-after-write**: a user
creates a pipeline, the UI lists pipelines, a replica that has not replayed the
commit serves the list, and their pipeline is missing. They retry and it
appears. This reads as data loss and is close to impossible to reproduce on
demand.

So: **reads stay on the primary unless a call site opts in.** An opt-out
design — everything to the replica except where someone remembered to pin it —
gets this backwards, because the cost of a missed call site is a user-visible
bug nobody can reproduce.

## How many replicas, per target

**Every target runs at least one read-only replica.** The read path is therefore
exercised everywhere, not only in production — which matters, because a code
path that runs on one of four targets is a code path nobody notices breaking.

| Target | Min | Max | Scaling |
|---|---|---|---|
| `deploy/aws/eks` | 1 | 3 | Alert-driven (below) |
| `deploy/aws/ec2` | 1 | 3 | Alert-driven (below) |
| `deploy/local/minikube` | 1 | 1 | Fixed |
| `deploy/local/docker` | 1 | 1 | Fixed |

### Replicas scale OUT, not UP — but they are sized like the primary

Read load is answered by **adding a replica**, never by growing one. That is the
whole reason replicas exist, and the vertical ladder in Phase A is written for
the primary, where horizontal scaling is not an option.

Their RESOURCES, though, track the primary's rung rather than being tuned down:

- **A replica is a promotion candidate.** If the primary is lost, a standby is
  what you promote — and promoting a half-sized replica gives you a half-sized
  primary at the worst possible moment. Sizing them alike is what keeps that
  option real.
- **Replay is not optional work.** A standby must apply every WAL record the
  primary produces, whatever else it is doing. A replica given less memory than
  the primary has a colder cache and replays against more disk reads, which
  shows up as lag — the one signal that must never be answered by adding
  replicas.
- Extra CPU on a replica helps read CONCURRENCY, not replay, which is largely
  single-threaded. So a saturated replica is a reason to add another, not to
  grow it — exactly what `PostgresReadReplicaSaturated` triggers.

So: one rung for the whole cluster, moved by the primary's alerts; replica
count moved independently by the replica's. A rung change multiplies by member
count, which is the cost to keep in view when sitting at the replica ceiling.

Costs to budget for, since they are not free:

- **eks** — each replica adds a 20Gi `pb-ebs` volume and a pod **on the same
  rung as the primary** (floor: `1000m` / `2Gi`, requests equal to limits — see
  Phase A). Karpenter places them on separate nodes, so replicas give real
  node/AZ separation for reads.
- **ec2** — the replica shares the host with the primary (default
  `m5.4xlarge`, 16 vCPU / 64 GiB, so it fits). Be clear-eyed about what this
  does and does not buy: it exercises the read path and can serve read load, but
  it is **not** failure isolation — same kernel, same disk, same instance — and
  moving `pg_dump` here does not offload anything, because it is the same CPU.
  Scaling toward 3 on one box competes with the rest of the stack for CPU and
  RAM; treat the max as a ceiling, not a target.
- **local** — minikube gets a second 1Gi volume, docker a second container.
  Fixed at 1: there is nothing to scale into on a laptop.

## Phase A — The write path: vertical only, 1 → 4 CPU

**Lettered, not numbered, because it is independent of the replica work and
should land first.** It is the most immediately deployable part of this plan —
it needs no standby, no pgbouncer change and no application code — and the floor
correction below is worth having whether or not read-splitting ever ships.

**Writes do not scale horizontally here, and nothing in this plan changes
that.** Streaming replication gives exactly one primary. A second writer means
multi-master or sharding, neither of which is in scope — so nobody should read
"replicas" and conclude the write path gained redundancy. Its only levers are
more resources, or less work.

### The floor is a `requests` change, not a `limits` change

Today Postgres runs `limits 1000m / 1536Mi` against `requests 150m / 768Mi` on
every target. That is **Burstable** QoS: the scheduler reserves 0.15 CPU for the
primary data tier, throttles it toward that request under node pressure, and
evicts it before any Guaranteed pod. For a single-primary database carrying
every write in the product, that is the wrong class.

A floor of 1 CPU therefore means `requests.cpu: "1000m"` — equal to the limit,
making the pod **Guaranteed** at the floor. Memory requests should rise to match
limits for the same reason.

**This is a 7× increase in RESERVED CPU on every target, and it changes
scheduling.** Requests are what the scheduler subtracts from a node's
allocatable capacity, so Postgres goes from reserving 0.15 to 1.0 vCPU
everywhere — correct for a database, and not free:

- **minikube** is the one to check first. Its VM is operator-sized
  (`--cpus=$MK_CPUS`, and those flags are CREATE-TIME only, so an existing
  profile does not grow), and the namespace's total requests already run to
  several vCPU. An extra 850m can tip a laptop profile into pods that will not
  schedule — with Postgres itself now the largest single reservation.
- **ec2** packs the whole stack onto one instance; the same 850m comes off what
  is available to plugin builds and the mesh.
- **eks** is the easy case: Karpenter sizes nodes to what is requested.

Sequence the floor change on its own, verify every pod still schedules on
minikube, and only then start the ladder.

### Memory is a function of CPU, not a separate dial

Memory scales **with the core count, at a fixed ratio of 2Gi per vCPU**, and the
server config scales with it. One ladder, three rungs, so a bump is picking a
row rather than inventing a pair of numbers:

| Rung | CPU (requests = limits) | Memory (requests = limits) | `shared_buffers` | `effective_cache_size` |
|---|---|---|---|---|
| Floor (default) | `1000m` | `2Gi` | `512MB` | `1200MB` |
| Middle | `2000m` | `4Gi` | `1GB` | `2400MB` |
| Ceiling | `4000m` | `8Gi` | `2GB` | `4800MB` |

`shared_buffers` is 25% of the memory limit and `effective_cache_size` ~60%,
which are the conventional Postgres ratios. The floor is a small increase on
today's `1536Mi` — rounded to 2Gi so the ladder is linear and the arithmetic is
obvious at a glance.

**Memory is the riskier axis, and it is not symmetric with CPU.** A container
over its CPU limit is throttled and gets slower. A container over its MEMORY
limit is **OOM-killed** — and for a single primary on a `Recreate` strategy that
is write downtime plus crash recovery, triggered by the limit that was supposed
to protect it. Two consequences:

- The memory alert must fire with enough headroom to act *before* the kill, not
  at the limit. Working-set-to-limit ratio, sustained, is the signal.
- `work_mem` is allocated per sort or hash **per connection**, so the worst case
  is `work_mem × concurrent operations`, bounded in practice by the pgbouncer
  budget (170 server connections across both replicas) rather than by
  `max_connections=200`. Keep `shared_buffers + (work_mem × that bound)`
  comfortably under the limit at every rung; it is the term that makes a
  generous `work_mem` an OOM rather than a speed-up.

**Both triggers move the whole rung.** CPU saturation moves up a row, and memory
pressure moves up a row — you do not raise memory while leaving CPU at the floor,
because the ladder exists to keep the server config, the pod limits and the QoS
class consistent with one another.

### More CPU alone buys very little

The only server argument today is `max_connections=200`. There is no
`shared_buffers`, no `work_mem`, no `effective_cache_size` — so Postgres runs
with the image default of **128MB** of shared buffers no matter how much memory
the pod is given. Raising the pod to 4 CPU and several GiB without touching the
server config mostly buys page cache.

Any vertical bump is therefore **two changes, together**: the pod's requests and
limits, and the server config scaled to the new memory figure. The ladder above
pairs them so they cannot drift apart.

### Mechanism: alert-driven, operator-approved — not VPA auto-mode

No VPA and no `resizePolicy` exist in `deploy/` today, and VPA in `Auto` mode is
the wrong tool here: it **evicts the pod to resize it**, and this Deployment
uses `strategy: Recreate` on a ReadWriteOnce volume, so an eviction is write
downtime at a moment the autoscaler chooses. An unattended component that can
restart the primary is a larger risk than the saturation it is correcting.

Instead:

- Alert on sustained saturation; a runbook step performs the bump.
- Set `resizePolicy` on the container so the change can be applied **in place**
  where the Kubernetes version supports it (eks is on 1.36, ec2 and minikube on
  1.35). Verify in-place behaviour on minikube before relying on it in
  production — if it falls back to a restart, that is write downtime and must be
  scheduled, not discovered.
- Treat 4 CPU as a ceiling with a meaning: at the ceiling the answer is no
  longer "more CPU", it is a query, an index, or moving read load to a replica.

**The ceiling is not an arbitrary number — it is exactly the namespace's hard
cap.** `k8s/resource-limits.yaml` is a LimitRange with container
`max: cpu "4", memory 10Gi`, and its own comment is emphatic that this is *"a
HARD admission gate, not a scheduling hint: a container whose limit (or request)
exceeds it cannot be created at all — the ReplicaSet just emits `pods "..." is
forbidden` and the Deployment sits at 0/1 with no pod to inspect."*

So the top rung is admissible with **zero headroom**: `4 == 4`. Two consequences
that must be written into the runbook, because the failure has no pod to debug:

- Raising Postgres beyond 4 CPU means **raising the LimitRange first**. Doing it
  in the other order takes the write path down, and `kubectl get pods` shows
  nothing wrong because no pod was ever created.
- The Pod-level cap (`cpu 6`, `memory 10Gi`) is not breached: the ceiling rung
  plus the `postgres-exporter` sidecar (`limits 100m / 128Mi`) totals 4.1 CPU and
  ~8.1Gi. Any future sidecar eats that margin.

### The alerts this needs, which do not exist today

The only Postgres alerts are `PostgresUnreachable` and `DatabaseBackupStale`.
There are **no container CPU or memory saturation rules at all**, so a primary
pinned at its 1 CPU ceiling is invisible until it surfaces as latency or
statement timeouts.

**None of these metrics are being collected today. That is the first task, not
a detail.**

`kubelet-cadvisor` is scraped on every Kubernetes target, but its
`metric_relabel_configs` deliberately reduce it to almost nothing — the comment
explains why: *"cAdvisor is ~3MB of series per node. Keep the two filesystem
gauges only."* The chain keeps `container_fs_(limit|usage)_bytes`, then only
`id="/"` (the node-level view, not per-container), and finally **drops the
`container`, `pod` and `namespace` labels**.

So `container_cpu_usage_seconds_total`, `container_memory_working_set_bytes` and
`container_spec_*` are not merely unused — they are **never ingested**, and the
labels needed to select a specific container are discarded from what remains.
A rule written against them would match nothing, and a rule that matches nothing
looks exactly like a healthy system.

kube-state-metrics is not a substitute: it exposes configured *limits*
(`kube_pod_container_resource_limits`) but no usage, and it is **absent on
minikube** while the alert file must stay byte-identical across all three
Kubernetes targets.

**The fix is a second, narrowly-scoped scrape job**, not an edit to the existing
one. The filesystem job's filter chain is tuned and load-bearing — widening its
`keep` regex would either drop the filesystem series (the `id="/"` keep removes
per-container series) or reintroduce the cardinality it exists to prevent. Add a
separate `kubelet-cadvisor-db` job that keeps only the CPU/memory/spec series
**and only for the Postgres pods**, preserving `pod` and `container` labels.
Scoping to one workload is what keeps the cardinality cost near zero rather than
~3MB per node.

**That is three edits, and nothing will catch you missing one.** Unlike
`alert-rules.yml`, which is byte-identical across the three Kubernetes targets
and drift-guarded by a contract test, `prometheus.yml` **differs per target** —
three distinct checksums today, legitimately, because the scrape topology is not
the same. So the job must be added to eks, ec2 and minikube by hand, and a
target that is missed simply has no data: its alerts never fire and look exactly
like a healthy system. Add a drift assertion for this job specifically, or
accept that the gap is invisible.

Until that job exists, every alert below is unwritable. Treat it as Phase 5's
first step.

Express every threshold as a **ratio of usage to limit**, never an absolute core
count. The same rule then holds at 1 CPU and at 4, survives a rung change
without an edit, and satisfies the count-agnostic constraint above.

| Alert | Signal | Acts on |
|---|---|---|
| `PostgresPrimaryCpuSaturated` | `rate(container_cpu_usage_seconds_total[5m]) ÷ (container_spec_cpu_quota ÷ container_spec_cpu_period)` sustained above ~0.85 | Move the primary up a rung |
| `PostgresPrimaryMemoryPressure` | `container_memory_working_set_bytes ÷ container_spec_memory_limit_bytes` sustained above ~0.80 | Move the primary up a rung |
| `PostgresReadReplicaSaturated` | the same CPU ratio, on replica pods | Scale out (KEDA), or up at the ceiling (AWS only, ceiling 2) |
| `PostgresReplicationLagHigh` | replay lag beyond threshold | Shed reads to the primary — **never** add a replica |
| `PostgresReplicationStopped` | replay LSN not advancing while the standby is up | Page: the standby is retaining WAL |
| `PostgresReplicationSlotRetainedBytes` | bytes held by a slot beyond threshold | Page: the primary's volume is at risk |

Two deliberate asymmetries in those thresholds:

**Memory fires lower than CPU (0.80 vs 0.85) and should fire sooner.** Over the
CPU limit a container is throttled and recovers; over the memory limit it is
OOM-killed, which on a `Recreate` single primary is write downtime plus crash
recovery. The alert exists to buy time to act, so it must fire while there is
still headroom — not at the moment the limit is reached.

**Lag and saturation point in opposite directions.** Saturation says "add
capacity"; lag says "this replica cannot keep up with replay", and adding
another replica puts another WAL sender on the primary and makes replay worse.
Wiring lag to a scale-up would deepen the incident it is reporting.

### Which alert moves which rung

Usage drives the ladder, and both axes move the whole rung — CPU and memory are
not raised independently, because the rung is what keeps the pod limits, the
server config and the QoS class consistent:

- `PostgresPrimaryCpuSaturated` **or** `PostgresPrimaryMemoryPressure`, sustained
  → next rung up (1→2 CPU / 2→4Gi, then 2→4 CPU / 4→8Gi).
- Sustained low utilisation on **both** → one rung down, never below the floor.
- At the ceiling (4 CPU / 8Gi) neither alert means "add resources" any more. The
  runbook must say so explicitly, or the ceiling becomes a place where alerts
  fire forever with no action: at that point the answer is a query, an index, or
  moving read load to a replica.

The cAdvisor metric names above are stable, but as established they are not
being ingested yet — the scoped scrape job comes first. The replication signals
come from `postgres-exporter` v0.17.1 and should likewise be confirmed against
that version's actual output before any rule is written.

The general rule, which this plan has already tripped over once: **verify the
series exists before writing the alert.** A rule referencing a metric nobody
collects is indistinguishable from a system that is fine.

### Per-target ceilings

- **eks** — 4 CPU is a Karpenter node-sizing question; the node must be able to
  host it alongside whatever else is scheduled.
- **ec2** — the default `m5.4xlarge` has 16 vCPU, so 4 fits, but it is shared
  with the entire rest of the stack. The ceiling competes with plugin builds and
  the mesh.
- **local** — 4 CPU will exceed what a default `minikube start` allocates. The
  floor of 1 CPU is what matters locally; the ceiling is effectively unreachable
  and should not be configured there.

## Phase 0 — Pre-flight audit (do this first; it is cheap and it gates the rest)

### 0a. Find the reads that are actually writes

A read-only transaction on a standby rejects row locks, and advisory locks
cannot be taken there at all. These exist today and all four *look* like reads
at the call site:

| Location | What it does |
|---|---|
| `packages/pipeline-data/src/api/crud-service.ts:765` | `SELECT … FOR UPDATE` serialising `setDefault` |
| `api/pipeline/src/services/pipeline-service.ts:318` | `pg_advisory_xact_lock(...)` |
| `api/compliance/src/services/subscription-service.ts:547` | `pg_advisory_xact_lock(...)` |
| `api/pipeline/src/routes/update-pipeline.ts:69` | promote-to-default, takes the locked path |

Re-run this search before Phase 4 rather than trusting this table — it is a
point-in-time snapshot:

```
grep -rn "FOR UPDATE\|pg_advisory" packages/pipeline-data/src platform/src api/*/src
```

None of these may be routed to a replica. `SET TRANSACTION READ ONLY` — shipped
in Phase 3, on both the replica and the primary path — makes a mistake fail
loudly rather than silently, but knowing the list up front is what keeps it from
being discovered in production.

### 0b. Measure, so the replica gets traffic worth moving

`api/compliance` has the most read call sites (84) and `platform` 51, but **call
count is not load**. Profile actual query time and volume before choosing what
to move. A replica that ends up serving cold queries has added a moving part and
kept the latency.

The lowest-risk first mover is the **public plugin directory**: it already has
its own pool, its role can only read `public_*` views, and a public catalog is
lag-tolerant by nature.

## Decisions taken during implementation

Four things could not be built as written. Recorded here with the reasoning,
because each one changes a phase.

### D1 — Two workloads with a parity test, NOT one StatefulSet

The plan said: one StatefulSet for the whole cluster, ordinal 0 the primary,
1..N standbys, so "replicas are sized like the primary" is structural. But the
same plan also requires four things a single pod template cannot give:

- **separate NetworkPolicy ingress rules** for the standby (Phase 1, deploy
  requirements) — one template means one `app: postgres` label, so the existing
  `allow-postgres-ingress` already covers every member and there is nothing to
  add;
- **a new Istio ServiceAccount identity** with its own AuthorizationPolicy
  entries (same list) — one template means one ServiceAccount;
- **different replica counts per target** (aws 1–3, local exactly 1) — with one
  StatefulSet the count is `1 + standbys`, so "minimum 1 replica" becomes
  `replicas: 2` and the manifest no longer says what it means;
- **a deliberately sized standby `max_connections`** (Phase 2) — one template
  means one `args:` list, so the standby inherits the primary's 200 whether or
  not that is wanted. Phase 2's instruction not to "inherit 200 by copy-paste"
  is unsatisfiable under Phase 1's topology.

So: a **separate `postgres-replica` StatefulSet**, plus a contract test
asserting its container resources and server args match the primary's exactly.
That delivers the actual goal — the two cannot drift — through the mechanism
this repo already uses everywhere else, and which is the explicit standing
preference: duplicate the manifest, guard the copy with a drift test, never
share a base.

**This deletes Phase 1a, which the plan called "the riskiest step in this
plan".** Phase 1a existed only because converting the *primary* to a StatefulSet
abandons its `postgres-data` PVC for a `volumeClaimTemplates`-provisioned one —
"the primary comes up on a new, empty one and the database appears to have lost
everything". With the primary left as the Deployment it already is, there is no
volume adoption, no data migration, no pre-created PVC with a guessed name, and
no rollback window. The standby's volumes are new by definition, so
`volumeClaimTemplates` is unambiguously correct for them.

### D2 — One read pool, and the dead tier pools go

Phase 2 asked whether read traffic should keep the per-tier pool isolation.
**It cannot, because that isolation does not exist.** The tier pool names
(`pipeline_builder_developer`, `_pro`, `_team`, `_enterprise`, `_unlimited`)
appear in exactly four files — the four pgbouncer configs — and nowhere else in
the repository: no application code, no env var, no script, no doc constructs
one. Every service connects to `DATABASE=pipeline_builder`, and the only
tier-ish pool anything actually opens is `pipeline_builder_public`, via
`public-reader.ts`.

Two consequences the configs' own comments get wrong:

- The claim that "pgBouncer enforces separate pool budgets so cross-tier
  saturation can't happen" is not in effect anywhere.
- On eks/ec2 the *effective* application budget is `pipeline_builder`'s
  `pool_size=15` × 2 replicas = **30 server connections**, not the 170 the
  capacity comment computes by summing pools nobody opens. The 170 figure
  describes a configuration that is not running.

So mirroring tier pools onto the read side would duplicate dead config. Instead:
delete the dead tier pools, give the write path the budget the comment always
intended, and add **one** read pool pointed at the standby Service. Making tier
routing real is a separate feature and is not in this plan's scope.

### D3 — minikube and docker were missing the capacity fix entirely

Found while setting the Phase A floor: `max_connections` was set on eks and ec2
only. On minikube and docker, Postgres ran with the **image defaults — 100
connections and 128MB of shared buffers** — while those targets' pgbouncer
configs carry the *old, uncapped* pool layout totalling up to 310 server
connections. That is the exact failure the eks/ec2 comment describes as already
fixed ("could ask for ~195 from ONE replica against Postgres' default of 100 —
sorry, too many clients"); the fix was never backported. Latent rather than
firing, only because the tier pools are dead (D2).

### D4 — A rung change cannot be applied fully in place

Phase A wanted `resizePolicy` so a bump applies in place where the kubelet
supports it. That works for CPU and **not** for memory: `shared_buffers` is read
at startup, so new memory without a restart leaves the server config on the old
rung — a half-applied rung that reports success. The policy therefore declares
`cpu: NotRequired` and `memory: RestartContainer`, tying the memory change to
the restart its paired config change needs anyway.

## Phase 1 — Replica infrastructure (no application change)

Nothing in the application changes. At the end of this phase a standby exists
and is streaming; no traffic reaches it.

- Decide self-managed vs RDS (see Open decisions).
- Self-managed: convert the Postgres Deployment to a **StatefulSet** with
  `volumeClaimTemplates`. **One StatefulSet for the whole cluster** — ordinal 0
  is the primary, 1..N are standbys. That is what makes "replicas are sized like
  the primary" structural rather than a convention someone has to remember: a
  StatefulSet carries a single pod template, so a rung change moves every member
  by construction and the two cannot drift. The cost is that a rung change
  restarts standbys too, which is harmless — they serve no writes and the read
  path falls back to the primary. The current Deployment plus standalone RWO PVC cannot
  grow a second member — EBS is ReadWriteOnce, so the standby needs its own
  volume. **This is a data migration, not a `kind:` change — see Phase 1a.**
- Add a replication role, `max_wal_senders`, and a replication slot; seed the
  standby with `pg_basebackup`.
- Expose the standby as its **own** Service. Do not add it to the primary's
  Service: a Service with both endpoints round-robins writes onto a read-only
  standby, failing as `cannot execute INSERT in a read-only transaction` on
  roughly half of all writes.

### Phase 1a — The StatefulSet conversion is the riskiest step in this plan

Treat it as its own change, rehearsed, with a rollback.

The primary's volume today is a **standalone PVC named `postgres-data`**,
attached by `claimName`. A StatefulSet with `volumeClaimTemplates` provisions a
*different* volume, named after the template and ordinal
(`<template>-postgres-0`). Applying a StatefulSet over the existing Deployment
therefore does not adopt the current volume: **the primary comes up on a new,
empty one and the database appears to have lost everything.**

It is recoverable — `pb-ebs` PVs are `Retain`'d, so the data outlives the PVC —
but recovery under pressure is not a plan. Do it deliberately:

1. Rehearse end-to-end on **minikube** first, where the volume is 1Gi and
   mistakes are free.
2. Take a verified backup, and confirm it restores, before touching eks.
3. Pre-create a PVC with the exact name the StatefulSet will look for, bound to
   the existing `Retain`'d PV, so the first pod adopts the real data rather
   than provisioning a blank volume.
4. Gate the cutover on evidence, not on the pod reporting Ready: compare row
   counts on a few known tables before and after. A healthy Postgres serving an
   empty database passes every probe in this repo.

Rollback is "point the Deployment back at `postgres-data`" **only while no
writes have landed on the new volume**. After that, rollback is a restore.

### WAL retention: the hazard that only appears above one replica

Each standby needs a replication slot, and **a slot retains WAL on the primary
until the standby consumes it**. A replica that is stopped, slow, or stuck does
not degrade reads — it fills the primary's disk. The primary's volume is 20Gi,
and the existing `PersistentVolumeAlmostFull` alert already states the
consequence: "Postgres and MongoDB stop accepting writes". A read-replica
feature that takes the primary down for writes is a strictly worse outcome than
having no replica at all.

Three requirements, all mandatory before the replica count can exceed one:

- Set **`max_slot_wal_keep_size`** so a lagging slot is dropped rather than
  allowed to consume the volume. A broken replica must fail, not take writes
  with it. **Derive the figure at the CEILING rung, not the floor**: a primary
  at 4 CPU generates considerably more WAL than one at 1, the data volume is
  20Gi either way, and a slot sized against the floor stops protecting the
  volume exactly when the system is busiest. Vertical scaling and slot retention
  are the same problem seen twice.
- Set `max_wal_senders` with headroom above the maximum replica count (3), plus
  spare for `pg_basebackup` while seeding a new one.
- Alert on **slot retained-WAL bytes**, not just on volume fullness. By the time
  the volume alert fires the write path is already minutes from stopping.

### The first-init trap

`postgres-init.sql` runs on an **empty data directory**. A standby seeded by
`pg_basebackup` is not empty, so it will not run — correct. But a standby
brought up on a *fresh* PVC **will** run it and produce a second, independent
cluster that looks completely healthy and shares no data. Guard explicitly:
the standby's startup must fail if its data directory is empty and no basebackup
has been taken.

### Deploy requirements this repo enforces

A new workload is not just a manifest. All of these have contract tests that
fail the build, and all of them have bitten a previous migration here:

- **Exec probes only.** kubelet→podIP does not work under Istio ambient, so
  `httpGet`/`tcpSocket` probes CrashLoop forever. Copy the primary's pattern:
  `exec: sh -c pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"`.
- **NetworkPolicy**: `postgres` appears 7× in `networkpolicy.yaml`. The standby
  needs equivalent ingress rules, including for the metrics exporter.
- **Istio AuthorizationPolicy**: `postgres` appears 4× in `istio.yaml`. A new
  ServiceAccount identity needs its own entries, or the mesh denies it.
- **`version` and `track` labels** on the workload, matching the image tag — a
  contract test asserts label == image version. The compose service needs the
  same labels; `docker-compose.yml` carries them per service and the same test
  reads them.
- **Volume sizes are contract-enforced**, not free choice:
  `storage-size-contract.test.ts` requires every durable volume to be **1Gi on
  the local targets and 20Gi on both AWS targets**, records a reason for any
  exception, and fails outright when an AWS size appears on a local target or
  the reverse. The replica's PVC follows the same figures as the primary's.
- **New `.env` keys must exist on all four targets.**
  `env-contract.test.ts` asserts every key is present on every target unless it
  is declared target-specific with a reason. At minimum this adds `DB_READ_HOST`
  and `DB_READ_PORT`; the replication credential needs generating in
  `pb_create_app_secrets` and an entry in `docs/runbooks/secret-rotation.md`,
  which has its own contract test. Values must also be quoted correctly — the
  AWS setup scripts `set -a; . .env`, so an unquoted multi-word value runs as a
  command.

### Reaching more than one replica

A pgbouncer `[databases]` entry names exactly **one** host, and pgbouncer cannot
load-balance across several. Scaling past one replica therefore needs a
**ClusterIP Service in front of the replica members**, with pgbouncer
pointed at that Service: new server connections then round-robin across the
members. A StatefulSet's default headless Service does not do this — it resolves
to individual pod addresses — so the Service is an explicit addition, not a
by-product of the StatefulSet.

## Phase 2 — pgbouncer

pgbouncer runs on **all four targets**, including docker-compose, so the
read-pool work is uniform rather than Kubernetes-only.

The existing config carries explicit capacity math, and it must be preserved:

> 2 pgbouncer replicas, each opening its own server connections, so the budget
> is per replica × 2: `15 + 10 + 20 + 35 + 5 = 85` per replica → **170 for
> both**, under `max_connections=200`, leaving 30 for
> `superuser_reserved_connections`, the exporter, pgAdmin and db-backup.

Two things follow:

1. **Read pools draw on the standby's budget, not the primary's.** They are a
   different Postgres instance with its own `max_connections`. Someone will
   assume the 200 is shared; it is not. Size the standby's `max_connections`
   deliberately rather than inheriting 200 by copy-paste.
2. **Decide whether read traffic keeps tier isolation.** Today pools are split
   per quota tier so a noisy `unlimited` org cannot starve `developer`. Mirroring
   that on the read side means four more pools; a single shared read pool is
   simpler but drops the isolation property for reads. This is a real decision,
   not a detail — write down which property you are choosing.

Also note the standing operational hazard: a crashlooping exporter sidecar drops
pgbouncer from its Service endpoints and breaks every *new* connection,
presenting as `db ECONNRESET` 500s with clean Postgres logs. A second upstream
widens that surface; update the runbook rather than rediscovering it.

## Phase 3 — The read connection *and* the safety net, together

**BUILT.** These shipped as one change, because Phase 4's watermark is what makes
opt-in safe: it had to exist before the first call site opted in, not after a few
had been migrated by hand.

What landed:

| File | What |
|---|---|
| `packages/pipeline-data/src/database/read-connection.ts` | new — the replica pool, modelled on `public-reader.ts`. `isReadReplicaConfigured()`, `getReadPool()`, `getReadDb()`, `closeReadConnection()`, `resetReadConnectionForTests()` |
| `packages/pipeline-data/src/database/tenancy.ts` | `mayHaveWritten` on `TenantContext` (set by `withTenantTx` *before* the transaction opens, so a concurrent read in the same handler cannot race it); `chooseReadTarget()`; `withTenantTxRead()` |
| `packages/pipeline-data/src/database/postgres-connection.ts` | `closeConnection()` now also closes the read pool |
| `packages/pipeline-data/test/read-routing.test.ts` | new — 9 tests over the routing decision. Replication is untestable here (PGlite has none), so the testable unit is the decision, which is also the part with code in it |
| 4 × `.env.example`, `docker-compose.yml`, `docs/environment-variables.md` | `DB_READ_HOST`, `DB_READ_PORT`, `DB_READ_ENABLED`, `DB_READ_MAX_POOL_SIZE`. The compose vars go on the `x-postgres-env` anchor — a passthrough contract test enforces that |

Env surface, as shipped: `DB_READ_HOST` empty (no replica) and `DB_READ_ENABLED`
defaulting to true, so the kill switch is armed but the feature is dark.

`withTenantTxRead` issues `SET TRANSACTION READ ONLY` on **both** paths, not just
the replica one. That is deliberate: Phase 0a found four call sites that look
like reads and are not, and declaring the transaction read-only makes them fail
*here*, with a clear message, including on the primary — where they would
otherwise succeed and quietly take a lock the caller never intended.

The design it was built to, which the rest of this section states:

- A second `Connection` with its own small pool, pointed at `DB_READ_HOST` /
  `DB_READ_PORT`, mirroring `public-reader.ts`.
- **`DB_READ_HOST` unset means "no replica": fall back to the primary pool.**
  Every target now ships a replica, so unset is no longer the normal case — it
  is the *degraded* case. It still matters for three reasons: this phase can
  merge before any replica exists, a developer running the stack partially can
  omit one, and it is the behaviour the kill switch and the lag circuit fall
  back to. Keep it working and test it deliberately; it is no longer exercised
  by simply running a local target.
- Export it as a distinct symbol. Do **not** make the existing `db` proxy
  conditionally point elsewhere — a global that silently changes target is how a
  write reaches a standby.
- Wire the lifecycle: `closeConnection()` must close both pools, and readiness
  must not report healthy on a dead read pool when reads are being routed to it.
- A **runtime kill switch** (env-driven) that forces all reads back to the
  primary without a redeploy. The fallback-when-unset behaviour is not enough:
  the case you need it for is a replica that is up but wrong.
- **No tenant context routes to the primary**, as its own decision
  (`reason: 'no-context'`) rather than falling out of the watermark check. The
  reason is not performance. The primary path runs through `withTenantTx`, whose
  `RLS_CONTEXT_MODE` guard warns — or in `strict` throws — when a caller reached
  the database outside `runWithTenantContext`. The replica path has no such
  guard, so a context-free caller routed there would set `app.org_id = ''` and
  get *no* diagnostic, and an empty org id is a scope that looks perfectly valid
  to every RLS policy. Shipping the replica path must not quietly become a way
  to bypass the audit that guard exists to drive. Correspondingly, the replica
  branch reads `orgId` off the context directly instead of defaulting to `''`:
  a `?? ''` there would re-open the hole on the next refactor.

### The write watermark — and the cross-request case, which is the hard one

**Within a single request**, use the mechanism already in place for tenancy.
`tenantContext` is an `AsyncLocalStorage`; add a "this request has written" flag
to the same context and have the read-only helper fall back to the primary for
the rest of that request, rather than relying on every author to notice.

**That is the easy half, and on its own it does not solve the problem.** The
failure users actually hit spans two requests: `POST /pipelines`, then the page
reloads and issues `GET /pipelines`. A new request has no watermark, the read
goes to a replica that has not replayed the commit, and the pipeline they just
created is missing. This is the common case, not an edge case.

Pick one of these deliberately — the plan does not work without it:

**(a) A short primary-pin, in Redis.** On commit, set `rw-pin:<orgId>` with a
TTL comfortably above observed p99 replication lag; the read helper routes to
the primary while that key exists. Redis is already deployed and already HA
(Sentinel, 3 replicas on both AWS targets), and the app tier is 2 replicas wide
on eks, so the pin **must** be shared state — an in-process map would miss every
request that lands on the other pod. Failure mode is the right one: if Redis is
unreachable the helper routes to the primary, which is the existing
fail-closed-without-Redis convention in this codebase.

Cost: a write by one member pins the whole org briefly, so a busy org gets
little replica benefit. Keyed per org rather than per user on purpose — a user
may read through a different session than the one that wrote.

**(b) LSN tracking.** An LSN is Postgres's byte position in the WAL — one
monotonic counter for the whole cluster, so two LSNs compare directly: if
`A >= B`, everything committed at `B` has already happened at `A`. Capture
`pg_current_wal_lsn()` at commit as a watermark, carry it with the client, and
before serving a read compare it against that standby's
`pg_last_wal_replay_lsn()`; at or past the watermark, the standby has applied
the caller's own write and the read is safe.

We run `postgres:18.6`, and **Postgres 18 added `pg_wal_replay_wait(lsn,
timeout)`**, which blocks on the standby until replay reaches a position. That
removes the polling loop this option needed before 18 and makes (b) materially
cheaper than it reads below — worth knowing when revisiting it.

Precise, with no false pinning. Still more machinery: the LSN has to travel with
the client, learning the standby's replay position is a round-trip on the read
path, and a replica that never catches up turns a wait into a hang unless it is
bounded.

**Recommendation: (a), the Redis pin.** Four reasons, in order of weight:

1. **Shared state is mandatory anyway.** The app tier is 2 replicas wide on eks,
   so the pin cannot live in process. (b) avoids shared state only by carrying
   the LSN on the CLIENT — and this product's own pitch is five ways in
   (dashboard, CLI, REST, CDK, AI). A CLI or CDK caller will not echo an LSN
   back, so (b) either degrades to "primary for every non-browser client" or
   needs server-side storage, which is (a) with extra steps.

2. **It costs no new coupling.** `pipeline-data` has no Redis dependency and
   should not grow one. It does not need to: the pin is read in
   `api-server`'s `api/tenant-context.ts` — the middleware that already builds
   the `TenantContext` — and `api-core` already ships `ioredis`. The middleware
   sets the same `mayHaveWritten` flag `tenancy.ts` already consults, so the
   data package is untouched and the cross-request case reuses the
   intra-request mechanism exactly.

3. **Its failure mode is already this codebase's convention.** Redis unreachable
   means route to the primary — the same fail-closed-without-Redis posture the
   leader lock takes. Nothing new to reason about at 3am.

4. **Its weakness does not bite here.** A per-org pin is coarse: one member's
   write briefly pins the whole org. But routing is opt-in, so a pinned org
   simply reads from the primary — which is the behaviour it has today. The pin
   can only remove a benefit, never introduce a regression.

**Revisit (b) when, and only when, a few busy orgs are observably keeping the
replica idle.** That is the condition under which precision pays for its
plumbing — and if it is implemented, the client-supplied LSN must be BOUNDED:
an unbounded wait on a replica that never catches up turns a bogus value into a
hang, which is a denial of service wearing a correctness costume.

**Decide before Phase 4 starts**, because opting call sites in without either
one reintroduces exactly the bug this plan opens by promising to prevent.

## Phase 4 — Routing, one call site at a time

A read-only variant of `withTenantTx` that sets the same RLS GUCs on the read
connection and issues `SET TRANSACTION READ ONLY`. That last part is the
guardrail for the Phase 0a list: a CTE with an `INSERT`, a `SELECT … FOR
UPDATE`, or a side-effecting function fails loudly on the replica instead of
failing far from the call site.

Opt call sites in individually, cheapest-risk first (public directory, then
whatever Phase 0b's profile actually identified).

Leave on the primary: anything in a request that has already written, anything
feeding an authorization decision, and anything the user is about to act on.

## Phase 5 — Guardrails before it is load-bearing

- Export replica lag as a metric (`pg_last_wal_replay_lsn` against the primary's
  `pg_current_wal_lsn`) using the existing `incCounter`/`observe` helpers, which
  create a series on first use.
- **Alert on replication STOPPED separately from replication SLOW.** If
  replication breaks, the replay LSN stops advancing and a lag-as-duration
  metric can look flat rather than spike. These are different alerts.
- Make the read helper fall back to the primary automatically when lag crosses a
  threshold. Correctness first, load second.
- Contract test asserting the read connection is configured read-only, so a
  later refactor cannot quietly point it at the primary and leave the complexity
  in place with none of the benefit.

### One implementation everywhere; only the counts differ

The application code is identical on every target — the read connection is
driven entirely by `DB_READ_HOST` / `DB_READ_PORT`, and the services ship as one
image per target. The alert rules are identical too, and that is enforced:
`alert-rules.yml` is **byte-identical across the three Kubernetes targets**
today (a contract test asserts it; docker carries a deliberate subset, having no
kube-state-metrics or PVC alerts).

**So every replica alert must be written count-agnostically.** An alert phrased
as "expected 3 replicas, found 2" cannot exist here — it would differ between
eks (max 2) and minikube (fixed 1) and break the drift guard. Express the
conditions in terms the count does not enter:

- *any* replica lagging beyond the threshold, not "replica 2 is lagging"
- *zero* healthy replicas, not "fewer than N"
- slot-retained WAL bytes above a limit, which is per-slot regardless of how
  many slots there are
- replica CPU saturation as a ratio, not an absolute total

What legitimately differs per target is **the scaling mechanism, not the
alerts**: the KEDA `ScaledObject` (or the runbook entry that performs the
scale-up) exists only on the AWS targets. The local targets receive the same
alerts, which simply never trigger an action there — that is the correct
outcome, and it keeps one alert file for every Kubernetes target.

### Alert-driven scaling (AWS targets, 1 → 2)

The metrics source already exists: `postgres-exporter` v0.17.1 runs as a sidecar
on the primary, and `alert-rules.yml` already carries `PostgresUnreachable`.
The replica workload needs the same sidecar, with a `replica` label so alerts
can distinguish members.

Scale **up** one replica at a time when, sustained over a window long enough to
exclude a burst:

- replica CPU is saturated (the read pods are the bottleneck, not the queries), or
- the read pool is queuing in pgbouncer (`cl_waiting` on the read database), or
- read-query latency has risen while the primary's has not.

Scale **down** one at a time on sustained low utilisation, never below 1.

Do **not** scale on replication lag. Lag means the replica cannot keep up with
*replay*; adding another replica adds another WAL sender and makes the primary's
job harder. Lag is a signal to shed read load back to the primary (the circuit
above), not to add members.

**Prefer alert-triggered, operator-approved scaling over fully automatic.** KEDA
is already installed and a `ScaledObject` precedent exists (`plugin.yaml`), so
automation is available — but a new Postgres standby is not a stateless pod: it
must be seeded with `pg_basebackup`, which takes minutes and loads the primary
*while it is already under pressure*. Automatic scale-up at peak can therefore
make the incident worse. If automation is adopted anyway, it needs a long
cooldown, a hard ceiling of 2, and a seeding path that does not run against the
primary (cascading replication, or a volume snapshot).

Either way the runbook must say what to do when the ceiling is reached: at 3
replicas the answer is no longer "add a replica", it is a query or an index.

## Phase 6 — Backups and restore

Not optional, and arguably the **largest near-term win**: moving `pg_dump` off
the primary removes a scheduled load spike from the write path.

- `backup-cronjob.yaml` and its `allow-postgres-ingress` NetworkPolicy rule both
  assume one host. Retarget backups at a standby, and move the netpol rule with
  them.
- The offload is real **on eks only**, where the standby is a separate node. On
  ec2 the standby shares the CPU and disk, so backing up "from the replica"
  moves the load nowhere. Retarget it anyway for consistency, but do not record
  it as a win there.
- A backup taken from a standby is only as fresh as replay. Record the replay
  position alongside the dump, or the restore point is unknown.
- **Restore rebuilds the standby.** `deploy/bin/restore.sh` restores the primary;
  afterwards the standby is streaming from a rewound timeline and must be
  re-seeded, not left running. Today nothing says so.

## The runbook this plan assumes

**Written: [docs/runbooks/postgres-scaling.md](../runbooks/postgres-scaling.md).** The sections below were the specification for it.

Several phases above say "the runbook must say" — about the 4 CPU ceiling and
the LimitRange ordering, the in-place resize risk, the scale-up procedure and
its basebackup cost, pgbouncer's endpoint hazard, and what to do once the
ceiling is reached. None of it exists yet.

`docs/runbooks/postgres-scaling.md` is the deliverable, following the existing
convention (`access-key-cutover.md`, `secret-rotation.md`). It is not optional
paperwork: every alert this plan adds is actionable only if the action is
written down, and the two worst failure modes here — a LimitRange rejection that
leaves no pod to inspect, and a replication slot filling the primary's volume —
are both ones an operator meets for the first time at 3am.

## Testing

The repo's database tests run on **PGlite** — in-process Postgres with no
streaming replication. **Replication lag cannot be reproduced locally**, so do
not plan to test it that way.

What *is* testable, and should be:

- **The routing decision.** A fake read connection that records which pool each
  call chose. This is the actual logic being added, and it covers the watermark,
  the kill switch and the lag fallback.
- **Read-only enforcement**: a contract test that the read pool rejects writes.
- **The Phase 0a audit as a ratchet**: a test that fails when a new `FOR UPDATE`
  or `pg_advisory_*` appears in a function routed to the read connection.

Without this, Phase 4 is 57 files of unverifiable judgement.

## What this does not buy you

**It is not failover.** A streaming replica removes the *read* single point of
failure, not the write one. If the primary dies, writes stop — nothing here
promotes anything. Automatic promotion needs a manager (Patroni, repmgr, RDS
Multi-AZ) and brings split-brain risk that must be designed for separately.
Expect to be asked "so are we HA now?"; the answer after this work is still no.

**It is not a fix for slow queries.** Moving an unindexed aggregate to a replica
makes it a different CPU's problem, while that CPU is also replaying WAL. A plan
that ships read-splitting *instead of* an index has added a moving part and kept
the latency.

**The local replicas are for fidelity, not capacity.** docker and minikube run
one node, so their replica isolates nothing and offloads nothing measurable. It
is there so the read path, the watermark and the lag circuit are exercised by
everyone who runs the stack, instead of only in production. Budget the RAM for
it: a second Postgres on a laptop is not free.

**ec2's replica is not failure isolation either.** Same host, same kernel, same
disk. It serves read load and exercises the path; it does not survive the
instance.

## Open decisions

1. **Self-managed streaming replica, or RDS read replica?** RDS is dramatically
   less work on the AWS targets and the connection layer already anticipates it
   (the SSL defaults mention RDS explicitly), but it applies only there.
   Self-managed keeps ec2 and eks symmetric at the cost of owning basebackup,
   slots and monitoring. **This changes most of Phase 1 and none of Phases 3–5**,
   so the connection work can proceed in parallel.

2. **Per-tier read pools, or one shared read pool?** Mirroring the existing tier
   split preserves noisy-neighbour isolation for reads and costs four more
   pools; one pool is simpler and drops that property.

3. **Who opts in?** This plan assumes per-call-site opt-in. Routing all `GET`
   handlers to the replica and pinning exceptions is far less work and is how
   most teams do it — but a missed exception is user-visible and
   non-reproducible.

4. **Is the goal load, or availability?** They pull in opposite directions. Load
   wants the replica busy; availability wants it idle and ready. If availability
   is the real goal, a manager plus promotion is the higher-value project and
   this becomes a prerequisite rather than the deliverable.

5. **Does the ec2 replica earn its keep?** It is mandated here (min 1 on every
   target) and it does exercise the read path, but on a single instance it
   provides no failure isolation and no genuine offload. Worth revisiting once
   there is measured read load, rather than assumed.

## Suggested sequencing

**Phase A stands alone and should go first.** It needs no standby, no pgbouncer
change and no application code, and the floor correction is worth having whether
or not read-splitting ever ships. Land it in two steps, not one: the
requests/limits floor on its own (verifying every pod still schedules on
minikube, where the 7× reservation increase bites hardest), then the scoped
cadvisor job and the saturation alerts that make the ladder actionable.

**Phase 3 is already done** and merged inert, with `DB_READ_HOST` unset
everywhere — independently reviewable, and it turns Phase 4 into a series of
small revertible changes. Phase 0a is done too (see its table); 0b, the
measurement that decides whether any of this is worth doing, is **not**, and it
is the cheapest remaining thing to do.

**Two things gate Phase 4 and should be settled before anyone opts a call site
in**: the cross-request read-after-write mechanism (pin or LSN), and Phase 1a's
volume adoption rehearsed on minikube. Neither is a detail that can be worked
out while migrating call sites.

Infrastructure (Phases 1–2) lands in parallel and stays dark until a host is
configured. Bring the replica up on **one target first** — minikube is the
cheapest place to get the StatefulSet, the basebackup seeding and the first-init
guard wrong — then eks, then ec2 and docker. Do not configure `DB_READ_HOST`
anywhere until Phase 5's lag circuit and slot-retention alert exist; a replica
serving reads with no way to see it falling behind is the failure this plan is
meant to prevent.

The ceiling of 2 is only reachable once the WAL-retention guards are in place.
Until `max_slot_wal_keep_size` is set and slot-retained bytes are alerted, every
target stays at exactly 1 regardless of load — a second replica without those
guards risks the primary'''s write path, which is a worse outcome than slow reads.

Phase 6 is separable and may be worth doing first if the primary'''s backup
window is already a problem.
