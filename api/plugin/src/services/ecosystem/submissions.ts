// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Anonymous public plugin submissions (docs/plans/plugin-ecosystem.md §4, W5):
 * the not-logged-in path into the `community` publisher. Identity-light, not
 * identity-free (D1):
 *
 *  - OFF unless `ANONYMOUS_SUBMISSIONS_ENABLED` AND outbound email is
 *    configured (the magic link is the only verification) AND every secret the
 *    path needs is set — anything missing answers 404, fail closed;
 *  - a self-hosted proof-of-work (E3) on every write, single use via Redis;
 *  - a verified email (magic link: single use, 30 minutes, bound to the
 *    submission), stored only as an HMAC (rate limits, claim matching) and an
 *    encrypted copy (N1/N3/N4 and takedown notices), both purged 90 days after
 *    a decision (E4) — no API ever returns it and audit never carries it;
 *  - 3 submissions per rolling 24 h per email and per client IP;
 *  - QUARANTINE: the zip goes to its own bucket, the build to the isolated
 *    quarantine buildkitd and `quarantine/<id>` — never a `plugins` row, never
 *    a tenant or `public/*` namespace before two-person moderation (E5).
 *
 * The submitter's only handles are two random tokens: the magic-link VERIFY
 * token (stored as sha256) and a STATUS token derived from the submission id
 * with a server secret (stored as sha256, so the status route looks it up;
 * derived, so every later email can carry the same link).
 *
 * This module: configuration, availability, the tokens, proof-of-work, the
 * name gate (E9), and the create / verify / status / inspect operations. The
 * gate pipeline is submission-pipeline.ts; moderation is submission-moderation.ts.
 */

import { createHash, createHmac, randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  ANONYMOUS_ACTOR_ID,
  blockingHeuristics,
  BUILTIN_RESERVED_HANDLES,
  createLogger,
  createProofOfWorkChallenge,
  decryptSecret,
  detectCatalogMetadata,
  encryptSecret,
  envInt,
  envStr,
  ErrorCode,
  errorMessage,
  findConfusableName,
  isAnonymousSubmissionsEnabled,
  isEncryptedBlob,
  lintPluginDockerfile,
  lintPluginSpec,
  parseCatalogEditsPart,
  PLUGIN_CATALOG_FIELDS,
  POW_DEFAULT_DIFFICULTY,
  POW_MAX_DIFFICULTY,
  resolveCatalogMetadata,
  scanPluginSourceHeuristics,
  SYSTEM_ACTOR_ID,
  SYSTEM_ORG_ID,
  verifyProofOfWork,
  type DetectedField,
  type HeuristicFinding,
  type PluginLintFinding,
  type ProofOfWorkChallenge,
} from '@pipeline-builder/api-core';
import {
  COMMUNITY_PUBLISHER_HANDLE,
  type PluginListing,
  type PluginSubmission,
  type Publisher,
  type SubmissionCatalog,
  type SubmissionStatus,
} from '@pipeline-builder/pipeline-data';

import { EcosystemError } from './context.js';
import { isOutboundEmailEnabled } from './email-status.js';
import { recordSubmission } from './metrics.js';
import { notifySubmissionReceived } from './notify.js';
import type { Gate } from './policy.js';
import { deleteQuarantineImage } from './registry.js';
import { listings, publishers, reservedNames, versions } from './store.js';
import { submissions, topInstalledListings, trustedListingsNamed } from './submissions-store.js';
import { readPackageFiles } from '../../helpers/package-files.js';
import type { ParsedPlugin, ParseZipOptions } from '../../helpers/plugin-spec.js';
import { emitPluginAudit } from '../audit.js';
import { deletePluginArtifact, pluginQuarantineBucket, putPluginArtifact, submissionArtifactKey } from '../plugin-artifact-storage.js';

const logger = createLogger('ecosystem-submissions');

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

/** Submissions per rolling 24 h, per verified email and per client IP (§4.2). */
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
/** The submitter's email (hash + ciphertext) is purged this long after a decision. */
export const EMAIL_RETENTION_DAYS = 90;

const DAY_MS = 24 * 3_600_000;
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
 * The extraction an ANONYMOUS package gets (E14): at most
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
async function withExtractSlot<T>(fn: () => Promise<T>): Promise<T> {
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

// -----------------------------------------------------------------------------
// Emails and tokens
// -----------------------------------------------------------------------------

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The canonical form of a submitter email, or null when it isn't one. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 320 && EMAIL_SHAPE.test(email) ? email : null;
}

/** HMAC of a normalized email (the only form rate limits and claim matching see). */
export function hashEmail(email: string, secret: string = submissionConfig().emailHashSecret): string {
  return createHmac('sha256', secret).update(`email:${email}`).digest('hex');
}

/** HMAC of the trusted client IP (the per-IP cap; the IP itself is never stored). */
export function hashClientIp(ip: string, secret: string = submissionConfig().emailHashSecret): string {
  return createHmac('sha256', secret).update(`ip:${ip}`).digest('hex');
}

