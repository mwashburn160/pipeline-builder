// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Metadata store for message attachments (the blobs live in object storage — see
 * attachment-storage.ts). Tenant-scoped via `withTenantTx` (RLS FORCE'd), so
 * every query runs under the caller's org GUC.
 */

import { schema, withTenantTx } from '@pipeline-builder/pipeline-data';
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { deleteAttachments, deleteAttachmentsByOrgPrefix } from './attachment-storage.js';

type Attachment = typeof schema.messageAttachment.$inferSelect;

export interface NewAttachment {
  orgId: string;
  uploadedBy: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  storageKey: string;
}

export class AttachmentService {
  /** Insert a PENDING attachment (message_id NULL) right after the blob lands. */
  async createPending(data: NewAttachment): Promise<Attachment> {
    const [row] = await withTenantTx(async (tx) => tx
      .insert(schema.messageAttachment)
      .values({ ...data, messageId: null })
      .returning());
    return row as Attachment;
  }

  /**
   * Single attachment by id. NOT filtered by the caller's org — an attachment's
   * `orgId` is the UPLOADER's org, which differs from the reader's on any
   * cross-org message (org→support, system announcement→org), so a caller-org
   * filter would make those unreadable. RLS still bounds the row set (own org +
   * system-org + sysadmin); the REAL authorization is done by the CALLER, which
   * must gate on parent-message visibility (linked) or uploader identity
   * (pending) — see the download route. Returns null when not found / not
   * RLS-visible.
   */
  async findById(id: string): Promise<Attachment | null> {
    const [row] = await withTenantTx(async (tx) => tx
      .select()
      .from(schema.messageAttachment)
      .where(eq(schema.messageAttachment.id, id))
      .limit(1));
    return (row as Attachment) ?? null;
  }

  /**
   * All attachments linked to a message (for rendering a thread). Same
   * authorization note as {@link findById}: the caller MUST have already
   * verified it can see `messageId` (via messageService.findVisibleById) before
   * calling this — no caller-org filter, so an org→support attachment is
   * readable by the support (system) org too.
   */
  async findByMessageId(messageId: string): Promise<Attachment[]> {
    return withTenantTx(async (tx) => tx
      .select()
      .from(schema.messageAttachment)
      .where(eq(schema.messageAttachment.messageId, messageId))) as Promise<Attachment[]>;
  }

  /** Batch variant of {@link findByMessageId} for embedding attachments in a
   *  thread payload without an N+1 fetch. Same authorization contract. */
  async findByMessageIds(messageIds: string[]): Promise<Attachment[]> {
    if (messageIds.length === 0) return [];
    return withTenantTx(async (tx) => tx
      .select()
      .from(schema.messageAttachment)
      .where(inArray(schema.messageAttachment.messageId, messageIds))) as Promise<Attachment[]>;
  }

  /**
   * Link a set of PENDING attachments to a freshly-created message. Only rows
   * that belong to the caller's org, were uploaded by the same user, and are
   * still unlinked (message_id IS NULL) are eligible — so a client can't steal
   * or re-point another user's / another message's attachment. Returns the rows
   * actually linked, so the caller can reject a mismatch (some id was bogus).
   */
  async linkToMessage(ids: string[], messageId: string, orgId: string, uploadedBy: string): Promise<Attachment[]> {
    if (ids.length === 0) return [];
    return withTenantTx(async (tx) => tx
      .update(schema.messageAttachment)
      .set({ messageId })
      .where(and(
        inArray(schema.messageAttachment.id, ids),
        eq(schema.messageAttachment.orgId, orgId.toLowerCase()),
        eq(schema.messageAttachment.uploadedBy, uploadedBy),
        isNull(schema.messageAttachment.messageId),
      ))
      .returning()) as Promise<Attachment[]>;
  }

  /**
   * Reap PENDING attachments (`message_id IS NULL`) older than a TTL — uploads
   * abandoned in compose or left dangling by an `attachmentIds` mismatch. Without
   * this they (rows + S3 blobs) accumulate forever and are an abuse vector.
   * Deletes up to `limit` rows and reclaims their blobs (best-effort). Runs under
   * the caller's tenant scope — the retention sweep invokes it as sysadmin, so it
   * spans all orgs. Signature matches `PurgeableEntity.purgeExpired(now, limit)`;
   * returns the number reaped.
   */
  async purgePending(now: Date, limit = 500): Promise<number> {
    const ttlHours = Math.max(1, Number.parseInt(process.env.MESSAGE_ATTACHMENT_PENDING_TTL_HOURS ?? '24', 10) || 24);
    const cutoff = new Date(now.getTime() - ttlHours * 3_600_000);
    const keys = await withTenantTx(async (tx) => {
      // pg DELETE has no LIMIT — select a bounded batch, then delete by id.
      const doomed = await tx
        .select({ id: schema.messageAttachment.id, storageKey: schema.messageAttachment.storageKey })
        .from(schema.messageAttachment)
        .where(and(
          isNull(schema.messageAttachment.messageId),
          lt(schema.messageAttachment.createdAt, cutoff),
        ))
        .limit(limit);
      if (doomed.length === 0) return [] as string[];
      await tx.delete(schema.messageAttachment)
        .where(inArray(schema.messageAttachment.id, doomed.map((d) => d.id)));
      return doomed.map((d) => d.storageKey);
    });
    await deleteAttachments(keys);
    return keys.length;
  }

  /**
   * Purge ALL attachment blobs for an org (key prefix `<orgId>/…`) — the
   * object-storage half of the platform org-delete cascade, which hard-deletes
   * the `message_attachments` rows but can't touch MinIO. Prefix-keyed, so it is
   * independent of the (already-deleted) metadata rows. Throws on a page failure
   * so the internal route reports an incomplete purge. Returns the blob count.
   */
  async purgeOrgBlobs(orgId: string): Promise<number> {
    return deleteAttachmentsByOrgPrefix(orgId);
  }
}

export const attachmentService = new AttachmentService();
