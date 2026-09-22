// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Anonymous public plugin submissions (docs/plugin-publishing.md):
 * the not-logged-in path into the `community` publisher. Identity-light, not
 * identity-free:
 *
 *  - OFF unless `ANONYMOUS_SUBMISSIONS_ENABLED` AND outbound email is
 *    configured (the magic link is the only verification) AND every secret the
 *    path needs is set — anything missing answers 404, fail closed;
 *  - a self-hosted proof-of-work on every write, single use via Redis;
 *  - a verified email (magic link: single use, 30 minutes, bound to the
 *    submission), stored only as an HMAC (rate limits, claim matching) and an
 *    encrypted copy (N1/N3/N4 and takedown notices), both purged 90 days after
 *    a decision — no API ever returns it and audit never carries it;
 *  - 3 submissions per rolling 24 h per email and per client IP;
 *  - QUARANTINE: the zip goes to its own bucket, the build to the isolated
 *    quarantine buildkitd and `quarantine/<id>` — never a `plugins` row, never
 *    a tenant or `public/*` namespace before two-person moderation.
 *
 * The submitter's only handles are two random tokens: the magic-link VERIFY
 * token (stored as sha256) and a STATUS token derived from the submission id
 * with a server secret (stored as sha256, so the status route looks it up;
 * derived, so every later email can carry the same link).
 *
 * This module: configuration, availability, the tokens, proof-of-work, the
 * name gate, and the create / verify / status / inspect operations. The
 * gate pipeline is submission-pipeline.ts; moderation is submission-moderation.ts.
 */

import { randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import path from 'path';

import {
  ANONYMOUS_ACTOR_ID,
  blockingHeuristics,
  BUILTIN_RESERVED_HANDLES,
  createLogger,
  detectCatalogMetadata,
  ErrorCode,
  errorMessage,
  findConfusableName,
  lintPluginDockerfile,
  lintPluginSpec,
  parseCatalogEditsPart,
  PLUGIN_CATALOG_FIELDS,
  resolveCatalogMetadata,
  scanPluginSourceHeuristics,
  SYSTEM_ACTOR_ID,
  type DetectedField,
  type HeuristicFinding,
  type PluginLintFinding,
} from '@pipeline-builder/api-core';
import {
  COMMUNITY_PUBLISHER_HANDLE,
  type PluginListing,
  type PluginSubmission,
  type Publisher,
  type SubmissionCatalog,
  type SubmissionStatus,
} from '@pipeline-builder/pipeline-data';

import { ecosystemAudit } from './audit.js';
import { EcosystemError } from './context.js';
import { recordSubmission } from './metrics.js';
import { notifySubmissionReceived } from './notify.js';
import type { Gate } from './policy.js';
import { deleteQuarantineImage } from './registry.js';
import { listings, publishers, reservedNames, versions } from './store.js';
import {
  SUBMISSIONS_PER_DAY,
  INSPECTS_PER_DAY,
  VERIFY_TOKEN_TTL_MS,
  SUBMISSION_TTL_DAYS,
  SWEEP_BATCH,
  preparedAnonymousExtract,
  verifyUrl,
  statusUrl,
  withExtractSlot,
} from './submission-config.js';
import {
  normalizeEmail,
  hashEmail,
  hashClientIp,
  statusTokenFor,
  tokenHash,
  consumeProofOfWork,
  consumeDailyCaps,
  encryptEmail,
} from './submission-guards.js';
import { closeSubmissionRequest } from './submission-moderation.js';
import { listingOwnerHash, submissions, topInstalledListings, trustedListingsNamed } from './submissions-store.js';
import { DEFAULT_PLUGIN_VERSION } from '../../helpers/default-version.js';
import { readPackageFiles } from '../../helpers/package-files.js';
import type { ParsedPlugin } from '../../helpers/plugin-spec.js';
import { deletePluginArtifact, pluginQuarantineBucket, putPluginArtifact, submissionArtifactKey } from '../plugin-artifact-storage.js';
import { DAY_MS, emailPurgeAt, isActiveListing } from './util.js';

const logger = createLogger('ecosystem-submissions');

// -----------------------------------------------------------------------------
// The name gate
// -----------------------------------------------------------------------------

/** The platform-owned publisher submissions land under (seeded by postgres-init.sql). */
export async function communityPublisher(): Promise<Publisher> {
  const p = await publishers.byHandle(COMMUNITY_PUBLISHER_HANDLE);
  if (!p) throw new EcosystemError(ErrorCode.SERVICE_UNAVAILABLE, 'The community publisher is missing; anonymous submissions are unavailable.');
  return p;
}

export type NameRefusal = 'reserved' | 'trusted_listing' | 'taken' | 'confusable';

export interface NameGateResult extends Gate {
  reason?: NameRefusal;
  /** The existing community listing an update lands on (same owner). */
  listing: PluginListing | null;
}

/**
 * May a submission from `emailHash` use `community/<name>`? Refused when the
 * name is reserved, an Official/Verified publisher lists it, another
 * submitter's community listing has it, or it is confusable with one of the
 * top listings (the same community listing excepted when the same email owns it).
 */
export async function submissionNameGate(name: string, emailHash: string | null): Promise<NameGateResult> {
  const community = await communityPublisher();
  const fail = (reason: NameRefusal, message: string): NameGateResult => ({ id: 'name', ok: false, message, reason, listing: null });

  if (BUILTIN_RESERVED_HANDLES.includes(name)) return fail('reserved', `The name "${name}" is reserved.`);
  const reserved = await reservedNames.get(name);
  if (reserved && reserved.publisherId !== community.id) return fail('reserved', `The name "${name}" is reserved.`);
  if ((await trustedListingsNamed(name)).length > 0) return fail('trusted_listing', `"${name}" is the name of an Official or Verified plugin.`);

  const existing = await listings.byName(community.id, name);
  if (existing) {
    const owner = await listingOwnerHash(existing.id);
    if (!owner || !emailHash || owner !== emailHash) {
      return fail('taken', `community/${name} belongs to another submitter; choose another name.`);
    }
    if (!isActiveListing(existing)) return fail('taken', `community/${name} is ${existing.state}.`);
  }

  const top = (await topInstalledListings()).filter((l) => !(existing && l.id === existing.id));
  const confusable = findConfusableName(name, top.map((l) => l.name));
  if (confusable) return fail('confusable', `"${name}" is too similar to the popular plugin "${confusable}".`);

  return { id: 'name', ok: true, message: existing ? `A new version of community/${name}` : `community/${name} is available`, listing: existing };
}

/** Throw the name refusal as 409 `NAME_TAKEN`. */
function assertName(gate: NameGateResult): void {
  if (!gate.ok) throw new EcosystemError(ErrorCode.NAME_TAKEN, gate.message, { reason: gate.reason });
}

// -----------------------------------------------------------------------------
// Parsing a submitted package
// -----------------------------------------------------------------------------

/** The package problems that refuse a submission outright (400), before anything is stored. */
function packageShapeProblem(plugin: ParsedPlugin): string | null {
  if (plugin.buildType !== 'build_image') return 'Anonymous submissions must be built by the platform from a Dockerfile (buildType build_image).';
  if (plugin.pluginSpec.pluginType === 'ManualApprovalStep') return 'Manual approval steps can\'t be submitted anonymously.';
  if (!plugin.dockerfileContent) return 'The package has no Dockerfile.';
  return null;
}

/** Parse + validate a submitted zip (400 on any spec problem). The caller removes `extractDir`. */
async function parseSubmittedZip(zipPath: string): Promise<ParsedPlugin> {
  // Lazy: the spec parser pulls in the build tooling, which the moderation and
  // request graphs that import this module never need.
  const spec: typeof import('../../helpers/plugin-spec.js') = await import('../../helpers/plugin-spec.js');
  let plugin: ParsedPlugin;
  try {
    plugin = await spec.parsePluginZip(zipPath, await preparedAnonymousExtract());
    spec.validateBuildArgs(plugin.pluginSpec.buildArgs);
  } catch (err) {
    throw new EcosystemError(ErrorCode.VALIDATION_ERROR, errorMessage(err));
  }
  const problem = packageShapeProblem(plugin);
  if (problem) {
    await fs.rm(plugin.extractDir, { recursive: true, force: true }).catch(() => undefined);
    throw new EcosystemError(ErrorCode.VALIDATION_ERROR, problem);
  }
  return plugin;
}

/** The raw spec text (for the text-level lint rules); empty when the spec lives elsewhere. */
export async function specText(extractDir: string): Promise<string> {
  return fs.readFile(path.join(extractDir, 'plugin-spec.yaml'), 'utf-8').catch(() => '');
}

/** The lint findings the gate and the inspect preview report (errors fail the gate). */
export async function lintPackage(plugin: Pick<ParsedPlugin, 'pluginSpec' | 'dockerfileContent' | 'extractDir'>): Promise<PluginLintFinding[]> {
  return [
    ...lintPluginSpec(plugin.pluginSpec as unknown as Record<string, unknown>, await specText(plugin.extractDir)),
    ...(plugin.dockerfileContent ? lintPluginDockerfile(plugin.dockerfileContent) : []),
  ];
}

// -----------------------------------------------------------------------------
// Operations
// -----------------------------------------------------------------------------

/** Everything the inspect preview shows (nothing is stored). */
export interface InspectResult {
  plugin: { name: string; version: string; pluginType: string; buildType: string; smokeTest: boolean };
  fields: DetectedField[];
  lint: PluginLintFinding[];
  heuristics: { blocking: number; findings: Array<Omit<HeuristicFinding, 'excerpt'>> };
  name: Gate;
}

/**
 * POST /inspect — the dry-run detection a submission form shows before
 * the real submit: the spec summary, the detected catalog fields, the lint
 * findings, a heuristics preview (no excerpts) and the name check. Consumes a
 * proof-of-work; stores nothing.
 */
export async function inspectSubmission(zipPath: string, pow: unknown, clientIp: string): Promise<InspectResult> {
  await consumeProofOfWork(pow);
  await consumeDailyCaps([`inspect:ip:${hashClientIp(clientIp || 'unknown')}`], INSPECTS_PER_DAY, 'inspections');
  return withExtractSlot(() => inspectPackage(zipPath));
}

async function inspectPackage(zipPath: string): Promise<InspectResult> {
  const plugin = await parseSubmittedZip(zipPath);
  try {
    const report = scanPluginSourceHeuristics(await readPackageFiles(plugin.extractDir));
    const name = await submissionNameGate(plugin.pluginSpec.name, null);
    return {
      plugin: {
        name: plugin.pluginSpec.name,
        version: plugin.pluginSpec.version ?? '',
        pluginType: plugin.pluginSpec.pluginType ?? 'CodeBuildStep',
        buildType: plugin.buildType,
        smokeTest: typeof plugin.pluginSpec.smokeTest === 'string' && plugin.pluginSpec.smokeTest.trim() !== '',
      },
      fields: detectCatalogMetadata({ spec: plugin.pluginSpec, readmeMd: plugin.readmeMd, dockerfileContent: plugin.dockerfileContent }),
      lint: await lintPackage(plugin),
      heuristics: {
        blocking: blockingHeuristics(report).length,
        findings: report.findings.map(({ excerpt: _excerpt, ...f }) => f),
      },
      // The owner check needs the verified email, which inspect never sees: an
      // existing community listing reads as "taken" here and is re-judged at submit.
      name: { id: name.id, ok: name.ok, message: name.message },
    };
  } finally {
    await fs.rm(plugin.extractDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The first metadata field a catalog-edit error names (`Invalid metadata: summary: …`), else `metadata`. */
function metadataFieldOf(error: string): string {
  const m = /^Invalid metadata: ([a-zA-Z]+)\b/.exec(error);
  return m && (PLUGIN_CATALOG_FIELDS as readonly string[]).includes(m[1]!) ? m[1]! : 'metadata';
}

export interface CreateSubmissionInput {
  zipPath: string;
  email: unknown;
  pow: unknown;
  metadata: unknown;
  acceptTerms: unknown;
  clientIp: string;
}

/**
 * POST / — accept a submission into quarantine: PoW, terms, email, the daily
 * caps, the package, the name; then stage the zip in the quarantine bucket and
 * send the magic link (N1). Status `pending_verification`.
 */
export async function createSubmission(input: CreateSubmissionInput): Promise<{ id: string; status: SubmissionStatus }> {
  await consumeProofOfWork(input.pow);
  if (input.acceptTerms !== 'true' && input.acceptTerms !== true) {
    throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'Accept the submission terms (acceptTerms=true).', { field: 'acceptTerms' });
  }
  const email = normalizeEmail(input.email);
  if (!email) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'A valid email address is required.', { field: 'email' });
  const edits = parseCatalogEditsPart(typeof input.metadata === 'string' ? input.metadata : undefined);
  if (!edits.ok) {
    throw new EcosystemError(ErrorCode.VALIDATION_ERROR, edits.error, {
      field: edits.contractKeys?.[0] ?? metadataFieldOf(edits.error),
      ...(edits.contractKeys ? { contractKeys: edits.contractKeys } : {}),
    });
  }

  const emailHash = hashEmail(email);
  const ipHash = hashClientIp(input.clientIp || 'unknown');
  // Counted before the package is even opened: a refused attempt (a zip bomb, a
  // bad spec) still spends its slot, so the caps bound the parsing work too.
  await consumeDailyCaps([`submit:email:${emailHash}`, `submit:ip:${ipHash}`], SUBMISSIONS_PER_DAY, 'submissions');
  return withExtractSlot(() => stageSubmission(input, email, emailHash, ipHash, edits.value));
}

async function stageSubmission(
  input: CreateSubmissionInput, email: string, emailHash: string, ipHash: string,
  editValues: Parameters<typeof resolveCatalogMetadata>[1],
): Promise<{ id: string; status: SubmissionStatus }> {
  const plugin = await parseSubmittedZip(input.zipPath);
  let id: string;
  let name: string;
  let version: string;
  try {
    const spec = plugin.pluginSpec;
    name = spec.name;
    version = spec.version ?? DEFAULT_PLUGIN_VERSION;
    const gate = await submissionNameGate(name, emailHash);
    assertName(gate);
    if (gate.listing && await versions.get(gate.listing.id, version)) {
      throw new EcosystemError(ErrorCode.CONFLICT, `community/${name} ${version} is already published; bump the version.`);
    }
    const resolved = resolveCatalogMetadata(detectCatalogMetadata({ spec, readmeMd: plugin.readmeMd, dockerfileContent: plugin.dockerfileContent }), editValues);
    const catalog: SubmissionCatalog = { values: resolved.values as Record<string, unknown>, sources: resolved.sources as Record<string, string> };

    id = randomUUID();
    const verifyToken = randomBytes(32).toString('base64url');
    const statusToken = statusTokenFor(id);
    const now = Date.now();
    await submissions.insert({
      id,
      status: 'pending_verification',
      emailHash,
      emailEnc: await encryptEmail(email),
      verifyTokenHash: tokenHash(verifyToken),
      verifyExpiresAt: new Date(now + VERIFY_TOKEN_TTL_MS),
      statusTokenHash: tokenHash(statusToken),
      name,
      version,
      spec: spec as unknown as Record<string, unknown>,
      catalog,
      dockerfile: plugin.dockerfileContent,
      artifactKey: submissionArtifactKey(id),
      clientIpHash: ipHash,
      expiresAt: new Date(now + SUBMISSION_TTL_DAYS * DAY_MS),
    });
    try {
      await putPluginArtifact(submissionArtifactKey(id), await fs.readFile(input.zipPath), pluginQuarantineBucket());
    } catch (err) {
      await submissions.remove(id);
      logger.error('Quarantine staging failed; submission dropped', { submissionId: id, error: errorMessage(err) });
      throw new EcosystemError(ErrorCode.SERVICE_UNAVAILABLE, 'Storage is temporarily unavailable; try again shortly.');
    }
    await notifySubmissionReceived({ email, name, version, verifyUrl: verifyUrl(verifyToken), statusUrl: statusUrl(statusToken) });
  } finally {
    await fs.rm(plugin.extractDir, { recursive: true, force: true }).catch(() => undefined);
  }

  ecosystemAudit({ action: 'plugin.submission.create', actor: ANONYMOUS_ACTOR_ID, targetType: 'plugin-submission', targetId: id, details: { submissionId: id, name, version } });
  recordSubmission('pending_verification');
  return { id, status: 'pending_verification' };
}

/** Enqueue the quarantine gate run (submission-pipeline.ts). Overridable in tests. */
let enqueueGates: (submissionId: string) => Promise<void> = async (submissionId) => {
  const { enqueueSubmissionBuild } = await import('../../queue/submission-build-queue.js');
  await enqueueSubmissionBuild(submissionId);
};

/** Test hook: replace the gate-run enqueue. */
export function setSubmissionEnqueueForTests(fn: typeof enqueueGates): void {
  enqueueGates = fn;
}

/** Whether `token` could be one of ours (a string of a plausible length) before it is hashed and looked up. */
const isTokenShaped = (token: unknown): token is string => typeof token === 'string' && token.length >= 16 && token.length <= 256;

/**
 * POST /verify — the magic link. Single use (the token hash is cleared in the
 * same guarded transition), 30-minute expiry, bound to one submission. Moves
 * it to `pending_review` and enqueues the quarantine gates. Returns the status
 * token — the only response that ever carries it.
 */
export async function verifySubmission(token: unknown): Promise<{ id: string; status: SubmissionStatus; statusToken: string }> {
  if (!isTokenShaped(token)) {
    throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'token is required', { field: 'token' });
  }
  const hash = tokenHash(token);
  const s = await submissions.byVerifyTokenHash(hash);
  if (!s || s.status !== 'pending_verification') throw new EcosystemError(ErrorCode.NOT_FOUND, 'This link is invalid or was already used.');
  if (!s.verifyExpiresAt || new Date(s.verifyExpiresAt).getTime() < Date.now()) {
    throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'This link has expired; submit the plugin again.', { reason: 'expired' });
  }
  const verified = await submissions.transition(s.id, 'pending_verification', {
    status: 'pending_review', verifiedAt: new Date(), verifyTokenHash: null, verifyExpiresAt: null,
  });
  if (!verified) throw new EcosystemError(ErrorCode.NOT_FOUND, 'This link is invalid or was already used.');
  try {
    await enqueueGates(s.id);
  } catch (err) {
    // Hand the link back so the submitter can retry once the queue is up.
    await submissions.transition(s.id, 'pending_review', { status: 'pending_verification', verifiedAt: null, verifyTokenHash: hash, verifyExpiresAt: s.verifyExpiresAt });
    logger.error('Submission gate run could not be queued', { submissionId: s.id, error: errorMessage(err) });
    throw new EcosystemError(ErrorCode.SERVICE_UNAVAILABLE, 'The checks could not be started; open the link again shortly.');
  }
  ecosystemAudit({ action: 'plugin.submission.verify', actor: ANONYMOUS_ACTOR_ID, targetType: 'plugin-submission', targetId: s.id, details: { submissionId: s.id, name: s.name, version: s.version } });
  recordSubmission('pending_review');
  return { id: s.id, status: 'pending_review', statusToken: statusTokenFor(s.id) };
}