const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** The status token of a submission: derived from its id with the server secret. */
export function statusTokenFor(submissionId: string, secret: string = submissionConfig().emailHashSecret): string {
  return createHmac('sha256', secret).update(`status-token:v1:${submissionId}`).digest('base64url');
}

/** A token as it is stored (sha256 hex). */
export const tokenHash = (token: string) => sha256Hex(token);

/** Encrypt the submitter's email for the transactional notices (system-org key). */
async function encryptEmail(email: string): Promise<string> {
  return JSON.stringify(await encryptSecret(email, SYSTEM_ORG_ID));
}

/** The submitter's email, or null when it was purged or can't be read. */
export async function submitterEmail(s: Pick<PluginSubmission, 'id' | 'emailEnc'>): Promise<string | null> {
  if (!s.emailEnc) return null;
  try {
    const blob: unknown = JSON.parse(s.emailEnc);
    return isEncryptedBlob(blob) ? await decryptSecret(blob, SYSTEM_ORG_ID) : null;
  } catch (err) {
    logger.warn('Submitter email unreadable', { submissionId: s.id, error: errorMessage(err) });
    return null;
  }
}

// -----------------------------------------------------------------------------
// Proof-of-work (E3)
// -----------------------------------------------------------------------------

/** Single-use bookkeeping for solved challenges. */
export interface PowReplayStore {
  /** True the FIRST time `key` is claimed within `ttlMs`; false on a replay. Throws when the store is down. */
  claim(key: string, ttlMs: number): Promise<boolean>;
}

const redisReplayStore: PowReplayStore = {
  async claim(key, ttlMs) {
    const { getHealthRedisConnection } = await import('../../queue/connections.js');
    const ok = await getHealthRedisConnection().set(`plugin-submission:pow:${key}`, '1', 'PX', Math.max(1_000, ttlMs), 'NX');
    return ok === 'OK';
  },
};

let replayStore: PowReplayStore = redisReplayStore;

/** Test hook: replace the replay store (pass nothing to restore Redis). */
export function setPowReplayStoreForTests(store?: PowReplayStore): void {
  replayStore = store ?? redisReplayStore;
}

// -----------------------------------------------------------------------------
// Daily caps (E16): one atomic counter per key, checked BEFORE any parsing
// -----------------------------------------------------------------------------

/** Rolling-window counters for the per-email / per-IP caps. */
export interface DailyCapStore {
  /** Increment `key` and return the new count; the window (`ttlMs`) starts at the first hit. Throws when the store is down. */
  incr(key: string, ttlMs: number): Promise<number>;
}

