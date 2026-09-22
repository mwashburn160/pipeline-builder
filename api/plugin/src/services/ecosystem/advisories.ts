// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Security advisories and CVE response (docs/plans/plugin-ecosystem.md W8, G9,
 * §3.0, §3.2 `blockOnAdvisory`, §5b N20/N21, §5c `plugin.advisory.*`).
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
 *    registered on W4's review-hooks seam; W4 sends N19 itself);
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
 * Also here: LISTED-VERSION DEPRECATION (the W2 handoff) — a publisher
 * deprecates its own listed version at once (it only narrows, like pause), the
 * system org may deprecate or clear, and deprecating the source plugin row of a
 * listed version carries over. Lookup warns; installers get N14.
 */

import {
  actorId,
  createLogger,
  emitCounter,
  ErrorCode,
  errorMessage,
  SYSTEM_ACTOR_ID,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import { renderUntrustedMarkdown } from '@pipeline-builder/api-server/lib/markdown.js';
import {
  advisoryRangeCovers,
  advisoryRangeProblem,
  parseSemver,
  schema,
  type AdvisorySeverity,
  type AdvisorySource,
  type AdvisoryState,
  type PluginAdvisory,
  type PluginAdvisoryInsert,
  type PluginListing,
  type PluginListingVersion,
  type PluginPublishRequest,
  type Publisher,
} from '@pipeline-builder/pipeline-data';
import { and, desc, eq, gte, inArray, type SQL } from 'drizzle-orm';

import { can, EcosystemError, submitterTag, type Caller } from './context.js';
import { INSTALLER_RECIPIENT_CHUNK, installingOrgs, notifyInstallers, orgApprovers } from './install-notify.js';
import { moderators, publisherManagers } from './notify.js';
import { assertRootOrg, ownPublisher } from './publishers.js';
import { setReviewSecurityReportHandler, type ReviewSecurityReport } from './review-hooks.js';
import { ACTIVE_LISTING_STATES, elevated, listings, OPEN_STATUSES, publishers, requests, versions } from './store.js';
import { listingView } from './views.js';
import { emitPluginAudit } from '../audit.js';
import { enqueueEcosystemNotification } from '../ecosystem-notifications.js';

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
/** Deprecation message cap. */
export const DEPRECATION_MESSAGE_MAX = 500;

type Advisory = PluginAdvisory;

// -----------------------------------------------------------------------------
// Data access (elevated, like store.ts: the advisory tables are instance-wide
// and the delivery ledger is written for other orgs)
// -----------------------------------------------------------------------------

const A = () => schema.pluginAdvisory;
const D = () => schema.pluginAdvisoryDelivery;
const first = <T>(rows: T[]): T | null => rows[0] ?? null;

export const advisoryStore = {
  byId: (id: string): Promise<Advisory | null> =>
    elevated(async (tx) => first(await tx.select().from(A()).where(eq(A().id, id)))),
  list: (filter: { listingId?: string; publisherId?: string; states?: AdvisoryState[]; publishedSince?: Date; limit?: number } = {}): Promise<Advisory[]> =>
    elevated(async (tx) => {
      const where: SQL[] = [];
      if (filter.listingId) where.push(eq(A().listingId, filter.listingId));
      if (filter.publisherId) where.push(eq(A().publisherId, filter.publisherId));
      if (filter.states?.length) where.push(inArray(A().state, filter.states));
      if (filter.publishedSince) where.push(gte(A().publishedAt, filter.publishedSince));
      return tx.select().from(A()).where(and(...where)).orderBy(desc(A().createdAt)).limit(filter.limit ?? 500);
    }),
  insert: (values: PluginAdvisoryInsert): Promise<Advisory> =>
    elevated(async (tx) => (await tx.insert(A()).values(values).returning())[0] as Advisory),
  /** Update, but only from `fromState` (the optimistic lock on publish / withdraw / edit). */
  transition: (id: string, fromState: AdvisoryState, patch: Partial<PluginAdvisoryInsert>): Promise<Advisory | null> =>
    elevated(async (tx) => first(await tx.update(A()).set({ ...patch, updatedAt: new Date() })
      .where(and(eq(A().id, id), eq(A().state, fromState))).returning())),
  remove: (id: string): Promise<void> =>
    elevated(async (tx) => { await tx.delete(A()).where(eq(A().id, id)); }),
};

export const deliveryStore = {
  /** The orgs already told about `advisoryId`. */
  orgsFor: (advisoryId: string): Promise<string[]> =>
    elevated(async (tx) => (await tx.select().from(D()).where(eq(D().advisoryId, advisoryId))).map((r) => r.orgId)),
  /** Record that `orgIds` were told (a duplicate from a racing retry is harmless). */
  record: async (advisoryId: string, orgIds: readonly string[]): Promise<void> => {
    // One transaction per row: a unique violation aborts only its own.
    for (const orgId of orgIds) {
      try {
        await elevated(async (tx) => { await tx.insert(D()).values({ advisoryId, orgId }); });
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err;
      }
    }
  },
};

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

function invalid(message: string): never {
  throw new EcosystemError(ErrorCode.VALIDATION_ERROR, message);
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
    const normalized = /^cve-/i.test(id) ? id.toUpperCase() : id;
    if (!out.includes(normalized)) out.push(normalized);
  }
  if (out.length > ADVISORY_MAX_IDS) invalid(`At most ${ADVISORY_MAX_IDS} vulnerability ids per advisory`);
  return out;
}

