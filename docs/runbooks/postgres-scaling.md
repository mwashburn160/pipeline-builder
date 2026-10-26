<!--
Copyright 2026 Pipeline Builder Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Postgres Scaling Runbook

## Highlights

- **Writes do not scale horizontally.** Streaming replication gives exactly one
  primary. The only levers on the write path are a resource rung or less work.
- **The resource ladder has three rungs and you move the whole rung.** CPU and
  memory are not independent dials, because the server config is derived from
  the memory figure.
- **The ceiling is the namespace's hard cap, with zero headroom.** 4 CPU is
  exactly the LimitRange maximum. Going past it means raising the LimitRange
  *first*, or the pod cannot be created at all and there is nothing to debug.
- **Scaling is automatic, in two stages: OUT first, then UP.** KEDA adds
  standbys to `PG_READ_REPLICA_MAX`; only at that ceiling does the vertical
  ladder move. The primary has no horizontal stage at all.
- **A standby is never smaller than the primary.** One below it cannot be
  promoted, which is most of the reason to keep one.
- **Replication lag means shed reads, never add a replica.** Another standby
  adds another WAL sender and makes replay worse.
- **A replication slot can take the write path down.** It retains WAL on the
  primary until its standby consumes it, so a stuck standby fills the primary's
  volume and stops writes.

## Overview

Two independent scaling axes, and conflating them is the common mistake:

| Axis | What it changes | Driven by | Bounded by |
|---|---|---|---|
| **Vertical (either workload)** | CPU, memory, and the server config derived from memory | the `platform` rung controller, from the saturation / underutilisation alerts | the LimitRange: container `cpu 4`, `memory 10Gi` |
| **Horizontal (the standbys only)** | Read capacity | a KEDA `ScaledObject`, from CPU/memory utilization | `PG_READ_REPLICA_MAX` (AWS 2, local 1) and the declared standby PVs |

**Stage order is enforced in code, not just documented.** A standby reaches the
vertical ladder only once it is at `PG_READ_REPLICA_MAX`: adding a standby adds
read capacity without restarting anything, whereas a rung change restarts every
standby. `PostgresReadReplicaSaturated` is tuned *above* KEDA's own threshold
(85% vs 75%), so its arrival already means the autoscaler could not fix it — but
the controller re-checks the live replica count anyway, because an alert cannot
see it.

Neither helps the other. Adding standbys does nothing for write throughput;
raising the primary's rung does nothing for read capacity once the read path is
actually offloaded.

## How it works

### The resource ladder

One ladder, three rungs. A bump is picking a row, not inventing a pair of
numbers:

| Rung | CPU (requests = limits) | Memory (requests = limits) | `shared_buffers` | `effective_cache_size` |
|---|---|---|---|---|
| Floor (default) | `1000m` | `2Gi` | `512MB` | `1200MB` |
| Middle | `2000m` | `4Gi` | `1GB` | `2400MB` |
| Ceiling | `4000m` | `8Gi` | `2GB` | `4800MB` |

`shared_buffers` is 25% of the memory limit, `effective_cache_size` ~60% — the
conventional Postgres ratios. Memory is 2Gi per vCPU at every rung.

**Requests equal limits deliberately**, which makes the pod Guaranteed QoS.
Before this, Postgres ran `limits 1000m/1536Mi` against `requests 150m/768Mi` —
Burstable — so the scheduler reserved 0.15 CPU for the tier carrying every write
in the product, throttled it toward that request under node pressure, and would
evict it before any Guaranteed pod.

**A rung change is always two edits, together**: the pod's requests/limits *and*
the `-c` server flags. `postgres-replica-parity.test.ts` asserts
`shared_buffers` stays at 25% of the memory limit, so a half-applied rung fails
the build rather than shipping. Raising the pod alone buys page cache and
almost nothing else — without these flags Postgres runs on the image default of
128MB of shared buffers however much memory the pod is given.

### Why memory is the dangerous axis

Over its CPU limit a container is throttled and recovers. Over its **memory**
limit it is OOM-killed — and for a single primary on a `Recreate` strategy that
is write downtime plus crash recovery, caused by the limit that was supposed to
protect it. Hence:

- `PostgresPrimaryMemoryPressure` fires at **0.80** and after **10m**;
  `PostgresPrimaryCpuSaturated` at **0.85** after **15m**. Memory fires lower
  and sooner on purpose.