const INCR_WITH_WINDOW = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`;

const redisDailyCapStore: DailyCapStore = {
  async incr(key, ttlMs) {
    const { getHealthRedisConnection } = await import('../../queue/connections.js');
    return Number(await getHealthRedisConnection().eval(INCR_WITH_WINDOW, 1, `plugin-submission:cap:${key}`, String(ttlMs)));
  },
};

let dailyCaps: DailyCapStore = redisDailyCapStore;

/** Test hook: replace the daily-cap store (pass nothing to restore Redis). */
export function setDailyCapStoreForTests(store?: DailyCapStore): void {
  dailyCaps = store ?? redisDailyCapStore;
}

/**
 * Count one attempt against each key (in order) and refuse with 429
 * `SUBMISSION_LIMIT` once any passes `max` in its 24 h window. Atomic per key
 * (one INCR), so concurrent requests can't all read "2 of 3" and pass. A store
 * outage FAILS CLOSED (503): without the counter there is no cap.
 */
async function consumeDailyCaps(keys: string[], max: number, what: string): Promise<void> {
  for (const key of keys) {
    let n: number;
    try {
      n = await dailyCaps.incr(key, DAY_MS);
    } catch (err) {
      logger.warn('Submission cap store unavailable; refusing', { error: errorMessage(err) });
      throw new EcosystemError(ErrorCode.SERVICE_UNAVAILABLE, 'Submissions are temporarily unavailable; try again shortly.');
    }
    if (!Number.isFinite(n) || n > max) {
      throw new EcosystemError(ErrorCode.SUBMISSION_LIMIT, `At most ${max} ${what} a day; try again tomorrow.`);
    }
  }
}

/** GET /challenge — a fresh challenge at the configured difficulty. */
export function issueChallenge(): ProofOfWorkChallenge {
  const cfg = submissionConfig();
  return createProofOfWorkChallenge(cfg.powSecret, { difficulty: cfg.powDifficulty });
}

/**
 * Verify and CONSUME a proof-of-work answer: a JSON string (multipart field)
 * or an object `{ challenge, nonce }`. Refused: missing, malformed, forged,
 * expired, easier than configured, wrong, or already used. A replay store
 * outage fails closed (503).
 */
export async function consumeProofOfWork(raw: unknown): Promise<void> {
  let solution: unknown = raw;
  if (typeof raw === 'string') {
    try {
      solution = JSON.parse(raw);
    } catch {
      solution = null;
    }
  }
  if (!solution || typeof solution !== 'object') {
    throw new EcosystemError(ErrorCode.PROOF_OF_WORK_INVALID, 'A proof-of-work answer is required (GET /challenge, then solve it).');
  }
  const cfg = submissionConfig();
  const verdict = verifyProofOfWork(solution as { challenge?: string; nonce?: string }, cfg.powSecret, { minDifficulty: cfg.powDifficulty });
  if (!verdict.ok) {
    throw new EcosystemError(ErrorCode.PROOF_OF_WORK_INVALID, `The proof-of-work answer was refused (${verdict.reason}); request a new challenge.`, { reason: verdict.reason });
  }
  let first: boolean;
  try {
    first = await replayStore.claim(verdict.key, verdict.expiresAt - Date.now());
  } catch (err) {
    logger.warn('Proof-of-work replay store unavailable; refusing', { error: errorMessage(err) });
    throw new EcosystemError(ErrorCode.SERVICE_UNAVAILABLE, 'Submissions are temporarily unavailable; try again shortly.');
  }
  if (!first) throw new EcosystemError(ErrorCode.PROOF_OF_WORK_INVALID, 'That proof-of-work answer was already used; request a new challenge.', { reason: 'replayed' });
}

// -----------------------------------------------------------------------------
// The name gate (E9)
// -----------------------------------------------------------------------------

/** The platform-owned publisher submissions land under (seeded by postgres-init.sql). */
export async function communityPublisher(): Promise<Publisher> {
  const p = await publishers.byHandle(COMMUNITY_PUBLISHER_HANDLE);
  if (!p) throw new EcosystemError(ErrorCode.SERVICE_UNAVAILABLE, 'The community publisher is missing; anonymous submissions are unavailable.');
  return p;
}

/** Who owns a community listing: the email hash of its first approved submission (null once purged). */
async function listingOwnerHash(listing: PluginListing): Promise<string | null> {
  const approved = (await submissions.list({ listingId: listing.id, statuses: ['approved', 'claimed'] }))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return approved[0]?.emailHash ?? null;
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
    const owner = await listingOwnerHash(existing);
    if (!owner || !emailHash || owner !== emailHash) {
      return fail('taken', `community/${name} belongs to another submitter; choose another name.`);
    }
    if (!['listed', 'unmaintained'].includes(existing.state)) return fail('taken', `community/${name} is ${existing.state}.`);
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

function audit(action: Parameters<typeof emitPluginAudit>[0]['action'], submissionId: string, details: Record<string, unknown>, actor: string = ANONYMOUS_ACTOR_ID): void {
  emitPluginAudit({ action, actorId: actor, orgId: SYSTEM_ORG_ID, targetType: 'plugin-submission', targetId: submissionId, details: { submissionId, ...details } });
}

/** Everything the inspect preview shows (nothing is stored). */
export interface InspectResult {
  plugin: { name: string; version: string; pluginType: string; buildType: string; smokeTest: boolean };
  fields: DetectedField[];
  lint: PluginLintFinding[];
  heuristics: { blocking: number; findings: Array<Omit<HeuristicFinding, 'excerpt'>> };
  name: Gate;
}

/**
 * POST /inspect — the dry-run §3.1a detection a submission form shows before
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
    version = spec.version ?? '0.0.0';
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

  audit('plugin.submission.create', id, { name, version });
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

/**
 * POST /verify — the magic link. Single use (the token hash is cleared in the
 * same guarded transition), 30-minute expiry, bound to one submission. Moves
 * it to `pending_review` and enqueues the quarantine gates. Returns the status
 * token — the only response that ever carries it.
 */
export async function verifySubmission(token: unknown): Promise<{ id: string; status: SubmissionStatus; statusToken: string }> {
  if (typeof token !== 'string' || token.length < 16 || token.length > 256) {
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
  audit('plugin.submission.verify', s.id, { name: s.name, version: s.version });
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
  if (typeof token !== 'string' || token.length < 16 || token.length > 256) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Not found');
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
    // `publishing` is a seconds-long internal claim (E10); to the submitter it is still under review.
    status: s.status === 'publishing' ? 'pending_review' : s.status,
    submittedAt: new Date(s.createdAt).toISOString(),
    ...(s.reason && (s.status === 'rejected' || s.status === 'gate_failed') ? { reason: s.reason } : {}),
    ...(gates ? { gates } : {}),
    ...(listing && publisher ? { listing: { publisher: publisher.handle, name: listing.name } } : {}),
  };
}

// -----------------------------------------------------------------------------
// Maintenance (E4): expiry and the email purge
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
        emailPurgeAfter: new Date(now.getTime() + EMAIL_RETENTION_DAYS * DAY_MS),
        reason: 'Expired before a decision',
      });
      if (!done) continue;
      moved++;
      expired++;
      const { closeSubmissionRequest } = await import('./submission-moderation.js');
      await closeSubmissionRequest(s.id, 'expired').catch((err) => logger.warn('Closing an expired submission\'s request failed', { submissionId: s.id, error: errorMessage(err) }));
      await dropQuarantineArtifacts(s);
      audit('plugin.submission.expire', s.id, { name: s.name, version: s.version, from: s.status }, SYSTEM_ACTOR_ID);
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
