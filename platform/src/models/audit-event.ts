// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Schema, model, Document } from 'mongoose';

/**
 * Audit event action categories.
 *
 * Only includes actions actually emitted by `helpers/audit.ts` callers today.
 * Add a value here AND wire the corresponding `audit(req, '<name>', ...)`
 * call in the controller — declaring the value alone produces a dead surface
 * that misleads dashboard filters.
 */
export type AuditAction =
  // User lifecycle (controllers/auth.ts, controllers/user-profile.ts)
  | 'user.register'
  | 'user.login'
  | 'user.logout'
  | 'user.delete'
  | 'user.tokens.revoke-all'
  // Organization (controllers/organization.ts)
  | 'org.create'
  // Admin actions (controllers/user-admin.ts)
  | 'admin.user.delete'
  | 'admin.org.delete';

/**
 * Audit event document stored in MongoDB.
 */
export interface AuditEventDocument extends Document {
  action: AuditAction;
  actorId: string;
  actorEmail?: string;
  orgId?: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ip?: string;
  createdAt: Date;
}

const auditEventSchema = new Schema<AuditEventDocument>(
  {
    action: { type: String, required: true, index: true },
    actorId: { type: String, required: true, index: true },
    actorEmail: { type: String },
    orgId: { type: String, index: true },
    targetType: { type: String },
    targetId: { type: String, index: true },
    details: { type: Schema.Types.Mixed },
    ip: { type: String },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'audit_events',
  },
);

// Compound index for org-scoped queries sorted by time
auditEventSchema.index({ orgId: 1, createdAt: -1 });

// TTL index — auto-delete events after 90 days (configurable via AUDIT_RETENTION_DAYS)
const retentionDays = parseInt(process.env.AUDIT_RETENTION_DAYS || '90', 10);
auditEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: retentionDays * 86400 });

export default model<AuditEventDocument>('AuditEvent', auditEventSchema);
