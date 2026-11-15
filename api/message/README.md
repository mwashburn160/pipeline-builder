# message

Internal messaging API for the pipeline-builder platform: org-to-org and org-to-system conversations, system-wide announcements, threaded replies, per-participant read tracking, and real-time delivery over Server-Sent Events. The API gateway (nginx) routes `/api/messages/*` here.

## Responsibilities

- Stores and serves messages: inbox listings, announcements, conversations, single messages, and full threads (Postgres via `CrudService`, RLS-scoped). Per-user targeted messages are visible only to their target.
- Announcements are sysadmin-only `*` broadcasts. A member may start a conversation only with an org in its own account (same root org) or with the system support desk; replies stay in a flat thread.
- Per-org read and hidden ("removed from inbox") state, bulk hide/unhide/read/delete, author-only edits, soft-delete with restore and purge (both behind step-up), and a retention sweep for tombstones, abandoned pending attachments and aged system notifications.
- Attachments: upload to S3-compatible storage (MinIO), image thumbnails, visibility-gated downloads.
- Support cases: `POST /messages/support` files a support conversation and, when the org holds a contact seat (or spends a one-time incident), opens a case with a frozen level and response target. Staff queue, status/severity/assign/transfer, staff notes, canned replies, CSAT, and on-call paging before a premium case's first-response deadline.
- Internal service routes: system notifications (`/internal/notify`), the org-delete attachment cascade, and billing's derived frustration signal (support text never leaves this service).
- Pushes live `MESSAGE` events over SSE (new message/reply, edit, delete, unread-count change), using short-lived single-use tickets so JWTs never appear in query strings or logs.
- Every `/messages` route is `apiCalls`-metered once at the prefix (service principals, the SSE ticket mint and the unread-count poll are exempt). Announcement and conversation pages are cached and invalidated on mutation.

## Endpoints

