// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The in-app message model: a thread's messages and their attachments. */

import type { MessagePriority, MessageType, Visibility } from '@pipeline-builder/api-core';

/** Attachment metadata (the blob is fetched separately, auth-gated). */
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