/** The status view: never the email, never raw heuristics — gate id/ok/message only. */
export interface SubmissionStatusView {
  id: string;
  name: string;
  version: string;
  status: SubmissionStatus;
  submittedAt: string;
  reason?: string;
  gates?: Gate[];
  listing?: { publisher: string; name: string };
}

/** GET /status?token= — what the submitter may see about their submission. */
export async function submissionStatus(token: unknown): Promise<SubmissionStatusView> {
  if (!isTokenShaped(token)) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Not found');
  const s = await submissions.byStatusTokenHash(tokenHash(token));
  if (!s) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Not found');
  const gates = Array.isArray((s.gateReport as { gates?: unknown } | null)?.gates)
    ? ((s.gateReport as { gates: Gate[] }).gates).map((g) => ({ id: String(g.id), ok: g.ok === true, message: String(g.message) }))
    : undefined;
  const listing = s.listingId ? await listings.byId(s.listingId) : null;
  const publisher = listing ? await publishers.byId(listing.publisherId) : null;
  return {
    id: s.id,
    name: s.name,
    version: s.version,
    // `publishing` is a seconds-long internal claim; to the submitter it is still under review.
    status: s.status === 'publishing' ? 'pending_review' : s.status,
    submittedAt: new Date(s.createdAt).toISOString(),
    ...(s.reason && (s.status === 'rejected' || s.status === 'gate_failed') ? { reason: s.reason } : {}),
    ...(gates ? { gates } : {}),
    ...(listing && publisher ? { listing: { publisher: publisher.handle, name: listing.name } } : {}),
  };
}

