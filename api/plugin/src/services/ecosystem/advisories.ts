// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Security advisories and CVE response (docs/plugin-publishing.md,
 * `blockOnAdvisory`, N20/N21, `plugin.advisory.*`).
 *
 * Lifecycle — every advisory starts as a PRIVATE draft (`plugin_advisories`
 * state `draft`, invisible to the public views) paired with an `advisory`
 * publish request in the security-fix lane, so it sits in the one Ecosystem
 * console queue with the 4-hour SLA:
 *
 *  - a publisher SUBMITS one for its own listing (`advisory` request kind);
 *  - the nightly CVE rescan opens one when a NEW critical/high finding hits a
 *    listed version ({@link openRescanDraft}, N20);
 *  - a security-flagged review report opens one ({@link openReviewAdvisoryDraft},
 * called by the review service, which sends N19 itself);
 *  - an Ecosystem Manager can open one and edit any draft before publishing.
 *
 * Only the system org PUBLISHES (approving the request, decisions.ts) or
 * WITHDRAWS (console route) an advisory. Publishing notifies every installing
 * org whose install reaches an affected version, and the publisher (N21,
 * immediate, idempotent per `(advisory, org)` through
 * `plugin_advisory_deliveries`; the maintenance pass retries a fan-out that
 * didn't finish, so delivery lands within 15 minutes). Lookup then warns, or
 * refuses per the org's `blockOnAdvisory` (pipeline-data plugin-resolution);
 * withdrawal clears both and tells the orgs that were told.
 *
 * Listed-version DEPRECATION — the softer signal, which never refuses a
 * resolution — lives in version-deprecation.ts.
 */

import {
  actorId,
  createLogger,
  ErrorCode,
  errorMessage,
  SYSTEM_ACTOR_ID,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { renderUntrustedMarkdown } from '@pipeline-builder/api-server/lib/markdown.js';
import {
  advisoryRangeCovers,
  advisoryRangeProblem,
  parseSemver,
  type AdvisorySeverity,
  type AdvisorySource,
  type AdvisoryState,
  type PluginAdvisory,
  type PluginListing,
  type PluginListingVersion,
  type PluginPublishRequest,
  type Publisher,
} from '@pipeline-builder/pipeline-data';

import { advisoryStore, deliveryStore } from './advisories-store.js';
import { ecosystemAudit } from './audit.js';
import { can, EcosystemError, invalid, submitterTag, type Caller } from './context.js';
import { INSTALLER_RECIPIENT_CHUNK, installingOrgs, orgApprovers, sendToOrgs } from './install-notify.js';
import { moderators, publisherManagers, sendNotice } from './notify.js';
import { listingWithPublisher } from './publishers.js';
import { listings, OPEN_STATUSES, publishers, requests, versions } from './store.js';
import { enqueueEcosystemNotification } from '../ecosystem-notifications.js';
import { isActiveListing, iso, normalizeVulnId, requiredText } from './util.js';

const logger = createLogger('ecosystem-advisories');

export const ADVISORY_SEVERITIES: readonly AdvisorySeverity[] = ['critical', 'high', 'medium', 'low'];
export const ADVISORY_SUMMARY_MAX = 300;
/** Details markdown cap (bytes, UTF-8). */
export const ADVISORY_DETAILS_MAX_BYTES = 32 * 1024;
export const ADVISORY_MAX_IDS = 50;
/** A vulnerability id: `CVE-2026-1234`, `GHSA-xxxx-xxxx-xxxx`, `RUSTSEC-2026-0001`, `ALAS-2026-1234`, … */
const VULN_ID = /^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9._:-]{1,60}$/;
/** How long after publication the maintenance pass keeps retrying an unfinished fan-out. */
export const FAN_OUT_RETRY_WINDOW_MS = 24 * 3_600_000;

type Advisory = PluginAdvisory;

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

/** The editable fields of an advisory. */
export interface AdvisoryFields {
  affectedRange: string;
  severity: AdvisorySeverity;
  summary: string;
  detailsMd: string | null;
  detailsHtml: string | null;
  cveIds: string[];
  fixedVersion: string | null;
}

/** Vulnerability ids from an array or a comma/space-separated string: validated, CVE ids upper-cased, deduplicated. */
export function parseVulnIds(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === '') return [];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : invalid('cveIds must be an array of ids');
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') invalid('cveIds must be strings');
    const id = item.trim();
    if (id === '') continue;
    if (!VULN_ID.test(id)) invalid(`"${id.slice(0, 80)}" is not a vulnerability id (e.g. CVE-2026-1234 or GHSA-xxxx-xxxx-xxxx)`);
    const normalized = normalizeVulnId(id);
    if (!out.includes(normalized)) out.push(normalized);
  }
  if (out.length > ADVISORY_MAX_IDS) invalid(`At most ${ADVISORY_MAX_IDS} vulnerability ids per advisory`);
  return out;
}

