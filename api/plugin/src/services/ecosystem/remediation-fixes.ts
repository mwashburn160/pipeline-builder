// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a nightly CVE remediation meets the plugin ecosystem
 * (docs/plugin-publishing.md "Scan gates"):
 *
 *  - **Official catalog fixes.** Tenants run Official plugins through the
 *    `pipeline-builder` listings, not the system-org rows. Once a system-org
 *    fix version is published, {@link openOfficialListingFix} opens a
 *    new-version publish request on its listing — submitted by the
 *    `plugin-remediation` service account, digest pinned (the version is
 *    frozen at that digest), `remediation_id` set. The seeded "Remediation
 *    fixes" rule (`remediationOnly`) approves it when the ecosystem gates pass
 *    (signed, scanned, no new Critical/High, no new secrets/egress/required
 *    inputs/root); anything else waits for a manager. When the listing version
 *    is live, {@link startOfficialFixRollout} starts Stage 3 for every org
 *    using the listing (`orgId: null`).
 *  - **The patch export.** An Official fix's patch is re-rooted at the plugin's
 *    `deploy/plugins/<category>/<name>/` directory ({@link officialExportDiff})
 *    and stored with the remediation ({@link storeOfficialExport}) for
 *    maintainers to merge into the repository. No pull request, no GitHub
 *    token: system-org admins download it (`GET /plugins/remediations/:id/export`).
 *  - **Third-party listings** are never rebuilt. {@link sendPublisherFixRequest}
 *    sends the publisher a fix request (N40, with the findings and the
 *    suggested patch) and tells the listing's installers it was sent.
 *  - An org plugin that is ALSO listed reaches its listing installers only
 *    through the publisher's normal new-version request: nothing here
 *    publishes it.
 *
 * Nothing happens while the operator knob `PLUGIN_REMEDIATION_ENABLED` is off.
 */

import { GetObjectCommand } from '@aws-sdk/client-s3';
import {
  callInternal,
  createLogger,
  errorMessage,
  getServiceAuthHeader,
  InternalHttpClient,
  isSystemOrgId,
  PIPELINE_INTERNAL,
  PLUGIN_REMEDIATION_SUBMITTER,
  remediationExportKey,
  SYSTEM_ORG_ID,
  SYSTEM_PLUGIN_REMEDIATION,
  type ContractHttpClient,
  type PluginScanFinding,
  type RemediationClearedFinding,
  type RemediationRemainingFinding,
} from '@pipeline-builder/api-core';
import { s3Client } from '@pipeline-builder/api-core/s3';
import { incCounter } from '@pipeline-builder/api-server';
import { Config } from '@pipeline-builder/pipeline-core';
import { OFFICIAL_PUBLISHER_HANDLE, schema, type PluginPublishRequest, type PluginRemediation } from '@pipeline-builder/pipeline-data';
import { eq } from 'drizzle-orm';

import { type Caller } from './context.js';
import { submitRemediationFix } from './requests.js';
import { elevated, listings, plugins, publishers, requests } from './store.js';
import { remediationConfig } from '../../config.js';
import { remediationNoticesEnabled, sendRemediationNotice } from '../remediation-notices.js';

const logger = createLogger('ecosystem-remediation-fixes');

/** The largest suggested patch read into a fix request. */
export const SUGGESTED_PATCH_MAX_BYTES = 64 * 1024;

const R = () => schema.pluginRemediation;

async function remediationById(id: string): Promise<PluginRemediation | null> {
  const rows = await elevated((tx) => tx.select().from(R()).where(eq(R().id, id))) as PluginRemediation[];
  return rows[0] ?? null;
}

async function updateRemediation(id: string, patch: Partial<PluginRemediation>): Promise<void> {
  await elevated((tx) => tx.update(R()).set({ ...patch, updatedAt: new Date() }).where(eq(R().id, id)));
}

/**
 * The submitter of an Official fix's publish request: the `plugin-remediation`
 * service account in the system org, holding only what a version request
 * needs. Its actor id is SYSTEM_PLUGIN_REMEDIATION, so the request's audit
 * entries are separable from a person's.
 */
export function remediationSubmitter(): Caller {
  return {
    userId: SYSTEM_PLUGIN_REMEDIATION,
    orgId: SYSTEM_ORG_ID.toLowerCase(),
    principalType: 'service_account',
    name: PLUGIN_REMEDIATION_SUBMITTER,
    isSuperAdmin: false,
    permissions: ['plugins:read', 'plugins:publish'],
    features: [],
    readOnlySession: false,
  };
}

