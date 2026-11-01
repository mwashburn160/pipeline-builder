---
layout: default
title: Postgres Failover
---

<!--
Copyright 2026 Pipeline Builder Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Postgres Failover Runbook

Promoting the streaming standby when the primary is gone. **Read the first
Highlight before doing anything** — the failure this runbook exists to prevent is
reaching for the nightly dump when a standby is seconds behind.

## Highlights

- **Do not restore from the dump first.** A streaming standby runs on every
  target. The dump's RPO is up to 24 hours; the standby's is seconds. Restoring
  when you could have promoted throws away a day of customer data, and it is the
  likeliest mistake here because it is what the DR section used to say.
- **Nothing promotes it for you.** There is no Patroni, no repmgr, no
  `pg_auto_failover`. Redis is the only store on this deployment with automatic
  failover. The exposure is therefore *time to notice*, not restore time.
- **Promotion is one-way.** A promoted standby cannot go back to streaming from
  the old primary; the old primary can only come back as a *new* standby, which
  means re-seeding it from scratch.
- **The old primary must not come back on its own.** `postgres` is a Deployment
  with `strategy: Recreate`. If its volume survives and the pod restarts after
  you promote, two nodes both believe they are primary and accept writes —
  split-brain, and the only clean exit is discarding one side's writes. Scale it
  to zero *before* you promote.
- **Repoint the Service, not pgbouncer.** `kubectl patch` on the `postgres`
  Service selector is one command, needs no config reload, and every consumer
  follows it. Editing `pgbouncer.ini` is a config change plus a reload, and it
  leaves the read pool pointing somewhere else.
- **Replication is ASYNCHRONOUS.** There is no `synchronous_standby_names` on any
  target, so promotion loses whatever had not replayed. Capture the replay
  position first so the loss is a known quantity rather than a guess.
- **You are down to one copy afterwards.** Re-seeding a standby is part of the
  incident, not cleanup for next week.

## Overview

The topology, the resource ladder and why a standby is never smaller than the
primary are in [Postgres Scaling](postgres-scaling.md) — this runbook assumes it
rather than repeating it. What matters here:

| Piece | What it is |
|---|---|
| `postgres` | Deployment, `replicas: 1`, `strategy: Recreate`. **The primary.** |
| `postgres` (Service) | `ClusterIP`, `selector: app: postgres`. What pgbouncer's write pools resolve. |
| `postgres-replica` | StatefulSet, `app: postgres-replica`. The standby, seeded by `pg_basebackup -R` with a permanent per-pod slot. On eks a KEDA `ScaledObject` owns the count (`PG_READ_REPLICA_MIN`…`MAX`, ceiling 2); on ec2/minikube it is a fixed 1. |
| `postgres-read` (Service) | `selector: app: postgres-replica`. Only consulted when `DB_READ_HOST` is set, which is **unset on every shipped target**. |

Every service writes through `DB_HOST=pgbouncer:6432`, and pgbouncer's
`pipeline_builder` pool is `host=postgres`. So the write path is
**service → pgbouncer → `postgres` Service → primary pod**, and the single thing
that has to change on promotion is which pod that Service selects.

## How it works

### Deciding to promote

Promotion is irreversible, so spend thirty seconds ruling out the cheap causes.

`PostgresUnreachable` fires when postgres-exporter cannot query Postgres for 3
minutes *while the exporter's own pod is healthy*. That already excludes an
exporter crash. It does **not** exclude a pod that is restarting, a node that is
draining, or a volume that is briefly detached — all of which resolve themselves
and none of which want a promotion.

```sh
kubectl -n pipeline-builder get pods -l app=postgres
kubectl -n pipeline-builder describe pod -l app=postgres | tail -30
kubectl -n pipeline-builder logs deploy/postgres --tail=100
```

**Promote when** the volume is lost or corrupt, the node is gone and the RWO
volume cannot attach elsewhere, or Postgres will not start and the cause is not
fixable in less time than the outage costs.

**Do not promote** for a `CrashLoopBackOff` with a legible cause, a pod that is
`Pending` on a resource request (see [Postgres Scaling](postgres-scaling.md)), or
`PostgresReplicationStopped` on its own — that one says the *standby* is broken,
which is the opposite situation, and promoting into it is how you lose both
copies.

### Step 1 — record how much you are about to lose

Asynchronous replication means the standby may be behind. Ask it, before you
change anything:

```sh
kubectl -n pipeline-builder exec postgres-replica-0 -c postgres-replica -- \
  psql -U postgres -tAc \
  "SELECT pg_is_in_recovery(), pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn(),
          now() - pg_last_xact_replay_timestamp() AS replay_age;"
```

`pg_is_in_recovery()` must be `t` — if it is `f` this node is already a primary
and you are about to create a second one. `replay_age` is the data-loss window.
Write it in the incident channel: it is the number anyone later asking "what did
we lose" needs, and it is unrecoverable once you promote.

If `receive_lsn` is ahead of `replay_lsn`, the standby has WAL it has not applied
yet. Wait for them to converge before promoting — that is free data.

### Step 2 — stop the old primary coming back

