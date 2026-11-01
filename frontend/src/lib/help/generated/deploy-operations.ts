// GENERATED FROM docs/deploy-operations.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: 2333de5df9a1fbbf7e7357ed276f14c03bf6cccb6ad24cb4ef463198d4f0f0b4
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
            "The backup CronJob is enabled by default and will alert until its image exists. It is in both AWS kustomizations, on BACKUP_SCHEDULE (02:00 UTC), with BACKUP_ENABLED=true — so a deploy with no working backup is red rather than quietly green. Build BACKUP_IMAGE, or set BACKUP_ENABLED=false to suspend it deliberately.",
            "The backup job is bucket-scoped and cannot delete. It used to run as the object store's root credential — admin over every bucket, with read and delete. It now holds a db-backups-only user with PutObject/GetObject/ListBucket and no delete verb, which is possible because retention is the bucket's own lifecycle rule rather than a client-side prune. A stolen backup credential cannot destroy the backups it was stolen from.",
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
          "content": "deploy/aws/eks/k8s/backup-cronjob.yaml is applied by the normal deploy on both AWS targets, from one implementation, and ships suspended (BACKUP_ENABLED=false). One REPLACE_ME remains: BACKUP_IMAGE, which must carry pg_dump, mongodump, the aws CLI, rclone, openssl and curl, and run as a non-root uid. Build it, set BACKUP_IMAGE, set BACKUP_ENABLED=true, and re-run the target's startup.sh — the schedule is BACKUP_SCHEDULE (default 0 2 * * *, 02:00 UTC)."
        },
        {
          "type": "text",
          "content": "The job writes to RustFS, the in-cluster object store (BACKUP_BUCKET=db-backups, S3_ENDPOINT=http://rustfs:9000), using the bucket-scoped backup-access-key/backup-secret-key from rustfs-secret — so no S3 bucket, IAM role, IRSA or Pod Identity is needed. rustfs-init creates db-backups with versioning, a BACKUP_RETENTION_DAYS expiry rule and a noncurrent expiry, and attaches a policy with no delete. Understand the trade before relying on it: those dumps live in the same cluster, account and region as the databases, so they survive a dropped table or a bad migration but not loss of the cluster, the AZ or the account. deploy/bin/{backup,restore}.sh honour S3_ENDPOINT for the dump path, so repointing both at a real off-cluster bucket is the only change required if that is ever revisited."
        },
        {
          "type": "list",
          "items": [
            "Create the bucket with SSE-KMS, versioning, and — recommended — Object Lock in governance mode."
          ]
        },
        {
          "type": "text",
          "content": "Put retention on a bucket lifecycle rule, not on a client-side prune: a compromised backup role can skip a client-side prune but cannot shorten a lifecycle rule. This is how the shipped RustFS path already works — rustfs-init sets the rule and the job holds no delete verb. Mirror it if you repoint at real S3."
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
          "content": "Grant no s3:DeleteObject: retention belongs to the lifecycle rule, so nothing needs it. The shipped RustFS policy is the model — PutObject, GetObject/GetObjectVersion, ListBucket/ListBucketVersions, scoped to the backup bucket and nothing else."
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
            "Apply and verify. Force one run rather than waiting for 02:00:"
          ]
        },
        {
          "type": "text",
          "content": "bash kubectl apply -f deploy/aws/eks/k8s/backup-cronjob.yaml kubectl -n pipeline-builder create job --from=cronjob/db-backup db-backup-manual"
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
          "content": "EC2 — the same CronJob, not a host timer"
        },
        {
          "type": "text",
          "content": "ec2 and eks run one implementation. k8s/backup-cronjob.yaml is applied by the normal deploy on both targets, on the same BACKUP_SCHEDULE, suspended until BACKUP_ENABLED=true. Enabling it is identical to eks: build the image, set BACKUP_IMAGE, flip BACKUP_ENABLED, re-run startup.sh."
        },
        {
          "type": "text",
          "content": "ec2 used to carry a second, separate schedule — bootstrap.sh installed a host pipeline-backup.timer firing backup.sh at 03:30 UTC while the CronJob ran at 03:00. The two knew nothing about each other, so enabling both produced two full dumps a night against the same destination half an hour apart, and the two AWS targets could not be reasoned about together. The timer has been removed."
        },
        {
          "type": "text",
          "content": "What bootstrap.sh still installs on the host is the client tools — pg_dump, mongodump and rclone — because the manual path runs there and needs them:"
        },
        {
          "type": "code",
          "content": "deploy/aws/ec2/bin/backup.sh          # dumps over kubectl port-forwards; no image needed",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "That manual path is also the answer while BACKUP_IMAGE does not yet exist: it works today, the CronJob does not."
        },
        {
          "type": "text",
          "content": "Bucket hardening is the same: SSE-KMS, versioning, and a bucket lifecycle retention policy rather than a client-side prune a compromised role could bypass. On the in-cluster default, rustfs-init already does the versioning and lifecycle parts."
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
              "one primary (replicas: 1, strategy: Recreate, one RWO volume) plus a streaming standby — postgres-replica, a StatefulSet on every k8s target and a service on docker, seeded by pg_basebackup -R with a permanent per-pod replication slot",
              "a standby exists; promotion is MANUAL. Replication is asynchronous — there is no synchronous_standby_names on any target — and no WAL archiving, so no point-in-time recovery",
              "Losing the primary's volume no longer means going back to the nightly dump: the standby is seconds behind and can be promoted, which is most of the reason it is kept. Nothing promotes it automatically, so that is a human step — see Postgres Failover. A pod restart is still just a brief outage."
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
          "content": "Redis HA removed the old data-tier single point of failure, and the Postgres standby removed most of what replaced it. What remains is not a missing copy but a missing promotion: the standby is there, it streams, and no controller promotes it — so the exposure is the minutes a human takes to notice and act, not the hours a restore takes. There is no Patroni, no repmgr, no pg_auto_failover; Redis is the only store on this deployment with automatic failover."
        },
        {
          "type": "text",
          "content": "MongoDB has no second copy at all. Its rs0 exists so drivers can use transactions and change streams, not for redundancy, so for Mongo the nightly dump really is the whole recovery story — and that asymmetry is why the two rows below differ."
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
              "The only scheduled backup is the nightly CronJob at 02:00 UTC. Everything written since the last successful dump is lost."
            ],
            [
              "RPO, Postgres + Mongo, no image built",
              "∞ — total loss",
              "The AWS targets schedule the CronJob by default, but it cannot run until BACKUP_IMAGE exists — it fails nightly and CronJobRunFailed fires. The local targets schedule nothing at all. Until a dump has actually landed and been restored, the honest RPO is total loss."
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
              "RPO, Postgres, primary volume lost",
              "seconds",
              "The standby is streaming asynchronously, so promoting it loses only what had not yet replayed. This is the number that matters in the common case, and it is three to four orders of magnitude better than the dump — but ONLY if whoever is on call knows the standby is there. Do not reach for the dump first."
            ],
            [
              "RTO, Postgres, primary lost",
              "promotion + rollout",
              "Promote the standby and repoint the write path: Postgres Failover. Manual, so the clock is \"time to notice\" plus a few minutes."
            ],
            [
              "RTO, from dumps (Mongo, or Postgres with no usable standby)",
              "restore time + rollout",
              "Provision, restore the dumps, restore the object-store mirror, re-create the secrets, roll the deployments."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Tightening the Mongo RPO below a day means running backup.sh more often — change the CronJob schedule:, it is cheap and the dumps are small. For Postgres the dump is already the second line rather than the first: streaming replication ships and is applied on every target, so the lever worth pulling is making promotion faster (or automatic), not dumping more often. What no amount of either buys is point-in-time recovery — the dumps are logical and there is no WAL archive, so a recovery lands on a dump boundary or on the standby's last replayed transaction, and nowhere in between."
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
          "content": "Periodically restore the latest backup into a scratch namespace or instance and verify — an untested backup is not a backup. For the cheap check you can run often, restore.sh --verify is read-only: it resolves the keys, downloads each archive and runs the same integrity checks a real restore runs, then stops before anything is dropped — so it needs no --confirm-destructive and no scratch database. It answers \"is there a restorable archive?\", not \"does the data come back correctly\"; only a real drill answers the second. A drill that restores only the dumps proves less than it looks: include the object-store mirror and a .env / certs/ restore, or you have not tested the parts that fail hardest."
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
          "content": "On AWS (ec2, eks) the consoles — and /pgadmin/, /mongo-express/ — are on by default (ADMIN_CONSOLES_ENABLED=true; set it false and the routes 404 instead). They sit behind an nginx auth_request to platform's GET /admin/console-check (see AWS: Access Points), which requires a superadmin whose active org is the system org, at AAL2."
        },
        {
          "type": "text",
          "content": "The active-org condition is specific to the consoles, and it is defence in depth rather than a replacement. The superadmin flag is select: false with no write path — the user-update surface is .strict() precisely so it cannot be set from outside — whereas membership rows have many (OAuth invite-accept, domain auto-join, SCIM, SSO JIT), which is why the two are ANDed: gating on the org alone would turn every org-join bug into privilege escalation. What the org adds is which hat the operator is currently wearing. A superadmin browsing a tenant org holds a token minted in that org, and opening mongo-express from there is a datastore-wide session begun from a tenant context, which the audit trail then reads as if it happened inside that tenant. So entering a console is a deliberate context switch, exactly as the plugin-ecosystem governance routes already are. Refusals answer 403 SYSTEM_ORG_REQUIRED, which nginx surfaces through X-PB-Deny-Reason — the one refusal on this route an operator can fix unaided."
        },
        {
          "type": "text",
          "content": "Note that system-org membership alone grants nothing. The flag is the privilege axis; the system org is a content boundary (isSystemOrgId is documented in api-core as \"a content-owner check, not a privilege gate\"). A non-admin system-org member — an Ecosystem Manager, say — passes the org gate and is still refused here, and cannot read tenant data anywhere: the Postgres RLS read predicate widens scope on current_is_sysadmin(), while its system-org clause runs the other way, making system-org content readable by every tenant."
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
          "content": "There are three, split by the question each answers rather than by service:"
        },
        {
          "type": "list",
          "items": [
            "Plugin ecosystem (uid: plugin-ecosystem) — the moderation queue by kind and status, oldest pending request per lane, SLA breaches, manager decisions and latency, auto-approvals per rule, separation-of-duties and Verified-eligibility refusals, Ecosystem Manager headcount, re-sign progress and failures, and ecosystem notice sends and drops.",
            "Platform health (uid: platform-health) — golden signals and the infrastructure failure modes that look healthy from above. Described under The Platform health dashboard.",
            "Product health (uid: product-health) — the tenant-facing half, which no infrastructure panel can see. Described under The Product health dashboard."
          ]
        },
        {
          "type": "text",
          "content": "Each file is identical on every target — a contract test enforces it, along with the uid, the title and the metrics the panels must keep referencing — so edit them in source control, not in the UI. After changing one on kubernetes, re-run the setup script's ConfigMap step (or kubectl create configmap grafana-dashboards … --dry-run=client -o yaml | kubectl apply -f -) and restart Grafana."
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
          "content": "Scheduled-job alerts"
        },
        {
          "type": "text",
          "content": "In alert-rules.yml on the three Kubernetes targets. Fed by kube-state-metrics (k8s/kube-state-metrics.yaml), deployed on aws/eks and aws/ec2 only. Docker has no Kubernetes API and ships neither rule; minikube ships the rules but not the exporter, so they are inert there."
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
              "CronJobRunFailed",
              "a Job in the namespace reached its Failed condition in the last 6 h (5 min)",
              "warning"
            ],
            [
              "CronJobNotScheduled",
              "an unsuspended CronJob's next scheduled run is over 2 h in the past (30 min)",
              "critical"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Why an exporter was needed at all. A CronJob's outcome lives in the API server, not in any pod's /metrics, so nothing in the stack could see it. The two scheduled jobs here each fail in a direction nothing noticed:"
        },
        {
          "type": "list",
          "items": [
            "db-backup POSTs to Alertmanager when it runs and fails, which leaves the worse case uncovered — a job that is suspended, deleted or never scheduled posts nothing, because nothing is left running to post. DatabaseBackupStale partly covers that through Pushgateway, but only once a backup has succeeded at least once to establish a series that can go stale.",
            "ask-model-up could not self-report at all: its image is registry.k8s.io/kubectl, which is distroless and ships no shell and no HTTP client, so there was nothing to run a curl from. A GPU node that could not be provisioned (no capacity, a vCPU quota) left Ask unavailable for the day with the first signal being a user's question failing."
          ]
        },
        {
          "type": "text",
          "content": "Both rules are keyed on CronJobs in the namespace rather than on job names, so anything scheduled later is covered without a new rule."
        },
        {
          "type": "text",
          "content": "Suspended CronJobs are deliberately excluded from CronJobNotScheduled. Setting ASK_SCHEDULE_ENABLED=false legitimately applies both ask-model scalers suspended, and paging for a supported configuration is how an alert gets permanently muted."
        },
        {
          "type": "text",
          "content": "Least privilege. Unlike the upstream deployment, this one watches a single namespace (--namespaces=pipeline-builder), which makes a namespaced Role sufficient rather than a cluster-wide ClusterRole over every object kind. It is granted list/watch only, and not secrets or configmaps — kube-state-metrics does not export their values but does export their names and metadata, and Grafana here applies no org scoping. The --resources flag and the Role must stay in exact lockstep: a resource watched without permission logs failed to list on every resync and its metric family is silently absent, so an alert built on it never fires. A contract test enforces both the lockstep and that every kube_* family the rules read is actually exported."
        },
        {
          "type": "text",
          "content": "kube-state-metrics itself is covered by ServiceDown — it is discovered by the same kubernetes-pods scrape job as everything else, so if it stops answering, that fires."
        },
        {
          "type": "text",
          "content": "The monitoring stack itself"
        },
        {
          "type": "text",
          "content": "Every observability component is scrape-annotated, so ServiceDown catches the process dying. None were watched for being alive and wrong, which is the failure that matters more: a monitoring system that is up and not working looks exactly like a healthy system."
        },
        {
          "type": "text",
          "content": "PrometheusRuleEvaluationFailing is the rule the others depend on. An expression that is syntactically valid but fails at evaluation — a label that does not exist at runtime, an on() matching nothing on one side — fails every cycle and never fires. Neither promtool check rules nor the unit tests catch that: the first validates syntax, and the second supplies its series by hand, so both pass for a rule that will never match real data. Every other alert here is only as trustworthy as this one."
        },
        {
          "type": "text",
          "content": "AlertmanagerNotificationsFailing covers alerts raised and lost — a rotated webhook, a receiver misconfiguration. Note the asymmetry it admits in its own description: you only receive it if some other receiver still works. The Watchdog is the belt to its braces and remains inert until an external dead-man's-switch is wired to it."
        },
        {
          "type": "text",
          "content": "Cardinality is the quiet way a monitoring system dies. Series accumulate, memory follows them directly, the pod is OOMKilled, and the thing that would have told you is the thing that died. PrometheusHeadSeriesHigh fires at 100k — roughly 3–5× this deployment's steady state and well inside what the 512Mi limit holds — so it reads as \"something started emitting a new label\" rather than as a cliff."
        },
        {
          "type": "text",
          "content": "Thanos failing degrades nothing you can see today. Dashboards keep working from local TSDB and alerts keep firing; the gap appears only when someone asks what was happening last month, by which point the data was never written. ThanosCompactionHalted is critical rather than a warning because the compactor halts deliberately and will not resume on its own. ThanosObjstoreFailing is the only view of whether the bucket accepts writes at all, because RustFS exposes no Prometheus endpoint of its own."
        },
        {
          "type": "text",
          "content": "Inhibition: suppressing consequences, and what cannot be suppressed"
        },
        {
          "type": "text",
          "content": "At 172 rules one root cause is a pager flood, and a flood is functionally the same as no alert. The inhibition tree in alertmanager.yml suppresses the consequences of DNS failure, a dead waypoint, Redis at its cap, node saturation, and a service being down."
        },
        {
          "type": "text",
          "content": "The constraint that shapes all of it: equal matches label names that must exist on both sides. A rule naming a label only one side carries silently matches nothing — it looks correct in review and does nothing in production. So equal: [] (global suppression) is used only where the dependency genuinely is cluster-wide — DNS, the waypoint, Redis — and a node-scoped cause uses equal: ['node'] so a saturated node never silences a healthy one."
        },
        {
          "type": "text",
          "content": "Two tempting rules are deliberately absent, recorded in the config rather than written as no-ops:"
        },
        {
          "type": "list",
          "items": [
            "ServiceDown → S2sErrorRateHigh is semantically right, but ServiceDown labels"
          ]
        },
        {
          "type": "text",
          "content": "the dead service service while the S2S alerts label the callee target, and inhibition cannot rename a label. Global suppression would silence S2S errors to a healthy target whenever any unrelated service was down."
        },
        {
          "type": "list",
          "items": [
            "Node saturation → ContainerOOMKilled/PodNotScheduled is also right, but those"
          ]
        },
        {
          "type": "text",
          "content": "come from kube-state-metrics, which carries no node label, and suppressing them globally would hide a pod that cannot schedule for an unrelated reason."
        },
        {
          "type": "text",
          "content": "Both would need a label added at the source. Neither is worth a rule that quietly does nothing."
        },
        {
          "type": "text",
          "content": "On-call paging: the three receivers that do not go to Slack"
        },
        {
          "type": "text",
          "content": "Three receivers point at platform's POST /observability/oncall-webhook rather than at a chat integration, and the reason is a constraint rather than a preference: alertmanager.yml is asserted byte-identical across all four targets and Alertmanager has no templating, so a route that existed only where paging is enabled would need a second copy of the whole config — the shape admin-consoles-disabled.conf already takes for nginx. Pointing at the product instead keeps the routes always present and honours ONCALL_ENABLED on the receiving side, where a disabled client accepts and drops. Alertmanager therefore sees a 200 either way, and a deployment that does not page accumulates no alertmanager_notifications_failed_total."
        },
        {
          "type": "list",
          "items": [
            "support-pager takes severity: critical + component: support with"
          ]
        },
        {
          "type": "text",
          "content": "continue: true, so a support critical reaches both the pager and critical-slack. Route order is load-bearing: it precedes the severity routes, which end continue: false, so moving it below severity = \"critical\" would stop evaluation there and the pager would never be reached."
        },
        {
          "type": "list",
          "items": [
            "meta-alerts takes delivery_meta: \"true\" and exists to break a circularity."
          ]
        },
        {
          "type": "text",
          "content": "With the Slack receivers unconfigured, AlertmanagerNotificationsFailing fires, is sent to Slack, fails, and increments the counter it watches — retrying forever while nobody reads it. This receiver answers 200 whatever the knobs say."
        },
        {
          "type": "list",
          "items": [
            "Both authenticate with the existing relay-token, on the same service and port"
          ]
        },
        {
          "type": "text",
          "content": "the per-org relay already uses. There is no new Secret, no NetworkPolicy rule and no istio-internal-routes.yaml entry — the credential and the path were already there."
        },
        {
          "type": "text",
          "content": "The secret that is new is PAGERDUTY_ROUTING_KEY, and it is a per-service integration key, not a REST API key: it can create events on one service and nothing else. It reaches the app Secret automatically through the _KEY suffix rule in the env classifier, never the world-readable ConfigMap, and it is consumed by platform and the message service rather than mounted into Alertmanager."
        },
        {
          "type": "text",
          "content": "Do not \"disable\" paging by emptying the key. ONCALL_ENABLED=true with an empty key is refused by pb_check_alert_delivery at deploy time, and for a reason worth stating: an empty api_url_file or routing key passes amtool check-config, so the failure surfaces at notify time — at 3am, on the one alert that was supposed to wake somebody. Set ONCALL_ENABLED=false instead, which is honest and which the posture gauges report."
        },
        {
          "type": "text",
          "content": "A third leg does not come through Alertmanager at all: the per-case sweep in the message service pages from a premium case's exact response_due_at. It runs whatever ONCALL_ENABLED says — paging is dropped when off, while its oncall_cases_due gauge shows what a deployment has promised before it buys a pager. See On-call Paging."
        },
        {
          "type": "text",
          "content": "The Platform health dashboard"
        },
        {
          "type": "text",
          "content": "platform-health.json is the counterpart to these alerts: the rules previously had one dashboard between them, which meant an alert could fire with nowhere to look. It is organised around the failure modes that look healthy from above — throttling under a fine CPU average, inodes under free bytes, a frozen autoscaler, DNS up with nobody able to reach it — and ends with a row for the alerting stack's own health."
        },
        {
          "type": "text",
          "content": "Two mechanical notes. Every dashboard must be named in the grafana-dashboards ConfigMap in deploy/bin/k8s-resources.sh: the provisioner loads whatever is in the mounted directory, so a dashboard added to config/ but missing from the ConfigMap never appears and nothing reports it missing — a contract test now checks both. And the JSON is byte-identical across all four targets, asserted the same way the rules are."
        },
        {
          "type": "text",
          "content": "The Product health dashboard"
        },
        {
          "type": "text",
          "content": "product-health.json covers what the other two cannot see. Both of them answer \"is the system up\"; neither answers \"is the product doing its job for tenants\". A survey found 274 business metrics emitted against 36 with a panel, and the gap was not scattered — it was the whole product layer. Pipeline executions, plugin builds and their queue wait, the account base, sign-in and second factors, step-up, SSO JIT provisioning, compliance scans, vulnerability findings, quota refusals, AI token spend and the billing ledger had no panel anywhere."
        },
        {
          "type": "text",
          "content": "It is organised by the question each row answers, and two panels are there for asymmetries worth stating:"
        },
        {
          "type": "list",
          "items": [
            "mongo_index_unknown is shown and deliberately NOT alerted. It counts indexes"
          ]
        },
        {
          "type": "text",
          "content": "no schema declares, which is normally an operator adding one by hand to rescue a slow query; index-reconcile.ts reports those and leaves them alone, so non-zero is an expected state. Its sibling mongo_index_reconcile_failed is alerted, because a failed rebuild leaves the OLD definition in place and writes can keep failing against it."
        },
        {
          "type": "list",
          "items": [
            "user_erasure_incomplete_total had an alert and no panel. A user deletion whose"
          ]
        },
        {
          "type": "text",
          "content": "ecosystem-content scrub failed still deleted the user — the scrub is post-commit and best-effort precisely so it cannot block the deletion — so the residue is the only evidence the reviews were left behind."
        },
        {
          "type": "list",
          "items": [
            "The Alert delivery row answers a question the other 37 panels cannot: whether"
          ]
        },
        {
          "type": "text",
          "content": "anyone would hear any of them. alert_delivery_enabled and alert_delivery_configured are deliberately separate — the first is what a deployment declared, the second whether delivery is actually possible — and oncall_cases_due is the outstanding obligation, which is published whatever ONCALL_ENABLED says. Before this row, answering \"does this deployment tell anyone when something breaks?\" meant reading .env, two Secrets and four copies of alertmanager.yml."
        },
        {
          "type": "text",
          "content": "Three alerts were added alongside it, for metrics that had neither an alert nor a panel. PooledQuotaResolutionDenying and PooledQuotaResolutionDegraded split quota_pool_resolution_failed_total by outcome: the pooled model keeps the real caps on the root org, and when a team cannot resolve its root its own limits are -1, so the reservation is refused rather than allowed through unmetered. That refusal is tenant-visible and ours. The other two outcomes keep enforcing real caps and degrade silently, which is the second alert. MongoIndexReconcileFailed is the gauge above."
        },
        {
          "type": "text",
          "content": "Two things that let these stay invisible, both now closed:"
        },
        {
          "type": "list",
          "items": [
            "The alert-drift guard (packages/api-core/test/failure-metrics-alerted.test.ts)"
          ]
        },
        {
          "type": "text",
          "content": "matched only *_failed_total, so a failure expressed as a GAUGE was outside it, and it read only quoted metric names, so a call site naming its metric through a constant — emitCounter(POOL_FAILURE_METRIC, …) — was invisible. quota_pool_resolution_failed_total slipped through on the second, while its own doc comment asked for the alert it did not have."
        },
        {
          "type": "list",
          "items": [
            "metrics.ts illustrated incCounter with invented metric names. A survey counted"
          ]
        },
        {
          "type": "text",
          "content": "three of them — pipelines_generated_total, quota_threshold_crossed_total, compliance_violations_found_total — as live metrics missing a panel. Nothing emitted any of them. The examples are now real calls with the labels they really pass."
        },
        {
          "type": "text",
          "content": "Network: DNS, the waypoint, and the layers between"
        },
        {
          "type": "text",
          "content": "Ingress and application HTTP were already covered — nginx_http_requests_total with GatewayError5xxRatioHigh/GatewayLatencyHigh, and ServiceError5xxBurst on the shared http_requests_total. What was missing sat below and beside them."
        },
        {
          "type": "text",
          "content": "DNS had no signal at all, which is why it gets three rules rather than one. CoreDNS lives in kube-system, a namespace no other scrape job touches, and the three failures are genuinely different:"
        },
        {
          "type": "list",
          "items": [
            "DnsQueriesAbsent — CoreDNS healthy and serving zero queries. This is the"
          ]
        },
        {
          "type": "text",
          "content": "outage this section exists for: allow-dns-egress once shipped without a to:, the AWS VPC CNI would not let that override the per-app except denies, and 10.0.0.0/8 covered the kube-dns IP. The resolver stayed up while no pod could route to it. It presented as platform CrashLooping on KMS GetPublicKey failed ... EAI_AGAIN, plugin stuck at 1/2 with \"All sentinels are unreachable\", and redis replicas stranded on a stale master IP — and nothing named DNS through five disproven theories."
        },
        {
          "type": "list",
          "items": [
            "DnsResolutionFailing — pods do reach CoreDNS and it cannot answer (>5%"
          ]
        },
        {
          "type": "text",
          "content": "SERVFAIL). An upstream or forwarded-zone problem. External names fail while ClusterIP names keep working, because ztunnel answers those from the mesh registry without a forward."
        },
        {
          "type": "list",
          "items": [
            "CoreDnsUnreachable — we cannot scrape it. Deliberately absent() or == 0:"
          ]
        },
        {
          "type": "text",
          "content": "== 0 is \"discovered, scrape failed\", absent() is \"never discovered\", which is what a label change or deleted DaemonSet looks like. A rule checking only == 0 goes silent in the worse case. Note the two branches fire with different label sets — absent() carries the matcher's labels."
        },
        {
          "type": "text",
          "content": "This needed no new RBAC (Prometheus already holds a cluster-wide ClusterRole), only the 9153 egress allowance in allow-coredns-metrics-egress — written with an explicit namespaceSelector rather than ports-only, following the same VPC CNI lesson."
        },
        {
          "type": "text",
          "content": "The waypoint is load-bearing for authorization and was never a scrape target. pb-waypoint runs in pipeline-builder, so istio-mesh (istio-system only) never saw it, and it carries no prometheus.io/scrape annotation, so the kubernetes-pods job never discovered it either — meaning ServiceDown could not fire for it, because up == 0 only works for something that was being scraped. Six services route through it via istio.io/use-waypoint, and it is the only thing in an ambient mesh that can enforce L7 policy, so losing it takes them with it. WaypointUnavailable covers that; the new istio-waypoint job selects the pod label two NetworkPolicies already rely on, and 15020 was added to allow-prometheus-scraping because default-deny-ingress is in force."
        },
        {
          "type": "text",
          "content": "That job also makes mesh authorization denials visible for the first time. ztunnel exports no deny counter — an L4 denial is just a connection that never opens — so the waypoint's 403s in istio_requests_total are the one direct view of policy rejecting traffic. MeshAuthzDenialsSpike reports it per destination, and the description gives the by-caller breakdown, because the usual cause is a policy change that did not account for one caller. L4 denials remain visible only indirectly, through the calling service's S2S error rate."
        },
        {
          "type": "text",
          "content": "S2S was alerted only at total failure. ServiceCircuitOpen is the end state — by the time it fires the caller has given up. Three rules now cover the slope into it, all reading counters that were already being emitted: S2sErrorRateHigh (>10% of calls failing, counting error and server_error but not circuit_open, which would double-count, nor too_large, which is a caller bug), S2sRetryAmplification (retries above half the request volume — how one slow dependency becomes a cluster-wide overload), and S2sCircuitProbeExpiring (half-open probes timing out, so the breaker can never close and the target stays cut off after it recovers)."
        },
        {
          "type": "text",
          "content": "SSE had six metrics and no alerts. These carry the live product surfaces — log streaming, execution status, build status. SseBackpressureDisconnects is a ratio rather than a count, because one client on bad wifi being dropped is normal while a tenth of all streams ending that way means the server cannot keep up with its own writes. SseStreamsRefused covers capacity rejections, deliberately excluding reason=\"forbidden\" — that is a client with the wrong scope, not an operational problem. SseConnectionsNotDraining is phrased as a floor (min_over_time over two hours) because no instantaneous threshold can tell a leak from a busy period."
        },
        {
          "type": "text",
          "content": "CPU: throttling, node saturation and autoscaler health"
        },
        {
          "type": "text",
          "content": "CPU is the control signal for almost all scaling here — every app service runs an HPA targeting 60% CPU utilization, and the Postgres read replicas use a KEDA type: cpu trigger — so the gaps in CPU observability were gaps in knowing whether scaling worked at all."
        },
        {
          "type": "text",
          "content": "Throttling is the failure this deployment is exposed to, not average usage. Nearly every workload sets limits.cpu, so the kernel enforces a CFS quota per 100 ms period. A service that bursts can average 40% CPU over five minutes while being throttled in most individual periods; it reaches users as p99 latency and reads like a network or database problem. Every usage-ratio rule is blind to this by construction, because the average is fine. ContainerCpuThrottling fires at 25% of periods throttled — a ratio, because a throttled count is meaningless without a total, and a mostly-idle pod legitimately clips a few periods. Scaling out does not fix it: each new replica is throttled the same way."
        },
        {
          "type": "text",
          "content": "HpaScalingDisabled is also the metrics-server monitor. Every HPA and the KEDA CPU trigger read metrics-server, which lives in kube-system — a namespace no scrape job here covers, and one the namespaced kube-state-metrics Role cannot see either. Rather than widen RBAC cluster-wide, this watches the consequence: the HPA's own ScalingActive condition. When metrics-server stops answering, every HPA freezes at its current replica count — not zero, not max — so the deployment keeps serving and simply never scales again. The first symptom is latency under a load spike that silently went unanswered."
        },
        {
          "type": "text",
          "content": "HpaAtMaxReplicas is the signal you want before a capacity incident: a workload pinned at its ceiling for an hour is shedding load while everything looks healthy. Check ContainerCpuThrottling first when it fires, because a throttled pod scales out badly."
        },
        {
          "type": "text",
          "content": "Node CPU (NodeCpuSaturated, 85%) matters most where it cannot be escaped: ec2 is one fixed instance, so every HPA replica shares the box and scaling out cannot relieve it — the answer there is a larger instance type. On eks, Auto Mode provisions another node, which makes this a cost and latency signal rather than an outage one."
        },
        {
          "type": "text",
          "content": "PodNotScheduled and ContainerRestartLooping close the other end: a pod that cannot be scheduled is the direct consequence of the two stories above — a Postgres rung increase, or an HPA scaling out onto a full node — and previously presented as nothing at all. An OOMKill also lands in the restart alert, because the kubelet restarts the container rather than reporting a distinct state; read the last state before assuming a crash. A rung change restarts Postgres once by design and stays under the threshold."
        },
        {
          "type": "text",
          "content": "Collection is three narrow cAdvisor jobs rather than one wide one, because unfiltered cAdvisor is ~3 MB of series per node: kubelet-cadvisor (filesystem, node-level), kubelet-cadvisor-node (node CPU plus machine_cpu_cores as the denominator), kubelet-cadvisor-apps (throttling, scoped by namespace/pod/ container) and kubelet-cadvisor-db (the Postgres ladder's usage and spec gauges, now with throttling too). They are separate jobs because each needs a different label filter — the filesystem job keeps device=~'/dev/...', which would drop every CPU series, and machine_cpu_cores carries no id label, so its keep has to admit the empty value or the ratio matches nothing."
        },
        {
          "type": "text",
          "content": "Memory: OOMKills, node pressure, and the Redis cliff"
        },
        {
          "type": "text",
          "content": "Redis is the sharp edge. Every target runs --maxmemory-policy noeviction, which is the right policy for what Redis holds — leader locks, session revocation, auto-expand cooldowns; evicting any of those is a correctness bug, not a slowdown. The cost is a cliff: at the cap every write fails while Redis stays reachable and answers PING, so RedisUnreachable cannot see it. What breaks is quiet and wide — non-concurrency-safe sweeps skip themselves, PVC and node-disk auto-expansion fail closed, session revocation stops persisting. RedisMemoryNearLimit fires at 85% of maxmemory, which is the last point at which that is still avoidable."
        },
        {
          "type": "text",
          "content": "ContainerMemoryNearLimit is the only warning an OOMKill gives you, since the kill itself is a SIGKILL: no graceful shutdown, in-flight requests dropped, and any leader lock the pod held left to expire on its TTL. It reads the cgroup figure rather than the Node heap, deliberately — prom-client exports no heap limit, so there is no denominator, and the heap is not what the kernel kills for. The cgroup counts every tenant: the V8 heap, off-heap Buffers and TLS, and on reporting the Chromium process. The threshold is 90% because working-set legitimately runs high; it includes page cache the kernel would reclaim rather than kill for."
        },
        {
          "type": "text",
          "content": "ContainerOOMKilled covers what ContainerRestartLooping misses: a single kill at a traffic peak, rather than a loop of more than three an hour. It is gated on a recent restart, because last_terminated_reason is a gauge that stays set for the rest of the pod's life — alerting on it alone would fire forever after one kill."
        },
        {
          "type": "text",
          "content": "NodeMemorySaturated is a different failure again: node pressure makes the kubelet evict, which presents as unexplained pod churn rather than a crash. The kubelet evicts Burstable pods by how far usage exceeds request, not by who is at fault, so the pod with the widest request-to-limit gap goes before anything misbehaving."
        },
        {
          "type": "text",
          "content": "Node's heap, and why only reporting pins it"
        },
        {
          "type": "text",
          "content": "Node 24 is cgroup-aware. Measured against the pinned image, V8 sizes its default heap at roughly 55–67% of the container limit (259MB at 384Mi, 432MB at 768Mi, 496MB at 896Mi, 1120MB at 2Gi). For a single-tenant Node container that split is sound and it tracks a limit change automatically — which is exactly why no other service sets --max-old-space-size. A pinned number would not follow a later limit change, leaving a service unable to use memory you are paying for, with nothing flagging the drift."
        },
        {
          "type": "text",
          "content": "reporting is the exception because it has a second tenant: a PDF render launches Chromium in the same container. V8's 496MB budget is computed as though V8 were alone, and ~496MB of heap plus ~150–300MB of Chromium plus ~100MB of Node runtime and off-heap is close to the whole 896Mi limit — while V8 does not collect aggressively until it approaches its ceiling. So the kill arrives during a render that lands on a heap-heavy request. NODE_OPTIONS=--max-old-space-size=320 leaves roughly 570MB for the runtime and Chromium at REPORT_PDF_CONCURRENCY=1, making REPORT_PDF_CONCURRENCY, the memory limit, and the heap cap three faces of one knob."
        },
        {
          "type": "text",
          "content": "Its memory request is 384Mi rather than 192Mi for the eviction reason above: a pod designed to use ~800MB while requesting 192Mi was first in line for eviction ahead of anything actually misbehaving. It is not raised to the full limit, which would reserve 896Mi permanently for a service that idles near 200MB — most of the box on the single-node ec2 target."
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
          "type": "text",
          "content": "When to arm it. Prefer true on an unattended cluster, or one with nobody on call who can answer a page within the hour: every pb-ebs claim is 20 GiB, so the 4× ceiling bounds the whole target near 1.1 TiB — tens of dollars a month — while a full volume stops Postgres and MongoDB accepting writes outright. Prefer false wherever someone is watching, which is why it ships that way. The alerts give hours of warning rather than minutes: PersistentVolumeFillingUpFast predicts a fill four hours out and PersistentVolumeFillingUp fires with 3 GiB still free, so automation is not buying a response you could not otherwise make. Note that the predictive rule is not routed to the expander even when it is armed — acting on an extrapolation would spend money on a trend that has not happened yet — so that one always needs a human."
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
          "content": "because volumeClaimTemplates is immutable. PvcAutoExpandTemplateDrift fires so it cannot rot silently — update rustfs.yaml / redis.yaml and re-apply with --cascade=orphan. It is severity: warning, so it already reaches the warning-slack receiver; what makes it the awkward one is that its consequence arrives at the next scale event, so there is nothing wrong in the cluster to look at when it fires."
        },
        {
          "type": "list",
          "items": [
            "PVC_AUTOEXPAND_MAX_GI is inert at the shipped sizes. Claims are 20 GiB and"
          ]
        },
        {
          "type": "text",
          "content": "the multiple binds at 80 GiB, so the absolute cap cannot be the limiting rail until a base claim exceeds roughly 125 GiB. Worth knowing before treating it as a second protection."
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
          "content": "When to arm it, and what to check first. Prefer false unless the instance is unattended: it ships provisioned at 580 GiB against roughly 260 GiB of commitments (180 GiB of declared PVs plus 80 GiB for the minikube node disk), so here the headroom is already the mitigation. Expansion is also two steps, and the second can fail on its own — ec2:ModifyVolume grows the disk, then the SSM document resizes the filesystem. When that second half never runs you are billed for a larger volume while the disk is still full, EBS refuses another modification for roughly six hours, and retrying cannot fix it; NodeDiskAutoExpandFilesystemPending exists for exactly that outcome. Before setting true, confirm all three:"
        },
        {
          "type": "list",
          "items": [
            "NODE_DISK_AUTOEXPAND_SSM_DOCUMENT matches your stack. The default assumes"
          ]
        },
        {
          "type": "text",
          "content": "the default stack name; under any other name SendCommand fails with InvalidDocument and every expansion half-completes."
        },
        {
          "type": "list",
          "items": [
            "the SSM agent is running on the instance (aws ssm describe-instance-information).",
            "the instance role still carries ssm:SendCommand on that document."
          ]
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
        },
        {
          "type": "text",
          "content": "Plugin uploads are accepted, not built"
        },
        {
          "type": "text",
          "content": "load-plugins.sh uploads each plugin and gets HTTP 202 Accepted. The image build, the cosign signature, the grype scan and PLUGIN_VULN_GATE all run after that, and the version row is written only once they pass — so a plugin whose build is blocked leaves no version at all. It is not listed as broken; it is simply absent from the catalog."
        },
        {
          "type": "text",
          "content": "So a successful load means every upload was accepted, not that every plugin is usable. Check the builds separately."
        },
        {
          "type": "text",
          "content": "The loader used to poll until every accepted plugin had a version and fail the load otherwise. That was removed: it could not distinguish a build that FAILED from one that had not finished. Loading the full catalog onto a cold cluster lands builds at roughly one a minute, so any fixed budget expires mid-run, and the loader declared ~100 healthy plugins failed while naming PLUGIN_VULN_GATE as the likely cause — a confident wrong diagnosis, and a red that carried no information."
        },
        {
          "type": "text",
          "content": "Build outcomes are reported where they are actually known:"
        },
        {
          "type": "list",
          "items": [
            "the Builds page (Queue / Failed-Triage) groups failures by category and"
          ]
        },
        {
          "type": "text",
          "content": "shows the CVE and the version that fixes it;"
        },
        {
          "type": "list",
          "items": [
            "the per-org security notifications N30/N31 name a blocked version;",
            "the plugin service log carries the same detail."
          ]
        },
        {
          "type": "text",
          "content": "This is a stage of init, not all of it. A blocked build leaves the admin user, the pipeline templates and the compliance rules in place — the deploy banner says INITIALIZATION INCOMPLETE and points at the stage that stopped, rather than claiming nothing loaded."
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