All `/messages` routes require authentication; the `/messages/internal/*` routes accept only signed service tokens from the named callers.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/messages` | List inbox root messages (paginated, filtered) |
| GET | `/messages/announcements` | Announcements visible to the org (cached) |
| GET | `/messages/conversations` | The org's conversations (cached) |
| GET | `/messages/unread/count` | Unread count for the caller |
| GET | `/messages/deleted` | The org's soft-deleted tombstones |
| GET | `/messages/recipients/orgs` | Orgs the caller may start a conversation with |
| GET | `/messages/:id` | A single message |
| GET | `/messages/:id/thread` | A full thread (root + replies, with attachment metadata) |
| GET | `/messages/:id/attachments` | A message's attachment metadata |
| POST | `/messages` | Create an announcement (sysadmin) or conversation |
| POST | `/messages/:id/reply` | Reply to a thread root |
| PATCH | `/messages/:id` | Edit a sent message's content (author only) |
| PUT | `/messages/:id/read` | Mark a message read |
| PUT | `/messages/:id/thread/read` | Mark a whole thread read |
| POST | `/messages/read` | Set read state on selected messages |
| POST | `/messages/hide` / `/messages/unhide` | Remove messages from / restore them to this org's inbox |
| DELETE | `/messages/:id` | Soft-delete a message (cascades to replies) |
| POST | `/messages/delete` | Soft-delete selected messages |
| POST | `/messages/:id/restore` | Restore a tombstone (step-up) |
| POST | `/messages/:id/purge` | Permanently delete a tombstone (step-up) |
| POST | `/messages/attachments` | Upload an attachment (`messages:write`) |
| GET | `/messages/attachments/:id` | Download an attachment (`?thumb=1` for an image preview) |
| POST | `/messages/support` | Contact the support desk (`messages:read`) |
| POST | `/messages/support/attachments` | Upload an attachment for a support request (`messages:read`) |
| POST | `/messages/support/:id/reply` | Reply on a support case (its author or tenant contact) |
| GET | `/messages/support/cases` | The org's support cases (paged) |
| GET | `/messages/support/cases/export` | The same ledger as CSV |
| GET | `/messages/support/contacts` | The org's designated support contacts |
| GET | `/messages/support/queue` | Staff queue across all tenants (staff only) |
| PATCH | `/messages/support/:id/status` | Change case status (both sides; reopening a closed case is staff only) |
| PATCH | `/messages/support/:id/severity` | Re-rank severity (staff only) |
| PATCH | `/messages/support/:id/assign` | Assign the staff owner (staff only) |
| PATCH | `/messages/support/:id/transfer` | Hand the case to another contact of the org (tenant) |
| PATCH | `/messages/support/:id/satisfaction` | Rate a resolved/closed case (tenant only) |
| PATCH | `/messages/support/bulk` | Bulk assign/close (staff only) |
| GET/POST/DELETE | `/messages/support/:id/notes[/:noteId]` | Staff-only case notes |
| GET/POST/PATCH/DELETE | `/messages/support/canned[/:id]` | Staff-only canned replies |
| POST | `/messages/notifications/ticket` | Exchange the JWT for a one-time SSE ticket |
| GET | `/messages/notifications?ticket=<id>` | Open the SSE stream (ticket consumed on connect) |
| POST | `/messages/internal/notify` | System notification into an org's inbox (platform, billing, compliance, quota, reporting) |
| DELETE | `/messages/internal/org/:orgId/attachments` | Reclaim a deleted org's attachment blobs (platform) |
| GET | `/messages/internal/offers/frustration/:orgId` | Derived frustration signal (billing) |

## Configuration

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | HTTP listen port | `3000` |
| `SSE_MAX_TOTAL_TICKETS` | Process-wide cap on live SSE tickets | `1000` |
| `SSE_MAX_TICKETS_PER_ORG` | Per-org cap on live SSE tickets | `10` |
| `CACHE_TTL_MESSAGE_SECONDS` | Announcement / conversation cache TTL (seconds) | `300` |
| `MESSAGE_SEND_RATE_MAX` / `MESSAGE_SEND_RATE_WINDOW_MS` | Per-org send/reply rate limit | `60` / `60000` |
| `MESSAGE_ATTACHMENT_RATE_MAX` / `MESSAGE_ATTACHMENT_RATE_WINDOW_MS` | Per-org upload rate limit | `30` / `60000` |
| `MESSAGE_ATTACHMENT_PENDING_TTL_HOURS` | Age at which unlinked uploads are reaped | `24` |
| `MESSAGE_NOTIFICATION_RETENTION_DAYS` | Age at which system notifications are hard-deleted | `365` |
| `MESSAGE_THUMBNAIL_MAX_DIM` | Long edge (px) of a generated image thumbnail | `320` |
| `S3_BUCKET` | Attachment bucket (`S3_ENDPOINT` etc. are read by the shared S3 client) | `message-attachments` |
| `SUPPORT_ENTITLEMENT_TIMEOUT_MS` / `SUPPORT_ENTITLEMENT_CACHE_TTL_SECONDS` | Platform entitlement read timeout / last-known-good TTL | `3000` / `900` |
| `SUPPORT_INCIDENT_TIMEOUT_MS` | Billing incident consume/refund timeout | `3000` |
| `SUPPORT_CASE_ALLOWANCE_PER_CONTACT` / `SUPPORT_CASE_ALLOWANCE_WINDOW_DAYS` | Fair-use case allowance (advisory) | `5` / `30` |
| `ONCALL_CASE_LEAD_MINUTES` / `ONCALL_SWEEP_INTERVAL_MS` / `ONCALL_SWEEP_BATCH_SIZE` | On-call paging lead time, sweep interval, per-tick cap | `120` / `300000` / `100` |

SSE ticket TTL is the shared `SSE_TICKET_TTL_MS` constant from `@pipeline-builder/api-core`. Postgres and JWT settings come from the shared core packages.

## Development

Builds on the shared core packages (`@pipeline-builder/api-core`, `@pipeline-builder/api-server`, `@pipeline-builder/pipeline-data`/`pipeline-core`). Project files are generated by projen from `.projenrc.ts`.

```sh
pnpm build   # compile + lint + test
pnpm test    # run tests
pnpm start   # run the compiled service (node lib/index.js)
```

## License

Apache-2.0