/** Details markdown → the stored markdown + its SERVER-SANITIZED html. */
function details(raw: unknown): { detailsMd: string | null; detailsHtml: string | null } {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return { detailsMd: null, detailsHtml: null };
  if (typeof raw !== 'string') invalid('detailsMd must be a string');
  if (Buffer.byteLength(raw, 'utf8') > ADVISORY_DETAILS_MAX_BYTES) invalid(`detailsMd must be at most ${ADVISORY_DETAILS_MAX_BYTES / 1024} KB`);
  return { detailsMd: raw, detailsHtml: renderUntrustedMarkdown(raw) };
}

/**
 * Validate advisory fields. `base` is the draft being edited (a partial body
 * then keeps its other values); without it every required field must be given.
 */
export function parseAdvisoryFields(body: Record<string, unknown>, base?: AdvisoryFields): AdvisoryFields {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;

  let affectedRange = base?.affectedRange ?? '';
  if (has('affectedRange') || !base) {
    if (typeof body.affectedRange !== 'string') invalid('affectedRange is required (a semver range such as ">=1.0.0 <1.4.2")');
    affectedRange = body.affectedRange.trim();
    const problem = advisoryRangeProblem(affectedRange);
    if (problem) invalid(`affectedRange: ${problem}`);
  }

  let severity = base?.severity as AdvisorySeverity;
  if (has('severity') || !base) {
    if (!ADVISORY_SEVERITIES.includes(body.severity as AdvisorySeverity)) invalid(`severity must be one of: ${ADVISORY_SEVERITIES.join(', ')}`);
    severity = body.severity as AdvisorySeverity;
  }

  let summary = base?.summary ?? '';
  if (has('summary') || !base) {
    if (typeof body.summary !== 'string' || body.summary.trim() === '') invalid('summary is required');
    summary = body.summary.trim().replace(/\s+/g, ' ');
    if (summary.length > ADVISORY_SUMMARY_MAX) invalid(`summary must be at most ${ADVISORY_SUMMARY_MAX} characters`);
  }

  const detail = has('detailsMd') ? details(body.detailsMd) : { detailsMd: base?.detailsMd ?? null, detailsHtml: base?.detailsHtml ?? null };
  const cveIds = has('cveIds') ? parseVulnIds(body.cveIds) : base?.cveIds ?? [];

  let fixedVersion = base?.fixedVersion ?? null;
  if (has('fixedVersion')) {
    const raw = body.fixedVersion;
    if (raw === null || raw === '') fixedVersion = null;
    else if (typeof raw !== 'string' || !parseSemver(raw.trim())) invalid('fixedVersion must be a semver version (e.g. 1.4.2)');
    else fixedVersion = raw.trim();
  }
  if (fixedVersion && advisoryRangeCovers(affectedRange, fixedVersion)) {
    invalid(`fixedVersion ${fixedVersion} is inside the affected range ${affectedRange}`);
  }
  return { affectedRange, severity, summary, ...detail, cveIds, fixedVersion };
}

const fieldsOf = (a: Advisory): AdvisoryFields => ({
  affectedRange: a.affectedRange,
  severity: a.severity,
  summary: a.summary,
  detailsMd: a.detailsMd,
  detailsHtml: a.detailsHtml,
  cveIds: a.cveIds ?? [],
  fixedVersion: a.fixedVersion,
});

// -----------------------------------------------------------------------------
// Views
// -----------------------------------------------------------------------------


export function advisoryView(
  a: Advisory,
  ctx: { listing: Pick<PluginListing, 'name'> | null; publisher: Pick<Publisher, 'handle'> | null; requestId: string | null; listedVersions: readonly string[] },
) {
  return {
    id: a.id,
    listingId: a.listingId,
    listingName: ctx.listing?.name ?? '',
    publisherHandle: ctx.publisher?.handle ?? '',
    affectedRange: a.affectedRange,
    fixedVersion: a.fixedVersion,
    severity: a.severity,
    summary: a.summary,
    detailsMd: a.detailsMd,
    detailsHtml: a.detailsHtml,
    cveIds: a.cveIds ?? [],
    state: a.state,
    source: a.source,
    createdBy: a.createdBy,
    publishedAt: iso(a.publishedAt),
    withdrawnAt: iso(a.withdrawnAt),
    createdAt: iso(a.createdAt)!,
    updatedAt: iso(a.updatedAt)!,
    requestId: ctx.requestId,
    affectedVersions: ctx.listedVersions.filter((v) => advisoryRangeCovers(a.affectedRange, v)),
  };
}
export type AdvisoryView = ReturnType<typeof advisoryView>;

