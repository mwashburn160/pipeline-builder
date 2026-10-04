// GENERATED FROM docs/deploy-operations.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: 42d5c68fbb4c32d7f2587ef8e7143704a944839a5d42c12fcd94cf36dbeffd96
// SPDX-License-Identifier: Apache-2.0
import { Wrench } from 'lucide-react';
import type { HelpTopic } from '../types';

export const deployOperationsTopic: HelpTopic = {
  "icon": Wrench,
  "id": "deploy-operations",
  "title": "Deploy Operations",
  "description": "Operator runbook — preflight, secret rotation, backups & DR, teardown",
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
          "content": "Day-2 procedures for a running Pipeline Builder deployment: preflight, secret generation and rotation, backups and disaster recovery, object storage, the mesh, and teardown."
        },
        {
          "type": "text",
          "content": "See deploy/README.md for the target map and bring-up flow."
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
            "Nothing is scheduled by default on any target. Until you wire a backup, your RPO is \"whenever someone last ran backup.sh by hand\".",
            "Postgres and MongoDB are each a single instance with no standby. Losing a volume means a restore, not a failover.",
            "There is no point-in-time recovery. The dumps are logical, so you can restore to a dump boundary and nothing in between.",
            "The biggest hole is .env and certs/. Lose SECRET_ENCRYPTION_KEY and a perfect database dump is still partially unreadable, forever. Copy them into your secret manager.",
            "There is deliberately no blind --rotate flag. Regenerating .env would put passwords out of sync with the running databases and break them. Rotate per secret, in order, database first.",
            "Adding the EKS backup CronJob to the kustomization would not enable backups — it would schedule a job that fails every night at 03:00. It needs three account-specific values and an IAM role that does not exist yet.",
            "The backup role gets no read and no delete. The job only writes; restores run from an operator's own credentials.",
            "An untested backup is not a backup, and a drill that restores only the dumps proves less than it looks."
          ]
        }
      ]
    },
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "This page is for whoever operates a deployed instance. It assumes the platform is already up — the bring-up itself is in AWS Deployment and the target READMEs."
        },
        {
          "type": "text",
          "content": "The single most important thing on it: read What the data tier actually is before you commit to an RPO, because the topology is the constraint, not the backup script."
        }
      ]
    },
    {
      "id": "how-it-works",
      "title": "How it works",
      "blocks": [
        {
          "type": "text",
          "content": "Backup and restore are one implementation"
        },
        {
          "type": "text",
          "content": "deploy/bin/backup.sh and deploy/bin/restore.sh do the work. Each target's bin/backup.sh / bin/restore.sh is a thin wrapper that picks the connection mode."
        },
        {
          "type": "table",
          "headers": [
            "Target",
            "Connect mode",
            "How it reaches the data"
          ],
          "rows": [
            [
              "minikube / ec2 / eks",
              "--connect k8s",
              "Short-lived kubectl port-forwards to the in-cluster Postgres, MongoDB and object store, with the connection env rewritten to the tunnels and torn down on exit — so in-cluster service names don't need to be host-reachable"
            ],
            [
              "docker",
              "--connect direct",
              "Straight to the containers"
            ]
          ]
        },
        {
          "type": "text",
          "content": "DRY_RUN=1 and restore.sh --list skip the port-forwards and need no cluster at all."
        },
        {
          "type": "text",
          "content": "What it moves: the Postgres dump and the Mongo dump, to and from S3 (restore.sh requires --confirm-destructive). Optionally it also mirrors every object-storage bucket with rclone, when S3_BACKUP_TARGET_URL is set — the source side (S3_ENDPOINT plus root credentials) is already in every target's .env, so only the destination is opt-in."
        },
        {
          "type": "text",
          "content": "The buckets mirrored are the canonical PB_OBJECTSTORE_BUCKETS list in deploy/bin/common.sh: message-attachments, registry, loki, thanos, plugins, plugin-quarantine, audit-heads. A deploy-contract test keeps that list equal to what each target's rustfs-init bootstrap Job creates and what the EKS CronJob mirrors."
        },
        {
          "type": "text",
          "content": "Secret generation is automatic and per-deploy"
        },
        {
          "type": "text",
          "content": "On first bring-up, .env is seeded from .env.example and its CHANGE_ME credentials are filled with fresh random values by pb_gen_env_secrets (deploy/bin/gen-env-secrets.sh), which then asserts no CHANGE_ME remains in a required secret. The MongoDB replica-set keyfile is generated by pb_ensure_mongo_keyfile (deploy/bin/mongo-keyfile.sh)."
        },
        {
          "type": "text",
          "content": "Neither .env nor mongodb-keyfile is tracked in git."
        },
        {
          "type": "note",
          "content": "The keyfiles that were previously committed have been git rm --cacheded. A fresh checkout ships none — setup generates them. Existing environments should rotate their keyfile, since it was shared publicly: generate a new one, then restart mongod on each member with the new key."
        }
      ]
    },
    {
      "id": "configuration",
      "title": "Configuration",
      "blocks": [
        {
          "type": "text",
          "content": "Preflight"
        },
        {
          "type": "text",
          "content": "Every entrypoint should assert its tools up front (preflight <tools…> in deploy/bin/common.sh) so a missing dependency fails fast instead of deep into a 30–60 minute provision."
        },
        {
          "type": "table",
          "headers": [
            "Target",
            "Tools"
          ],
          "rows": [
            [
              "docker",
              "docker, openssl, jq"
            ],
            [
              "minikube",
              "minikube, kubectl, openssl, envsubst, jq"
            ],
            [
              "ec2 (bootstrap)",
              "aws, docker, jq, openssl"
            ],
            [
              "eks",
              "aws, eksctl, kubectl, openssl, jq"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Backup and restore additionally need pg_dump / psql (Postgres client) and mongodump / mongorestore (Mongo database tools)."
        },
        {
          "type": "text",
          "content": "EKS — enabling the nightly CronJob"
        },
        {
          "type": "text",
          "content": "deploy/aws/eks/backup/backup-cronjob.yaml is deliberately not in k8s/kustomization.yaml, and adding it there would not enable backups — it would schedule a job that fails every night at 03:00. The manifest carries three account-specific REPLACE_ME values (the backup image, BACKUP_BUCKET, S3_BACKUP_TARGET_URL) and needs an IAM role that does not exist yet, so it cannot be a one-line kustomization change. It stays a template you complete and apply explicitly."
        },
        {
          "type": "list",
          "items": [
            "Create the bucket with SSE-KMS, versioning, and — recommended — Object Lock in governance mode."
          ]
        },
        {
          "type": "text",
          "content": "Put retention on a bucket lifecycle rule, not on the script's client-side RETENTION_DAYS prune: a compromised backup role can skip a client-side prune but cannot shorten a lifecycle rule."
        },
        {
          "type": "list",
          "items": [
            "Create the IAM role. This is the part the deploy does not do for you — the EKS setup role grants only SES and CodePipeline today, so this is an addition."
          ]
        },
        {
          "type": "text",
          "content": "Make a role the db-backup ServiceAccount can assume, via EKS Pod Identity:"
        },
        {
          "type": "text",
          "content": "bash aws eks create-pod-identity-association \\ --cluster-name <cluster> --namespace pipeline-builder \\ --service-account db-backup --role-arn <role>"
        },
        {
          "type": "text",
          "content": "Or via IRSA, then uncomment the eks.amazonaws.com/role-arn annotation on the ServiceAccount in the manifest. Minimum policy:"
        },
        {
          "type": "text",
          "content": "json { \"Version\": \"2012-10-17\", \"Statement\": [ { \"Effect\": \"Allow\", \"Action\": [\"s3:PutObject\", \"s3:AbortMultipartUpload\"], \"Resource\": \"arn:aws:s3:::<backup-bucket>/*\" }, { \"Effect\": \"Allow\", \"Action\": [\"kms:GenerateDataKey\", \"kms:Encrypt\"], \"Resource\": \"<the bucket's KMS key ARN>\" } ] }"
        },
        {
          "type": "text",
          "content": "Grant no s3:DeleteObject and no s3:GetObject: the job only writes. Restores run from an operator's own credentials via bin/restore.sh, so a compromised backup pod can neither read the history back nor delete it. Add s3:ListBucket on arn:aws:s3:::<backup-bucket> only if you later turn on the client-side prune."
        },
        {
          "type": "list",
          "items": [
            "Point image: at a suitable image — one that ships pg_dump, mongodump, the aws CLI, rclone and bash (the job script uses set -o pipefail, which dash does not have), and that runs as non-root. The pod sets runAsNonRoot: true, runAsUser: 65532, so a root-by-default image such as the official postgres is rejected by the kubelet."
          ]
        },
        {
          "type": "list",
          "items": [
            "Set the values. BACKUP_BUCKET, and keep ENV_NAME matching what backup.sh / restore.sh use — they read the same s3://<bucket>/<env>/<YYYY/MM/DD>/ layout. Then either complete the S3_BACKUP_TARGET_* block plus an objectstore-backup-target Secret, or unset S3_BACKUP_TARGET_URL to skip the object-storage mirror."
          ]
        },
        {
          "type": "list",
          "items": [
            "Apply and verify. Force one run rather than waiting for 03:00:"
          ]
        },
        {
          "type": "text",
          "content": "bash kubectl apply -f deploy/aws/eks/backup/backup-cronjob.yaml kubectl -n pipeline-builder create job --from=cronjob/db-backup db-backup-manual"
        },
        {
          "type": "text",
          "content": "Check both the pod logs and that the objects actually landed in the bucket."
        },
        {
          "type": "list",
          "items": [
            "Test a restore into a scratch namespace: deploy/aws/eks/bin/restore.sh --confirm-destructive, plus --object-store for object storage. Until this passes you have a CronJob, not a backup."
          ]
        },
        {
          "type": "text",
          "content": "EC2 — enabling the timer"
        },
        {
          "type": "text",
          "content": "bootstrap.sh installs pipeline-backup.timer disabled. To enable it:"
        },
        {
          "type": "list",
          "items": [
            "Install the DB clients on the host.",
            "Give the host a path to the ClusterIP databases — the shipped backup.sh does this itself with kubectl port-forward.",
            "Provision the bucket plus the same s3:PutObject and KMS grant as above, via the instance profile rather than Pod Identity.",
            "Set BACKUP_BUCKET.",
            "systemctl enable --now pipeline-backup.timer.",
            "Verify with systemctl list-timers pipeline-backup and one manual systemctl start pipeline-backup.service."
          ]
        },
        {
          "type": "text",
          "content": "Bucket hardening is the same: SSE-KMS, versioning, and a bucket lifecycle retention policy rather than the app's client-side RETENTION_DAYS prune, which a compromised role could bypass."
        },
        {
          "type": "text",
          "content": "Local targets"
        },
        {
          "type": "text",
          "content": "Minikube and docker are local and have no bucket to write to. Run their bin/backup.sh by hand against reachable object storage if you want copies."
        },
        {
          "type": "text",
          "content": "Object-storage mirror"
        },
        {
          "type": "text",
          "content": "Plugin images, message attachments and logs are backed up by the same script. The source side (S3_ENDPOINT plus RUSTFS_ROOT_ACCESS_KEY / SECRET_KEY) is already in .env; set a durable S3_BACKUP_TARGET_URL and its S3_BACKUP_TARGET_ACCESS_KEY / _SECRET_KEY to opt in."
        },
        {
          "type": "text",
          "content": "backup.sh runs rclone copy — additive, never deleting from the backup, so a source delete can't wipe it. Pair the target with versioning for point-in-time. (That copy rather than sync has this property was verified live before choosing it here.)"
        },
        {
          "type": "text",
          "content": "Restore with restore.sh --object-store --confirm-destructive, a reverse mirror that is standalone and does not touch the databases."
        },
        {
          "type": "text",
          "content": "Leaving S3_BACKUP_TARGET_URL unset is a deliberate opt-out — but a DB-only restore can't rebuild a working platform without the blobs."
        }
      ]
    },
    {
      "id": "secret-rotation",
      "title": "Secret rotation",
      "blocks": [
        {
          "type": "text",
          "content": "There is deliberately NO blind --rotate flag. A naive \"regenerate .env\" would rewrite passwords out of sync with the running databases and break them — the password in .env must match what the DB actually accepts. Rotate per secret, in order."
        },
        {
          "type": "note",
          "content": "Application secrets — the ES256 user-token signing key, the per-service internal signing keys, SECRET_ENCRYPTION_KEY, the alert-relay bearer and the image-registry signing key each have a zero-downtime overlap window and a step-by-step procedure, with verification and rollback, in Secret Rotation. Use pb_rotate_env_secret / pb_finish_env_rotation from deploy/bin/gen-env-secrets.sh rather than hand-editing .env; the SecretRotationPreviousLingering alert fires while a rotation is left half-finished. The datastore credentials below are the ones that have no overlap mechanism."
        },
        {
          "type": "text",
          "content": "Secrets with an overlap window"
        },
        {
          "type": "list",
          "items": [
            "User-token signing key (ES256, platform only). Rotate by kid: publish the incoming key alongside the retiring one, switch signing, then drop the old kid. Nobody is logged out, and no other service needs a restart or a config change because they all read /.well-known/jwks.json. Full procedure."
          ]
        },
        {
          "type": "text",
          "content": "The stored machine credentials are opaque service-account keys, not JWTs, so the events Lambda and CodeBuild are unaffected — nothing to re-mint. The overlap must outlive the longest refresh token (REFRESH_TOKEN_EXPIRES_IN, 30 days by default) or devices that have not refreshed are signed out."
        },
        {
          "type": "list",
          "items": [
            "Per-service internal signing keys (internal service tokens only, stateless). One ES256 key per service, mounted into that service alone. Rotate with deploy/bin/service-signing-keys.sh --rotate <service>; the overlap is the retiring public key staying in the shared bundle. Service tokens live 5 minutes, so the window is short and no session is affected. Roll the public bundle out BEFORE the private key."
          ]
        },
        {
          "type": "list",
          "items": [
            "Registry signing keypair (jwt-keys.sh). Rotate via a two-cert trust bundle, new cert first, so in-flight registry tokens keep verifying: full procedure. Nothing to re-issue — CodeBuild presents a registry:push service-account key, and the signing keypair only affects the tokens image-registry mints."
          ]
        },
        {
          "type": "text",
          "content": "Datastore credentials — database first, always"
        },
        {
          "type": "list",
          "items": [
            "POSTGRES_PASSWORD / DB_PASSWORD. Change the password in Postgres first, then update the secret, then roll:"
          ]
        },
        {
          "type": "text",
          "content": "sql ALTER USER \"$POSTGRES_USER\" WITH PASSWORD '<new>';"
        },
        {
          "type": "text",
          "content": "→ update the k8s Secret / .env → kubectl rollout restart deploy/postgres and the app deployments. Do not just rewrite .env."
        },
        {
          "type": "list",
          "items": [
            "ECOSYSTEM_PUBLIC_READER_PASSWORD (the public plugin directory's view-only login). Same order:"
          ]
        },
        {
          "type": "text",
          "content": "sql ALTER ROLE ecosystem_public_reader WITH PASSWORD '<new>'; -- as the superuser"
        },
        {
          "type": "text",
          "content": "→ update .env / the postgres-secret key → restart pgbouncer, whose userlist is seeded at startup (compose: docker compose up -d --force-recreate pgbouncer; k8s: kubectl rollout restart deploy/pgbouncer) → restart the plugin service."
        },
        {
          "type": "text",
          "content": "The role can only read the two public views, so a leak exposes nothing that isn't already public — but rotate it like any credential."
        },
        {
          "type": "list",
          "items": [
            "MONGO_INITDB_ROOT_PASSWORD + MONGODB_URI. db.changeUserPassword() in Mongo first, then update the secret and URI, then roll."
          ]
        },
        {
          "type": "list",
          "items": [
            "Mongo keyfile. Requires a rolling restart of the replica set with the new key, since members must share it. Plan a maintenance window."
          ]
        },
        {
          "type": "text",
          "content": "Always update the k8s Secret — not just .env — on the k8s targets, then kubectl rollout restart the affected Deployments."
        }
      ]
    },
    {
      "id": "what-the-data-tier-actually-is",
      "title": "What the data tier actually is",
      "blocks": [
        {
          "type": "text",
          "content": "Read this before sizing an RPO, because the topology is the constraint:"
        },
        {
          "type": "table",
          "headers": [
            "Store",
            "Topology",
            "Standby / failover",
            "Consequence"
          ],
          "rows": [
            [
              "Postgres",
              "single instance, replicas: 1, strategy: Recreate, one RWO volume",
              "none — no hot standby, no replica, no WAL archiving",
              "Losing the volume loses everything written since the last dump. A pod restart is a brief outage; a lost volume is a restore."
            ],
            [
              "MongoDB",
              "single instance, replicas: 1, running as a ONE-MEMBER replica set (rs0)",
              "none — rs0 exists so drivers can use transactions and change streams, not for redundancy",
              "Same: one member, one volume, no second copy."
            ],
            [
              "Redis",
              "3 + 3 Sentinel (eks/ec2), single pod (minikube/docker)",
              "Sentinel failover on the AWS targets",
              "Not backed up at all, by design — see below."
            ],
            [
              "Object store (RustFS)",
              "4-pod erasure-coded StatefulSet (eks) · single-node (ec2/minikube/docker)",
              "Pod-fault tolerance on eks only. ec2/minikube/docker rely on the EBS volume or hostPath disk plus snapshots — a real simplification from the old 4-directory MinIO layout on ec2, which was never actual drive-fault tolerance anyway, since all four directories lived on the same EBS volume",
              "Mirrored by backup.sh when S3_BACKUP_TARGET_URL is set."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Redis HA removed the old data-tier single point of failure; Postgres is now the one that remains, with MongoDB beside it. Neither is replicated on any target, including eks."
        },
        {
          "type": "text",
          "content": "RPO and RTO"
        },
        {
          "type": "table",
          "headers": [
            "",
            "Value",
            "Why"
          ],
          "rows": [
            [
              "RPO, Postgres + Mongo",
              "up to 24 hours",
              "The only scheduled backup is the nightly CronJob at 03:00 UTC. Everything written since the last successful dump is lost."
            ],
            [
              "RPO, Postgres + Mongo, no schedule wired",
              "∞ — total loss",
              "Nothing is scheduled by default on ANY target. Until you complete the steps above, the RPO is \"whenever someone last ran backup.sh by hand\"."
            ],
            [
              "Point-in-time recovery",
              "not possible",
              "The dumps are LOGICAL (pg_dump / mongodump). There is no WAL archiving, no pg_basebackup, no oplog tailing — you can restore to a dump boundary and to nothing in between."
            ],
            [
              "RPO, metrics",
              "~2 hours",
              "The Thanos sidecar uploads Prometheus' TSDB blocks every 2h; the not-yet-uploaded block is lost with the pod."
            ],
            [
              "RPO, logs",
              "minutes",
              "Loki flushes chunks to the object store continuously; the in-pod WAL is an emptyDir and is lost with the pod."
            ],
            [
              "RTO",
              "restore time + rollout",
              "There is nothing to fail over TO. Recovery is: provision, restore the dumps, restore the object-store mirror, re-create the secrets, roll the deployments."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Tightening the RPO below a day means either running backup.sh more often — change the CronJob schedule:, it is cheap and the dumps are small — or introducing real replication, which this deployment does not ship."
        },
        {
          "type": "text",
          "content": "What is NOT backed up"
        },
        {
          "type": "text",
          "content": "backup.sh and the CronJob cover exactly three things: the Postgres dump, the Mongo dump, and — only when S3_BACKUP_TARGET_URL is set — an rclone copy mirror of the object-store buckets. Everything below is outside that, and some of it is unrecoverable rather than merely inconvenient."
        },
        {
          "type": "text",
          "content": ".env, and every generated key — the largest hole, and the one that is not recoverable by re-provisioning:"
        },
        {
          "type": "table",
          "headers": [
            "Location",
            "Holds"
          ],
          "rows": [
            [
              "deploy/<target>/.env",
              "SECRET_ENCRYPTION_KEY"
            ],
            [
              "deploy/<target>/certs/",
              "The ES256 user-token key, the per-service internal signing keys, the image-registry token keypair, the gateway TLS material"
            ],
            [
              "deploy/<target>/mongodb-keyfile",
              "The replica-set key"
            ]
          ]
        },
        {
          "type": "text",
          "content": "All are gitignored and none is in the backup."
        },
        {
          "type": "list",
          "items": [
            "Lose SECRET_ENCRYPTION_KEY and every encrypted column stays encrypted forever — stored AI provider keys, IdP client secrets, TOTP secrets and the SAML SP private keys. A restored database is then partially unreadable even though the dump was perfect.",
            "Lose the user-token signing key and every session ends at once. Recoverable — people sign in again.",
            "Copy .env, certs/ and mongodb-keyfile into your secret manager as part of provisioning, and treat them as part of the backup set. See Secret Rotation."
          ]
        },
        {
          "type": "text",
          "content": "Also outside the backup:"
        },
        {
          "type": "list",
          "items": [
            "Prometheus' local TSDB (--storage.tsdb.retention.time=7d). Not backed up, and does not need to be if the thanos bucket is in the object-store mirror — the sidecar has already uploaded everything older than ~2h. Skip the mirror and you have no metric history at all after a rebuild.",
            "Loki's log store. Same shape: chunks and index live in the loki object-store bucket and are covered only by the mirror. /loki in the pod is ephemeral scratch.",
            "Grafana (/var/lib/grafana). Datasources are re-provisioned from the grafana-datasources ConfigMap, so those come back; dashboards, users, API keys and annotations created through the UI do not. Keep dashboards in source control if they matter.",
            "Alertmanager state (silences plus the notification log). After a rebuild every silence is gone and previously-notified alerts re-notify once.",
            "Jaeger traces. All-in-one, non-durable by design.",
            "Redis. Deliberately not backed up: it holds BullMQ queues, the durable audit spool, session and step-up state, and idempotency keys. Losing it drops in-flight plugin builds (BullMQ retries what it still has) and any audit events still in the spool that had not flushed to Mongo.",
            "Plugin build scratch and the buildkit layer cache. emptyDir or a named volume; ephemeral by contract, rebuilt on the next build.",
            "The cluster itself. No etcd backup, no manifest snapshot. Recovery is re-running the target's setup.sh against the restored data, which is the supported path."
          ]
        },
        {
          "type": "text",
          "content": "DR drill"
        },
        {
          "type": "text",
          "content": "Periodically restore the latest backup into a scratch namespace or instance and verify — an untested backup is not a backup. A drill that restores only the dumps proves less than it looks: include the object-store mirror and a .env / certs/ restore, or you have not tested the parts that fail hardest."
        }
      ]
    },
    {
      "id": "object-storage-rustfs",
      "title": "Object storage (RustFS)",
      "blocks": [
        {
          "type": "text",
          "content": "Several stateful services store into RustFS (S3-compatible, on every deploy target), each with its own bucket and a per-service, bucket-scoped key — never the root credentials. All are created by the rustfs-init bootstrap Job, a compose service or a k8s Job."
        },
        {
          "type": "table",
          "headers": [
            "Bucket",
            "Consumer",
            "Key"
          ],
          "rows": [
            [
              "message-attachments",
              "message service (attachments)",
              "message-svc"
            ],
            [
              "registry",
              "Docker registry (S3 storage driver — now stateless, no PVC)",
              "registry-svc"
            ],
            [
              "loki",
              "Loki (chunks + index; /loki is now ephemeral scratch)",
              "loki-svc"
            ],
            [
              "thanos",
              "Thanos sidecar (Prometheus 2h TSDB blocks, long-term) — read back via the store-gateway and querier",
              "thanos-svc"
            ]
          ]
        },
        {
          "type": "text",
          "content": "See deploy/aws/eks/k8s/rustfs.yaml and each other target's k8s/rustfs.yaml for the full reasoning."
        },
        {
          "type": "text",
          "content": "Topology by target"
        },
        {
          "type": "list",
          "items": [
            "EKS (production) — distributed RustFS: a StatefulSet of 4 pods, one pb-ebs PVC each, erasure-coded so it tolerates 2 pod or drive losses, spread across nodes via anti-affinity. Clients hit the rustfs Service (round-robin); peers resolve via the rustfs-headless Service. Topology was verified live — the rc CLI, RustFS's mc equivalent, and Object Lock enforcement both checked against a real container — before the manifest was written.",
            "ec2 (single-node prod-style) — single-node RustFS, one hostPath directory. A deliberate simplification from MinIO's former 4-directory SNMD layout, which bought bit-rot detection and healing, not drive-fault tolerance: all four directories sat on the same EBS data volume regardless. Durability is unchanged — the EBS volume plus its daily DLM snapshots and DeletionPolicy / UpdateReplacePolicy: Snapshot in template.yaml. True drive or node HA needs separate volumes and nodes, i.e. EKS.",
            "docker / minikube (local dev) — single-node RustFS, single directory, no HA."
          ]
        },
        {
          "type": "text",
          "content": "Back up the object-store drives as part of DR: EKS the 4 data-rustfs-* PVCs, ec2 rustfs-data, dev ./data/rustfs-data."
        },
        {
          "type": "text",
          "content": "Long-term metrics (Thanos) read path"
        },
        {
          "type": "text",
          "content": "The sidecar only uploads Prometheus' 2h blocks to the thanos bucket. Querying them back is served by two components — thanos-query.yaml on the k8s targets, equivalent services in docker-compose:"
        },
        {
          "type": "list",
          "items": [
            "a store-gateway, exposing the archived blocks over the Thanos StoreAPI (gRPC 10901; its local index cache is ephemeral);",
            "a querier, a Prometheus-compatible HTTP endpoint on 9090 that fans out to the sidecar plus store-gateway and de-duplicates."
          ]
        },
        {
          "type": "text",
          "content": "PROMETHEUS_URL points platform's Observability query endpoint at the querier (http://thanos-query:9090) so PromQL spans recent plus archived history; set it back to http://prometheus:9090 for recent-only. KEDA autoscaling deliberately still targets Prometheus directly — recent-only, lower latency."
        }
      ]
    },
    {
      "id": "service-mesh-istio-ambient",
      "title": "Service mesh (Istio ambient)",
      "blocks": [
        {
          "type": "text",
          "content": "All targets run an Istio ambient mesh with STRICT mTLS and identity authz."
        },
        {
          "type": "code",
          "content": "kubectl get pods -n istio-system            # istiod, ztunnel, istio-cni Ready\nistioctl analyze -n pipeline-builder        # policy sanity\nistioctl ztunnel-config workloads           # every pod PROTOCOL=HBONE (enrolled)",
          "language": "bash"
        },
        {
          "type": "table",
          "headers": [
            "Symptom",
            "Cause"
          ],
          "rows": [
            [
              "A service 403s another",
              "The caller's sa/<name> is missing from the callee's AuthorizationPolicy in k8s/istio.yaml — add it and re-apply. Every scraped app service must list prometheus; every API must list nginx."
            ],
            [
              "Ingress broken after STRICT",
              "The nginx external port is not carved out — 8080 on aws, 8080 + 8443 on local."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Teardown: kubectl delete -k k8s/ removes the mesh policies but leaves istio-system installed; istioctl install is idempotent so re-runs are safe. minikube delete (local/ec2) or eksctl delete cluster (eks) wipe everything."
        },
        {
          "type": "text",
          "content": "See Service Mesh for the full troubleshooting table."
        }
      ]
    },
    {
      "id": "teardown",
      "title": "Teardown",
      "blocks": [
        {
          "type": "list",
          "items": [
            "docker — docker compose down (data persists in data/). Reset with down && rm -rf data/.",
            "minikube — bin/shutdown.sh does a graceful minikube stop: it halts the VM but PRESERVES its disk and the full cluster state (workloads, PVCs, data), so a restart brings everything back with no re-provisioning. It deliberately does NOT delete the namespace or manifests. Bring it back with bin/startup.sh (fast resume plus reconnected port-forwards; no re-install, no re-apply). To wipe instead: minikube delete --profile=pipeline-builder — a clean rebuild is delete then re-run bin/setup.sh, or RECREATE=y bin/setup.sh.",
            "ec2 — bin/shutdown.sh as root removes the iptables DNAT rules, then does a graceful minikube stop, preserving the VM disk and cluster state. bin/startup.sh brings it back. It does NOT touch the EC2 instance — tear that down by deleting the CloudFormation stack. Wipe the cluster with sudo -u minikube minikube delete --profile=pipeline-builder.",
            "eks — shutdown.sh (types the cluster name to confirm; --delete-volumes to also remove the Retained EBS/EFS). Without --domain, eks leaves the ACM cert, Route 53 alias and SES resources behind, and warns that it did."
          ]
        },
        {
          "type": "note",
          "content": "Minikube data location. Minikube stores all hostPath data — Postgres, MongoDB, RustFS buckets — on the VM's own persistent /data disk, not the host deploy/local/minikube/data/ folder, which stays empty. Minikube reserves /data for its persistent disk, which shadows a host mount there, and DB data on a 9p mount is unreliable. Data survives minikube stop/start; minikube delete wipes it. For host-side copies use deploy/local/minikube/bin/backup.sh."
        },
        {
          "type": "text",
          "content": "Lean deploy (LEAN=1)"
        },
        {
          "type": "text",
          "content": "When the full stack plus the Istio mesh exceeds ~8 vCPU — an ~8-core laptop, or a smaller EC2 instance — LEAN=1 brings up the core stack and mesh only. It omits the optional observability and admin services (prometheus, thanos, loki, promtail, jaeger, alertmanager, mongo-express, pgadmin, grafana, kiali) and collapses every workload to a single replica."
        },
        {
          "type": "text",
          "content": "Supported on:"
        },
        {
          "type": "list",
          "items": [
            "minikube — LEAN=1 deploy/local/minikube/bin/setup.sh",
            "ec2 — at launch via the CFN Lean param (LEAN=1 deploy/aws/ec2/bin/setup.sh, or pipeline-manager infra provision --target ec2 --lean), or on the box with LEAN=1 sudo -E bash deploy/aws/ec2/bin/startup.sh (-E preserves the env through sudo)"
          ]
        },
        {
          "type": "text",
          "content": "It lets ec2 run on a t3.xlarge instead of a t3.2xlarge. Both targets drive the same lean_filter. Full stack is the default for larger machines; eks is unaffected. See Service Mesh: LEAN mode."
        },
        {
          "type": "text",
          "content": "Lifecycle scripts (minikube + ec2)"
        },
        {
          "type": "text",
          "content": "Both single-node targets share a setup.sh / startup.sh / shutdown.sh triad:"
        },
        {
          "type": "table",
          "headers": [
            "Script",
            "Does"
          ],
          "rows": [
            [
              "setup.sh",
              "Provisions — CREATE cluster, install mesh and KEDA, apply manifests"
            ],
            [
              "startup.sh",
              "The fast resume of a stopped cluster: reconnects port-forwards on minikube, re-mounts host data and iptables on ec2. No re-install, no re-apply"
            ],
            [
              "shutdown.sh",
              "A graceful minikube stop"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Sizing overrides. setup.sh (minikube) and startup.sh (ec2) take env-var overrides: DISK_SIZE=60g (VM disk; default 30g minikube, 40g ec2), ISTIO_VERSION=…, LEAN=1."
        },
        {
          "type": "text",
          "content": "CPU, memory and disk size are applied only at cluster CREATE. When an existing cluster is found, the scripts resume it with data preserved, unless you ask to recreate: on a TTY they prompt (default: keep), or set RECREATE=y to rebuild non-interactively. On minikube that WIPES /data; on ec2 it rebuilds the cluster but host $DATA_DIR data survives, so clear it to truly wipe. Back up first with backup.sh if needed."
        },
        {
          "type": "text",
          "content": "On the docker driver the disk is bounded by Docker Desktop's virtual-disk limit; eks node disk is managed by the Auto Mode NodeClass, not DISK_SIZE."
        },
        {
          "type": "text",
          "content": "Destructive resets print raw one-liners today — dump first with backup.sh before wiping data you might want."
        }
      ]
    },
    {
      "id": "operator-consoles-grafana-kiali",
      "title": "Operator consoles (/grafana/, /kiali/)",
      "blocks": [
        {
          "type": "text",
          "content": "The three kubernetes targets serve two admin consoles through nginx subpaths, the same pattern as /pgadmin/:"
        },
        {
          "type": "list",
          "items": [
            "Grafana — dashboards over Thanos → Prometheus → Loki → Jaeger. Thanos is the default datasource because it fans out to the object-store blocks that Prometheus alone drops.",
            "Kiali — the Istio mesh console."
          ]
        },
        {
          "type": "text",
          "content": "Both are dropped by LEAN=1."
        },
        {
          "type": "text",
          "content": "Access and authentication"
        },
        {
          "type": "text",
          "content": "On AWS (ec2, eks) the consoles — and /pgadmin/, /mongo-express/ — are off by default, with their routes returning 404. Turned on with ADMIN_UIS_ENABLED=true, they sit behind an nginx auth_request to platform's superadmin + AAL2 check (GET /admin/console-check; see AWS: Access Points)."
        },
        {
          "type": "text",
          "content": "The RustFS object-store console is covered by the same flag, but is served on its own port :9001 at /rustfs/console/ instead of a gateway path — its UI resolves its API endpoints from window.location and points its S3 client at the bare origin — ListBuckets is GET /, objects are /<bucket>/... — so it needs an origin whose whole path space is RustFS's. :9000 is the S3 data plane and has no UI at all. On ec2 that port is published by a second ALB listener; on eks and the local targets reach it on localhost (kubectl port-forward svc/nginx 9001:9001, or the port-forward minikube's startup script already creates)."
        },
        {
          "type": "text",
          "content": "Locally (docker, minikube) nginx applies no auth of its own."
        },
        {
          "type": "text",
          "content": "Each carries its own login as well, and both read data with no org scoping — unlike the tenant-facing /dashboard/observability pages, which are org-scoped through the platform's PromQL proxy. They are therefore admin-only, and nothing tenant-facing links to them."
        },
        {
          "type": "text",
          "content": "Kiali additionally runs view_only_mode with read-only RBAC (no create, update or delete verbs anywhere) and auth.strategy: token, so signing in needs a ServiceAccount token:"
        },
        {
          "type": "code",
          "content": "kubectl -n pipeline-builder create token kiali",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Two limits worth knowing"
        },
        {
          "type": "list",
          "items": [
            "Under Istio ambient without waypoint proxies, Kiali's graph is L4 only. Measured on a live cluster: ztunnel emits 553 istio_* series and istio_requests_total is zero. So you get who talks to whom, how much, and whether it is mTLS — but no HTTP rates, latency or status codes.",
            "On docker only Grafana ships. That target runs no service mesh, so Kiali would render an empty graph."
          ]
        },
        {
          "type": "text",
          "content": "On minikube both are also port-forwarded by startup.sh (Grafana localhost:3001, Kiali localhost:20001) and exposed on NodePorts 30300 / 30201."
        },
        {
          "type": "text",
          "content": "Provisioned dashboards"
        },
        {
          "type": "text",
          "content": "Grafana loads every dashboard JSON under config/grafana/dashboards/ (docker: config/grafana/provisioning/dashboards/) into a read-only Pipeline Builder folder. On the kubernetes targets the setup scripts turn that directory into the grafana-dashboards ConfigMap, mounted at /etc/grafana/provisioning/dashboards."
        },
        {
          "type": "text",
          "content": "Today that is Plugin ecosystem (uid: plugin-ecosystem): the moderation queue by kind and status, oldest pending request per lane, SLA breaches, manager decisions and latency, auto-approvals per rule, separation-of-duties and Verified-eligibility refusals, Ecosystem Manager headcount, re-sign progress and failures, and ecosystem notice sends and drops."
        },
        {
          "type": "text",
          "content": "The file is identical on every target — a platform test enforces it — so edit it in source control, not in the UI. After changing it on kubernetes, re-run the setup script's ConfigMap step (or kubectl create configmap grafana-dashboards … --dry-run=client -o yaml | kubectl apply -f -) and restart Grafana."
        },
        {
          "type": "text",
          "content": "Plugin-ecosystem alerts"
        },
        {
          "type": "text",
          "content": "In alert-rules.yml on every target. Runbook: Ecosystem Moderation."
        },
        {
          "type": "table",
          "headers": [
            "Alert",
            "Fires when",
            "Severity"
          ],
          "rows": [
            [
              "EcosystemSecurityLaneSLABreach",
              "a security-fix request has waited over 4 h (5 min)",
              "critical"
            ],
            [
              "EcosystemStandardLaneSLABreach",
              "a standard request has waited over 48 h (30 min)",
              "warning"
            ],
            [
              "EcosystemResignFailures",
              "more than 3 image re-signs failed in the last hour",
              "warning"
            ],
            [
              "EcosystemResignStalled",
              "re-sign jobs are queued but nothing was re-signed for 2 h",
              "warning"
            ],
            [
              "EcosystemApproverShortage",
              "fewer than 2 system-org members hold plugins:moderate (1 h)",
              "warning"
            ],
            [
              "EcosystemNotificationsDropped",
              "a queued ecosystem notice was given up on after its retries",
              "warning"
            ],
            [
              "SubmissionBacklogHigh",
              "more than 25 anonymous plugin submissions awaiting gates or moderation for 1 h",
              "warning"
            ],
            [
              "SubmissionGateFailureSpike",
              "more than 10 anonymous submissions failed the same gate in an hour",
              "warning"
            ],
            [
              "OfficialAutoApprovalAnomaly",
              "the Official catalog auto-approval rule is near its 50/day cap or far above its usual hourly rate",
              "warning"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The ecosystem gauges (ecosystem_requests_pending, ecosystem_requests_sla_breached, ecosystem_approvers, …) are sampled every minute by every plugin replica, so the rules take max() and never read a stale former leader. ecosystem_approvers is read from platform at most every 5 minutes and simply isn't reported while platform can't answer, so a platform outage never looks like an approver shortage."
        },
        {
          "type": "text",
          "content": "Storage alerts"
        },
        {
          "type": "text",
          "content": "In alert-rules.yml on the three Kubernetes targets. Fed by two scrape jobs against the kubelet (kubelet and kubelet-cadvisor in prometheus.yml), which need the nodes/metrics RBAC in k8s/prometheus.yaml; egress on :10250 was already granted by allow-kube-api-egress. Docker has no kubelet and ships none of these."
        },
        {
          "type": "table",
          "headers": [
            "Alert",
            "Fires when",
            "Severity"
          ],
          "rows": [
            [
              "PersistentVolumeFillingUp",
              "a PVC is under 15% free for 15 min",
              "warning"
            ],
            [
              "PersistentVolumeCriticallyFull",
              "a PVC is under 5% free for 5 min",
              "critical"
            ],
            [
              "PersistentVolumeFillingUpFast",
              "extrapolating 6 h, a PVC under 40% free runs out within 4 h",
              "warning"
            ],
            [
              "NodeDiskFillingUp",
              "a node's root filesystem is under 15% free for 15 min",
              "warning"
            ],
            [
              "NodeDiskCriticallyFull",
              "a node's root filesystem is under 5% free for 5 min",
              "critical"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Which of these has data depends on the target, and that is a property of the volumes, not a setting. The PersistentVolume rules read kubelet_volume_stats_, which the kubelet emits only for volumes whose CSI driver implements metrics — so they have data on eks (pb-ebs, ebs.csi.eks.amazonaws.com). On ec2 and minikube the PVs are manual hostPath* (storageClassName: \"\") and the kubelet reports nothing for them; verified live, where the collector had run 20,832 times and produced zero kubelet_volume_stats_* series against two bound PVCs. There, the node-disk rules are the real signal — and the better one, because every hostPath mount (RustFS's buckets, the Postgres and Mongo data directories, the registry) shares that single filesystem and they all stop together when it fills."
        },
        {
          "type": "text",
          "content": "Remedies differ accordingly:"
        },
        {
          "type": "list",
          "items": [
            "eks — pb-ebs sets allowVolumeExpansion: true, so expansion is online:"
          ]
        },
        {
          "type": "text",
          "content": "bash kubectl -n pipeline-builder patch pvc postgres-data \\ -p '{\"spec\":{\"resources\":{\"requests\":{\"storage\":\"5Gi\"}}}}'"
        },
        {
          "type": "text",
          "content": "Volumes only ever grow: neither EBS nor Kubernetes can shrink one, and EBS refuses a second modification of the same volume for roughly 6 hours — so size with headroom rather than nudging upward. The StatefulSet claims (data-rustfs-{0..3}, data-redis-{0..2}) come from volumeClaimTemplates, which is immutable on a live StatefulSet: patch each PVC and edit the manifest, re-applying with kubectl delete sts <name> --cascade=orphan so the pods survive. Skip the manifest edit and a replacement replica silently comes back at the old size."
        },
        {
          "type": "list",
          "items": [
            "ec2 — there is no CSI volume to expand. Grow the instance's EBS volume"
          ]
        },
        {
          "type": "text",
          "content": "(aws ec2 modify-volume), then growpart and resize2fs on the instance itself. Patching a PVC does nothing, because the PV is a directory on that disk."
        },
        {
          "type": "list",
          "items": [
            "minikube — minikube stop, grow the VM disk, minikube start; or free"
          ]
        },
        {
          "type": "text",
          "content": "space (docker system prune inside the node, old Loki/Thanos blocks)."
        },
        {
          "type": "text",
          "content": "Automatic PVC expansion (eks only)"
        },
        {
          "type": "text",
          "content": "With PVC_AUTOEXPAND_ENABLED=true, Alertmanager also POSTs PersistentVolumeFillingUp / PersistentVolumeCriticallyFull to platform's /observability/pvc-autoexpand, which raises the claim's requested size. The route is additive (continue: true), so the ops-team Slack notification still happens — automation must never be the only thing that knows a volume is filling."
        },
        {
          "type": "text",
          "content": "Off by default, and eks-only. Expansion is irreversible: neither EBS nor Kubernetes can shrink a volume. ec2 and minikube bind manual hostPath PVs with no CSI driver to resize, and the endpoint refuses a claim with no storageClassName rather than issuing a patch the API server would accept and silently ignore."
        },
        {
          "type": "table",
          "headers": [
            "Setting",
            "Default",
            "Meaning"
          ],
          "rows": [
            [
              "PVC_AUTOEXPAND_ENABLED",
              "false",
              "Arms the expander"
            ],
            [
              "PVC_AUTOEXPAND_STEP_PERCENT",
              "50",
              "Growth per expansion, rounded up to a whole GiB"
            ],
            [
              "PVC_AUTOEXPAND_CEILING_MULTIPLE",
              "4",
              "Hard ceiling, as a multiple of the original request"
            ],
            [
              "PVC_AUTOEXPAND_MAX_GI",
              "500",
              "Absolute cap whatever the multiple says"
            ],
            [
              "PVC_AUTOEXPAND_COOLDOWN_SECONDS",
              "21600",
              "Minimum gap per claim (EBS refuses a second modify for ~6 h)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The ceiling is measured from the size pinned in pipeline-builder.io/autoexpand-original on first expansion, so it cannot compound. On reaching it expansion stops and PvcAutoExpandAtCeiling fires (critical): a volume that keeps growing past 4× is usually an unarchived WAL or a log loop, not real demand, and the right response is to find the writer."
        },
        {
          "type": "text",
          "content": "Operational properties worth knowing:"
        },
        {
          "type": "list",
          "items": [
            "Fails closed without Redis. The cooldown and the cross-replica lock are one"
          ]
        },
        {
          "type": "text",
          "content": "SET NX EX; with no Redis there is neither, and the failure mode would be repeated EBS modification attempts on every repeat_interval."
        },
        {
          "type": "list",
          "items": [
            "Least privilege. Platform holds a namespaced Role (get, patch on"
          ]
        },
        {
          "type": "text",
          "content": "persistentvolumeclaims in pipeline-builder only) — not a ClusterRole, and no create/delete: deleting a Retain-policy claim would orphan a billing EBS volume."
        },
        {
          "type": "list",
          "items": [
            "StatefulSet claims are expanded too, and that leaves the manifest behind,"
          ]
        },
        {
          "type": "text",
          "content": "because volumeClaimTemplates is immutable. PvcAutoExpandTemplateDrift fires so it cannot rot silently — update rustfs.yaml / redis.yaml and re-apply with --cascade=orphan."
        },
        {
          "type": "text",
          "content": "Automatic data-volume expansion (ec2 only)"
        },
        {
          "type": "text",
          "content": "The ec2 counterpart, and a different actuator because there is no claim to patch: this target binds manual hostPath PVs, so the databases, the RustFS buckets and the registry all share one EBS volume (/dev/xvdf, whole-disk ext4 labelled pipeline-data, mounted at /opt/pipeline). With NODE_DISK_AUTOEXPAND_ENABLED=true, NodeDiskFillingUp also POSTs to platform's /observability/node-disk-autoexpand, which calls ec2:ModifyVolume and then runs an SSM document to grow the filesystem."
        },
        {
          "type": "text",
          "content": "Why SSM, and why it is not a back door. resize2fs needs root on the host, which no pod has. The instance role is granted ssm:SendCommand on exactly one document — <stack>-resize-data-fs, which takes no parameters and resizes a fixed device — and on exactly one instance. A workload that reaches IMDS and steals instance credentials can therefore trigger that one resize and nothing else. A grant on AWS-RunShellScript, or a parameterised document, would hand it arbitrary root commands on a box that also builds untrusted plugins."
        },
        {
          "type": "text",
          "content": "ec2:ModifyVolume is additionally conditioned on the pipeline-builder-data-volume tag, so the instance cannot grow — or bill for — any other volume in the account, including its own root volume."
        },
        {
          "type": "text",
          "content": "There is no growpart: UserData formats the volume whole-disk with no partition table, so the filesystem starts at sector 0 and resize2fs alone is correct. That omits the step most likely to destroy data. The document does wait for the EBS modification to settle first — resize2fs against a volume still being optimized grows to the old size and reports success."
        },
        {
          "type": "text",
          "content": "The volume is found by asking IMDS for this instance's id and filtering DescribeVolumes on attachment plus the data-volume tag, rather than by a configured name: the volume's Name tag interpolates the domain, and a tag-value lookup could match a different stack's volume in the same account."
        },
        {
          "type": "text",
          "content": "Ceiling, cooldown and fail-closed-without-Redis behave exactly as the eks path, with NodeDiskAutoExpandAtCeiling (critical) and NodeDiskAutoExpandFailing watching the actuator. The ceiling is measured from the size first seen, recorded as a tag on the volume so it cannot compound."
        },
        {
          "type": "text",
          "content": "Blast radius is larger than anything on eks, which is why it ships off: this is the single disk the whole deployment runs on."
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
            "AWS Deployment — deploying to EC2 and EKS in the first place",
            "Secret Rotation — the per-secret procedures with overlap windows",
            "Service Mesh — the full mesh troubleshooting table and LEAN mode",
            "Environment Variables — every configuration variable",
            "Ecosystem Moderation — the queue the alerts above watch"
          ]
        }
      ]
    }
  ],
  "sourceDoc": "docs/deploy-operations.md"
};