// -----------------------------------------------------------------------------
// Maintenance: expiry and the email purge
// -----------------------------------------------------------------------------

/** Remove a submission's quarantine artifacts (zip + image). Best-effort; both stores sweep on their own too. */
export async function dropQuarantineArtifacts(s: Pick<PluginSubmission, 'id' | 'artifactKey' | 'quarantineImageRef'>): Promise<void> {
  if (s.artifactKey) await deletePluginArtifact(s.artifactKey, pluginQuarantineBucket());
  await deleteQuarantineImage(s.id).catch((err) => {
    logger.warn('Quarantine image delete failed (the registry sweep will collect it)', { submissionId: s.id, error: errorMessage(err) });
  });
}

/**
 * Undecided submissions past `expires_at` (30 days) → `expired`, their
 * artifacts deleted, audited as `plugin.submission.expire` (system).
 * `pending_review` ones sitting in the moderation queue expire too, and their
 * open request is closed so it can't be approved against deleted artifacts.
 */
export async function expireSubmissions(now: Date = new Date()): Promise<number> {
  let expired = 0;
  for (;;) {
    const due = await submissions.dueForExpiry(now, SWEEP_BATCH);
    let moved = 0;
    for (const s of due) {
      const done = await submissions.transition(s.id, s.status, {
        status: 'expired',
        decidedAt: now,
        verifyTokenHash: null,
        emailPurgeAfter: emailPurgeAt(now),
        reason: 'Expired before a decision',
      });
      if (!done) continue;
      moved++;
      expired++;
      await closeSubmissionRequest(s.id, 'expired').catch((err) => logger.warn('Closing an expired submission\'s request failed', { submissionId: s.id, error: errorMessage(err) }));
      await dropQuarantineArtifacts(s);
      ecosystemAudit({ action: 'plugin.submission.expire', actor: SYSTEM_ACTOR_ID, targetType: 'plugin-submission', targetId: s.id, details: { submissionId: s.id, name: s.name, version: s.version, from: s.status } });
      recordSubmission('expired');
    }
    // A short page is the last one; a page that moved nothing (every row raced
    // to another state) would re-read the same rows forever.
    if (due.length < SWEEP_BATCH || moved === 0) return expired;
  }
}

/**
 * Null both email columns of decided submissions past `email_purge_after` (90
 * days after the decision): batched SQL updates until none is left, so the
 * purge is complete however many rows are due.
 */
export async function purgeSubmitterEmails(now: Date = new Date()): Promise<number> {
  let purged = 0;
  for (;;) {
    const n = await submissions.purgeEmails(now, SWEEP_BATCH);
    purged += n;
    if (n < SWEEP_BATCH) return purged;
  }
}
