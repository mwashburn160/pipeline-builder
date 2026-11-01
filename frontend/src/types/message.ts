// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The in-app message model: a thread's messages and their attachments. */

import type { MessagePriority, MessageType, Visibility } from '@pipeline-builder/api-core';

/** Attachment metadata (the blob is fetched separately, auth-gated). */
/**
 * The workflow half of a support thread, as a tenant may see it.
 *
 * `threadId` is the case IDENTITY — the root message's id — so this joins onto
 * an inbox row directly. `displayNumber` is the per-org number a customer
 * quotes (rendered `ACME-1042`); it is unique per org, never global, because a
 * global sequence would disclose total case volume to every customer.
 *
 * No `assignedTo`: which engineer holds the case is internal. The tenant's
 * counterparty is the support desk, not a named individual.
 */
export interface SupportCaseSummary {
  /** CSAT the customer gave, 1–5, or null when unrated — which is the usual
   *  state and must stay distinguishable from a low score. */
  satisfaction?: number | null;
  threadId: string;
  displayNumber: number;
  /** `open` | `awaiting_support` | `awaiting_customer` | `resolved` | `closed`. */
  status: string;
  severity: string;
  /** The support level FROZEN at open, so a mid-case downgrade does not change
   *  the promise shown against a case someone is already waiting on. */
  level: string;
  /** Opened by spending a one-time incident rather than against a contact seat. */
  openedWithIncident: boolean;
  /** The designated contact currently responsible, or null. */
  tenantContact: string | null;
  /** First staff reply. Null while the case is still awaiting its first answer. */
  firstResponseAt: string | null;
  createdAt: string;
  closedAt: string | null;
}

/**
 * One row of the staff support queue.
 *
 * Distinct from {@link SupportCaseSummary}: this is the STAFF view, so it
 * carries `orgId` (whose case it is) and `assignedTo` (which engineer holds it)
 * — both of which the tenant-facing summary deliberately omits.
 */
/**
 * A reusable staff reply template.
 *
 * System-wide, not per-tenant: the vendor's own wording for recurring
 * questions, authored once and reused across every customer. Staff-only on read
 * as well as write, because there is no tenancy boundary underneath it.
 */
export interface CannedResponse {
  id: string;
  title: string;
  body: string;
}

/**
 * A staff-only note on a case.
 *
 * Rendered ONLY on the staff queue. All three note routes are system-admin
 * gated server-side, and the notes live in their own table so that no tenant
 * read path can reach them by forgetting a condition.
 */
export interface SupportCaseNote {
  id: string;
  caseId: string;
  content: string;
  createdBy: string;
  createdAt: string;
}

export interface SupportQueueRow {
  threadId: string;
  /** The tenant the case belongs to. */
  orgId: string;
  displayNumber: number;
  status: string;
  severity: string;
  /** The level FROZEN at open — who is paying, and which target applies here. */
  level: string;
  openedWithIncident: boolean;
  /** The engineer holding it, or null for the unowned pool. */
  assignedTo: string | null;
  tenantContact: string | null;
  /** Null means never answered — which age alone cannot distinguish from
   *  "answered and waiting again", and they mean opposite things. */
  firstResponseAt: string | null;
  createdAt: string;
  /** RESPONSE age: elapsed minus time spent awaiting the customer. */
  waitingSeconds: number;
}

export interface MessageAttachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

/** Internal message model. */
export interface Message {
  id: string;
  orgId: string;
  /**
   * Display name of the sender org (`orgId`), resolved server-side. Optional —
   * absent when the name couldn't be resolved, so the UI falls back to the id.
   */
  orgName?: string;
  threadId: string | null;
  recipientOrgId: string;
  /** Display name of the recipient org (`recipientOrgId`); see `orgName`. Unset for '*' broadcasts. */
  recipientOrgName?: string;
  /**
   * Optional per-user target WITHIN `recipientOrgId`. Null (default) = the whole
   * recipient org sees it; when set, only this user does. Announcement broadcasts
   * ('*' recipient) never set this.
   */
  recipientUserId: string | null;
  messageType: MessageType;
  /**
   * Logical channel/inbox bucket (e.g. 'support', 'help'). Null for
   * org-to-org conversations that don't belong to a channel.
   */
  channel: string | null;
  subject: string;
  content: string;
  /**
   * Per-participant read receipts: maps `orgId` → ISO timestamp of when that
   * org marked the thread read. Empty `{}` means no participant has read it.
   * Sender's mark-as-read does not flip recipient's view and vice-versa.
   */
  readBy: Record<string, string>;
  priority: MessagePriority;
  /** Attachment metadata, embedded by the thread endpoint (absent on list rows). */
  attachments?: MessageAttachment[];
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  /** Set when the author edited the content after sending (drives the "edited" hint). */
  editedAt?: string | null;
  visibility: Visibility;
  isDefault: boolean;
  isActive: boolean;
  deletedAt?: string;
  deletedBy?: string;
}