- `work_mem` is allocated per sort or hash **per connection**, so the worst case
  is `work_mem × concurrent operations`, bounded by the pgbouncer budget (110
  server connections on the primary across both pooler replicas), not by
  `max_connections=200`. At 4MB that is ~440MB, which with 512MB of shared
  buffers leaves real headroom under the 2Gi floor. This is the term that turns
  a generous `work_mem` into an OOM rather than a speed-up.
- `resizePolicy` declares `cpu: NotRequired` and `memory: RestartContainer`.
  That is not pessimism: `shared_buffers` is read at startup, so new memory
  without a restart would leave the server config on the old rung — a
  half-applied rung that reports success.

### Why 4 CPU and not 5

`k8s/resource-limits.yaml` is a **LimitRange**, which its own comment is
emphatic about: *"a HARD admission gate, not a scheduling hint: a container
whose limit (or request) exceeds it cannot be created at all — the ReplicaSet
just emits `pods "..." is forbidden` and the Deployment sits at 0/1 with no pod
to inspect."*

Container max is `cpu "4"`, `memory 10Gi`. So the top rung is admissible with
**zero headroom**: `4 == 4`. The Pod-level cap (`cpu 6`, `memory 10Gi`) is not
breached — the ceiling rung plus the `postgres-exporter` sidecar (`100m`/`128Mi`)
totals 4.1 CPU and ~8.1Gi — but any future sidecar eats that margin.

## Configuration

### Automatic rung changes (`POSTGRES_RUNG_ENABLED=true`)

Alertmanager routes the Postgres CPU/memory alerts to
`POST /observability/postgres-rung` on `platform`, authenticated with the same
per-instance relay secret as `/pvc-autoexpand`, and the controller moves one
rung — pod requests/limits **and** the derived server config in one patch.
**Off by default**: a rung change restarts the container, and on the single
primary that is a brief write interruption.

| Alert | Workload | Direction |
|---|---|---|
| `PostgresPrimaryCpuSaturated` | primary | up |
| `PostgresPrimaryMemoryPressure` | primary | up |
| `PostgresPrimaryUnderutilised` | primary | down |
| `PostgresReadReplicaSaturated` | standby | up — only at replica max |
| `PostgresReadReplicaUnderutilised` | standby | down — only above the primary's rung |

What it refuses to do, and the outcome it reports:

| Outcome | Meaning |
|---|---|
| `at-ceiling` | At `POSTGRES_RUNG_MAX`. Raising it means raising the **LimitRange first**, or the pod cannot be created at all |
| `at-floor` | At `1000m/2Gi`; the data tier does not drop below Guaranteed QoS at 1 CPU |
| `not-at-replica-max` | A standby KEDA can still scale **out**, and out is cheaper than up |
| `below-primary` | A standby rung-down that would put it under the primary, so it could not be promoted |
| `cooldown` | Inside `POSTGRES_RUNG_COOLDOWN_SECONDS` of the last decision |
| `error` + "Redis unavailable" | **Fails closed.** No Redis means no cooldown and no cross-replica lock, so two platform replicas would both restart the primary |

Watch `postgres_rung_current{workload}`, `postgres_rung_at_ceiling{workload}`
and `postgres_rung_total{workload,direction,result}`.

**Scale-down is deliberately hard to trigger**: both axes below 30%/40% of their
limits, over a 30-minute rate, sustained for **2 hours**, and `severity: info`
rather than a page. The deadband between that and the scale-up thresholds
(0.85 CPU / 0.80 memory) is where a correctly-sized database sits; a narrower
one would oscillate, and every oscillation is a restart.

**One interaction worth knowing**: raising a standby's rung lowers its
utilization as a share of the new, larger request, which looks to KEDA like
idleness. The `ScaledObject`'s scale-down stabilization window is longer than
its scale-up window precisely so a rung change settles before the count reacts.

### Moving the primary up a rung, by hand

For when `POSTGRES_RUNG_ENABLED` is false, or the controller reported
`at-ceiling` and you have decided to raise the LimitRange. Triggered by
`PostgresPrimaryCpuSaturated` **or** `PostgresPrimaryMemoryPressure`, sustained.
Both move the *whole* rung.

1. **Check you are not already at the ceiling.** At 4 CPU / 8Gi neither alert
   means "add resources" any more — see [At the ceiling](#at-the-ceiling).
2. **Edit the target's `k8s/postgres.yaml`**: the container `resources` (requests
   *and* limits) and the `-c shared_buffers` / `-c effective_cache_size` flags,
   to one row of the ladder.
