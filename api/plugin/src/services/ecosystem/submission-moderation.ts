// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Anonymous submissions in the moderation queue (docs/plugin-publishing.md
 * steps 5–7). A submission that passed every automated gate
 * becomes a `submission` publish request on the `community` publisher —
 * created ONLY here, by the gate pipeline, never by a route — and goes through
 * the same queue, SLA, two-person approval and separation-of-duties machinery
 * as every other request (decisions.ts):
 *
 *  - APPROVE (second approval) publishes the quarantined digest
 *    `quarantine/<id>` → `public/community/<name>` with a fresh `unverified`
 *    signature, creates or extends the community listing, and tells the
 * submitter (N4);
 *  - REJECT marks the submission rejected and tells the submitter why (N4);
 *  - a `claim` of a community listing, when approved and the claimer's
 *    verified email matches the one that submitted it, links those
 *    submissions to the claiming account (N5).
 *
 * The request pins the quarantined DIGEST: approval publishes exactly it
 * or fails closed.
 */

import {
  isoOrNull,
  ANONYMOUS_ACTOR_ID,
  ConflictError,
  createLogger,
  ErrorCode,
  errorMessage,
  SYSTEM_ACTOR_ID,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import { renderUntrustedMarkdown } from '@pipeline-builder/api-server/lib/markdown.js';
import type { PluginSpec } from '@pipeline-builder/pipeline-core';
import {
  COMMUNITY_PUBLISHER_HANDLE,
  type ListingVersionSpecSnapshot,
  type PluginListing,
  type PluginListingVersion,
  type PluginPublishRequest,
  type PluginSubmission,
  type Publisher,
} from '@pipeline-builder/pipeline-data';

import { ecosystemAudit } from './audit.js';
import { EcosystemError, type Caller } from './context.js';
import { announceNewVersion } from './install-notify.js';
import { LISTING_FIELDS, listingColumns, listingFieldValue, metadataRow } from './metadata.js';
import { recordSubmission } from './metrics.js';
import { notifySubmissionClaimed, notifySubmissionDecision, notifySubmissionQueued } from './notify.js';
import { contractDiff, type Gate } from './policy.js';
import { publishImage } from './registry.js';
import { trustFor } from './resign.js';
import { atomically, listings, OPEN_STATUSES, previousVersion, recomputeLatest, requests, versions } from './store.js';
import { listingUrl, statusUrl, submissionConfig } from './submission-config.js';
import { hashEmail, statusTokenFor, submitterEmail } from './submission-guards.js';
import { listingOwnerHash, submissions } from './submissions-store.js';
import { dropQuarantineArtifacts, submissionNameGate } from './submissions.js';
import { emailPurgeAt, isActiveListing } from './util.js';

const logger = createLogger('ecosystem-submission-moderation');


/** What the gate pipeline recorded about the quarantined build (`gate_report.facts`). */
export interface SubmissionFacts {
  imageRepository: string;
  digest: string;
  vulnCritical: number | null;
  vulnHigh: number | null;
  vulnMedium: number | null;
  vulnLow: number | null;
  /** Fixable subset (grype reports a fixed version). */
  vulnCriticalFixable: number | null;
  vulnHighFixable: number | null;
  scannedAt: string | null;
  runAsRoot: boolean | null;
}

/** The recorded gate report of a submission. */
export interface SubmissionGateReport {
  gates: Gate[];
  facts?: SubmissionFacts;
  completedAt: string;
}

export function gateReportOf(s: Pick<PluginSubmission, 'gateReport'>): SubmissionGateReport | null {
  const r = s.gateReport as SubmissionGateReport | null;
  return r && Array.isArray(r.gates) ? r : null;
}

const payloadOf = (r: PluginPublishRequest) => (r.payload ?? {}) as { submissionId?: string; name?: string; version?: string; newListing?: boolean };

/** The submission a `submission` request moderates. */
export async function submissionForRequest(r: PluginPublishRequest): Promise<PluginSubmission> {
  const id = payloadOf(r).submissionId;
  const s = typeof id === 'string' ? await submissions.byId(id) : null;
  if (!s) throw new EcosystemError(ErrorCode.NOT_FOUND, 'The submission no longer exists.');
  return s;
}

/**
 * Queue a gate-green submission for moderation: the `submission` request
 * (actor ANONYMOUS, no submitting org — nobody can have a conflict of
 * interest), audited as `plugin.request.submit`, N2 to the moderators.
 */
export async function insertSubmissionRequest(s: PluginSubmission, publisher: Publisher, listing: PluginListing | null, digest: string): Promise<PluginPublishRequest> {
  return requests.insert({
    publisherId: publisher.id,
    listingId: listing?.id ?? null,
    version: s.version,
    digest,
    kind: 'submission',
    submittedBy: ANONYMOUS_ACTOR_ID,
    submittedOrgId: null,
    payload: { submissionId: s.id, name: s.name, version: s.version, newListing: !listing },
  });
}

/** Announce a queued submission request (after the transaction that created it committed). */
export async function announceSubmissionRequest(s: PluginSubmission, r: PluginPublishRequest, listing: PluginListing | null, digest: string): Promise<void> {
  ecosystemAudit({ action: 'plugin.request.submit', actor: ANONYMOUS_ACTOR_ID, targetType: 'plugin-publish-request', targetId: r.id, details: { kind: 'submission', submissionId: s.id, version: s.version, digest } });
  await notifySubmissionQueued({ name: s.name, version: s.version, newListing: !listing });
}

/** Whether a submission already has its OPEN moderation request (the gate run's idempotency key). */
export async function hasOpenSubmissionRequest(submissionId: string): Promise<boolean> {
  return (await requests.list({ kinds: ['submission'], statuses: OPEN_STATUSES, submissionId, limit: 1 })).length > 0;
}

/** Close a submission's open request (the submission expired). */
export async function closeSubmissionRequest(submissionId: string, reason: string): Promise<void> {
  const open = await requests.list({ kinds: ['submission'], statuses: OPEN_STATUSES, submissionId });
  for (const r of open) {
    await requests.transition(r.id, r.status, { status: 'rejected', reason, decidedBy: SYSTEM_ACTOR_ID, decidedAt: new Date() });
  }
}

/**
 * The frozen per-version record of a submission (the shape policy.specSnapshot
 * produces for an org plugin row), built from the submitted spec, its accepted
 * catalog values and the quarantine facts — there is no `plugins` row.
 */
export async function submissionSnapshot(s: PluginSubmission, facts: SubmissionFacts): Promise<ListingVersionSpecSnapshot> {
  // Lazy: the spec helpers pull in the build tooling, which the decision path otherwise never loads.
  const { specContractFields } = await import('../../helpers/plugin-spec.js');
  const spec = s.spec as unknown as PluginSpec;
  const v = (s.catalog?.values ?? {}) as Record<string, unknown>;
  const str = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null);
  const readme = str(v.readme);
  return {
    pluginType: spec.pluginType ?? 'CodeBuildStep',
    computeType: spec.computeType ?? 'SMALL',
    secrets: spec.secrets ?? [],
    ...specContractFields(spec),
    runAsRoot: facts.runAsRoot ?? undefined,
    license: str(v.license) ?? undefined,
    readmeHtml: readme ? renderUntrustedMarkdown(readme) : undefined,
    imageSource: 'built',
    buildType: 'build_image',
    metadata: spec.metadata ?? {},
    env: spec.env ?? {},
    installCommands: spec.installCommands ?? [],
    commands: spec.commands ?? [],
    timeout: spec.timeout ?? null,
    failureBehavior: spec.failureBehavior ?? 'fail',
    primaryOutputDirectory: spec.primaryOutputDirectory ?? null,
    dockerfile: s.dockerfile,
    description: str(v.description),
    summary: str(v.summary),
    displayName: str(v.displayName),
    keywords: Array.isArray(v.keywords) ? v.keywords : [],
    category: str(v.category) ?? 'unknown',
    homepageUrl: str(v.homepageUrl),
    sourceUrl: str(v.sourceUrl),
    documentationUrl: str(v.documentationUrl),
    icon: v.icon ?? null,
    changelog: str(v.changelog),
  };
}