/** Views for a set of advisories (listings, publishers, versions and open requests resolved once each). */
export async function advisoryViews(rows: Advisory[]): Promise<AdvisoryView[]> {
  const listingIds = [...new Set(rows.map((a) => a.listingId))];
  const listingMap = new Map((await listings.byIds(listingIds)).map((l) => [l.id, l]));
  const pubMap = new Map((await publishers.byIds([...new Set(rows.map((a) => a.publisherId))])).map((p) => [p.id, p]));
  const allVersions = await versions.forListings(listingIds);
  const open = await requests.list({ statuses: OPEN_STATUSES, kinds: ['advisory'], limit: 1000 });
  const requestFor = new Map(open.map((r) => [String((r.payload as { advisoryId?: string }).advisoryId ?? ''), r.id]));
  return rows.map((a) => advisoryView(a, {
    listing: listingMap.get(a.listingId) ?? null,
    publisher: pubMap.get(a.publisherId) ?? null,
    requestId: a.state === 'draft' ? requestFor.get(a.id) ?? null : null,
    listedVersions: allVersions.filter((v) => v.listingId === a.listingId).map((v) => v.version),
  }));
}

// -----------------------------------------------------------------------------
// Drafts
// -----------------------------------------------------------------------------

/** The request payload an advisory draft's request carries (the queue shows it). */
function requestPayload(a: Advisory, listing: Pick<PluginListing, 'name'>, submitter: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    name: listing.name,
    advisoryId: a.id,
    severity: a.severity,
    summary: a.summary,
    affectedRange: a.affectedRange,
    source: a.source,
    submitter,
    ...extra,
  };
}

/**
 * The draft half of a TENANT `advisory` request (requests.ts `buildRequest`):
 * validates the body against the caller's own listing and stores the private
 * draft. The caller inserts the request; if that fails it must
 * {@link removeDraft} the row.
 */
export async function buildPublisherDraft(caller: Caller, publisher: Publisher, body: Record<string, unknown>) {
  if (typeof body.listingId !== 'string' || body.listingId === '') throw new EcosystemError(ErrorCode.MISSING_REQUIRED_FIELD, 'listingId is required');
  const listing = await listings.byId(body.listingId);
  if (!listing || listing.publisherId !== publisher.id) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Listing not found');
  const raw = body.advisory;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('advisory is required: { affectedRange, severity, summary, detailsMd?, cveIds?, fixedVersion? }');
  const fields = parseAdvisoryFields(raw as Record<string, unknown>);
  const advisory = await advisoryStore.insert({
    listingId: listing.id,
    publisherId: publisher.id,
    ...fields,
    state: 'draft',
    source: 'publisher',
    createdBy: caller.userId,
  });
  return {
    advisory,
    listing,
    request: {
      listingId: listing.id,
      lane: 'security' as const,
      payload: requestPayload(advisory, listing, submitterTag(caller)),
    },
  };
}

/** Drop a draft whose request never got stored. */
export async function removeDraft(advisoryId: string): Promise<void> {
  await advisoryStore.remove(advisoryId).catch((err) => logger.warn('Orphan advisory draft not removed', { advisoryId, error: errorMessage(err) }));
}

/** The advisory an `advisory` request carries, or 404. */
async function advisoryOf(r: Pick<PluginPublishRequest, 'payload'>): Promise<Advisory> {
  const id = (r.payload as { advisoryId?: unknown } | null)?.advisoryId;
  const advisory = typeof id === 'string' ? await advisoryStore.byId(id) : null;
  if (!advisory) throw new EcosystemError(ErrorCode.NOT_FOUND, 'The advisory draft no longer exists.');
  return advisory;
}

/**
 * Store a SYSTEM-side draft (moderator, CVE rescan, review report) with its
 * `advisory` request in the security lane. The request is attributed to the
 * system org, so the publisher's members can never decide it.
 */