// -----------------------------------------------------------------------------
// Official catalog fixes
// -----------------------------------------------------------------------------

/** Advisory ids and severity counts the fix clears (from the targeted findings it cleared). */
export function clearedFacts(targeted: readonly PluginScanFinding[], cleared: readonly RemediationClearedFinding[]): { advisoryIds: string[]; criticalCleared: number; highCleared: number; kev: boolean } {
  const ids = new Set(cleared.map((c) => c.id));
  const hit = targeted.filter((f) => ids.has(f.id));
  const unique = (sev: 'critical' | 'high') => new Set(hit.filter((f) => f.severity === sev).map((f) => f.id)).size;
  return {
    advisoryIds: [...ids].sort().slice(0, 500),
    criticalCleared: unique('critical'),
    highCleared: unique('high'),
    kev: hit.some((f) => f.kev === true),
  };
}

/**
 * Open the new-version publish request for a published system-org fix on its
 * Official listing. Idempotent: a remediation that already has a request
 * answers it (and an open request for the same version is adopted). Returns
 * null when there is nothing to publish to (remediation off, not a system-org
 * remediation, no Official listing of the name) or the version moved off the
 * remediation's digest. Never throws for a refused submit (a red gate leaves
 * the request unopened; the refusal is logged and counted).
 */
export async function openOfficialListingFix(input: { remediationId: string; toPluginId: string; toVersion: string; digest: string }): Promise<{ requestId: string } | null> {
  if (!remediationNoticesEnabled()) return null;
  const row = await remediationById(input.remediationId);
  if (!row || !isSystemOrgId(row.orgId)) {
    logger.warn('Official listing fix for a remediation that is not the system org\'s', { remediationId: input.remediationId });
    return null;
  }
  if (row.publishRequestId) return { requestId: row.publishRequestId };
  const official = await publishers.byHandle(OFFICIAL_PUBLISHER_HANDLE);
  const plugin = await plugins.byId(input.toPluginId, row.orgId);
  if (!official || !plugin || plugin.version !== input.toVersion) return null;
  // The digest the remediation verified is the one that is listed, or nothing is.
  if (plugin.imageDigest !== input.digest) {
    incCounter('plugin_remediation_listing_fixes_total', { outcome: 'digest_moved' });
    logger.warn('Official fix digest moved since it was verified; not listed', { remediationId: row.id });
    return null;
  }
  const listing = await listings.byName(official.id, plugin.name);
  if (!listing) return null;

  let requestId: string;
  let status: string;
  try {
    const { request } = await submitRemediationFix(remediationSubmitter(), plugin.id, row.id);
    requestId = request.id;
    status = request.status;
  } catch (err) {
    const e = err as { code?: string; details?: { requestId?: unknown } };
    if (e.code === 'DUPLICATE_ENTRY' && typeof e.details?.requestId === 'string') {
      requestId = e.details.requestId;
      status = (await requests.byId(requestId))?.status ?? 'pending';
    } else {
      incCounter('plugin_remediation_listing_fixes_total', { outcome: 'refused' });
      logger.warn('Official fix publish request refused', { remediationId: row.id, code: e.code ?? 'error', error: errorMessage(err) });
      return null;
    }
  }
  await updateRemediation(row.id, { publishRequestId: requestId });
  incCounter('plugin_remediation_listing_fixes_total', { outcome: status === 'approved' ? 'auto_approved' : 'pending' });
  // The rollout starts from the request's execution (services/ecosystem/
  // execution.ts → onRemediationRequestPublished), in-line after an automatic
  // approval or later after a manager's.
  return { requestId };
}

/**
 * Called when a remediation's publish request has published its listing
 * version (in-line after an automatic approval, or from the execution of a
 * manager's approval). Starts the Official rollout. Never throws.
 */
export async function onRemediationRequestPublished(r: Pick<PluginPublishRequest, 'remediationId' | 'kind'>): Promise<void> {
  if (r.kind !== 'new_version' || !r.remediationId) return;
  await startOfficialFixRollout(r.remediationId);
}

/** The pipeline service client (swappable in tests). */
let pipelineClient: (() => ContractHttpClient) | null = null;

/** Test hook: replace the pipeline service client (nothing restores the live one but passing nothing). */
export function setRemediationPipelineClientForTests(client?: ContractHttpClient): void {
  pipelineClient = client ? () => client : null;
}