/**
 * Execute an approved `submission` request (decisions.execute): publish the
 * pinned quarantined digest into `public/community/<name>`, record the listing
 * version, mark the submission approved (N4). Fails closed on any mismatch.
 *
 * Order: every check (the name gate re-run NOW), then CLAIM the
 * submission `pending_review → publishing` (an expiry can no longer take
 * it or delete its artifacts), then the image copy (idempotent), then every
 * database write in ONE transaction (listing, version, latest pointer,
 * request link, `publishing → approved`). Any failure hands the claim back.
 */
export async function publishSubmission(r: PluginPublishRequest, publisher: Publisher, actor: string): Promise<void> {
  if (publisher.handle !== COMMUNITY_PUBLISHER_HANDLE) throw new ConflictError('Submission requests belong to the community publisher.');
  const s = await submissionForRequest(r);
  if (s.status !== 'pending_review') throw new ConflictError(`The submission is ${s.status}.`);
  const report = gateReportOf(s);
  const facts = report?.facts;
  if (!report || !facts || report.gates.some((g) => !g.ok)) throw new ConflictError('The submission has no passing gate report.');
  if (!r.digest || facts.digest !== r.digest || s.version !== r.version) {
    throw new ConflictError('The quarantined build no longer matches the digest the request pinned.', ErrorCode.PLUGIN_DIGEST_MISMATCH);
  }

  // the name is judged again at approval — a reservation, an Official or
  // Verified listing, or a confusable top listing may have appeared since the
  // gates ran.
  const gate = await submissionNameGate(s.name, s.emailHash);
  if (!gate.ok) throw new ConflictError(`The name no longer passes: ${gate.message}`, ErrorCode.NAME_TAKEN);

  let listing = r.listingId ? await listings.byId(r.listingId) : await listings.byName(publisher.id, s.name);
  if (listing) {
    if (!isActiveListing(listing) || listing.publisherId !== publisher.id) {
      throw new ConflictError(`community/${s.name} is not live under the community publisher.`);
    }
    // No recorded owner (purged, or never approved) is NOT "anyone may extend it".
    const owner = await listingOwnerHash(listing.id);
    const empty = (await versions.countForListing(listing.id)) === 0;
    if (!empty && (!owner || owner !== s.emailHash)) throw new ConflictError(`community/${s.name} belongs to another submitter.`);
    if (await versions.get(listing.id, s.version)) throw new ConflictError(`${s.version} is already published to community/${s.name}.`);
  }

  const claimed = await submissions.transition(s.id, 'pending_review', { status: 'publishing' });
  if (!claimed) throw new ConflictError('The submission changed state meanwhile (expired or decided); nothing was published.');

  let version: PluginListingVersion;
  let updated: PluginListing | null;
  let target: PluginListing;
  const existed = listing !== null && (await versions.countForListing(listing.id)) > 0;
  try {
    const published = await publishImage({
      sourceRepository: facts.imageRepository,
      digest: facts.digest,
      publisherHandle: publisher.handle,
      name: s.name,
      version: s.version,
      tier: trustFor(publisher),
      publisherOrgId: null,
    });
    const values = (s.catalog?.values ?? {}) as Record<string, unknown>;
    const snapshot = await submissionSnapshot(s, facts);
    const prev = existed && listing ? await previousVersion(listing.id, s.version) : null;
    const now = new Date();
    ({ target, version, updated } = await atomically(async () => {
      const into = listing ?? await listings.insert({ publisherId: publisher.id, name: s.name, ...listingColumns(values), latestVersion: s.version });
      const inserted = await versions.insert({
        listingId: into.id,
        sourcePluginId: null,
        version: s.version,
        imageDigest: facts.digest,
        imageRepository: published.imageRepository,
        specSnapshot: snapshot,
        breaking: prev !== null && prev.version.split('.')[0] !== s.version.split('.')[0],
        changelog: typeof values.changelog === 'string' ? values.changelog : null,
        vulnCritical: facts.vulnCritical,
        vulnHigh: facts.vulnHigh,
        vulnCriticalFixable: facts.vulnCriticalFixable,
        vulnHighFixable: facts.vulnHighFixable,
        scannedAt: facts.scannedAt ? new Date(facts.scannedAt) : null,
        publishedBy: actor,
      });
      const latest = await recomputeLatest(into.id);
      if (!r.listingId) await requests.transition(r.id, 'approved', { listingId: into.id });
      const approved = await submissions.transition(s.id, 'publishing', {
        status: 'approved',
        listingId: into.id,
        decidedBy: actor,
        decidedAt: now,
        reason: null,
        emailPurgeAfter: emailPurgeAt(now),
      });
      if (!approved) throw new ConflictError('The submission changed state meanwhile; nothing was published.');
      return { target: into, version: inserted, updated: latest };
    }));
  } catch (err) {
    await submissions.transition(s.id, 'publishing', { status: 'pending_review' }).catch((e) =>
      logger.error('Handing back a submission claim failed', { submissionId: s.id, error: errorMessage(e) }));
    throw err;
  }

  ecosystemAudit({
    action: 'plugin.listing.publish',
    actor,
    targetType: 'plugin-listing-version',
    targetId: version.id,
    details: {
      listing: `${publisher.handle}/${s.name}`, version: s.version, digest: facts.digest, tier: publisher.tier, kind: 'submission', submissionId: s.id,
    },
  });
  ecosystemAudit({ action: 'plugin.submission.approve', actor, targetType: 'plugin-submission', targetId: s.id, details: { submissionId: s.id, listing: `${publisher.handle}/${s.name}`, version: s.version, digest: facts.digest } });
  recordSubmission('approved');
  // Published: the public copy is the image now; the quarantined package and build are spent.
  await dropQuarantineArtifacts(s).catch((err) =>
    logger.warn('Dropping a published submission\'s quarantine artifacts failed', { submissionId: s.id, error: errorMessage(err) }));

  const email = await submitterEmail(s);
  if (email) {
    await notifySubmissionDecision({ email, name: s.name, version: s.version, approved: true, listingUrl: listingUrl(s.name), statusUrl: statusUrl(statusTokenFor(s.id)) });
  }
  if (existed) await announceNewVersion(publisher, updated ?? target, version);
}