/** Details markdown → the stored markdown + its SERVER-SANITIZED html (G6). */
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

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

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
  const listingMap = new Map<string, PluginListing | null>();
  for (const id of listingIds) listingMap.set(id, await listings.byId(id));
  const pubMap = new Map<string, Publisher | null>();
  for (const id of new Set(rows.map((a) => a.publisherId))) pubMap.set(id, await publishers.byId(id));
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
 * system org, so the publisher's members can never decide it (§3.0.1).
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
  emitPluginAudit({
    action: 'plugin.advisory.create',
    actorId: createdBy,
    orgId: SYSTEM_ORG_ID,
    ...(publisher.ownerOrgId ? { affectedOrgId: publisher.ownerOrgId } : {}),
    targetType: 'plugin-advisory',
    targetId: advisory.id,
    details: { source, listing: `${publisher.handle}/${listing.name}`, severity: fields.severity, affectedRange: fields.affectedRange, cveCount: fields.cveIds.length, requestId: request.id, ...(input.auditDetails ?? {}) },
  });
  emitCounter('ecosystem_advisory_drafts_total', { source });
  return { advisory, request };
}

/** The listing an advisory is about, with its publisher (404 when either is gone). */
async function listingWithPublisher(listingId: unknown): Promise<{ listing: PluginListing; publisher: Publisher }> {
  if (typeof listingId !== 'string' || listingId === '') throw new EcosystemError(ErrorCode.MISSING_REQUIRED_FIELD, 'listingId is required');
  const listing = await listings.byId(listingId);
  const publisher = listing ? await publishers.byId(listing.publisherId) : null;
  if (!listing || !publisher) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Listing not found');
  return { listing, publisher };
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
  const open = (await requests.list({ statuses: OPEN_STATUSES, kinds: ['advisory'], listingId: updated.listingId }))
    .find((r) => (r.payload as { advisoryId?: string }).advisoryId === id);
  if (open) {
    await requests.transition(open.id, open.status, {
      payload: { ...open.payload, severity: updated.severity, summary: updated.summary, affectedRange: updated.affectedRange },
    });
  }
  const publisher = await publishers.byId(updated.publisherId);
  emitPluginAudit({
    action: 'plugin.advisory.update',
    actorId: actorId({ userId: caller.userId }),
    orgId: SYSTEM_ORG_ID,
    ...(publisher?.ownerOrgId ? { affectedOrgId: publisher.ownerOrgId } : {}),
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
  try {
    await enqueueEcosystemNotification('N20', recipients, {
      subject: `Security advisory draft (${a.severity}): ${ref}`.slice(0, 500),
      text: [
        `A private ${a.severity} advisory draft was opened for ${ref} (${a.affectedRange}): ${a.summary}`,
        ...(a.cveIds.length ? [`Vulnerabilities: ${a.cveIds.slice(0, 20).join(', ')}${a.cveIds.length > 20 ? ', …' : ''}`] : []),
        'It is not public. An Ecosystem Manager reviews and publishes it; publishers can ship a fixed version through the security-fix lane meanwhile.',
      ].join('\n\n').slice(0, 10_000),
    }, { immediate: true });
  } catch (err) {
    emitCounter('ecosystem_notification_failed_total', { event: 'N20' });
    logger.warn('Advisory draft notice not sent', { advisoryId: a.id, error: errorMessage(err) });
  }
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
    if (!listing || !(ACTIVE_LISTING_STATES as readonly string[]).includes(listing.state)) return null;
    const publisher = await publishers.byId(listing.publisherId);
    if (!publisher || publisher.suspendedAt) return null;

    const covered = new Set((await advisoryStore.list({ listingId: listing.id }))
      .filter((a) => advisoryRangeCovers(a.affectedRange, lv.version))
      .flatMap((a) => a.cveIds ?? []));
    const fresh = input.findings.filter((f) => VULN_ID.test(f.id) && !covered.has(/^cve-/i.test(f.id) ? f.id.toUpperCase() : f.id));
    const ids = parseVulnIds([...new Set(fresh.map((f) => f.id))].slice(0, ADVISORY_MAX_IDS));
    if (ids.length === 0) {
      emitCounter('ecosystem_advisory_rescan_deduplicated_total', {});
      return null;
    }
    const kept = fresh.filter((f) => ids.includes(/^cve-/i.test(f.id) ? f.id.toUpperCase() : f.id));
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
    emitCounter('ecosystem_advisory_rescan_draft_failed_total', {});
    logger.error('Could not open the rescan advisory draft', { listingVersionId: input.listingVersion.id, error: errorMessage(err) });
    return null;
  }
}

/**
 * The W4 HOOK (review-hooks.ts `setReviewSecurityReportHandler`, registered by
 * {@link registerAdvisoryHooks}): a review report flagged as a SECURITY issue
 * opens a PRIVATE advisory draft on the listing. W4 already sent N19, so this
 * sends nothing. Idempotent per review: another report on the same review
 * returns the existing draft. The range starts at the reviewed version (else
 * the listing's latest) and the severity at `high`; an Ecosystem Manager edits
 * both before publishing. The reporter is never recorded on the draft or in
 * audit (the publisher's admins read both) — the draft is the system's; the
 * reporter's text stays in the private request payload, never in the details
 * that would become public.
 */
export async function openReviewAdvisoryDraft(report: ReviewSecurityReport): Promise<Advisory> {
  const { listing, publisher } = await listingWithPublisher(report.listingId);
  const existing = (await requests.list({ kinds: ['advisory'], listingId: listing.id, limit: 1000 }))
    .find((r) => (r.payload as { reviewId?: string }).reviewId === report.reviewId);
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

/** Register the advisory side of the review-report seam (once, at mount). */
export function registerAdvisoryHooks(): void {
  setReviewSecurityReportHandler(async (report) => { await openReviewAdvisoryDraft(report); });
}

// -----------------------------------------------------------------------------
// Publish (the approved `advisory` request), discard, withdraw
// -----------------------------------------------------------------------------

/** Every org whose install reaches a version `a` covers (the §5b "installing orgs"). */
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
    if (told > 0) emitCounter('ecosystem_advisory_notified_orgs_total', {}, told);
    return told;
  } catch (err) {
    emitCounter('ecosystem_notification_failed_total', { event: 'N21' });
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
  emitPluginAudit({
    action: 'plugin.advisory.publish',
    actorId: actor,
    orgId: SYSTEM_ORG_ID,
    ...(publisher.ownerOrgId ? { affectedOrgId: publisher.ownerOrgId } : {}),
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
  emitCounter('ecosystem_advisories_published_total', { severity: published.severity });
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
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 1000) : '';
  if (!reason) throw new EcosystemError(ErrorCode.MISSING_REQUIRED_FIELD, 'reason is required');
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
  emitPluginAudit({
    action: 'plugin.advisory.withdraw',
    actorId: actor,
    orgId: SYSTEM_ORG_ID,
    ...(publisher?.ownerOrgId ? { affectedOrgId: publisher.ownerOrgId } : {}),
    targetType: 'plugin-advisory',
    targetId: id,
    details: { listing: `${publisher?.handle ?? ''}/${listing?.name ?? ''}`, severity: withdrawn.severity, reason: reason.slice(0, 200) },
  });
  emitCounter('ecosystem_advisories_withdrawn_total', {});
  if (listing && publisher) {
    // Exactly the orgs that were told it was published (the publisher among them).
    const told = await deliveryStore.orgsFor(id);
    const content = n21Content(withdrawn, listing, publisher, true, reason);
    const publisherOrg = publisher.ownerOrgId?.toLowerCase() ?? null;
    try {
      if (publisherOrg) await enqueueEcosystemNotification('N21', [publisherManagers(publisherOrg)], content, { immediate: true });
      const installers = told.filter((o) => o !== publisherOrg);
      for (let i = 0; i < installers.length; i += INSTALLER_RECIPIENT_CHUNK) {
        await enqueueEcosystemNotification('N21', installers.slice(i, i + INSTALLER_RECIPIENT_CHUNK).map(orgApprovers), content, { immediate: true });
      }
    } catch (err) {
      emitCounter('ecosystem_notification_failed_total', { event: 'N21' });
      logger.warn('Advisory withdrawal notice not sent', { advisoryId: id, error: errorMessage(err) });
    }
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

// -----------------------------------------------------------------------------
// Listed-version deprecation (W2 handoff)
// -----------------------------------------------------------------------------

function deprecationMessageOf(raw: unknown, required: boolean): string | null {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    if (required) throw new EcosystemError(ErrorCode.MISSING_REQUIRED_FIELD, 'message is required (why the version is deprecated and what to use instead)');
    return null;
  }
  if (typeof raw !== 'string') invalid('message must be a string');
  const message = raw.trim().replace(/\s+/g, ' ');
  if (message.length > DEPRECATION_MESSAGE_MAX) invalid(`message must be at most ${DEPRECATION_MESSAGE_MAX} characters`);
  return message;
}

/** N14 to the orgs whose install reaches the version. */
function notifyVersionDeprecated(publisher: Publisher, listing: PluginListing, version: string, message: string | null): Promise<number> {
  const ref = `${publisher.handle}/${listing.name}@${version}`;
  return notifyInstallers('N14', publisher, listing, {
    subject: `Plugin ${ref} is deprecated`,
    text: `${ref}, installed in your organization, was deprecated by its publisher${message ? `: ${message}` : '.'} `
      + 'It keeps resolving, but synth prints a warning. Move your pipelines to a supported version.',
  }, { version });
}

/** Mark one listed version deprecated (idempotent; a new message replaces the old one). Returns whether it was newly deprecated. */
async function markDeprecated(
  v: PluginListingVersion, listing: PluginListing, publisher: Publisher, message: string | null,
  audit: { actor: string; orgId: string; via: 'publisher' | 'system_org' | 'source_plugin' },
): Promise<boolean> {
  const fresh = v.deprecatedAt === null;
  if (!fresh && (v.deprecationMessage ?? null) === message) return false;
  await versions.update(v.id, { deprecatedAt: v.deprecatedAt ?? new Date(), deprecationMessage: message });
  emitPluginAudit({
    action: 'plugin.version.deprecate',
    actorId: audit.actor,
    orgId: audit.orgId,
    ...(publisher.ownerOrgId ? { affectedOrgId: publisher.ownerOrgId } : {}),
    targetType: 'plugin-listing-version',
    targetId: v.id,
    details: { listing: `${publisher.handle}/${listing.name}`, version: v.version, deprecated: true, via: audit.via },
  });
  if (fresh) await notifyVersionDeprecated(publisher, listing, v.version, message);
  return fresh;
}

/**
 * POST /plugins/publisher/listings/:listingId/deprecate — the publisher
 * deprecates one of its OWN listed versions, at once and without review: it
 * only narrows (lookup warns, AI selection skips it, N14 to installers). There
 * is no tenant un-deprecate.
 */
export async function deprecateOwnListedVersion(caller: Caller, listingId: string, body: Record<string, unknown>) {
  assertRootOrg(caller);
  if (!can(caller, 'plugins:publish')) throw new EcosystemError(ErrorCode.INSUFFICIENT_PERMISSIONS, 'Deprecating needs plugins:publish');
  const publisher = await ownPublisher(caller);
  const listing = await listings.byId(listingId);
  if (!listing || listing.publisherId !== publisher.id) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Listing not found');
  if (typeof body.version !== 'string' || body.version === '') throw new EcosystemError(ErrorCode.MISSING_REQUIRED_FIELD, 'version is required');
  const v = await versions.get(listing.id, body.version);
  if (!v) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Version not found');
  const message = deprecationMessageOf(body.message, true);
  await markDeprecated(v, listing, publisher, message, { actor: actorId({ userId: caller.userId }), orgId: caller.orgId, via: 'publisher' });
  return listingView((await listings.byId(listing.id))!, publisher, { versions: await versions.forListings([listing.id]) });
}

/** POST /plugins/ecosystem/listings/:id/versions/:version/deprecate — the system org deprecates (or, `deprecated: false`, clears) a listed version. */
export async function setListedVersionDeprecation(caller: Caller, listingId: string, version: string, body: Record<string, unknown>) {
  if (!can(caller, 'plugins:moderate')) throw new EcosystemError(ErrorCode.INSUFFICIENT_PERMISSIONS, 'Deprecating needs plugins:moderate');
  const { listing, publisher } = await listingWithPublisher(listingId);
  const v = await versions.get(listing.id, version);
  if (!v) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Version not found');
  const actor = actorId({ userId: caller.userId });
  if (body.deprecated === false) {
    if (v.deprecatedAt !== null) {
      await versions.update(v.id, { deprecatedAt: null, deprecationMessage: null });
      emitPluginAudit({
        action: 'plugin.version.deprecate',
        actorId: actor,
        orgId: SYSTEM_ORG_ID,
        ...(publisher.ownerOrgId ? { affectedOrgId: publisher.ownerOrgId } : {}),
        targetType: 'plugin-listing-version',
        targetId: v.id,
        details: { listing: `${publisher.handle}/${listing.name}`, version, deprecated: false, via: 'system_org' },
      });
    }
  } else {
    await markDeprecated(v, listing, publisher, deprecationMessageOf(body.message, false), { actor, orgId: SYSTEM_ORG_ID, via: 'system_org' });
  }
  return listingView((await listings.byId(listing.id))!, publisher, { versions: await versions.forListings([listing.id]) });
}

/**
 * Deprecating an org plugin row carries over to every listing version
 * published FROM it (W0.4 `POST /plugins/:id/deprecate` and a `lifecycle:
 * deprecated` update, through deprecation-notice.ts). Never throws; returns how
 * many listed versions were newly deprecated.
 */
export async function deprecateListedFromSource(
  plugin: { id: string; orgId: string; deprecationMessage?: string | null },
  actor: string,
): Promise<number> {
  try {
    const listed = await versions.bySourcePlugins([plugin.id]);
    let count = 0;
    for (const v of listed) {
      const listing = await listings.byId(v.listingId);
      const publisher = listing ? await publishers.byId(listing.publisherId) : null;
      if (!listing || !publisher || v.deprecatedAt !== null) continue;
      if (await markDeprecated(v, listing, publisher, plugin.deprecationMessage?.trim() || null, { actor, orgId: plugin.orgId, via: 'source_plugin' })) count++;
    }
    return count;
  } catch (err) {
    logger.warn('Listed-version deprecation from the source plugin failed', { pluginId: plugin.id, error: errorMessage(err) });
    return 0;
  }
}