Do this **before** promoting, not after. `strategy: Recreate` plus a surviving
volume is all it takes for Kubernetes to restart a primary that then accepts
writes nobody is replicating.

```sh
kubectl -n pipeline-builder scale deploy/postgres --replicas=0
kubectl -n pipeline-builder get pods -l app=postgres   # expect: no resources found
```

### Step 3 — promote

```sh
kubectl -n pipeline-builder exec postgres-replica-0 -c postgres-replica -- \
  psql -U postgres -c "SELECT pg_promote(wait => true, wait_seconds => 60);"
```

`pg_promote` removes `standby.signal` and ends recovery. Confirm:

```sh
kubectl -n pipeline-builder exec postgres-replica-0 -c postgres-replica -- \
  psql -U postgres -tAc "SELECT pg_is_in_recovery();"   # expect: f
```

### Step 4 — repoint the write path

One patch. pgbouncer keeps `host=postgres` and needs no reload, because what
changes is which pod that Service name resolves to:

```sh
kubectl -n pipeline-builder patch svc postgres \
  -p '{"spec":{"selector":{"app":"postgres-replica"}}}'
```

pgbouncer's existing server connections are to an address that no longer answers,
so they fail and are re-established against the new target. Writes resume within
seconds; in-flight transactions at the moment of failure are lost and the
application sees connection errors, which is the expected shape — see
[pgbouncer sidecar SPOF](../deploy-operations.md) for why a broken pooler looks
like `db ECONNRESET` with clean Postgres logs.

Verify from a service, not just from psql:

```sh
kubectl -n pipeline-builder exec deploy/pgbouncer -c pgbouncer -- \
  psql "postgres://$PGBOUNCER_USER:$PGBOUNCER_PASS@localhost:6432/pipeline_builder" \
  -tAc "SELECT pg_is_in_recovery(), current_setting('transaction_read_only');"
```

Both should be `f` / `off`. If `transaction_read_only` is `on`, you are still
talking to a standby and the patch has not taken effect.

### Step 5 — re-seed a standby

You are now running on a single copy with no second line. The promoted pod is
`postgres-replica-0`, which is also what `postgres-read` and the remaining
standby slots are named for — so the cleanest recovery is to rebuild the pair
rather than nest a standby under a StatefulSet member:

1. Re-provision the `postgres` Deployment's volume (the old one is the lost or
   corrupt disk) and bring it up **empty**.
2. Seed it from the new primary the same way `postgres-replica` seeds itself:
   `pg_basebackup -R --create-slot --slot=<name>` against the promoted pod.
3. Once it is streaming, you have a primary and a standby again — in the mirror
   image of the usual roles. Decide deliberately whether to stay that way or to
   fail back during a maintenance window, and if you fail back, do it with this
   runbook and not by editing the Service twice.

Until a standby is streaming, `pb_replication_connected_standbys` is 0 and
`PostgresReplicationStopped` fires. That alert is **correct** during this window;
do not silence it beyond the time you expect re-seeding to take.

### Step 6 — the replication slot on the old primary

If the old primary's volume survived, it still holds a permanent slot for the
standby you just promoted. It retains WAL for a consumer that is never coming
back, so if that volume is ever mounted again it will fill — see
`PostgresReplicationSlotRetainedBytes` and
[Postgres Scaling](postgres-scaling.md#postgresreplicationslotretainedbytes--the-one-that-threatens-writes).
Drop the slot before reusing the volume for anything, or discard the volume.

## Configuration

| Variable | Role in failover |
|---|---|
| `DB_REPLICATION_USER` / `DB_REPLICATION_PASSWORD` | The standby's streaming credentials. A failed authentication in the standby's logs is the **expected** symptom after rotating these — see [Secret Rotation](secret-rotation.md). Re-seeding needs them. |
| `DB_HOST` / `DB_PORT` | `pgbouncer` / `6432` on every target. Unchanged by failover — the Service patch is what moves. |
| `DB_READ_HOST` | Unset on every shipped target, so nothing reads from the standby today. If you have enabled it, note that after promotion `postgres-read` selects the pod that is now the primary: correct, but no longer offloading anything. |
| `PG_READ_REPLICA_MIN` / `MAX` | eks only. KEDA owns the standby count; the StatefulSet declares no `replicas`. Scaling the StatefulSet by hand is re-applied away. |

## What this does not cover

- **Point-in-time recovery.** The dumps are logical (`pg_dump`) and there is no
  WAL archive, so recovery lands on a dump boundary or on the standby's last
  replayed transaction, and nowhere in between.
- **MongoDB.** `rs0` is a one-member replica set for transactions and change
  streams, not redundancy. There is nothing to promote; Mongo's recovery really
  is the nightly dump.
- **Automatic failover.** Deliberately absent today. Adding it (Patroni, CNPG)
  is an architectural decision, not a runbook step.

## Related

- [Postgres Scaling](postgres-scaling.md) — the topology, the resource rungs, and the slot that threatens the write path
- [Deploy Operations](../deploy-operations.md#rpo-and-rto) — RPO/RTO, what is and is not backed up
- [Secret Rotation](secret-rotation.md) — rotating `DB_REPLICATION_PASSWORD`