/** A moderator rejected a `submission` request: the submission is rejected, the submitter told why (N4). */
export async function rejectSubmission(r: PluginPublishRequest, reason: string, actor: string): Promise<void> {
  const s = await submissionForRequest(r);
  const now = new Date();
  const done = await submissions.transition(s.id, 'pending_review', {
    status: 'rejected',
    reason,
    decidedBy: actor,
    decidedAt: now,
    emailPurgeAfter: emailPurgeAt(now),
  });
  if (!done) {
    logger.warn('Rejected a submission request whose submission was no longer pending', { submissionId: s.id, status: s.status });
    return;
  }
  ecosystemAudit({ action: 'plugin.submission.reject', actor, targetType: 'plugin-submission', targetId: s.id, details: { submissionId: s.id, name: s.name, version: s.version, reason: reason.slice(0, 200) } });
  recordSubmission('rejected');
  await dropQuarantineArtifacts(s);
  const email = await submitterEmail(s);
  if (email) await notifySubmissionDecision({ email, name: s.name, version: s.version, approved: false, reason, statusUrl: statusUrl(statusTokenFor(s.id)) });
}

// -----------------------------------------------------------------------------
// The review view: gate report, heuristics, the diff vs the previous
// approved version of the same community listing.
// -----------------------------------------------------------------------------

