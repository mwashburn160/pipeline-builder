// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { envInt } from '@pipeline-builder/api-core';

/**
 * The compliance service's env-tunable settings, in one place.
 *
 * Every value is read through api-core's `envInt` so the docs-drift guard
 * (`packages/api-core/test/env-documented.test.ts`) sees it, and is resolved
 * once at import time. The scan/digest scheduler cadences are NOT here: they
 * come from pipeline-core's `Config.getAny('compliance')`.
 */
interface AppConfig {
  rules: {
    /** Authoring-time cap on a rule's regex pattern length (NOT the ReDoS bound). */
    maxRegexLength: number;
    /** Hard wall-clock bound (ms) on one rule-authored regex match. */
    regexTimeoutMs: number;
  };
  validate: {
    /** Max top-level attribute keys accepted by the validate routes. */
    maxAttributeKeys: number;
    /** Max nesting depth of an attribute value accepted by the validate routes. */
    maxAttributeDepth: number;
  };
  scan: {
    /** Persist scan progress every N evaluated entities. */
    progressBatchSize: number;
    /** Entities evaluated concurrently per batch. */
    concurrency: number;
    /** A `running` scan older than this (ms) is presumed orphaned and failed. */
    staleTimeoutMs: number;
    /** Keyset page size when fetching a scan's entities. */
    entityPageSize: number;
    /** Safety bound on entities per target per scan; exceeding it fails the scan. */
    entityMaxTotal: number;
  };
  /** Days compliance audit / finished-scan / notification-log rows are kept. */
  auditRetentionDays: number;
  /** Days ahead of an exemption's expiry that its org is warned. */
  exemptionExpiryWarnDays: number;
  /** Per-channel notification delivery timeout (ms). */
  notifyTimeoutMs: number;
}

export const config: AppConfig = {
  rules: {
    maxRegexLength: envInt('COMPLIANCE_MAX_REGEX_LENGTH', 100, { min: 1 }),
    regexTimeoutMs: envInt('COMPLIANCE_REGEX_TIMEOUT_MS', 50, { min: 1 }),
  },
  validate: {
    maxAttributeKeys: envInt('COMPLIANCE_MAX_ATTRIBUTE_KEYS', 100, { min: 1 }),
    maxAttributeDepth: envInt('COMPLIANCE_MAX_ATTRIBUTE_DEPTH', 10, { min: 1 }),
  },
  scan: {
    progressBatchSize: envInt('COMPLIANCE_SCAN_PROGRESS_BATCH_SIZE', 10, { min: 1 }),
    concurrency: envInt('COMPLIANCE_SCAN_CONCURRENCY', 10, { min: 1 }),
    staleTimeoutMs: envInt('COMPLIANCE_SCAN_STALE_TIMEOUT_MS', 2 * 60 * 60 * 1000, { min: 60_000 }),
    entityPageSize: envInt('COMPLIANCE_SCAN_ENTITY_PAGE_SIZE', 1000, { min: 1 }),
    entityMaxTotal: envInt('COMPLIANCE_SCAN_ENTITY_MAX_TOTAL', 100_000, { min: 1 }),
  },
  auditRetentionDays: envInt('COMPLIANCE_AUDIT_RETENTION_DAYS', 180, { min: 1 }),
  exemptionExpiryWarnDays: envInt('COMPLIANCE_EXEMPTION_EXPIRY_WARN_DAYS', 7, { min: 1, max: 90 }),
  notifyTimeoutMs: envInt('COMPLIANCE_NOTIFY_TIMEOUT_MS', 5000, { min: 1 }),
};