async function createSystemDraft(input: {
  listing: PluginListing;
  publisher: Publisher;
  fields: AdvisoryFields;
  source: Exclude<AdvisorySource, 'publisher'>;
  createdBy: string;
  submitter: Record<string, unknown>;
  extraPayload?: Record<string, unknown>;
  auditDetails?: Record<string, unknown>;
}): Promise<{ advisory: Advisory; request: PluginPublishRequest }> {
  const { listing, publisher, fields, source, createdBy } = input;
  const advisory = await advisoryStore.insert({ listingId: listing.id, publisherId: publisher.id, ...fields, state: 'draft', source, createdBy });
  let request: PluginPublishRequest;
  try {
    request = await requests.insert({
      publisherId: publisher.id,
      listingId: listing.id,
      kind: 'advisory',
      lane: 'security',
      submittedBy: createdBy,
      submittedOrgId: SYSTEM_ORG_ID,
      payload: requestPayload(advisory, listing, input.submitter, input.extraPayload),
    });
  } catch (err) {
    await removeDraft(advisory.id);
    throw err;
  }
  ecosystemAudit({
    action: 'plugin.advisory.create',
    actor: createdBy,
    affectedOrgId: publisher.ownerOrgId,
    targetType: 'plugin-advisory',
    targetId: advisory.id,
    details: { source, listing: `${publisher.handle}/${listing.name}`, severity: fields.severity, affectedRange: fields.affectedRange, cveCount: fields.cveIds.length, requestId: request.id, ...(input.auditDetails ?? {}) },
  });
  incCounter('ecosystem_advisory_drafts_total', { source });
  return { advisory, request };
}

/** POST /plugins/ecosystem/advisories — an Ecosystem Manager opens a draft (another manager publishes it). */
export async function createModeratorDraft(caller: Caller, body: Record<string, unknown>) {
  if (!can(caller, 'plugins:moderate')) throw new EcosystemError(ErrorCode.INSUFFICIENT_PERMISSIONS, 'Advisories need plugins:moderate');
  const { listing, publisher } = await listingWithPublisher(body.listingId);
  const fields = parseAdvisoryFields(body);
  const { advisory, request } = await createSystemDraft({
    listing, publisher, fields, source: 'moderator', createdBy: actorId({ userId: caller.userId }), submitter: submitterTag(caller),
  });
  await notifyDraftOpened(advisory, listing, publisher, { toPublisher: false, excludeUserIds: [caller.userId] });
  const [view] = await advisoryViews([advisory]);
  return { advisory: view!, request };
}

/** PATCH /plugins/ecosystem/advisories/:id — edit a DRAFT before it is published (the request's payload follows). */
export async function editDraft(caller: Caller, id: string, body: Record<string, unknown>) {
  if (!can(caller, 'plugins:moderate')) throw new EcosystemError(ErrorCode.INSUFFICIENT_PERMISSIONS, 'Advisories need plugins:moderate');
  const current = await advisoryStore.byId(id);
  if (!current) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Advisory not found');
  if (current.state !== 'draft') throw new EcosystemError(ErrorCode.CONFLICT, `The advisory is ${current.state}; only drafts can be edited.`);
  const fields = parseAdvisoryFields(body, fieldsOf(current));
  const updated = await advisoryStore.transition(id, 'draft', fields);
  if (!updated) throw new EcosystemError(ErrorCode.CONFLICT, 'The advisory was published or discarded meanwhile.');
  const [open] = await requests.list({ statuses: OPEN_STATUSES, kinds: ['advisory'], advisoryId: id, limit: 1 });
  if (open) {
    await requests.transition(open.id, open.status, {
      payload: { ...open.payload, severity: updated.severity, summary: updated.summary, affectedRange: updated.affectedRange },
    });
  }
  const publisher = await publishers.byId(updated.publisherId);
  ecosystemAudit({
    action: 'plugin.advisory.update',
    actor: actorId({ userId: caller.userId }),
    affectedOrgId: publisher?.ownerOrgId,
    targetType: 'plugin-advisory',
    targetId: id,
    details: { fields: Object.keys(body).filter((k) => k in fields), severity: updated.severity, affectedRange: updated.affectedRange },
  });
  const [view] = await advisoryViews([updated]);
  return view!;
}