/** GET /ecosystem/requests/:id → `submission` (moderators only; never the email). */
export async function submissionReview(r: PluginPublishRequest) {
  return (await submissionReviewContext(r)).review;
}

/** The submission review with the rows it was built from (so the console's diff reads nothing twice). */
export async function submissionReviewContext(r: PluginPublishRequest) {
  const s = await submissionForRequest(r);
  const report = gateReportOf(s);
  const listing = r.listingId ? await listings.byId(r.listingId) : null;
  const prev = listing ? await previousVersion(listing.id, s.version) : null;
  const current = report?.facts ? await submissionSnapshot(s, report.facts) : null;
  const values = (s.catalog?.values ?? {}) as Record<string, unknown>;
  const sources = (s.catalog?.sources ?? {}) as Record<string, string>;
  const fields = Object.keys(values);
  const review = {
    id: s.id,
    status: s.status,
    name: s.name,
    version: s.version,
    newListing: !listing,
    submittedAt: new Date(s.createdAt).toISOString(),
    verifiedAt: isoOrNull(s.verifiedAt),
    gateReport: report,
    heuristics: s.heuristics ?? null,
    // The quarantined build's signed SBOM and a fresh grype report (console routes, moderators only).
    sbomUrl: report?.facts ? `/api/plugins/ecosystem/requests/${r.id}/submission-sbom` : null,
    scanUrl: report?.facts ? `/api/plugins/ecosystem/requests/${r.id}/submission-scan` : null,
    previousVersion: prev?.version ?? null,
    metadata: fields.map((field) => metadataRow(
      field,
      values[field] ?? null,
      listing && (LISTING_FIELDS as readonly string[]).includes(field) ? listingFieldValue(listing, field as never) : null,
      sources[field] ?? null,
      listing !== null,
    )),
    contract: current ? contractDiff(prev?.specSnapshot ?? null, current) : null,
    dockerfile: {
      previous: (prev?.specSnapshot?.dockerfile as string | null | undefined) ?? null,
      current: s.dockerfile ?? null,
      changed: ((prev?.specSnapshot?.dockerfile as string | null | undefined) ?? null) !== (s.dockerfile ?? null),
    },
    vuln: report?.facts ? {
      previous: prev ? { critical: prev.vulnCritical, high: prev.vulnHigh } : null,
      current: {
        critical: report.facts.vulnCritical,
        high: report.facts.vulnHigh,
        criticalFixable: report.facts.vulnCriticalFixable,
        highFixable: report.facts.vulnHighFixable,
        scannedAt: report.facts.scannedAt,
      },
    } : null,
  };
  return { review, submission: s, listing, previous: prev, facts: report?.facts ?? null };
}

