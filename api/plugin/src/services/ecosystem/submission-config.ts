// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration of anonymous submissions: the caps, the secrets and switches
 * that must all be set before the path answers, the extraction limits, and
 * the submitter-facing URLs.
 */

import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  createLogger,
  envInt,
  envStr,
  ErrorCode,
  isAnonymousSubmissionsEnabled,
  POW_DEFAULT_DIFFICULTY,
  POW_MAX_DIFFICULTY,
} from '@pipeline-builder/api-core';
import { COMMUNITY_PUBLISHER_HANDLE } from '@pipeline-builder/pipeline-data';

import { EcosystemError } from './context.js';
import { isOutboundEmailEnabled } from './email-status.js';
import type { ParseZipOptions } from '../../helpers/plugin-spec.js';

const logger = createLogger('ecosystem-submission-config');

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

/** Submissions per rolling 24 h, per verified email and per client IP. */
export const SUBMISSIONS_PER_DAY = 3;
/** Dry-run inspections per 24 h per client IP (no email on that path, so the IP is the only key). */
export const INSPECTS_PER_DAY = 10;
/** Entries an anonymous package may hold (a tenant upload may hold far more). */
export const ANONYMOUS_MAX_ENTRIES = 2_000;
/** Extracted bytes an anonymous package may expand to, as a multiple of `SUBMISSION_MAX_ZIP_BYTES`. */
export const ANONYMOUS_EXPANSION_FACTOR = 10;
/** The magic link's lifetime. */
export const VERIFY_TOKEN_TTL_MS = 30 * 60_000;
/** An undecided submission (and its quarantine artifacts) lives this long. */
export const SUBMISSION_TTL_DAYS = 30;

/** Rows per page of the expiry sweep and the email purge. */
export const SWEEP_BATCH = 500;

export interface SubmissionConfig {
  powSecret: string;
  powDifficulty: number;
  emailHashSecret: string;
  quarantineBuildkitAddr: string;
  buildTimeoutMs: number;
  maxZipBytes: number;
  /** Where anonymous packages are extracted — never the tenant build temp root. */
  extractDir: string;
  /** Anonymous extractions in flight per replica (bounds `extractDir` to this × the byte cap). */
  maxConcurrentExtracts: number;
}

/** The path's configuration, read at call time. */
export function submissionConfig(): SubmissionConfig {
  return {
    powSecret: envStr('SUBMISSION_POW_SECRET', ''),
    powDifficulty: envInt('SUBMISSION_POW_DIFFICULTY', POW_DEFAULT_DIFFICULTY, { min: 1, max: POW_MAX_DIFFICULTY }),
    emailHashSecret: envStr('SUBMISSION_EMAIL_HASH_SECRET', ''),
    quarantineBuildkitAddr: envStr('PLUGIN_QUARANTINE_BUILDKIT_ADDR', ''),
    buildTimeoutMs: envInt('SUBMISSION_BUILD_TIMEOUT_SECONDS', 900, { min: 60 }) * 1000,
    maxZipBytes: envInt('SUBMISSION_MAX_ZIP_BYTES', 50 * 1024 * 1024, { min: 1024 }),
    extractDir: envStr('SUBMISSION_EXTRACT_DIR', path.join(os.tmpdir(), 'pb-submission-extract')),
    maxConcurrentExtracts: envInt('SUBMISSION_MAX_CONCURRENT_EXTRACTS', 2, { min: 1, max: 64 }),
  };
}

/**
 * The extraction an ANONYMOUS package gets: at most
 * {@link ANONYMOUS_EXPANSION_FACTOR} × the zip cap and
 * {@link ANONYMOUS_MAX_ENTRIES} entries, into its own directory. Every
 * consumer of an anonymous zip — inspect, submit and the quarantine worker —
 * parses with these, never the tenant-upload limits (GBs, 10 000 entries).
 */
export function anonymousExtractOptions(cfg: SubmissionConfig = submissionConfig()): Required<ParseZipOptions> {
  return {
    limits: { maxBytes: cfg.maxZipBytes * ANONYMOUS_EXPANSION_FACTOR, maxEntries: ANONYMOUS_MAX_ENTRIES },
    extractRoot: cfg.extractDir,
  };
}

/**
 * {@link anonymousExtractOptions} with the directory created and RESOLVED (the
 * Dockerfile containment check compares real paths — `/tmp` is a symlink on
 * some hosts).
 */
export async function preparedAnonymousExtract(): Promise<Required<ParseZipOptions>> {
  const opts = anonymousExtractOptions();
  await fs.mkdir(opts.extractRoot, { recursive: true });
  return { ...opts, extractRoot: await fs.realpath(opts.extractRoot) };
}

let extractsInFlight = 0;

/**
 * Run `fn` holding one of the replica's anonymous-extraction slots — the
 * directory's quota: with at most `maxConcurrentExtracts` packages expanding at
 * once, `extractDir` never holds more than that many byte caps. A full house
 * answers 503 at once rather than queueing anonymous work.
 */
export async function withExtractSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (extractsInFlight >= submissionConfig().maxConcurrentExtracts) {
    throw new EcosystemError(ErrorCode.SERVICE_UNAVAILABLE, 'Submissions are busy; try again shortly.');
  }
  extractsInFlight++;
  try {
    return await fn();
  } finally {
    extractsInFlight--;
  }
}

/** What a flag-on instance is missing (empty = nothing). Every item fails the path closed. */
export function missingConfiguration(cfg: SubmissionConfig = submissionConfig()): string[] {
  const missing: string[] = [];
  if (!cfg.powSecret) missing.push('SUBMISSION_POW_SECRET');
  if (!cfg.emailHashSecret) missing.push('SUBMISSION_EMAIL_HASH_SECRET');
  if (!cfg.quarantineBuildkitAddr) missing.push('PLUGIN_QUARANTINE_BUILDKIT_ADDR');
  return missing;
}

let warnedMissing = false;

/**
 * Whether the anonymous path is served right now: the flag, every secret, and
 * outbound email (cached 60 s, fail closed).
 */
export async function submissionsAvailable(): Promise<boolean> {
  if (!isAnonymousSubmissionsEnabled()) return false;
  const missing = missingConfiguration();
  if (missing.length > 0) {
    if (!warnedMissing) {
      warnedMissing = true;
      logger.warn('ANONYMOUS_SUBMISSIONS_ENABLED is on but the path is not configured; serving 404', { missing });
    }
    return false;
  }
  return isOutboundEmailEnabled();
}

/** Refuse (404 `SUBMISSIONS_DISABLED`) when the path is unavailable. */
export async function assertSubmissionsAvailable(): Promise<void> {
  if (!await submissionsAvailable()) throw new EcosystemError(ErrorCode.SUBMISSIONS_DISABLED, 'Not found');
}

/** The frontend origin email links point at. */
export function frontendBaseUrl(): string {
  return envStr('PLATFORM_FRONTEND_URL', envStr('PLATFORM_BASE_URL', 'https://localhost:8443')).replace(/\/+$/, '');
}

export const verifyUrl = (token: string) => `${frontendBaseUrl()}/plugins/submit/verify?token=${encodeURIComponent(token)}`;
export const statusUrl = (token: string) => `${frontendBaseUrl()}/plugins/submit/status?token=${encodeURIComponent(token)}`;
export const listingUrl = (name: string) => `${frontendBaseUrl()}/plugins/${COMMUNITY_PUBLISHER_HANDLE}/${encodeURIComponent(name)}`;