/** N20: an advisory draft was opened for the publisher's listing — publisher managers and moderators, immediate. */
async function notifyDraftOpened(
  a: Advisory,
  listing: Pick<PluginListing, 'name'>,
  publisher: Publisher,
  opts: { toPublisher: boolean; excludeUserIds?: string[] },
): Promise<void> {
  const ref = `${publisher.handle}/${listing.name}`;
  const recipients = [moderators('plugins:moderate', { orgId: publisher.ownerOrgId, userIds: opts.excludeUserIds })];
  if (opts.toPublisher && publisher.ownerOrgId) recipients.push(publisherManagers(publisher.ownerOrgId));
  await sendNotice('N20', recipients, {
    subject: `Security advisory draft (${a.severity}): ${ref}`,
    text: [
      `A private ${a.severity} advisory draft was opened for ${ref} (${a.affectedRange}): ${a.summary}`,
      ...(a.cveIds.length ? [`Vulnerabilities: ${a.cveIds.slice(0, 20).join(', ')}${a.cveIds.length > 20 ? ', …' : ''}`] : []),
      'It is not public. An Ecosystem Manager reviews and publishes it; publishers can ship a fixed version through the security-fix lane meanwhile.',
    ].join('\n\n'),
  }, { immediate: true });
}

/** A finding as the CVE rescan reports it. */
export interface RescanFinding { id: string; severity: 'critical' | 'high'; packageName: string; packageVersion: string }

/**
 * The nightly rescan found NEW critical/high vulnerabilities in a LISTED
 * version (its counts grew past the listing version's stored facts). Open a
 * private draft — deduplicated per listing version and CVE set: ids already
 * named by ANY advisory on the listing that covers this version (published,
 * draft, or discarded/withdrawn — a moderator's "not applicable" sticks) are
 * left out, and nothing is opened when none are left. N20 to the publisher's
 * managers and the moderators. Never throws (the rescan goes on).
 */
export async function openRescanDraft(input: {
  listingVersion: Pick<PluginListingVersion, 'id' | 'listingId' | 'version' | 'yankedAt'>;
  findings: readonly RescanFinding[];
}): Promise<Advisory | null> {
  try {
    const { listingVersion: lv } = input;
    if (lv.yankedAt) return null;
    const listing = await listings.byId(lv.listingId);
    if (!listing || !isActiveListing(listing)) return null;
    const publisher = await publishers.byId(listing.publisherId);
    if (!publisher || publisher.suspendedAt) return null;

    const covered = new Set((await advisoryStore.list({ listingId: listing.id }))
      .filter((a) => advisoryRangeCovers(a.affectedRange, lv.version))
      .flatMap((a) => a.cveIds ?? []));
    const fresh = input.findings.filter((f) => VULN_ID.test(f.id) && !covered.has(normalizeVulnId(f.id)));
    const ids = parseVulnIds([...new Set(fresh.map((f) => f.id))].slice(0, ADVISORY_MAX_IDS));
    if (ids.length === 0) {
      incCounter('ecosystem_advisory_rescan_deduplicated_total', {});
      return null;
    }
    const kept = fresh.filter((f) => ids.includes(normalizeVulnId(f.id)));
    const severity: AdvisorySeverity = kept.some((f) => f.severity === 'critical') ? 'critical' : 'high';
    const rows = kept.slice(0, 100).map((f) => `| ${f.id} | ${f.severity} | ${f.packageName.replace(/\|/g, '\\|')} | ${f.packageVersion.replace(/\|/g, '\\|')} |`);
    const detailsMd = [
      `The nightly vulnerability rescan found ${ids.length} new critical/high ${ids.length === 1 ? 'vulnerability' : 'vulnerabilities'} in ${publisher.handle}/${listing.name} ${lv.version}.`,
      '',
      '| Vulnerability | Severity | Package | Installed version |',
      '|---|---|---|---|',
      ...rows,
      '',
      'Review the range and severity before publishing: widen `affectedRange` to every version shipping the vulnerable package, and set `fixedVersion` once a fixed version is listed.',
    ].join('\n');
    const summary = `${ids.length} new ${severity === 'critical' ? 'critical' : 'high'}-severity ${ids.length === 1 ? 'vulnerability' : 'vulnerabilities'} in ${listing.name} ${lv.version} (${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ', …' : ''})`;
    const { advisory } = await createSystemDraft({
      listing,
      publisher,
      fields: {
        affectedRange: lv.version,
        severity,
        summary: summary.slice(0, ADVISORY_SUMMARY_MAX),
        detailsMd,
        detailsHtml: renderUntrustedMarkdown(detailsMd),
        cveIds: ids,
        fixedVersion: null,
      },
      source: 'cve_rescan',
      createdBy: SYSTEM_ACTOR_ID,
      submitter: { principalType: 'system', name: 'cve-rescan' },
      extraPayload: { listingVersionId: lv.id, version: lv.version },
      auditDetails: { version: lv.version },
    });
    await notifyDraftOpened(advisory, listing, publisher, { toPublisher: true });
    return advisory;
  } catch (err) {
    incCounter('ecosystem_advisory_rescan_draft_failed_total', {});
    logger.error('Could not open the rescan advisory draft', { listingVersionId: input.listingVersion.id, error: errorMessage(err) });
    return null;
  }
}

