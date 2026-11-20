// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Nightly toolchain FIXES, propose-only (docs/plugin-publishing.md
 * "Remediation → toolchains").
 *
 * A managed toolchain release (`pipeline-bootstrap@V` + `cdk-synth@V`) flagged
 * by the nightly rescan, with PLUGIN_REMEDIATION_TOOLCHAINS=propose, is queued
 * as ONE `kind = 'toolchain'` remediation on its bootstrap row (queueing.ts).
 * The job ({@link runToolchainRemediation}):
 *
 *  1. reads the release's kept build inputs (toolchain-inputs.ts) — none →
 *     needs_owner (TOOLCHAIN_INPUTS_MISSING);
 *  2. runs the remediation ENGINE (Stage 1 rebuild on a freshly pulled base —
 *     the bootstrap's digest-pinned `ARG NODE_IMAGE` refreshed within its tag —
 *     then Stage 2 libraries) on the bootstrap, with library upgrades capped at
 *     PATCH whatever the system org's settings say; then on cdk-synth, built
 *     FROM the candidate bootstrap (`BOOTSTRAP_IMAGE` build arg, by digest). A
 *     half with nothing targeted keeps its image (the bootstrap) — cdk-synth is
 *     always rebuilt when the bootstrap is;
 *  3. verifies the PAIR strictly (toolchain-verify.ts) — targeted findings gone,
 *     no new Critical/High, the exact tool versions unchanged, `cdk synth` of
 *     the fixture app passing in both images;
 *  4. records a RELEASE CANDIDATE on the row (`toolchain_candidate`: digests,
 *     the next free patch release, the spec change sync-image-tags.sh
 *     --toolchain-only would make, stored as an exportable patch) and moves it
 *     to awaiting_approval. NEVER published here, whatever the org mode.
 *
 * Approval ({@link approveToolchainFix}: system org + plugins:write + step-up)
 * re-scans both candidate digests through the build gate and publishes the
 * release through the normal toolchain release path — both halves stored as
 * system-org versions (`persistVersion` → `deployVersion`, which registers the
 * `toolchain_release` row: it is then listed in the Toolchain console and
 * selectable as an org default) — then sends N34 naming the fixed release to
 * the orgs on the vulnerable one. Nobody is moved: orgs change release only
 * through their own toolchain default (or the platform default, which stays
 * the operator's console decision). Reject discards the candidate images.
 */

import * as fs from 'fs';
import path from 'path';

import {
  ACTIVE_BUILD_REMEDIATION_STAGES,
  createLogger,
  errorMessage,
  ErrorCode,
  MANAGED_TOOLCHAIN,
  nextRemediationVersion,
  recordAudit,
  remediationExportKey,
  SYSTEM_ORG_ID,
  SYSTEM_PLUGIN_REMEDIATION,
  TOOLCHAIN_FIX_MAX_GATE_REFUSALS,
  TOOLCHAIN_FIX_METRICS,
  TOOLCHAIN_FIX_PUBLISH_LEASE_MS,
  toolchainFromMetadata,
  type PluginRemediationSettings,
  type PluginScanFinding,
  type PluginToolchain,
  type RemediationClearedFinding,
  type RemediationFixMethod,
  type RemediationRemainingFinding,
  type RemediationRemainingReason,
  type ToolchainFixCandidate,
  type ToolchainFixDto,
  type ToolchainFixHalf,
  type ToolchainFixPublishState,
  type ToolchainFixRefusal,
} from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { schema, type Plugin, type PluginRemediation } from '@pipeline-builder/pipeline-data';
import AdmZip from 'adm-zip';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { runRemediationEngine, type EngineOutcome } from './engine.js';
import { advisoryIds, countCleared, countStage, sendOwnerRequest } from './lifecycle.js';
import type { ImageRef, RemediationPorts } from './ports.js';
import { recordFromRow } from './publish.js';
import { elevatedTx, getRemediation, newestCleanOwnerVersion, readSettings, updateRemediation } from './store.js';
import { liveToolchainInputs, type ToolchainInputFiles, type ToolchainInputsStore } from './toolchain-inputs.js';
import { TOOLCHAIN_SYNTH_SMOKE_COMMAND } from './toolchain-smoke.js';
import { refreshNodeImage, toolchainFromDockerfile, toolchainInputsOf, toolchainSpecChange, type ToolchainDir } from './toolchain-spec.js';
import { verifyToolchainCandidate, type ToolchainHalfEvidence } from './toolchain-verify.js';
import { remediationConfig } from '../../config.js';
import type { PluginRecordData } from '../../helpers/plugin-helpers.js';
import { EcosystemError } from '../ecosystem/context.js';
import { putRemediationArtifact } from '../plugin-sources.js';
import { sendRemediationNotice } from '../remediation-notices.js';
import { notifyToolchainHygiene } from '../toolchain-hygiene.js';
import { persistVersion } from '../version-persist.js';

const logger = createLogger('toolchain-remediation');

/** The engine's ports plus reading an image's labels (the toolchain LABELs). */
export interface ToolchainPorts extends RemediationPorts {
  imageLabels(ref: ImageRef): Promise<Record<string, string>>;
}

export interface ToolchainRunDeps {
  ports: ToolchainPorts;
  inputs?: ToolchainInputsStore;
  workRoot: string;
}

type Halves = Record<ToolchainDir, Plugin>;

const HALVES: readonly ToolchainDir[] = [MANAGED_TOOLCHAIN.bootstrap, MANAGED_TOOLCHAIN.synth];
const identity = (f: Pick<PluginScanFinding, 'id' | 'packageName'>): string => `${f.id}|${f.packageName.toLowerCase()}`;
const countCandidate = (outcome: 'proposed' | 'refused' | 'approved' | 'rejected'): void => incCounter(TOOLCHAIN_FIX_METRICS.candidates, { outcome });

/** Record one toolchain-fix audit entry (never throws). */
export function auditToolchainFix(action: 'toolchain.fix.proposed' | 'toolchain.fix.approved' | 'toolchain.fix.rejected', row: PluginRemediation, details: Record<string, unknown>, actorId: string = SYSTEM_PLUGIN_REMEDIATION, outcome: 'success' | 'failure' = 'success'): void {
  try {
    recordAudit({
      action,
      actorId,
      orgId: SYSTEM_ORG_ID,
      targetType: 'plugin_remediation',
      targetId: row.id,
      outcome,
      details: { fromRelease: row.fromVersion, ...(row.toolchainCandidate ? { toRelease: row.toolchainCandidate.toRelease } : {}), stage: row.stage, ...details },
    });
  } catch (err) {
    logger.warn('Toolchain fix audit failed', { remediationId: row.id, action, error: errorMessage(err) });
  }
}

/**
 * The settings a toolchain fix runs under: library upgrades capped at PATCH
 * whatever the org says (the effective level is the strictest of the org,
 * per-type and per-plugin levels, and patch is the strictest there is).
 */
export function toolchainRemediationSettings(settings: PluginRemediationSettings): PluginRemediationSettings {
  return { ...settings, libraryUpgradeLevel: 'patch' };
}

/** Both halves of `release` in the system org (live rows), or null when either is gone. */
export async function releaseHalves(release: string): Promise<Halves | null> {
  const p = schema.plugin;
  const rows = await elevatedTx((tx) => tx.select().from(p).where(and(
    eq(p.orgId, SYSTEM_ORG_ID), inArray(p.name, [...HALVES]), eq(p.version, release), isNull(p.deletedAt),
  ))) as Plugin[];
  const bs = rows.find((r) => r.name === MANAGED_TOOLCHAIN.bootstrap);
  const synth = rows.find((r) => r.name === MANAGED_TOOLCHAIN.synth);
  return bs && synth ? { 'pipeline-bootstrap': bs, 'cdk-synth': synth } : null;
}

/** Every release number either half or the release table holds (soft-deleted included: their numbers stay reserved). */
async function takenReleases(): Promise<string[]> {
  const p = schema.plugin;
  const [plugins, releases] = await elevatedTx(async (tx) => [
    await tx.select({ v: p.version }).from(p).where(and(eq(p.orgId, SYSTEM_ORG_ID), inArray(p.name, [...HALVES]))),
    await tx.select({ v: schema.toolchainRelease.releaseVersion }).from(schema.toolchainRelease),
  ]) as [Array<{ v: string }>, Array<{ v: string }>];
  return [...plugins, ...releases].map((r) => r.v);
}

const remainingOf = (f: PluginScanFinding, reason: RemediationRemainingReason, detail?: string): RemediationRemainingFinding => ({
  id: f.id,
  severity: f.severity,
  purl: f.purl,
  packageName: f.packageName,
  packageType: f.packageType,
  packageVersion: f.packageVersion,
  fixedIn: f.fixedIn,
  ...(f.kev ? { kev: true } : {}),
  reason,
  ...(detail ? { detail } : {}),
});

/** The remaining-finding reason a refusal is reported with. */
const REFUSAL_REASON: Readonly<Record<ToolchainFixRefusal, RemediationRemainingReason>> = {
  TOOLCHAIN_INPUTS_MISSING: 'no_source',
  NO_CANDIDATE: 'still_present',
  GATE_REFUSED: 'still_present',
  TARGETED_STILL_PRESENT: 'still_present',
  NEW_FINDINGS: 'new_findings',
  TOOL_VERSION_CHANGED: 'patch_broke_plugin',
  FIX_NOT_REPRODUCIBLE: 'no_patcher',
  SPEC_CHANGED: 'patch_broke_plugin',
  SYNTH_SMOKE_FAILED: 'patch_broke_plugin',
};

/** The targeted findings a half carries (by advisory × package, as verification counts them). */
function targetedIn(targeted: readonly PluginScanFinding[], half: Plugin): PluginScanFinding[] {
  const present = new Set((half.scanSummary?.findings ?? []).map(identity));
  return targeted.filter((f) => present.has(identity(f)));
}

/** Engine ports that serve a half's kept inputs as its build context (and its record's contract as the context's). */
function contextPorts(ports: ToolchainPorts, files: ToolchainInputFiles, buildArgs: Record<string, string>, record: PluginRecordData): RemediationPorts {
  return {
    ...ports,
    fetchSource: async () => 'ok',
    async openSource(_zip, workRoot) {
      const dir = fs.mkdtempSync(path.join(workRoot, 'toolchain-'));
      for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
      return { dir, dockerfile: 'Dockerfile', buildType: 'build_image', buildArgs };
    },
    // A toolchain half's contract is its stored record's: the spec is not a
    // build input the fix may change (verification refuses a changed spec).
    contractOf: async () => ({
      pluginType: record.pluginType,
      commands: record.commands ?? [],
      installCommands: record.installCommands ?? [],
      requiredMetadata: record.requiredMetadata ?? [],
      requiredVars: record.requiredVars ?? [],
      metadataTypes: record.metadataTypes ?? {},
      varsTypes: record.varsTypes ?? {},
      secrets: record.secrets ?? [],
      env: record.env ?? {},
    }),
  };
}

/** A candidate's patched build inputs (its ZIP's top-level text files). */
function patchedInputs(zip: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of new AdmZip(zip).getEntries()) {
    if (e.isDirectory) continue;
    out.set(e.entryName.replace(/^\.\//, ''), e.getData().toString('utf8'));
  }
  return toolchainInputsOf(out);
}

interface HalfRun {
  name: ToolchainDir;
  from: Plugin;
  ref: ImageRef;
  rebuilt: boolean;
  outcome: EngineOutcome | null;
  targeted: PluginScanFinding[];
  inputs: Map<string, string>;
  patched: Map<string, string>;
}

async function discardRebuilt(ports: RemediationPorts, runs: readonly HalfRun[]): Promise<void> {
  for (const r of runs) if (r.rebuilt) await ports.discardImage(r.ref).catch(() => undefined);
}

async function toNeedsOwner(row: PluginRemediation, remaining: RemediationRemainingFinding[], refusal: ToolchainFixRefusal | null, extra: Partial<PluginRemediation> = {}): Promise<'needs_owner'> {
  const done = (await updateRemediation(row.id, {
    stage: 'needs_owner', outcome: 'owner_request', remaining, finishedAt: new Date(), ...(refusal ? { error: refusal } : {}), ...extra,
  }, ACTIVE_BUILD_REMEDIATION_STAGES)) ?? row;
  countStage('needs_owner', 'owner_request');
  if (refusal) countCandidate('refused');
  await sendOwnerRequest(done, remaining, null);
  return 'needs_owner';
}

/**
 * One toolchain remediation run (the job calls it for a `kind = 'toolchain'`
 * row). Returns the stage it ended in.
 */
export async function runToolchainRemediation(row: PluginRemediation, deps: ToolchainRunDeps): Promise<PluginRemediation['stage'] | 'skipped'> {
  const { ports } = deps;
  const store = deps.inputs ?? liveToolchainInputs;
  const release = row.fromVersion;
  const halves = await releaseHalves(release);
  if (!halves) {
    await updateRemediation(row.id, { stage: 'failed', outcome: 'cancelled', error: 'VERSION_DELETED', finishedAt: new Date() }, ACTIVE_BUILD_REMEDIATION_STAGES);
    countStage('failed', 'cancelled');
    return 'failed';
  }
  // A newer release uploaded the normal way supersedes the fix.
  if (await newestCleanOwnerVersion(SYSTEM_ORG_ID, MANAGED_TOOLCHAIN.bootstrap, release)) {
    await updateRemediation(row.id, { stage: 'done', outcome: 'superseded', finishedAt: new Date() }, ACTIVE_BUILD_REMEDIATION_STAGES);
    countStage('done', 'superseded');
    return 'done';
  }
  const targeted = row.targeted ?? [];
  const expected = toolchainFromMetadata(halves['pipeline-bootstrap'].metadata);
  const kept = { 'pipeline-bootstrap': await store.read(release, 'pipeline-bootstrap'), 'cdk-synth': await store.read(release, 'cdk-synth') };
  if (!kept['pipeline-bootstrap']?.Dockerfile || !kept['cdk-synth']?.Dockerfile || !expected) {
    return toNeedsOwner(row, targeted.map((f) => remainingOf(f, 'no_source', 'TOOLCHAIN_INPUTS_MISSING')), 'TOOLCHAIN_INPUTS_MISSING');
  }

  const toRelease = nextRemediationVersion(release, await takenReleases(), 'patch');
  if (!toRelease) {
    await updateRemediation(row.id, { stage: 'failed', outcome: 'error', error: 'VERSION_NOT_SEMVER', finishedAt: new Date() }, ACTIVE_BUILD_REMEDIATION_STAGES);
    countStage('failed', 'error');
    return 'failed';
  }
  await updateRemediation(row.id, { stage: 'rebuild', startedAt: new Date() }, ['queued', 'rebuild', 'libraries']);

  const settings = toolchainRemediationSettings(await readSettings(SYSTEM_ORG_ID));
  const runs: HalfRun[] = [];
  const engineFor = async (name: ToolchainDir, files: Map<string, string>, buildArgs: Record<string, string>, aimed: PluginScanFinding[]): Promise<EngineOutcome> => {
    const from = halves[name];
    const record = recordFromRow(from);
    return runRemediationEngine({
      remediationId: row.id,
      orgId: SYSTEM_ORG_ID,
      plugin: {
        id: from.id,
        name,
        version: from.version,
        imageDigest: from.imageDigest ?? null,
        sourceKind: 'zip',
        sourceKey: null,
        sourceSha256: null,
        // The synth smoke runs once, on the verified pair, below.
        smokeTest: null,
        originalFindings: from.scanSummary?.findings ?? [],
        record,
      },
      targeted: aimed,
      settings,
      versionFor: () => toRelease,
      onStage: async (stage) => { await updateRemediation(row.id, { stage }, ['rebuild', 'libraries']); },
      workRoot: deps.workRoot,
    }, contextPorts(ports, Object.fromEntries(files), buildArgs, record));
  };

  try {
    // -- pipeline-bootstrap --------------------------------------------------------
    const bs = halves['pipeline-bootstrap'];
    const bsInputs = toolchainInputsOf(new Map(Object.entries(kept['pipeline-bootstrap'])));
    const bsTargets = targetedIn(targeted, bs);
    let baseImage: ToolchainFixCandidate['baseImage'] = null;
    if (bsTargets.length > 0) {
      const ctx = new Map(bsInputs);
      const refreshed = await refreshNodeImage(ctx.get('Dockerfile')!, (r) => ports.resolveDigest(r));
      if (refreshed) { ctx.set('Dockerfile', refreshed.dockerfile); baseImage = { from: refreshed.from, to: refreshed.to }; }
      const outcome = await engineFor('pipeline-bootstrap', ctx, {}, bsTargets);
      if (outcome.error) throw Object.assign(new Error(outcome.error), { code: outcome.error });
      if (!outcome.candidate) return await toNeedsOwner(row, outcome.remaining, 'NO_CANDIDATE', { cleared: [], fixMethods: [] });
      runs.push({ name: 'pipeline-bootstrap', from: bs, ref: outcome.candidate.ref, rebuilt: true, outcome, targeted: bsTargets, inputs: bsInputs, patched: patchedInputs(outcome.candidate.patched.zip) });
    } else {
      runs.push({ name: 'pipeline-bootstrap', from: bs, ref: { orgId: SYSTEM_ORG_ID, name: bs.name, digest: bs.imageDigest! }, rebuilt: false, outcome: null, targeted: [], inputs: bsInputs, patched: bsInputs });
    }

    // -- cdk-synth, FROM the candidate bootstrap --------------------------------------
    const synth = halves['cdk-synth'];
    const synthInputs = toolchainInputsOf(new Map(Object.entries(kept['cdk-synth'])));
    // Everything the bootstrap carried is inherited: its targets are cdk-synth's too.
    const synthTargets = [...new Map([...targetedIn(targeted, synth), ...bsTargets].map((f) => [identity(f), f])).values()];
    const synthOutcome = await engineFor('cdk-synth', synthInputs, { BOOTSTRAP_IMAGE: ports.imageReference(runs[0]!.ref) }, synthTargets);
    if (synthOutcome.error) throw Object.assign(new Error(synthOutcome.error), { code: synthOutcome.error });
    if (!synthOutcome.candidate) {
      await discardRebuilt(ports, runs);
      return await toNeedsOwner(row, synthOutcome.remaining, 'NO_CANDIDATE', { cleared: [], fixMethods: [] });
    }
    runs.push({ name: 'cdk-synth', from: synth, ref: synthOutcome.candidate.ref, rebuilt: true, outcome: synthOutcome, targeted: synthTargets, inputs: synthInputs, patched: patchedInputs(synthOutcome.candidate.patched.zip) });

    // -- verification ----------------------------------------------------------------
    const evidence: ToolchainHalfEvidence[] = [];
    for (const r of runs) {
      const original = r.from.scanSummary?.findings ?? [];
      evidence.push({
        name: r.name,
        targeted: r.targeted,
        original,
        scan: r.outcome?.candidate ? r.outcome.candidate.gated.scan : { findings: original, waivedKeys: new Set(r.from.scanSummary?.waived ?? []), refusal: null },
        labels: await ports.imageLabels(r.ref).catch(() => null),
        fixMethods: r.outcome?.fixMethods ?? [],
        spec: { before: r.inputs.get('plugin-spec.yaml') ?? null, after: r.patched.get('plugin-spec.yaml') ?? null },
      });
    }
    let smoke: 'passed' | 'failed' = 'passed';
    for (const r of runs) {
      if (!await ports.smokeTest(r.ref, TOOLCHAIN_SYNTH_SMOKE_COMMAND).then(() => true, () => false)) smoke = 'failed';
    }
    const verdict = verifyToolchainCandidate({
      halves: evidence,
      expected,
      dockerfileToolchain: toolchainFromDockerfile(runs[0]!.patched.get('Dockerfile') ?? ''),
      synthSmoke: smoke,
    });
    if (!verdict.ok) {
      await discardRebuilt(ports, runs);
      const detail = verdict.refusal!;
      const reason = REFUSAL_REASON[detail];
      logger.info('Toolchain candidate refused', { remediationId: row.id, refusal: detail, half: verdict.half, changes: verdict.changes });
      return await toNeedsOwner(row, targeted.map((f) => remainingOf(f, reason, detail)), detail, { cleared: [], fixMethods: [] });
    }

    // -- the release candidate --------------------------------------------------------
    const change = toolchainSpecChange({
      original: { 'pipeline-bootstrap': runs[0]!.inputs, 'cdk-synth': runs[1]!.inputs },
      patched: { 'pipeline-bootstrap': runs[0]!.patched, 'cdk-synth': runs[1]!.patched },
      toRelease,
    });
    const halfOf = (r: HalfRun): ToolchainFixHalf => ({
      name: r.name,
      fromPluginId: r.from.id,
      fromDigest: r.from.imageDigest ?? null,
      digest: r.ref.digest,
      rebuilt: r.rebuilt,
      cleared: r.outcome?.cleared ?? [],
      fixMethods: r.outcome?.fixMethods ?? [],
    });
    const candidate: ToolchainFixCandidate = {
      fromRelease: release,
      toRelease,
      toolchain: expected,
      bootstrap: halfOf(runs[0]!),
      cdkSynth: halfOf(runs[1]!),
      baseImage,
      sourceDigest: change.sourceDigest,
      buildInputs: { 'pipeline-bootstrap': Object.fromEntries(change.final['pipeline-bootstrap']), 'cdk-synth': Object.fromEntries(change.final['cdk-synth']) },
      synthSmoke: 'passed',
      verifiedAt: new Date().toISOString(),
    };
    let exportKey: string | null = remediationExportKey(SYSTEM_ORG_ID, row.pluginId, release, row.id);
    try {
      await putRemediationArtifact(exportKey, change.diff);
    } catch (err) {
      logger.warn('Toolchain spec patch not stored', { remediationId: row.id, error: errorMessage(err) });
      exportKey = null;
    }
    const cleared = dedupeCleared(runs.flatMap((r) => r.outcome?.cleared ?? []), targeted);
    const fixMethods = [...new Set(runs.flatMap((r) => r.outcome?.fixMethods ?? []))] as RemediationFixMethod[];
    const waiting = await updateRemediation(row.id, {
      stage: 'awaiting_approval',
      publishMode: 'propose',
      decidedAt: null,
      decidedBy: null,
      toolchainCandidate: candidate,
      exportKey,
      patchKey: exportKey,
      cleared,
      remaining: [],
      fixMethods,
      versionBump: 'patch',
      upgradeLevel: runs.map((r) => r.outcome?.upgradeLevel ?? null).find((l) => l !== null) ?? null,
    }, ACTIVE_BUILD_REMEDIATION_STAGES);
    if (!waiting) {
      await discardRebuilt(ports, runs);
      return 'skipped'; // cancelled while it ran
    }
    countStage('awaiting_approval', null);
    countCandidate('proposed');
    auditToolchainFix('toolchain.fix.proposed', waiting, {
      toRelease,
      digests: { [MANAGED_TOOLCHAIN.bootstrap]: candidate.bootstrap.digest, [MANAGED_TOOLCHAIN.synth]: candidate.cdkSynth.digest },
      cleared: advisoryIds(cleared),
      sourceDigest: candidate.sourceDigest.to,
    });
    await sendRemediationNotice({
      code: 'N36',
      orgId: SYSTEM_ORG_ID,
      remediationId: row.id,
      pluginName: MANAGED_TOOLCHAIN.bootstrap,
      fromVersion: release,
      toVersion: toRelease,
      awaitingApproval: true,
      cleared,
      remaining: [],
      proposeReasons: [],
    }).catch(() => undefined);
    return 'awaiting_approval';
  } catch (err) {
    await discardRebuilt(ports, runs);
    throw err;
  }
}

/** Cleared findings across both halves, once per targeted finding. */
function dedupeCleared(cleared: readonly RemediationClearedFinding[], targeted: readonly PluginScanFinding[]): RemediationClearedFinding[] {
  const wanted = new Set(targeted.map((f) => `${f.id}|${f.purl}`));
  const out = new Map<string, RemediationClearedFinding>();
  for (const c of cleared) {
    const k = `${c.id}|${c.purl}`;
    if (wanted.has(k) && !out.has(k)) out.set(k, c);
  }
  return [...out.values()];
}

// =============================================================================
// Decisions (routes/toolchain-fixes.ts)
// =============================================================================

const stageConflict = (stage: string, details: Record<string, unknown> = {}): EcosystemError =>
  new EcosystemError(ErrorCode.REMEDIATION_STAGE_CONFLICT, `Not possible while the toolchain fix is ${stage}`, { stage, ...details });

/** A toolchain fix of the system org (null otherwise: the routes answer 404). */
export async function getToolchainFix(id: string): Promise<PluginRemediation | null> {
  const row = await getRemediation(id);
  return row && row.kind === 'toolchain' && row.orgId.toLowerCase() === SYSTEM_ORG_ID.toLowerCase() ? row : null;
}

/** The newest toolchain fixes, newest first. */
export async function listToolchainFixes(limit = 50): Promise<PluginRemediation[]> {
  const R = schema.pluginRemediation;
  return await elevatedTx((tx) => tx.select().from(R)
    .where(and(eq(R.orgId, SYSTEM_ORG_ID.toLowerCase()), eq(R.kind, 'toolchain')))
    .orderBy(desc(R.createdAt), desc(R.id)).limit(limit)) as PluginRemediation[];
}

export interface DecisionDeps { ports: ToolchainPorts; inputs?: ToolchainInputsStore }

function assertDecidable(row: PluginRemediation): ToolchainFixCandidate {
  if (row.stage !== 'awaiting_approval' || !row.toolchainCandidate) throw stageConflict(row.stage);
  return row.toolchainCandidate;
}

/** The fix version's record: the flagged half's, renumbered, with provenance. */
function releaseRecord(from: Plugin, c: ToolchainFixCandidate, cleared: readonly RemediationClearedFinding[]): PluginRecordData {
  const base = recordFromRow(from);
  const ids = advisoryIds(cleared);
  return {
    ...base,
    version: c.toRelease,
    changelog: `${c.toRelease}: Security fix of toolchain release ${c.fromRelease} by Pipeline Builder toolchain remediation: clears ${ids.join(', ') || 'its targeted findings'}. Tool versions unchanged.`.slice(0, 10_000),
    quotaResetAt: null,
  };
}

const leaseFrom = (now: Date): string => new Date(now.getTime() + TOOLCHAIN_FIX_PUBLISH_LEASE_MS).toISOString();
const EXPIRED = new Date(0).toISOString();

/**
 * Claim the publish of a candidate: one conditional UPDATE that succeeds only
 * while the row awaits a decision AND nobody holds an unexpired lease on it
 * (no publish yet, or a stuck one whose lease passed). Two approvers, or an
 * approver and the sweep, can never both run it.
 */
async function claimPublish(row: PluginRemediation, state: ToolchainFixPublishState, decided: { by: string; reason: string | null } | null, now: Date): Promise<PluginRemediation | null> {
  const R = schema.pluginRemediation;
  const rows = await elevatedTx((tx) => tx.update(R).set({
    toolchainCandidate: sql`jsonb_set(${R.toolchainCandidate}, '{publish}', ${JSON.stringify(state)}::jsonb)`,
    ...(decided ? { decidedBy: decided.by, decidedAt: now, decisionReason: decided.reason } : {}),
    updatedAt: now,
  }).where(and(
    eq(R.id, row.id),
    eq(R.stage, 'awaiting_approval'),
    sql`(${R.toolchainCandidate}->'publish' IS NULL OR (${R.toolchainCandidate}->'publish'->>'leaseUntil')::timestamptz < ${now.toISOString()}::timestamptz)`,
  )).returning()) as PluginRemediation[];
  return rows[0] ?? null;
}

/** The live system-org row of `name@version`, if one exists. */
async function storedHalf(name: string, version: string): Promise<Pick<Plugin, 'id' | 'imageDigest'> | null> {
  const p = schema.plugin;
  const [r] = await elevatedTx((tx) => tx.select({ id: p.id, imageDigest: p.imageDigest }).from(p)
    .where(and(eq(p.orgId, SYSTEM_ORG_ID), eq(p.name, name), eq(p.version, version), isNull(p.deletedAt))).limit(1)) as Array<Pick<Plugin, 'id' | 'imageDigest'>>;
  return r ?? null;
}

/**
 * Publish an approved candidate as the new toolchain release — RESUMABLE and
 * idempotent. The approval is recorded first (`toolchain_candidate.publish`:
 * who, when, a lease, and per-step progress), then each step runs only if it
 * has not already happened:
 *   1. store pipeline-bootstrap@<toRelease> (an existing row with the candidate's
 *      digest is reused; a different digest under that number refuses);
 *   2. the same for cdk-synth;
 *   3. keep the release's build inputs;
 *   4. send N34 to the orgs on the vulnerable release;
 * then the row is `done`. Halves not yet stored are re-scanned through the
 * build gate first; a refusal before anything was stored returns the
 * candidate to undecided (409). A failure part-way releases the lease and
 * keeps the progress: the next approve (or the nightly sweep, for a crash
 * that never released it) resumes the remaining steps, with the same number.
 */
export async function approveToolchainFix(row: PluginRemediation, actor: string, reason: string | null, deps: DecisionDeps): Promise<PluginRemediation> {
  // The operator knob off stops every remediation write, an approval's publish (and its resume) included.
  if (!remediationConfig().enabled) throw new EcosystemError(ErrorCode.SERVICE_UNAVAILABLE, 'Plugin remediation is turned off by the operator');
  const c = assertDecidable(row);
  const now = new Date();
  const resuming = !!c.publish;
  const halves = await releaseHalves(c.fromRelease);
  if (!halves) throw stageConflict('orphaned', { reason: 'FROM_RELEASE_DELETED' });
  if (!resuming && (await takenReleases()).includes(c.toRelease)) throw stageConflict('outdated', { reason: 'RELEASE_VERSION_TAKEN', toRelease: c.toRelease });
  const state: ToolchainFixPublishState = c.publish
    ? { ...c.publish, leaseUntil: leaseFrom(now), resumes: c.publish.resumes + 1 }
    : { approvedBy: actor, approvedAt: now.toISOString(), leaseUntil: leaseFrom(now), steps: { bootstrap: null, cdkSynth: null, inputs: false, notice: false }, resumes: 0 };
  const claimed = await claimPublish(row, state, resuming ? null : { by: actor, reason }, now);
  if (!claimed) throw stageConflict('being published', { reason: 'PUBLISH_IN_PROGRESS' });

  // Every write of the publish state is conditional on STILL holding the lease
  // this attempt claimed (the leaseUntil it last wrote): an attempt whose lease
  // passed and was taken over by a resume (or another approver) can neither
  // renew, release nor overwrite the new holder's lease and progress.
  const R = schema.pluginRemediation;
  const writeHeld = async (held: string, set: Partial<typeof R.$inferInsert>): Promise<boolean> => {
    const rows = await elevatedTx((tx) => tx.update(R).set({ ...set, updatedAt: new Date() }).where(and(
      eq(R.id, row.id),
      eq(R.stage, 'awaiting_approval'),
      sql`${R.toolchainCandidate}->'publish'->>'leaseUntil' = ${held}`,
    )).returning({ id: R.id })) as Array<{ id: string }>;
    return rows.length > 0;
  };
  const leaseLost = (): EcosystemError => stageConflict('being published', { reason: 'LEASE_LOST' });
  let gateRefusals = c.gateRefusals ?? 0;
  /** Record progress and renew the lease; refuses (LEASE_LOST) once another attempt holds it. */
  const save = async (): Promise<void> => {
    const held = state.leaseUntil;
    state.leaseUntil = leaseFrom(new Date());
    if (!await writeHeld(held, { toolchainCandidate: { ...c, gateRefusals, publish: state } })) {
      state.leaseUntil = held;
      throw leaseLost();
    }
  };
  /** Give the lease up (keeping the progress) — only while this attempt still holds it. */
  const releaseLease = async (): Promise<void> => {
    const held = state.leaseUntil;
    state.leaseUntil = EXPIRED;
    await writeHeld(held, { toolchainCandidate: { ...c, gateRefusals, publish: state } }).catch(() => false);
  };
  const auditFields = { ...(resuming ? { resumed: true, approvedBy: state.approvedBy } : {}), ...(reason ? { reason } : {}) };

  const pending = [
    { half: c.bootstrap, key: 'bootstrap' as const },
    { half: c.cdkSynth, key: 'cdkSynth' as const },
  ].filter((h) => state.steps[h.key] === null);

  // Re-scan the halves still to store: a finding that appeared since the candidate was verified refuses.
  const plan: Array<{ half: ToolchainFixHalf; key: 'bootstrap' | 'cdkSynth'; record: PluginRecordData; gated: Awaited<ReturnType<ToolchainPorts['scan']>> | null }> = [];
  for (const { half, key } of pending) {
    const record = releaseRecord(halves[half.name], c, half.cleared);
    const existing = await storedHalf(half.name, c.toRelease);
    if (existing) {
      if (existing.imageDigest !== half.digest) {
        await releaseLease();
        throw stageConflict('outdated', { reason: 'RELEASE_VERSION_TAKEN', toRelease: c.toRelease, half: half.name });
      }
      plan.push({ half, key, record, gated: null }); // stored by an earlier attempt that crashed before recording it
      continue;
    }
    const gated = await deps.ports.scan({ orgId: SYSTEM_ORG_ID, name: half.name, digest: half.digest }, record);
    if (gated.scan.refusal) {
      gateRefusals++;
      const exhausted = gateRefusals >= TOOLCHAIN_FIX_MAX_GATE_REFUSALS;
      const held = state.leaseUntil;
      let wrote: boolean;
      if (exhausted) {
        // Refused again and again: a person must look (needs_review), and the failure is alerted (ToolchainFixFailing).
        state.leaseUntil = EXPIRED;
        wrote = await writeHeld(held, { stage: 'needs_review', error: 'GATE_REFUSED', toolchainCandidate: { ...c, gateRefusals, publish: state } });
        if (wrote) {
          incCounter(TOOLCHAIN_FIX_METRICS.failures, { stage: 'gate_refused' });
          countStage('needs_review', null);
          logger.error('Toolchain fix publish refused by the build gate too many times; moved to needs_review', { remediationId: row.id, refusals: gateRefusals, refusal: gated.scan.refusal });
        }
      } else if (!state.steps.bootstrap && !state.steps.cdkSynth) {
        // Nothing stored yet: back to undecided (reject is possible again). Otherwise keep the progress.
        wrote = await writeHeld(held, { toolchainCandidate: { ...c, gateRefusals, publish: undefined }, decidedBy: null, decidedAt: null, decisionReason: null });
      } else {
        await releaseLease();
        wrote = true;
      }
      if (!wrote) throw leaseLost();
      auditToolchainFix('toolchain.fix.approved', row, { refusal: gated.scan.refusal, half: half.name, refusals: gateRefusals, ...(exhausted ? { movedTo: 'needs_review' } : {}), ...auditFields }, actor, 'failure');
      throw stageConflict('refused by the build gate', {
        reason: 'GATE_REFUSED', half: half.name, refusal: gated.scan.refusal, refusals: gateRefusals, ...(exhausted ? { stage: 'needs_review' } : {}),
      });
    }
    plan.push({ half, key, record, gated });
    // A re-scan can be slow: renew the lease so a resume never takes over mid-publish.
    await save();
  }

  try {
    for (const p of plan) {
      const id = p.gated === null
        ? (await storedHalf(p.half.name, c.toRelease))!.id
        : (await persistVersion({
          orgId: SYSTEM_ORG_ID,
          userId: SYSTEM_PLUGIN_REMEDIATION,
          access: { isSystemAdmin: true, canPublish: true },
          pluginRecord: p.record,
          image: { imageDigest: p.half.digest, imageSource: 'built' },
          facts: p.gated.facts,
          summary: p.gated.summary,
          skippedScan: false,
          emit: () => undefined,
        })).id;
      state.steps[p.key] = id;
      await save();
    }
    if (!state.steps.inputs) {
      const store = deps.inputs ?? liveToolchainInputs;
      for (const half of HALVES) await store.write(c.toRelease, half, c.buildInputs[half]);
      state.steps.inputs = true;
      await save();
    }
    if (!state.steps.notice) {
      await notifyToolchainHygiene({ kind: 'fixed', releaseVersion: c.fromRelease, fixedRelease: c.toRelease, cleared: advisoryIds(row.cleared ?? []) });
      state.steps.notice = true;
      await save();
    }
  } catch (err) {
    // A lost lease is not a failure: the attempt holding it now carries on.
    if ((err as { details?: { reason?: string } }).details?.reason === 'LEASE_LOST') throw err;
    incCounter(TOOLCHAIN_FIX_METRICS.failures, { stage: state.steps.bootstrap && state.steps.cdkSynth && !state.steps.inputs ? 'keep_inputs' : 'publish' });
    logger.error('Toolchain fix publish failed; it resumes on the next approve or the nightly sweep', { remediationId: row.id, steps: state.steps, error: errorMessage(err) });
    await releaseLease();
    throw err;
  }

  const finished = new Date();
  const done = (await updateRemediation(row.id, {
    stage: 'done',
    outcome: 'cleared',
    toVersion: c.toRelease,
    toPluginId: state.steps.bootstrap,
    publishedAt: finished,
    finishedAt: finished,
    toolchainCandidate: { ...c, publish: state },
  }, ['awaiting_approval']))!;
  countStage('done', 'cleared');
  countCleared(done);
  countCandidate('approved');
  auditToolchainFix('toolchain.fix.approved', done, {
    toRelease: c.toRelease,
    plugins: [{ name: MANAGED_TOOLCHAIN.bootstrap, id: state.steps.bootstrap }, { name: MANAGED_TOOLCHAIN.synth, id: state.steps.cdkSynth }],
    cleared: advisoryIds(done.cleared ?? []),
    ...auditFields,
  }, actor);
  return done;
}

/**
 * Resume every approved candidate whose publish was interrupted and never
 * released its lease (a crash): the nightly pass calls it. Each resume is the
 * same idempotent publish as a repeat approve, audited as a resume by the
 * remediation system on behalf of the original approver. Never throws.
 */
export async function resumeStuckToolchainFixes(deps: DecisionDeps, now: Date = new Date()): Promise<number> {
  if (!remediationConfig().enabled) return 0;
  const R = schema.pluginRemediation;
  const stuck = await elevatedTx((tx) => tx.select().from(R).where(and(
    eq(R.kind, 'toolchain'),
    eq(R.stage, 'awaiting_approval'),
    sql`${R.toolchainCandidate}->'publish' IS NOT NULL`,
    sql`(${R.toolchainCandidate}->'publish'->>'leaseUntil')::timestamptz < ${now.toISOString()}::timestamptz`,
  )).limit(50)) as PluginRemediation[];
  let resumed = 0;
  for (const row of stuck) {
    try {
      await approveToolchainFix(row, SYSTEM_PLUGIN_REMEDIATION, null, deps);
      resumed++;
    } catch (err) {
      logger.warn('Stuck toolchain fix not resumed', { remediationId: row.id, error: errorMessage(err) });
    }
  }
  return resumed;
}

/** Reject a candidate: nothing is published, its images go. */
export async function rejectToolchainFix(row: PluginRemediation, actor: string, reason: string | null, deps: DecisionDeps): Promise<PluginRemediation> {
  const c = assertDecidable(row);
  // Only before publishing starts: an approved candidate may already have a stored half.
  if (c.publish) throw stageConflict('being published', { reason: 'PUBLISH_STARTED' });
  const now = new Date();
  const done = await updateRemediation(row.id, {
    stage: 'failed', outcome: 'rejected', decidedBy: actor, decidedAt: now, decisionReason: reason, finishedAt: now,
  }, ['awaiting_approval']);
  if (!done) throw stageConflict('changing');
  for (const half of [c.bootstrap, c.cdkSynth]) {
    if (half.rebuilt) await deps.ports.discardImage({ orgId: SYSTEM_ORG_ID, name: half.name, digest: half.digest }).catch(() => undefined);
  }
  countStage('failed', 'rejected');
  countCandidate('rejected');
  auditToolchainFix('toolchain.fix.rejected', done, { ...(reason ? { reason } : {}) }, actor);
  return done;
}

/** Discard a superseded candidate's images (the nightly sweep). Best-effort. */
export async function discardToolchainCandidate(row: PluginRemediation, ports: Pick<RemediationPorts, 'discardImage'>): Promise<void> {
  const c = row.toolchainCandidate;
  if (!c) return;
  for (const half of [c.bootstrap, c.cdkSynth]) {
    if (half.rebuilt) await ports.discardImage({ orgId: SYSTEM_ORG_ID, name: half.name, digest: half.digest }).catch(() => undefined);
  }
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** A toolchain fix as the routes answer it: never a storage key, never source text. */
export function toToolchainFixDto(r: PluginRemediation): ToolchainFixDto {
  const c = r.toolchainCandidate ?? null;
  const cleared = c
    ? [...c.bootstrap.cleared.map((x) => ({ ...x, half: c.bootstrap.name })), ...c.cdkSynth.cleared.map((x) => ({ ...x, half: c.cdkSynth.name }))]
    : [];
  return {
    id: r.id,
    stage: r.stage,
    outcome: r.outcome ?? null,
    fromRelease: r.fromVersion,
    toRelease: c?.toRelease ?? r.toVersion ?? null,
    targetedCount: (r.targeted ?? []).length,
    cleared,
    remaining: r.remaining ?? [],
    toolchain: (c?.toolchain as PluginToolchain | undefined) ?? null,
    baseImage: c?.baseImage ?? null,
    sourceDigest: c?.sourceDigest ?? null,
    digests: c ? {
      'pipeline-bootstrap': { from: c.bootstrap.fromDigest, to: c.bootstrap.digest },
      'cdk-synth': { from: c.cdkSynth.fromDigest, to: c.cdkSynth.digest },
    } : null,
    hasExport: !!r.exportKey,
    publishing: c?.publish && r.stage === 'awaiting_approval'
      ? { approvedBy: c.publish.approvedBy, approvedAt: c.publish.approvedAt, steps: c.publish.steps }
      : null,
    error: r.error ?? null,
    decidedBy: r.decidedBy ?? null,
    decidedAt: iso(r.decidedAt),
    createdAt: r.createdAt.toISOString(),
    finishedAt: iso(r.finishedAt),
  };
}
