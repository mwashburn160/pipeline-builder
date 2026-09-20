// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The FIDO Metadata Service (MDS3) as platform uses it — only for orgs that set
 * an authenticator (AAGUID) allowlist.
 *
 * WHAT IT PROVIDES
 *   - Provenance: SimpleWebAuthn's `MetadataService` is seeded with the blob's
 *     metadata statements, so a DIRECT attestation from a known model is
 *     verified against that model's own attestation roots during
 *     `verifyRegistrationResponse` (packed, TPM, Android key/SafetyNet).
 *   - Status: an AAGUID whose status reports say its keys or user verification
 *     were COMPROMISED is refused, whatever the allowlist says.
 *   - Friendly names (`description`) for the admin's allowlist editor.
 *
 * SOURCES (see `config.auth.webauthn.mds`). `FIDO_MDS_BLOB_PATH` — a blob JWT
 * downloaded out of band — wins; otherwise it is fetched from `FIDO_MDS_URL`
 * (bounded by a timeout). Either way `verifyMDSBlob` checks the blob's
 * signature chain against the FIDO root BEFORE any statement is trusted, so a
 * tampered file or a hijacked download is refused, not believed.
 *
 * CACHING. Loaded lazily (the first allowlisted registration or admin read) and
 * kept in memory for `refreshMs`. A failed refresh KEEPS the previous snapshot —
 * stale metadata is still signed metadata, and dropping it would refuse every
 * allowlisted registration until the next success. With no snapshot at all the
 * service reports unavailable and allowlisted registrations are refused (the
 * policy asked for provenance we can't check — fail closed).
 */

import { readFile } from 'fs/promises';
import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { MetadataService, type MetadataStatement } from '@simplewebauthn/server';
import { verifyMDSBlob } from '@simplewebauthn/server/helpers';
import { config } from '../config/index.js';
import { incCounter } from '../observability/metrics.js';

const logger = createLogger('fido-mds');

/** Statuses that make an authenticator model untrustworthy outright. */
const COMPROMISED_STATUSES: ReadonlySet<string> = new Set([
  'USER_VERIFICATION_BYPASS',
  'ATTESTATION_KEY_COMPROMISE',
  'USER_KEY_REMOTE_COMPROMISE',
  'USER_KEY_PHYSICAL_COMPROMISE',
  'REVOKED',
]);

/** What platform keeps per authenticator model. */
export interface MdsModel {
  aaguid: string;
  /** Human name from the metadata statement ("YubiKey 5 Series"). */
  description: string;
  /** A status report says the model's keys / user verification were compromised. */
  compromised: boolean;
}

interface MdsSnapshot {
  models: Map<string, MdsModel>;
  loadedAt: number;
  source: 'file' | 'url';
}

let snapshot: MdsSnapshot | null = null;
let inflight: Promise<MdsSnapshot | null> | null = null;
/** When the last load FAILED — loads are not retried for {@link RETRY_AFTER_FAILURE_MS}
 *  after one, so an unreachable MDS costs one timeout per window, not one per request. */
let lastFailureAt = 0;
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;

/** Read the raw blob JWT from the configured source. */
async function readBlob(): Promise<{ blob: string; source: MdsSnapshot['source'] } | null> {
  const mds = config.auth.webauthn.mds;
  if (mds.blobPath) return { blob: (await readFile(mds.blobPath, 'utf8')).trim(), source: 'file' };
  if (mds.url) {
    const res = await fetch(mds.url, { signal: AbortSignal.timeout(mds.fetchTimeoutMs) });
    if (!res.ok) throw new Error(`MDS answered ${res.status}`);
    return { blob: (await res.text()).trim(), source: 'url' };
  }
  return null;
}

/** Turn verified blob entries into the model map + the statements to seed. */
export function modelsFromEntries(entries: ReadonlyArray<{
  aaguid?: string;
  metadataStatement?: MetadataStatement;
  statusReports?: ReadonlyArray<{ status: string }>;
}>): { models: Map<string, MdsModel>; statements: MetadataStatement[] } {
  const models = new Map<string, MdsModel>();
  const statements: MetadataStatement[] = [];
  for (const entry of entries) {
    if (!entry.aaguid || !entry.metadataStatement) continue;
    const aaguid = entry.aaguid.toLowerCase();
    statements.push(entry.metadataStatement);
    models.set(aaguid, {
      aaguid,
      description: entry.metadataStatement.description || aaguid,
      compromised: (entry.statusReports ?? []).some((r) => COMPROMISED_STATUSES.has(r.status)),
    });
  }
  return { models, statements };
}

async function load(): Promise<MdsSnapshot | null> {
  try {
    const read = await readBlob();
    if (!read) return snapshot;
    const { payload } = await verifyMDSBlob(read.blob);
    const { models, statements } = modelsFromEntries(payload.entries);
    // Seed the library so DIRECT attestations from these models verify against
    // their own roots. `permissive`: an unknown AAGUID yields no statement
    // rather than a throw — platform refuses that case itself, with a clearer
    // error, and only for orgs that asked for the check.
    await MetadataService.initialize({ mdsServers: [], statements, verificationMode: 'permissive' });
    snapshot = { models, loadedAt: Date.now(), source: read.source };
    incCounter('platform_fido_mds_loads_total', { outcome: 'success', source: read.source });
    logger.info('FIDO metadata loaded', { models: models.size, source: read.source, blobNo: payload.no });
  } catch (err) {
    lastFailureAt = Date.now();
    incCounter('platform_fido_mds_loads_total', { outcome: 'failure', source: config.auth.webauthn.mds.blobPath ? 'file' : 'url' });
    logger.warn('FIDO metadata load failed; keeping the previous snapshot if any', {
      error: errorMessage(err),
      hasPrevious: snapshot !== null,
    });
  }
  return snapshot;
}

/**
 * The current metadata, loading or refreshing it when absent or older than
 * `refreshMs`. Null when no metadata has ever been loaded (unconfigured, or
 * every attempt failed). Concurrent callers share one load.
 */
export async function ensureMds(): Promise<MdsSnapshot | null> {
  const fresh = snapshot && Date.now() - snapshot.loadedAt < config.auth.webauthn.mds.refreshMs;
  if (fresh) return snapshot;
  if (Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) return snapshot;
  if (!inflight) inflight = load().finally(() => { inflight = null; });
  return inflight;
}

/** One model's metadata; `undefined` when MDS does not know it, `null` when MDS is unavailable. */
export async function lookupModel(aaguid: string): Promise<MdsModel | undefined | null> {
  const mds = await ensureMds();
  if (!mds) return null;
  return mds.models.get(aaguid.toLowerCase());
}

/** Every known model, by name — the allowlist editor's catalog. Null when unavailable. */
export async function listModels(): Promise<MdsModel[] | null> {
  const mds = await ensureMds();
  if (!mds) return null;
  return [...mds.models.values()].sort((a, b) => a.description.localeCompare(b.description));
}

/** Test hook: install (or clear) a snapshot without a blob. */
export function _setMdsModelsForTests(models: MdsModel[] | null): void {
  snapshot = models
    ? { models: new Map(models.map((m) => [m.aaguid.toLowerCase(), m])), loadedAt: Date.now(), source: 'file' }
    : null;
  inflight = null;
  lastFailureAt = 0;
}