/** A review report flagged as a security issue, as the advisory path receives it. */
export interface ReviewSecurityReport {
  reviewId: string;
  reportId: string;
  listingId: string;
  /** The version the review is about (the draft's starting affected range), when known. */
  version: string | null;
  /** The reporter's free-text details (private: never shown on the public page). */
  details: string | null;
}

/**
 * A review report flagged as a SECURITY issue opens a PRIVATE advisory draft
 * on the listing (the review service calls this after sending N19, so this
 * sends nothing). Idempotent per review: another report on the same review
 * returns the existing draft. The range starts at the reviewed version (else
 * the listing's latest) and the severity at `high`; an Ecosystem Manager edits
 * both before publishing. The reporter is never recorded on the draft or in
 * audit (the publisher's admins read both) — the draft is the system's; the
 * reporter's text stays in the private request payload, never in the details
 * that would become public.
 */
export async function openReviewAdvisoryDraft(report: ReviewSecurityReport): Promise<Advisory> {
  const { listing, publisher } = await listingWithPublisher(report.listingId);
  const [existing] = await requests.list({ kinds: ['advisory'], reviewId: report.reviewId, limit: 1 });
  if (existing) return advisoryOf(existing);
  const range = report.version && parseSemver(report.version) ? report.version : listing.latestVersion;
  if (!range) throw new EcosystemError(ErrorCode.CONFLICT, 'The listing has no published version to scope the advisory to.');
  const { advisory } = await createSystemDraft({
    listing,
    publisher,
    fields: {
      affectedRange: range,
      severity: 'high',
      summary: `Security issue reported in a review of ${listing.name} ${range}`.slice(0, ADVISORY_SUMMARY_MAX),
      detailsMd: null,
      detailsHtml: null,
      cveIds: [],
      fixedVersion: null,
    },
    source: 'review',
    createdBy: SYSTEM_ACTOR_ID,
    submitter: { principalType: 'system', name: 'review-report' },
    extraPayload: {
      reviewId: report.reviewId,
      reportId: report.reportId,
      ...(report.details ? { reportDetails: report.details.slice(0, 4000) } : {}),
    },
    auditDetails: { reviewId: report.reviewId, reportId: report.reportId },
  });
  return advisory;
}

// -----------------------------------------------------------------------------
// Publish (the approved `advisory` request), discard, withdraw
// -----------------------------------------------------------------------------

/** Every org whose install reaches a version `a` covers (the "installing orgs"). */
async function affectedInstallers(a: Advisory, listing: PluginListing, publisher: Publisher): Promise<string[]> {
  const covered = (await versions.forListings([listing.id])).filter((v) => advisoryRangeCovers(a.affectedRange, v.version));
  const orgs = new Set<string>();
  for (const v of covered) {
    for (const o of await installingOrgs(publisher, listing, v.version)) orgs.add(o.orgId);
  }
  return [...orgs];
}

function n21Content(a: Advisory, listing: Pick<PluginListing, 'name'>, publisher: Pick<Publisher, 'handle'>, withdrawn: boolean, reason?: string) {
  const ref = `${publisher.handle}/${listing.name}`;
  if (withdrawn) {
    return {
      subject: `Security advisory withdrawn: ${ref}`,
      text: `The ${a.severity} security advisory for ${ref} (${a.affectedRange}) — "${a.summary}" — was withdrawn by the system org${reason ? `: ${reason}` : '.'} `
        + 'Lookups no longer warn about it or block on it.',
    };
  }
  return {
    subject: `Security advisory (${a.severity}): ${ref}`,
    text: [
      `A ${a.severity} security advisory was published for ${ref}: ${a.summary}`,
      `Affected versions: ${a.affectedRange}.${a.fixedVersion ? ` Fixed in ${a.fixedVersion}.` : ' No fixed version is listed yet.'}`,
      ...(a.cveIds.length ? [`Vulnerabilities: ${a.cveIds.slice(0, 20).join(', ')}${a.cveIds.length > 20 ? ', …' : ''}`] : []),
      'Pipelines that resolve an affected version get a warning at synth, or stop resolving it when your organization\'s plugin policy blocks advisories of this severity (blockOnAdvisory).',
      `Details: /plugins/${publisher.handle}/${listing.name}`,
    ].join('\n\n'),
  };
}

