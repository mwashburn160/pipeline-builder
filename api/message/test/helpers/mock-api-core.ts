// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Message's `@pipeline-builder/api-core` mock.
 *
 * The shared parts (REAL api-core base, logger stub, `ErrorCode` proxy, error
 * classes, pagination constants, audit/boot wiring, the internal-service gate)
 * live in `@pipeline-builder/api-core/testing`. Only
 * message-specific defaults belong here.
 */
import { jest } from '@jest/globals';
import {
  baseApiCoreMock,
  loggerMock,
  passThroughMiddleware,
  serviceAuditDefaults,
  withInternalServiceGate,
} from '@pipeline-builder/api-core/testing';

export { loggerMock };

/**
 * The REAL api-core exports, resolved HERE (not inside the shared factory):
 * `requireActual` on an ESM barrel only succeeds while nothing else is
 * mid-`import()` of it, and this module — a static import of every suite that
 * uses it, evaluated before the suite's `await import(SUT)` — is the one point
 * where that reliably holds.
 */
const actualApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;

/** Message-specific defaults layered over the shared base. */
const messageDefaults = (): Record<string, unknown> => ({
  ...serviceAuditDefaults(),
  // Shared attachment bounds (used by attachment-routes' multer setup).
  MESSAGE_ATTACHMENT_MAX_BYTES: 10 * 1024 * 1024,
  MESSAGE_ATTACHMENT_ALLOWED_MIME: new Set([
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'application/pdf', 'text/plain', 'text/csv', 'application/json',
  ]),
  // Mirror the real isAllowedAttachmentType: MIME allow-list, plus a safe-
  // extension fallback for the generic application/octet-stream.
  isAllowedAttachmentType: (mimetype: string, filename: string): boolean => {
    const mime = new Set([
      'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf',
      'text/plain', 'text/csv', 'application/json', 'text/json',
      'application/zip', 'application/x-zip-compressed', 'application/gzip',
      'application/x-gzip', 'application/x-tar', 'application/tar',
      'application/x-compressed-tar', 'application/x-yaml', 'application/yaml',
      'text/yaml', 'text/x-yaml',
    ]);
    if (mime.has(mimetype)) return true;
    if (mimetype !== 'application/octet-stream') return false;
    const i = (filename || '').lastIndexOf('.');
    if (i < 0) return false;
    const ext = new Set([
      '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.csv',
      '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      '.zip', '.gz', '.tgz', '.tar', '.json', '.yaml', '.yml',
    ]);
    return ext.has(filename.slice(i).toLowerCase());
  },
  // `requirePermission(...perms)` / `requirePermissionOrService(...perms)` are
  // factories that RETURN middleware. Suites exercising the gate override these
  // with real 403-unless-permitted semantics.
  requirePermission: () => passThroughMiddleware,
  requirePermissionOrService: () => passThroughMiddleware,
  createCacheService: () => ({
    getOrSet: (_key: string, factory: () => Promise<unknown>) => factory(),
    get: async () => null,
    set: async () => undefined,
    invalidatePattern: () => Promise.resolve(0),
  }),
  // Org id→name enrichment (org-names helper) — resolve to "no names" so route
  // suites fall back to the raw id, exactly like a platform lookup miss.
  fetchOrgNames: async () => ({}),
});

/**
 * Default api-core namespace for `unstable_mockModule`. Spread `overrides` last
 * so a suite can replace any default (and add exports the default omits).
 */
export function apiCoreMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const merged = { ...messageDefaults(), ...overrides };
  return withInternalServiceGate(baseApiCoreMock(actualApiCore, merged), overrides);
}