3. **Edit `k8s/postgres-replica.yaml` to match.** The parity test requires it,
   and Postgres requires it: a standby whose `max_connections`,
   `max_worker_processes`, `max_wal_senders`, `max_prepared_transactions` or
   `max_locks_per_transaction` is *lower* than the primary's refuses to start as
   a hot standby.
4. **Apply, and expect a restart.** The memory `resizePolicy` is
   `RestartContainer` because the paired config change needs one anyway. On a
   single primary that is write downtime — schedule it.
5. **Verify the server actually took the new values**, not just that the pod is
   Running:

   ```bash
   kubectl exec -n pipeline-builder deploy/postgres -c postgres -- \
     psql -U "$POSTGRES_USER" -d postgres -c "SHOW shared_buffers; SHOW effective_cache_size"
   ```

**On minikube, check scheduling first.** Its VM is operator-sized at
`minikube start --cpus=$MK_CPUS`, and those flags are **create-time only** — an
existing profile does not grow. The floor alone took Postgres from reserving
0.15 to 1.0 vCPU; the middle and top rungs are generally unreachable on a laptop
and the ceiling should not be configured there at all.

### At the ceiling

At 4 CPU / 8Gi, `PostgresPrimaryCpuSaturated` firing is **not** a request for
more CPU. There is no rung above, and raising the LimitRange to make one is a
namespace-wide change that affects every workload's admission.

The answers, in order of how often they are the real one:

1. **A query or a missing index.** `pg_stat_statements` ordered by `total_exec_time`.
2. **Read load that has not been offloaded.** Check
   `postgres_read_routed_total{target="primary"}` by `reason`: if it is mostly
   `no-replica` the feature is not enabled, if mostly `replica-lagging` the
   circuit is open, if mostly `may-have-written` the write-pin TTL is too long
   for the traffic.
3. **Only then** a larger node class and a raised LimitRange, in that order.

Record which one it was. A ceiling that pages forever with no action is worse
than no alert.

### Adding a read replica (AWS targets, 1 → 2)