/**
 * Tell every installing org (and the publisher) about a PUBLISHED advisory
 * (N21, immediate). Idempotent per `(advisory, org)`: orgs already in the
 * delivery ledger are skipped, so a retry only reaches the rest. Never throws;
 * returns how many orgs were newly told.
 */
export async function fanOutAdvisory(a: Advisory): Promise<number> {
  try {
    const listing = await listings.byId(a.listingId);
    const publisher = listing ? await publishers.byId(listing.publisherId) : null;
    if (!listing || !publisher) return 0;
    const done = new Set(await deliveryStore.orgsFor(a.id));
    const content = n21Content(a, listing, publisher, false);
    let told = 0;
    // The publisher first (its managers); an installing publisher org is covered by this notice.
    const publisherOrg = publisher.ownerOrgId?.toLowerCase() ?? null;
    if (publisherOrg && !done.has(publisherOrg)) {
      await enqueueEcosystemNotification('N21', [publisherManagers(publisherOrg)], content, { immediate: true });
      await deliveryStore.record(a.id, [publisherOrg]);
      done.add(publisherOrg);
      told++;
    }
    const pending = (await affectedInstallers(a, listing, publisher)).filter((o) => !done.has(o));
    for (let i = 0; i < pending.length; i += INSTALLER_RECIPIENT_CHUNK) {
      const chunk = pending.slice(i, i + INSTALLER_RECIPIENT_CHUNK);
      await enqueueEcosystemNotification('N21', chunk.map(orgApprovers), content, { immediate: true });
      await deliveryStore.record(a.id, chunk);
      told += chunk.length;
    }
    if (told > 0) incCounter('ecosystem_advisory_notified_orgs_total', {}, told);
    return told;
  } catch (err) {
    incCounter('ecosystem_notification_failed_total', { event: 'N21' });
    logger.warn('Advisory fan-out incomplete; the maintenance pass retries it', { advisoryId: a.id, error: errorMessage(err) });
    return 0;
  }
}

/**
 * Execute an APPROVED `advisory` request (decisions.ts): the draft becomes
 * public (the `public_advisories` view, the directory banner), lookup starts
 * warning/blocking, and N21 goes out. Throws a refusal (the caller rolls the
 * request back).
 */
export async function publishAdvisory(r: PluginPublishRequest, publisher: Publisher, actor: string): Promise<Advisory> {
  const draft = await advisoryOf(r);
  if (draft.state !== 'draft') throw new EcosystemError(ErrorCode.CONFLICT, `The advisory is already ${draft.state}.`);
  const listing = await listings.byId(draft.listingId);
  if (!listing) throw new EcosystemError(ErrorCode.NOT_FOUND, 'The listing no longer exists.');
  const published = await advisoryStore.transition(draft.id, 'draft', { state: 'published', publishedBy: actor, publishedAt: new Date() });
  if (!published) throw new EcosystemError(ErrorCode.CONFLICT, 'The advisory was published or discarded meanwhile.');
  ecosystemAudit({
    action: 'plugin.advisory.publish',
    actor: actor,
    affectedOrgId: publisher.ownerOrgId,
    targetType: 'plugin-advisory',
    targetId: published.id,
    details: {
      listing: `${publisher.handle}/${listing.name}`,
      severity: published.severity,
      affectedRange: published.affectedRange,
      fixedVersion: published.fixedVersion,
      cveIds: published.cveIds.slice(0, 20),
      source: published.source,
      requestId: r.id,
    },
  });
  incCounter('ecosystem_advisories_published_total', { severity: published.severity });
  await fanOutAdvisory(published);
  return published;
}

/** A rejected or withdrawn `advisory` request discards its draft (it never became public). */
export async function discardDraft(r: Pick<PluginPublishRequest, 'kind' | 'payload'>): Promise<void> {
  if (r.kind !== 'advisory') return;
  const id = (r.payload as { advisoryId?: unknown } | null)?.advisoryId;
  if (typeof id !== 'string') return;
  await advisoryStore.transition(id, 'draft', { state: 'withdrawn', withdrawnAt: new Date() });
}

/**
 * POST /plugins/ecosystem/advisories/:id/withdraw — the system org withdraws a
 * PUBLISHED advisory: it leaves the directory, lookup stops warning and
 * blocking, and every org that was told hears (N21). Terminal: a withdrawn
 * advisory is never republished (open a new draft instead).
 */