// -----------------------------------------------------------------------------
// Claims
// -----------------------------------------------------------------------------

/** The claiming caller's email hash — only for a VERIFIED account email and a configured secret. */
export function claimantEmailHash(caller: Pick<Caller, 'email' | 'emailVerified'>): string | null {
  if (!caller.email || caller.emailVerified !== true) return null;
  const secret = submissionConfig().emailHashSecret;
  return secret ? hashEmail(caller.email.trim().toLowerCase(), secret) : null;
}

/**
 * Whether a `claim` request's claimer is the listing's submitter (the email
 * hashes match). Null when it can't be told (not a community listing claim,
 * no verified claimer email, or the submitter's email already purged). The
 * console shows "email does not match submitter" on `false`.
 */
export async function claimEmailMatch(r: PluginPublishRequest): Promise<boolean | null> {
  if (r.kind !== 'claim') return null;
  const payload = (r.payload ?? {}) as { target?: { listingId?: string }; claimantEmailHash?: string };
  const listingId = payload.target?.listingId;
  if (!listingId || !payload.claimantEmailHash) return null;
  const owner = await listingOwnerHash(listingId);
  return owner ? owner === payload.claimantEmailHash : null;
}

/**
 * After an approved listing claim: when the claimer's verified email is the
 * one that submitted it, mark those submissions `claimed`
 * (`plugin.submission.claim`) and tell the claimer (N5). Never throws — the
 * claim itself already succeeded.
 */
export async function linkClaimedSubmissions(input: {
  listing: PluginListing; claimantEmailHash: string | null | undefined; userId: string; orgId: string | null; actor: string; publisherHandle: string;
}): Promise<number> {
  try {
    if (!input.claimantEmailHash) return 0;
    const rows = (await submissions.list({ listingId: input.listing.id, statuses: ['approved'] }))
      .filter((s) => s.emailHash === input.claimantEmailHash);
    for (const s of rows) {
      const done = await submissions.transition(s.id, 'approved', { status: 'claimed' });
      if (!done) continue;
      ecosystemAudit({
        action: 'plugin.submission.claim',
        actor: input.actor,
        targetType: 'plugin-submission',
        targetId: s.id,
        details: {
          submissionId: s.id, listing: `${input.publisherHandle}/${input.listing.name}`, claimedBy: input.userId,
        },
      });
      recordSubmission('claimed');
    }
    if (rows.length > 0) await notifySubmissionClaimed({ userId: input.userId, orgId: input.orgId, listing: `${input.publisherHandle}/${input.listing.name}` });
    return rows.length;
  } catch (err) {
    logger.warn('Linking claimed submissions failed', { listingId: input.listing.id, error: errorMessage(err) });
    return 0;
  }
}

// -----------------------------------------------------------------------------
// The quarantined build's SBOM and scan (console downloads)
// -----------------------------------------------------------------------------

/** The quarantined image a `submission` request pins, or 404. */
async function quarantinedImage(requestId: string): Promise<{ s: PluginSubmission; facts: SubmissionFacts }> {
  const r = await requests.byId(requestId);
  if (!r || r.kind !== 'submission') throw new EcosystemError(ErrorCode.NOT_FOUND, 'Submission request not found');
  const s = await submissionForRequest(r);
  const facts = gateReportOf(s)?.facts;
  if (!facts) throw new EcosystemError(ErrorCode.NOT_FOUND, 'The submission has no quarantined build');
  return { s, facts };
}

/** GET /ecosystem/requests/:id/submission-sbom — the quarantined build's SIGNED SPDX SBOM. */
export async function submissionSbom(requestId: string): Promise<Record<string, unknown>> {
  const { s, facts } = await quarantinedImage(requestId);
  const [{ fetchImageSbom }, { Config }] = await Promise.all([import('../../helpers/supply-chain.js'), import('@pipeline-builder/pipeline-core')]);
  return fetchImageSbom({ orgId: SYSTEM_ORG_ID, name: s.name, imageDigest: facts.digest, imageRepository: facts.imageRepository }, Config.get('registry'));
}

/** GET /ecosystem/requests/:id/submission-scan — grype over the signed SBOM, run now (critical/high itemized). */
export async function submissionScan(requestId: string) {
  const sbom = await submissionSbom(requestId);
  const { scanSbom } = await import('../../helpers/vuln-scan.js');
  const scan = await scanSbom(sbom, 'rescan');
  return { ...scan, scannedAt: scan.scannedAt.toISOString() };
}