function livePipelineClient(): ContractHttpClient {
  if (pipelineClient) return pipelineClient();
  const { services } = Config.get('server');
  return new InternalHttpClient({ host: services.pipelineHost, port: services.pipelinePort }) as unknown as ContractHttpClient;
}

/**
 * Start Stage 3 for a published Official fix across every org using the
 * listing (`orgId: null`, `publisher: pipeline-builder`). Idempotent on the
 * pipeline side (per remediation). Moves the remediation from `published` to
 * `rolling_out` when the rollout starts. Returns whether it started (or was
 * already running). Never throws.
 */
export async function startOfficialFixRollout(remediationId: string): Promise<boolean> {
  if (!remediationNoticesEnabled()) return false;
  try {
    const row = await remediationById(remediationId);
    if (!row || !row.toVersion || !row.toPluginId || !isSystemOrgId(row.orgId)) return false;
    const facts = clearedFacts(row.targeted ?? [], row.cleared ?? []);
    const res = await callInternal(livePipelineClient(), PIPELINE_INTERNAL.startRemediationRollout, {
      params: { remediationId: row.id },
      body: {
        orgId: null,
        plugin: row.pluginName,
        publisher: OFFICIAL_PUBLISHER_HANDLE,
        fromVersion: row.fromVersion,
        toVersion: row.toVersion,
        toPluginId: row.toPluginId,
        ...facts,
      },
      options: {
        headers: { Authorization: getServiceAuthHeader({ serviceName: 'plugin', orgId: SYSTEM_ORG_ID, role: 'member' }) },
        maxRetries: 2,
      },
    });
    if (!res.ok) {
      incCounter('plugin_remediation_listing_fixes_total', { outcome: 'rollout_not_started' });
      logger.warn('Official fix rollout not started', { remediationId: row.id, reason: res.reason, ...(res.reason === 'status' ? { status: res.status } : {}) });
      return false;
    }
    if (row.stage === 'published') await updateRemediation(row.id, { stage: 'rolling_out' });
    return true;
  } catch (err) {
    incCounter('plugin_remediation_listing_fixes_total', { outcome: 'rollout_not_started' });
    logger.warn('Official fix rollout not started', { remediationId, error: errorMessage(err) });
    return false;
  }
}

// -----------------------------------------------------------------------------
// The deploy/plugins/** patch export
// -----------------------------------------------------------------------------

const CATEGORY = /^[a-z][a-z0-9-]{0,63}$/;
const NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

/** The repository directory of an Official plugin: `deploy/plugins/<category>/<name>/` (or `deploy/plugins/<name>/` without a category). */
export function officialPluginDir(pluginName: string, category?: string | null): string {
  if (!NAME.test(pluginName)) throw new Error('invalid plugin name');
  return category && CATEGORY.test(category) && category !== 'unknown'
    ? `deploy/plugins/${category}/${pluginName}/`
    : `deploy/plugins/${pluginName}/`;
}