export async function withdrawAdvisory(caller: Caller, id: string, body: Record<string, unknown>) {
  if (!can(caller, 'plugins:moderate')) throw new EcosystemError(ErrorCode.INSUFFICIENT_PERMISSIONS, 'Advisories need plugins:moderate');
  const reason = requiredText(body.reason, 'reason', 1000);
  const current = await advisoryStore.byId(id);
  if (!current) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Advisory not found');
  if (current.state !== 'published') {
    throw new EcosystemError(ErrorCode.CONFLICT, current.state === 'draft'
      ? 'The advisory is a draft: reject its request to discard it.'
      : 'The advisory is already withdrawn.');
  }
  const withdrawn = await advisoryStore.transition(id, 'published', { state: 'withdrawn', withdrawnAt: new Date() });
  if (!withdrawn) throw new EcosystemError(ErrorCode.CONFLICT, 'The advisory was withdrawn meanwhile.');
  const listing = await listings.byId(withdrawn.listingId);
  const publisher = await publishers.byId(withdrawn.publisherId);
  const actor = actorId({ userId: caller.userId });
  ecosystemAudit({
    action: 'plugin.advisory.withdraw',
    actor: actor,
    affectedOrgId: publisher?.ownerOrgId,
    targetType: 'plugin-advisory',
    targetId: id,
    details: { listing: `${publisher?.handle ?? ''}/${listing?.name ?? ''}`, severity: withdrawn.severity, reason: reason.slice(0, 200) },
  });
  incCounter('ecosystem_advisories_withdrawn_total', {});
  if (listing && publisher) {
    // Exactly the orgs that were told it was published (the publisher among them).
    const told = await deliveryStore.orgsFor(id);
    const content = n21Content(withdrawn, listing, publisher, true, reason);
    const publisherOrg = publisher.ownerOrgId?.toLowerCase() ?? null;
    if (publisherOrg) await sendNotice('N21', [publisherManagers(publisherOrg)], content, { immediate: true });
    await sendToOrgs('N21', told.filter((o) => o !== publisherOrg), content, { immediate: true });
  }
  const [view] = await advisoryViews([withdrawn]);
  return view!;
}

/**
 * Maintenance: finish the fan-out of advisories published in the last day (a
 * fan-out interrupted by an outage resumes here; the ledger makes it
 * idempotent). Returns how many orgs were newly told.
 */
export async function retryAdvisoryFanOut(now: Date = new Date()): Promise<number> {
  const recent = await advisoryStore.list({ states: ['published'], publishedSince: new Date(now.getTime() - FAN_OUT_RETRY_WINDOW_MS) });
  let told = 0;
  for (const a of recent) told += await fanOutAdvisory(a);
  return told;
}

// -----------------------------------------------------------------------------
// Lists
// -----------------------------------------------------------------------------

const STATES: readonly AdvisoryState[] = ['draft', 'published', 'withdrawn'];

/** GET /plugins/publisher/advisories — the caller's publisher's advisories, in every state (drafts are private to it and the system org). */
export async function publisherAdvisories(caller: Caller) {
  if (!can(caller, 'plugins:read')) throw new EcosystemError(ErrorCode.INSUFFICIENT_PERMISSIONS, 'Advisories need plugins:read');
  const publisher = await publishers.byOrg(caller.orgId);
  if (!publisher) return [];
  // Every member reads the advisories on their own listings; the embargoed
  // DRAFTS (a fix not yet shipped) stay with the publisher's managers.
  const manager = can(caller, 'publishers:manage');
  const rows = await advisoryStore.list({ publisherId: publisher.id, ...(manager ? {} : { states: ['published', 'withdrawn'] as AdvisoryState[] }) });
  // Only the publisher's own drafts name their author; system-side drafts are the system's.
  return (await advisoryViews(rows))
    .map((v) => (v.source === 'publisher' ? v : { ...v, createdBy: SYSTEM_ACTOR_ID }));
}

/** GET /plugins/ecosystem/advisories — every advisory (filter by `state`, `listingId`). */
export async function consoleAdvisories(query: Record<string, unknown>) {
  const state = typeof query.state === 'string' && (STATES as readonly string[]).includes(query.state) ? query.state as AdvisoryState : null;
  const listingId = typeof query.listingId === 'string' && query.listingId ? query.listingId : undefined;
  return advisoryViews(await advisoryStore.list({ ...(state ? { states: [state] } : {}), ...(listingId ? { listingId } : {}) }));
}
