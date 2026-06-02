# Message Service

Internal messaging API for the pipeline-builder platform. Provides org-to-org and org-to-system conversations, system-wide announcements, threaded replies, per-participant read tracking, and real-time delivery over Server-Sent Events (SSE).

## Concepts

- **Announcements** — System-admin broadcasts to every org. Created with `messageType=announcement` and `recipientOrgId="*"`; only sysadmins may send them.
- **Conversations** — Two-way threaded messaging between an org and the system support inbox, or between orgs. Created with `messageType=conversation` and a concrete `recipientOrgId`.
- **Threads** — A root message (`threadId` is null) plus its replies (`threadId` references the root). Replies-to-replies are rejected to keep threads flat and readable.
- **Read tracking** — Read state is per-participant, stamped as `readBy[orgId]`. The recipient reading a thread never flips the sender's view, and vice versa.

## Endpoints

All `/messages` routes require authentication; reads are also quota-metered (`apiCalls`).

### Read

| Method | Path | Description |
|--------|------|-------------|
| GET | `/messages` | List inbox root messages (paginated, filtered) |
| GET | `/messages/announcements` | List announcements visible to the org (cached) |
| GET | `/messages/conversations` | List conversations for the org (cached) |
| GET | `/messages/unread/count` | Count unread messages for the org |
| GET | `/messages/:id` | Get a single message |
| GET | `/messages/:id/thread` | Get a full thread (root + replies, oldest first) |

Inbox listings accept `messageType`, `priority`, `channel`, `isRead`, and `threadId` filters plus standard pagination (`limit`, `offset`, `sortBy`, `sortOrder`). `threadId=root` (or omitting it) returns root messages only.

### Write

| Method | Path | Description |
|--------|------|-------------|
| POST | `/messages` | Create an announcement (sysadmin) or conversation |
| POST | `/messages/:id/reply` | Reply to the root message of a thread |
| PUT | `/messages/:id/read` | Mark a single message as read |
| PUT | `/messages/:id/thread/read` | Mark every message in a thread as read |
| DELETE | `/messages/:id` | Soft-delete a message (cascades to thread replies) |

Deleting a root message cascades a soft-delete to all of its replies. Non-admins may delete only their own root messages (no replies); sysadmins may delete any message, and their cascade sweeps replies from both participants.

## Real-Time Notifications (SSE)

Recipients receive live `MESSAGE` events when a message is created, replied to, deleted, or when their unread count changes. Because `EventSource` cannot send `Authorization` headers, the service uses a short-lived, single-use **ticket** so JWTs never appear in query strings or logs:

1. `POST /messages/notifications/ticket` (authenticated) — exchange the JWT for a one-time ticket.
2. `GET /messages/notifications?ticket=<ticket>` — open the SSE stream; the ticket is consumed on connect.

Tickets expire after `SSE_TICKET_TTL_MS` (30s default) and are bounded per-process and per-org to cap memory under abuse. A connection slot is reserved before SSE headers are flushed, so an over-limit client gets a clean `429` instead of a committed `200`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SSE_MAX_TOTAL_TICKETS` | `1000` | Process-wide cap on live SSE tickets |
| `SSE_MAX_TICKETS_PER_ORG` | `10` | Per-org cap on live SSE tickets |
| `CACHE_TTL_MESSAGE` | `300` | Cache TTL (seconds) for announcements/conversations |

## Services

- **MessageService** — CRUD plus thread, read-tracking, and unread-count operations via the `CrudService` base class. Reads of announcements and conversations are cached and invalidated automatically on any mutation.