Triggered by `PostgresReadReplicaSaturated`, sustained. **Not** by
`PostgresReplicationLagHigh` — see [Lag](#lag-is-not-a-capacity-signal).

**Prerequisites, all of them, before going past one standby:**

- `max_slot_wal_keep_size` is set on the primary (it is: 4GB on AWS, 256MB
  local).
- `PostgresReplicationSlotRetainedBytes` and `PostgresReplicationSlotOrphaned`
  are deployed and firing correctly.
- On **ec2 only**: the DataVolume has room and a PV exists for the new ordinal.
  Only one standby PV is declared there. In this order — grow
  `DataVolumeSize` (and its `MinValue`) by 20 GiB, add a PV with a **distinct**
  `hostPath`, then raise `replicas`. Raise replicas first and the pod sits
  Pending forever with the PVC's description the only clue. eks needs none of
  this: `pb-ebs` provisions dynamically.

Then:

```bash
kubectl scale statefulset postgres-replica -n pipeline-builder --replicas=2
```

**One at a time, and watch the primary.** A new standby is seeded with
`pg_basebackup`, which takes minutes and loads the primary *while it is already
under pressure*. This is why scaling is operator-approved rather than a KEDA
`ScaledObject`: automatic scale-up at peak can deepen the incident it is
reacting to.

Verify it is actually streaming, not merely Ready:

```bash
kubectl exec -n pipeline-builder deploy/postgres -c postgres -- \
  psql -U "$POSTGRES_USER" -d postgres -c "SELECT client_addr, state, sync_state FROM pg_stat_replication"
```

**Scaling down**: one at a time on sustained low utilisation, never below 1 —
and **drop the slot afterwards**, or it retains WAL forever (see
`PostgresReplicationSlotOrphaned`).

### At the replica ceiling

The answer is no longer "add a replica". It is a query or an index, exactly as
at the CPU ceiling.

## Lag is not a capacity signal

Saturation says *add capacity*. Lag says *this standby cannot keep up with
replay*. They point in opposite directions, and wiring lag to a scale-up would
deepen the incident being reported: another standby is another WAL sender on a
primary that is already the bottleneck.

When `PostgresReplicationLagHigh` fires, reads have **already** shed back to the
primary — the application's lag circuit opens on its own. So this is a
throughput event, not a correctness one. Look at:

- **Long-running read queries on the standby.** They block replay.
  `max_standby_streaming_delay=30s` gives them a window; past it they are
  cancelled with *"canceling statement due to conflict with recovery"*, which
  surfaces at the reader with the cause on the other server.
- **The primary's write rate.** Replay is single-threaded; a bulk write can
  outrun it.

`hot_standby_feedback=on` stops the primary vacuuming rows a standby's open
query still needs, which is the other half of that interaction.

## Troubleshooting

### Reads are not reaching the replica

`postgres_read_routed_total{target="primary"}` carries the reason. Each one is a
different fix:

| `reason` | Meaning | Fix |
|---|---|---|
| `no-replica` | `DB_READ_HOST` unset, or `DB_READ_ENABLED=false` | Expected until someone opts in — this is how all four targets ship |
| `replica-lagging` | Lag beyond `DB_READ_MAX_LAG_SECONDS`, **or unknown** | See below; unknown and lagging are the same decision on purpose |
| `no-context` | A caller outside `runWithTenantContext` | A wiring bug. The primary path's `RLS_CONTEXT_MODE` guard will name the call site |
| `may-have-written` | This request wrote, or its org wrote inside the pin TTL | Correct behaviour. If it dominates, `DB_READ_WRITE_PIN_TTL_SECONDS` is too long for the traffic |

**`postgres_replica_lag_seconds` has no series at all** has TWO causes, and they
need opposite responses:

1. **Nothing is reading.** The sampler runs only from the read path, so an idle
   process never samples — and `PostgresReadCircuitOpen` therefore cannot fire
   either. This is expected while few call sites are opted in. Check lag from
   the PRIMARY's side instead, which is independent of application traffic:
   `pb_replication_client_replay_lag_bytes` and `PostgresReplicationLagHigh`.
   That exporter metric is the real safety net; the app-side gauge is
   supplementary.
2. **The services cannot reach the standby**, which is not the same as it being
   behind. The circuit fails
closed on an unknown lag, so this looks identical to real lag. Check, in order:

1. `DB_READ_DATABASE` — it must be `pipeline_builder_read`, the pgbouncer
   database whose `[databases]` entry names `host=postgres-read`. Pointing it at
   `pipeline_builder` sends every read back to the primary through a second pool
   with nothing to indicate it.
2. The `allow-postgres-replica-ingress` NetworkPolicy and the
   `postgres-replica-allow` AuthorizationPolicy. Both fail as a timeout.
3. The standby's own health.

### Reads are slow but the standby looks idle

The standby's CPU can sit at 40% while every read queues, because the
bottleneck is the POOLER's server-connection budget rather than the database.
The container-CPU alerts are blind to that by construction, which is why these
two exist — and the pair is what tells the two remedies apart:

| Firing | Meaning | Do |
|---|---|---|
| `PostgresReadPoolExhausted` (± queuing) | The read pool is at its `max_db_connections` | Raise it in `pgbouncer.yaml` **and** check the standby's own `max_connections` — the read pool draws on the standby's budget, not the primary's |
| `PostgresReadPoolQueuing` alone | Connections are free but clients still wait | The standby is slow, not the pool. Look at replay conflicts and long read queries |

Note `DB_READ_MAX_POOL_SIZE` is per service **process** while
`max_db_connections` caps the whole pool, so client-side demand can exceed the
server-side cap by a wide margin; that is what pooling absorbs, and these alerts
are where it becomes visible.

### `PostgresReplicationSlotRetainedBytes` — the one that threatens writes

A slot retains WAL on the **primary** until its standby consumes it. This is not
a read-path problem; it fills the primary's volume, and a full volume stops
Postgres accepting writes.

```bash
kubectl exec -n pipeline-builder deploy/postgres -c postgres -- \
  psql -U "$POSTGRES_USER" -d postgres -c \
  "SELECT slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
   FROM pg_replication_slots ORDER BY 3 DESC"
```

- **`active = t`** — a standby is attached but behind. Fix the standby; the slot
  drains on its own.
- **`active = f`** — orphaned. Nothing is coming for it. Drop it:
  `SELECT pg_drop_replication_slot('<slot_name>')`.

`max_slot_wal_keep_size` is the backstop, and it costs you the standby: past it
Postgres invalidates the slot and that standby must be re-seeded. The alert
fires at 192MiB, below the smallest cap across targets, so there is always a
window to act first.

### A standby that is healthy and empty

The symptom: the pod is Ready, `pg_isready` passes, queries succeed, and the
data is missing or ancient.

This is the first-init trap. The official entrypoint runs `initdb` on an empty
`PGDATA`, which on a standby produces a second, **independent** cluster that
passes every probe in this repo and shares no data with the primary. The
`basebackup` init container exists to make that impossible — it exits non-zero
rather than letting Postgres start unseeded. If you see this, something bypassed
it:

```bash
kubectl exec -n pipeline-builder postgres-replica-0 -c postgres-replica -- \
  psql -U "$POSTGRES_USER" -d postgres -c "SELECT pg_is_in_recovery()"
```

`false` on a pod named `postgres-replica-*` means it is its own primary. Delete
the PVC and the pod so it re-clones, then drop the orphaned slot.

### After a restore

**A restore invalidates every standby.** It rewrites the primary and starts a new
timeline; a standby still streaming may keep serving its pre-restore copy with
no error at all. `deploy/bin/restore.sh` prints the re-seed commands when it
finishes — follow them, then drop the old slots.

## Reference

| Alert | Fires on | Action |
|---|---|---|
| `PostgresPrimaryCpuSaturated` | >85% of the CPU limit, 15m | Up one rung; at the ceiling, a query or an index |
| `PostgresPrimaryMemoryPressure` | >80% of the memory limit, 10m | Up one rung — before the OOM kill |
| `PostgresReadReplicaSaturated` | A standby >85% of its CPU limit, 15m | Standby scales out (KEDA), or up at the ceiling |
| `PostgresReplicationLagHigh` | A standby >64MiB behind replay, 10m | Shed reads (automatic). **Never** add a replica |
| `PostgresReplicationStopped` | Zero streaming standbys, 10m | Page. The slot is still retaining WAL |
| `PostgresReplicationSlotRetainedBytes` | A slot holding >192MiB, 15m | Page. The primary's volume is at risk |
| `PostgresReplicationSlotOrphaned` | A slot inactive 30m | Drop it |
| `PostgresReadCircuitOpen` | Circuit open 30m | Reads have given up on the replica |
| `PostgresReadPoolQueuing` | Oldest read client waited >1s, 10m | The POOLER is the bottleneck, not the standby — which can look idle on CPU |
| `PostgresReadPoolExhausted` | Read pool >90% of its cap, 15m | Raise `max_db_connections` AND the standby's capacity |
| `PostgresReplicaUnreachable` | A standby's exporter cannot reach it, 5m | Reads shed on their own; the urgent part is the WAL its slot still retains |
| `PostgresPrimaryUnderutilised` | Both axes low, 2h | Primary drops a rung (info, not a page) |
| `PostgresReadReplicaUnderutilised` | Both axes low on a standby, 2h | Standby drops a rung, never below the primary's |

| Setting | Default | Notes |
|---|---|---|
| `DB_READ_HOST` | *(unset)* | The **pooler**. Unset = no replica, every read on the primary |
| `DB_READ_DATABASE` | `pipeline_builder_read` | The pgbouncer database that routes to the standby |
| `DB_READ_ENABLED` | `true` | Kill switch; forces reads to the primary with no redeploy |
| `DB_READ_MAX_LAG_SECONDS` | `5` | Circuit threshold. Not read-after-write protection |
| `DB_READ_LAG_SAMPLE_MS` | `5000` | 3x this and the sample counts as unknown |
| `DB_READ_WRITE_PIN_TTL_SECONDS` | `10` | Cross-request read-after-write. Needs Redis |
| `DB_REPLICATION_USER` / `_PASSWORD` | `pb_replicator` / *(generated)* | The standbys' login. [Rotation](secret-rotation.md#db_replication_password-read-replicas) has no overlap window |
| `PG_READ_REPLICA_MIN` / `_MAX` | `1` / `2` AWS, `1` local | The KEDA floor and ceiling. **Not** the StatefulSet's `replicas`, which the AWS manifests omit so a redeploy cannot fight the HPA. `MAX` may not exceed the declared standby PVs on the hostPath targets — `pb_read_replica_env` refuses the deploy |
| `POSTGRES_RUNG_ENABLED` | `false` | Automatic vertical scaling. A rung change restarts the container |
| `POSTGRES_RUNG_MAX` | `2` | Top rung index; `2` is the LimitRange's container max exactly |
| `POSTGRES_RUNG_COOLDOWN_SECONDS` | `1800` | Hold after a decision; Alertmanager re-sends on its repeat interval |

Design rationale, decisions and what this does **not** buy:
[docs/plans/postgres-read-write-split.md](../plans/postgres-read-write-split.md).