/** A diff path, relative to the build context: no absolute paths, no `..`. */
function safeRelative(path: string): string | null {
  const p = path.replace(/^\.\//, '');
  if (p === '' || p.startsWith('/') || p.split('/').some((seg) => seg === '..')) return null;
  return p;
}

/**
 * Re-root a remediation diff (paths relative to the plugin's build context)
 * at the plugin's directory in the repository, so a maintainer applies it
 * with `git apply` from the repo root. Handles `diff --git`, `---`/`+++`
 * (with or without `a/`/`b/`, and `/dev/null`) and rename/copy headers.
 * Throws on a path that escapes the build context.
 */
export function officialExportDiff(diff: string, pluginName: string, category?: string | null): string {
  const dir = officialPluginDir(pluginName, category);
  const reroot = (raw: string, side: 'a' | 'b'): string => {
    if (raw === '/dev/null') return raw;
    const stripped = raw.replace(/^[ab]\//, '');
    const rel = safeRelative(stripped);
    if (!rel) throw new Error('patch path escapes the build context');
    return `${side}/${dir}${rel}`;
  };
  return diff.split('\n').map((line) => {
    let m = /^diff --git (\S+) (\S+)$/.exec(line);
    if (m) return `diff --git ${reroot(m[1]!, 'a')} ${reroot(m[2]!, 'b')}`;
    m = /^(---|\+\+\+) (\S+)(\t.*)?$/.exec(line);
    if (m) return `${m[1]} ${reroot(m[2]!, m[1] === '---' ? 'a' : 'b')}${m[3] ?? ''}`;
    m = /^(rename|copy) (from|to) (.+)$/.exec(line);
    if (m) {
      const rel = safeRelative(m[3]!);
      if (!rel) throw new Error('patch path escapes the build context');
      return `${m[1]} ${m[2]} ${dir}${rel}`;
    }
    return line;
  }).join('\n');
}

/** Writes one remediation artifact to plugin-sources (plugin-sources.ts `putRemediationArtifact`). */
export type RemediationArtifactWriter = (key: string, body: Buffer | string) => Promise<void>;

/**
 * Store an Official fix's export with the remediation (`…/remediations/<id>/export.diff`)
 * and record it (`export_key`) — under the FIX version's prefix once the fix is
 * published (`to_plugin_id` / `to_version`), so the from-version's purge never
 * takes it (remediation/publish.ts). The source diff is the remediation's own
 * `remediation.diff`; `put` is plugin-sources' `putRemediationArtifact` (passed
 * in by the engine, which already holds the storage module). Returns the key,
 * or null when the remediation isn't the system org's. Throws on a storage
 * failure (the caller decides).
 */
export async function storeOfficialExport(remediationId: string, diff: string, put: RemediationArtifactWriter, category?: string | null): Promise<string | null> {
  const row = await remediationById(remediationId);
  if (!row || !isSystemOrgId(row.orgId)) return null;
  const key = row.toPluginId && row.toVersion
    ? remediationExportKey(row.orgId, row.toPluginId, row.toVersion, row.id)
    : row.pluginId ? remediationExportKey(row.orgId, row.pluginId, row.fromVersion, row.id) : null;
  // Neither version is stored any more (both purged): nowhere to keep it.
  if (!key) return null;
  await put(key, officialExportDiff(diff, row.pluginName, category));
  await updateRemediation(row.id, { exportKey: key });
  return key;
}

// -----------------------------------------------------------------------------
// Third-party listings: the publisher fix request
// -----------------------------------------------------------------------------

/** Reads a suggested patch's text from plugin-sources (swappable in tests). */
export type PatchReader = (key: string) => Promise<string | null>;

const livePatchReader: PatchReader = async (key) => {
  const out = await s3Client().send(new GetObjectCommand({
    Bucket: remediationConfig().sourcesBucket,
    Key: key,
    Range: `bytes=0-${SUGGESTED_PATCH_MAX_BYTES - 1}`,
  }));
  return out.Body ? out.Body.transformToString('utf-8') : null;
};

let patchReader: PatchReader = livePatchReader;

/** Test hook: replace the suggested-patch reader (pass nothing to restore the live one). */
export function setSuggestedPatchReaderForTests(reader?: PatchReader): void {
  patchReader = reader ?? livePatchReader;
}

/**
 * A listed third-party version has fixable findings: the platform never
 * rebuilds it. Send its publisher a fix request (N40) with the findings and
 * the suggested patch, and tell its installers the request was sent.
 * Deduplicated per (listing, version, findings). An Official listing is
 * remediated through its system-org row instead, so it gets no request. Never
 * throws.
 */
export async function sendPublisherFixRequest(input: { listingId: string; version: string; remaining: RemediationRemainingFinding[]; suggestedPatchKey: string | null }): Promise<void> {
  if (!remediationNoticesEnabled() || input.remaining.length === 0) return;
  let suggestedPatch: string | null = null;
  if (input.suggestedPatchKey) {
    try {
      suggestedPatch = await patchReader(input.suggestedPatchKey);
    } catch (err) {
      // The request still goes out, with the findings and their fixed versions.
      logger.warn('Suggested patch unreadable; sending the fix request without it', { listingId: input.listingId, error: errorMessage(err) });
    }
  }
  await sendRemediationNotice({ code: 'N40', listingId: input.listingId, version: input.version, remaining: input.remaining, suggestedPatch });
}

/**
 * Who may fix a flagged version automatically (plan "Safety, ownership and
 * limits"): an org's own plugin row and the system org's (Official) rows are
 * remediated; a listing version is never rebuilt — the Official listing is
 * fixed through its system-org row, a third-party listing gets a fix request.
 */
export type RemediationOwnership = 'org' | 'official' | 'publisher_fix_request';

export function remediationOwnership(target: { kind: 'plugin'; orgId: string } | { kind: 'listing_version'; publisherHandle: string }): RemediationOwnership {
  if (target.kind === 'plugin') return isSystemOrgId(target.orgId) ? 'official' : 'org';
  return target.publisherHandle === OFFICIAL_PUBLISHER_HANDLE ? 'official' : 'publisher_fix_request';
}
