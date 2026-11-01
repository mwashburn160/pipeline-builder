// GENERATED FROM docs/runbooks/postgres-failover.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: aeaa10273203ab39fde093150ea0c77868ecbb1aa35f4c9336d1ac218cb2255a
// SPDX-License-Identifier: Apache-2.0
import { Siren } from 'lucide-react';
import type { HelpTopic } from '../types';

export const runbookPostgresFailoverTopic: HelpTopic = {
  "icon": Siren,
  "id": "runbook-postgres-failover",
  "title": "Runbook: Postgres Failover",
  "description": "Promote the streaming standby when the primary is gone — deciding to, the loss window, repointing the write path",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "<!-- Copyright 2026 Pipeline Builder Contributors SPDX-License-Identifier: Apache-2.0 -->"
        },
        {
          "type": "text",
          "content": "Promoting the streaming standby when the primary is gone. Read the first Highlight before doing anything — the failure this runbook exists to prevent is reaching for the nightly dump when a standby is seconds behind."
        }
      ]
    },
    {
      "id": "highlights",
      "title": "Highlights",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Do not restore from the dump first. A streaming standby runs on every"
          ]
        },
        {
          "type": "text",
          "content": "target. The dump's RPO is up to 24 hours; the standby's is seconds. Restoring when you could have promoted throws away a day of customer data, and it is the likeliest mistake here because it is what the DR section used to say."
        },
        {
          "type": "list",
          "items": [
            "Nothing promotes it for you. There is no Patroni, no repmgr, no"
          ]
        },
        {
          "type": "text",
          "content": "pg_auto_failover. Redis is the only store on this deployment with automatic failover. The exposure is therefore time to notice, not restore time."
        },
        {
          "type": "list",
          "items": [
            "Promotion is one-way. A promoted standby cannot go back to streaming from"
          ]
        },
        {
          "type": "text",
          "content": "the old primary; the old primary can only come back as a new standby, which means re-seeding it from scratch."
        },
        {
          "type": "list",
          "items": [
            "The old primary must not come back on its own. postgres is a Deployment"
          ]
        },
        {
          "type": "text",
          "content": "with strategy: Recreate. If its volume survives and the pod restarts after you promote, two nodes both believe they are primary and accept writes — split-brain, and the only clean exit is discarding one side's writes. Scale it to zero before you promote."
        },
        {
          "type": "list",
          "items": [
            "Repoint the Service, not pgbouncer. kubectl patch on the postgres"
          ]
        },
        {
          "type": "text",
          "content": "Service selector is one command, needs no config reload, and every consumer follows it. Editing pgbouncer.ini is a config change plus a reload, and it leaves the read pool pointing somewhere else."
        },
        {
          "type": "list",
          "items": [
            "Replication is ASYNCHRONOUS. There is no synchronous_standby_names on any"
          ]
        },
        {
          "type": "text",
          "content": "target, so promotion loses whatever had not replayed. Capture the replay position first so the loss is a known quantity rather than a guess."
        },
        {
          "type": "list",
          "items": [
            "You are down to one copy afterwards. Re-seeding a standby is part of the"
          ]
        },
        {
          "type": "text",
          "content": "incident, not cleanup for next week."
        }
      ]
    },
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "The topology, the resource ladder and why a standby is never smaller than the primary are in Postgres Scaling — this runbook assumes it rather than repeating it. What matters here:"
        },
        {
          "type": "table",
          "headers": [
            "Piece",
            "What it is"
          ],
          "rows": [
            [
              "postgres",
              "Deployment, replicas: 1, strategy: Recreate. The primary."
            ],
            [
              "postgres (Service)",
              "ClusterIP, selector: app: postgres. What pgbouncer's write pools resolve."
            ],
            [
              "postgres-replica",
              "StatefulSet, app: postgres-replica. The standby, seeded by pg_basebackup -R with a permanent per-pod slot. On eks a KEDA ScaledObject owns the count (PG_READ_REPLICA_MIN…MAX, ceiling 2); on ec2/minikube it is a fixed 1."
            ],
            [
              "postgres-read (Service)",
              "selector: app: postgres-replica. Only consulted when DB_READ_HOST is set, which is unset on every shipped target."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Every service writes through DB_HOST=pgbouncer:6432, and pgbouncer's pipeline_builder pool is host=postgres. So the write path is service → pgbouncer → postgres Service → primary pod, and the single thing that has to change on promotion is which pod that Service selects."
        }
      ]
    },
    {
      "id": "how-it-works",
      "title": "How it works",
      "blocks": [
        {
          "type": "text",
          "content": "Deciding to promote"
        },
        {
          "type": "text",
          "content": "Promotion is irreversible, so spend thirty seconds ruling out the cheap causes."
        },
        {
          "type": "text",
          "content": "PostgresUnreachable fires when postgres-exporter cannot query Postgres for 3 minutes while the exporter's own pod is healthy. That already excludes an exporter crash. It does not exclude a pod that is restarting, a node that is draining, or a volume that is briefly detached — all of which resolve themselves and none of which want a promotion."
        },
        {
          "type": "code",
          "content": "kubectl -n pipeline-builder get pods -l app=postgres\nkubectl -n pipeline-builder describe pod -l app=postgres | tail -30\nkubectl -n pipeline-builder logs deploy/postgres --tail=100",
          "language": "sh"
        },
        {
          "type": "text",
          "content": "Promote when the volume is lost or corrupt, the node is gone and the RWO volume cannot attach elsewhere, or Postgres will not start and the cause is not fixable in less time than the outage costs."
        },
        {
          "type": "text",
          "content": "Do not promote for a CrashLoopBackOff with a legible cause, a pod that is Pending on a resource request (see Postgres Scaling), or PostgresReplicationStopped on its own — that one says the standby is broken, which is the opposite situation, and promoting into it is how you lose both copies."
        },
        {
          "type": "text",
          "content": "Step 1 — record how much you are about to lose"
        },
        {
          "type": "text",
          "content": "Asynchronous replication means the standby may be behind. Ask it, before you change anything:"
        },
        {
          "type": "code",
          "content": "kubectl -n pipeline-builder exec postgres-replica-0 -c postgres-replica -- \\\n  psql -U postgres -tAc \\\n  \"SELECT pg_is_in_recovery(), pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn(),\n          now() - pg_last_xact_replay_timestamp() AS replay_age;\"",
          "language": "sh"
        },
        {
          "type": "text",
          "content": "pg_is_in_recovery() must be t — if it is f this node is already a primary and you are about to create a second one. replay_age is the data-loss window. Write it in the incident channel: it is the number anyone later asking \"what did we lose\" needs, and it is unrecoverable once you promote."
        },
        {
          "type": "text",
          "content": "If receive_lsn is ahead of replay_lsn, the standby has WAL it has not applied yet. Wait for them to converge before promoting — that is free data."
        },
        {
          "type": "text",
          "content": "Step 2 — stop the old primary coming back"
        },
        {
          "type": "text",
          "content": "Do this before promoting, not after. strategy: Recreate plus a surviving volume is all it takes for Kubernetes to restart a primary that then accepts writes nobody is replicating."
        },
        {
          "type": "code",
          "content": "kubectl -n pipeline-builder scale deploy/postgres --replicas=0\nkubectl -n pipeline-builder get pods -l app=postgres   # expect: no resources found",
          "language": "sh"
        },
        {
          "type": "text",
          "content": "Step 3 — promote"
        },
        {
          "type": "code",
          "content": "kubectl -n pipeline-builder exec postgres-replica-0 -c postgres-replica -- \\\n  psql -U postgres -c \"SELECT pg_promote(wait => true, wait_seconds => 60);\"",
          "language": "sh"
        },
        {
          "type": "text",
          "content": "pg_promote removes standby.signal and ends recovery. Confirm:"
        },
        {
          "type": "code",
          "content": "kubectl -n pipeline-builder exec postgres-replica-0 -c postgres-replica -- \\\n  psql -U postgres -tAc \"SELECT pg_is_in_recovery();\"   # expect: f",
          "language": "sh"
        },
        {
          "type": "text",
          "content": "Step 4 — repoint the write path"
        },
        {
          "type": "text",
          "content": "One patch. pgbouncer keeps host=postgres and needs no reload, because what changes is which pod that Service name resolves to:"
        },
        {
          "type": "code",
          "content": "kubectl -n pipeline-builder patch svc postgres \\\n  -p '{\"spec\":{\"selector\":{\"app\":\"postgres-replica\"}}}'",
          "language": "sh"
        },
        {
          "type": "text",
          "content": "pgbouncer's existing server connections are to an address that no longer answers, so they fail and are re-established against the new target. Writes resume within seconds; in-flight transactions at the moment of failure are lost and the application sees connection errors, which is the expected shape — see pgbouncer sidecar SPOF for why a broken pooler looks like db ECONNRESET with clean Postgres logs."
        },
        {
          "type": "text",
          "content": "Verify from a service, not just from psql:"
        },
        {
          "type": "code",
          "content": "kubectl -n pipeline-builder exec deploy/pgbouncer -c pgbouncer -- \\\n  psql \"postgres://$PGBOUNCER_USER:$PGBOUNCER_PASS@localhost:6432/pipeline_builder\" \\\n  -tAc \"SELECT pg_is_in_recovery(), current_setting('transaction_read_only');\"",
          "language": "sh"
        },
        {
          "type": "text",
          "content": "Both should be f / off. If transaction_read_only is on, you are still talking to a standby and the patch has not taken effect."
        },
        {
          "type": "text",
          "content": "Step 5 — re-seed a standby"
        },
        {
          "type": "text",
          "content": "You are now running on a single copy with no second line. The promoted pod is postgres-replica-0, which is also what postgres-read and the remaining standby slots are named for — so the cleanest recovery is to rebuild the pair rather than nest a standby under a StatefulSet member:"
        },
        {
          "type": "list",
          "items": [
            "Re-provision the postgres Deployment's volume (the old one is the lost or"
          ]
        },
        {
          "type": "text",
          "content": "corrupt disk) and bring it up empty."
        },
        {
          "type": "list",
          "items": [
            "Seed it from the new primary the same way postgres-replica seeds itself:"
          ]
        },
        {
          "type": "text",
          "content": "pg_basebackup -R --create-slot --slot=<name> against the promoted pod."
        },
        {
          "type": "list",
          "items": [
            "Once it is streaming, you have a primary and a standby again — in the mirror"
          ]
        },
        {
          "type": "text",
          "content": "image of the usual roles. Decide deliberately whether to stay that way or to fail back during a maintenance window, and if you fail back, do it with this runbook and not by editing the Service twice."
        },
        {
          "type": "text",
          "content": "Until a standby is streaming, pb_replication_connected_standbys is 0 and PostgresReplicationStopped fires. That alert is correct during this window; do not silence it beyond the time you expect re-seeding to take."
        },
        {
          "type": "text",
          "content": "Step 6 — the replication slot on the old primary"
        },
        {
          "type": "text",
          "content": "If the old primary's volume survived, it still holds a permanent slot for the standby you just promoted. It retains WAL for a consumer that is never coming back, so if that volume is ever mounted again it will fill — see PostgresReplicationSlotRetainedBytes and Postgres Scaling. Drop the slot before reusing the volume for anything, or discard the volume."
        }
      ]
    },
    {
      "id": "configuration",
      "title": "Configuration",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Variable",
            "Role in failover"
          ],
          "rows": [
            [
              "DB_REPLICATION_USER / DB_REPLICATION_PASSWORD",
              "The standby's streaming credentials. A failed authentication in the standby's logs is the expected symptom after rotating these — see Secret Rotation. Re-seeding needs them."
            ],
            [
              "DB_HOST / DB_PORT",
              "pgbouncer / 6432 on every target. Unchanged by failover — the Service patch is what moves."
            ],
            [
              "DB_READ_HOST",
              "Unset on every shipped target, so nothing reads from the standby today. If you have enabled it, note that after promotion postgres-read selects the pod that is now the primary: correct, but no longer offloading anything."
            ],
            [
              "PG_READ_REPLICA_MIN / MAX",
              "eks only. KEDA owns the standby count; the StatefulSet declares no replicas. Scaling the StatefulSet by hand is re-applied away."
            ]
          ]
        }
      ]
    },
    {
      "id": "what-this-does-not-cover",
      "title": "What this does not cover",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Point-in-time recovery. The dumps are logical (pg_dump) and there is no"
          ]
        },
        {
          "type": "text",
          "content": "WAL archive, so recovery lands on a dump boundary or on the standby's last replayed transaction, and nowhere in between."
        },
        {
          "type": "list",
          "items": [
            "MongoDB. rs0 is a one-member replica set for transactions and change"
          ]
        },
        {
          "type": "text",
          "content": "streams, not redundancy. There is nothing to promote; Mongo's recovery really is the nightly dump."
        },
        {
          "type": "list",
          "items": [
            "Automatic failover. Promotion is a human step today, which is why this"
          ]
        },
        {
          "type": "text",
          "content": "runbook exists and is kept short enough to follow under pressure. Automating it (Patroni, CNPG) is an architectural choice to make deliberately rather than a step to add here."
        }
      ]
    },
    {
      "id": "related",
      "title": "Related",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Postgres Scaling — the topology, the resource rungs, and the slot that threatens the write path",
            "Deploy Operations — RPO/RTO, what is and is not backed up",
            "Secret Rotation — rotating DB_REPLICATION_PASSWORD"
          ]
        }
      ]
    }
  ],
  "sourceDoc": "docs/runbooks/postgres-failover.md"
};
