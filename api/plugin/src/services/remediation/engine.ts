// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The remediation engine: Stage 1 (rebuild on a freshly pulled base) and Stage
 * 2 (library remediation by package type), each verified, producing at most ONE
 * candidate image for the version and the account of what it cleared and what
 * is left for the owner (plan "End-to-end flow", "Stage 1", "Stage 2").
 *
 * Side-effect free apart from its ports (builds push candidate images; every
 * candidate not selected is discarded before returning). The job
 * (queue/plugin-remediation.ts) owns the row, publishing and notices.
 *
 * Stage 1 (kept source, build_image only): copy the context, refresh every
 * digest-pinned FROM within its tag, point a shared platform base at its
 * rebuilt image when a targeted package sits in that base's layers (the
 * system-org base pass, once per base and findings set), build with --pull
 * --no-cache, gate and verify. All targeted findings gone → the candidate.
 * Partly cleared with nothing broken → the starting point for Stage 2 (source
 * patches apply on its context, overlays build FROM its image). A failed build
 * → Stage 2 from the original context; the failure is noted for the owner.
 *
 * Stage 2: group by package (purl), choose the smallest fix within the
 * strictest applicable upgrade level (org, per-type, per-plugin), source patch
 * where the context declares the package, else one overlay layer, else the ask
 * agent (always propose-only), else the owner. All packages are tried in one
 * build; if that fails verification with several packages, each is retried
 * alone and the ones that pass are combined into the one candidate.
 */

import * as fs from 'fs';
import path from 'path';

import {
  chooseFixVersion,
  comparePackageVersions,
  effectiveLibraryUpgradeLevel,
  errorMessage,
  GRYPE_PACKAGE_TYPE_CATALOG,
  libraryUpgradeAllowed,
  libraryUpgradeRequirement,
  remediationVersionBump,
  type LibraryUpgradeLevel,
  type LibraryUpgradeRequirement,
  type PackageFixChoice,
  type PluginRemediationSettings,
  type PluginScanFinding,
  type RemediationClearedFinding,
  type RemediationFixMethod,
  type RemediationRemainingFinding,
  type RemediationRemainingReason,
  type RemediationVersionBump,
} from '@pipeline-builder/api-core';

import { applyPatch, treeDiff } from './diff.js';
import { pinnedArgNames, refreshPinnedBases, rewriteSharedBase, sharedBaseOf } from './dockerfile.js';
import { overlayDockerfile } from './overlay.js';
import { overlayCommand, SOURCE_PATCHERS, type FixTarget, type SourcePatch } from './patchers/index.js';
import { parsePurl } from './patchers/types.js';
import type { GatedScan, ImageRef, OpenedSource, RemediationPorts } from './ports.js';
import { scopeCheck, verifyCandidate, type ImageConfigFacts, type PluginContractShape, type ScopeResult, type VerifyResult } from './verify.js';
import { copyDir, readTree, writeChanged, zipDir } from './workspace.js';
import type { PluginRecordData } from '../../helpers/plugin-helpers.js';

/** The flagged version, as the engine needs it. */
export interface FromVersion {
  id: string;
  name: string;
  version: string;
  imageDigest: string | null;
  sourceKind: string;
  sourceKey: string | null;
  sourceSha256: string | null;
  /** The spec's smokeTest command ('' / null = none declared). */
  smokeTest: string | null;
  /** The version's own Critical/High findings (the "no new findings" baseline). */
  originalFindings: PluginScanFinding[];
  record: PluginRecordData;
}

export interface EngineInput {
  remediationId: string;
  orgId: string;
  plugin: FromVersion;
  targeted: PluginScanFinding[];
  settings: PluginRemediationSettings;
  /** The tag a candidate built for this bump is pushed under (the fix version it would publish as). */
  versionFor(bump: RemediationVersionBump): string;
  onStage?(stage: 'rebuild' | 'libraries'): Promise<void>;
  /** Scratch directory root (removed by the caller). */
  workRoot: string;
}

export interface EngineCandidate {
  ref: ImageRef;
  version: string;
  gated: GatedScan;
  /** The patched build context (its ZIP is stored with the remediation and as the fix version's source). */
  patched: { zip: Buffer; sha256: string };
  /** The patch as a reviewer reads it (original kept source → patched context). */
  diff: string;
  /** The Dockerfile content the candidate was built from (the fix version's `dockerfile`). */
  dockerfile: string | null;
}

export interface EngineOutcome {
  candidate: EngineCandidate | null;
  cleared: RemediationClearedFinding[];
  remaining: RemediationRemainingFinding[];
  fixMethods: RemediationFixMethod[];
  versionBump: RemediationVersionBump;
  /** The largest library move the candidate makes (null for a rebuild only). */
  upgradeLevel: LibraryUpgradeLevel | null;
  majorUpgrade: boolean;
  askAgentPatch: boolean;
  hasSmokeTest: boolean;
  /** A fail-closed error CODE (SOURCE_CHECKSUM_MISMATCH); the remediation fails with it. */
  error: string | null;
  /** The kept source was gone (the row is now source-less). */
  sourceMissing: boolean;
}

type PlanKind = 'source' | 'overlay' | 'agent';

interface Plan {
  kind: PlanKind;
  /** The packages this plan fixes (one, or several for an ask-agent patch). */
  targets: FixTarget[];
  findings: PluginScanFinding[];
  requirement: LibraryUpgradeRequirement;
  /** ask-agent only. */
  diff?: string;
}

interface Attempt {
  plans: Plan[];
  ref: ImageRef | null;
  version: string;
  gated: GatedScan | null;
  verify: VerifyResult;
  dir: string | null;
  dockerfile: string | null;
}

interface Stage1Result { ref: ImageRef; version: string; gated: GatedScan; verify: VerifyResult; dir: string; dockerfile: string }

const RANK: Record<LibraryUpgradeLevel, number> = { patch: 0, minor: 1, major: 2 };
const keyOf = (f: Pick<PluginScanFinding, 'purl' | 'packageType' | 'packageName' | 'packageVersion'>): string => f.purl || `${f.packageType}:${f.packageName}@${f.packageVersion}`;

/**
 * Whether a package's chosen fix is a real upgrade: a fixed version strictly
 * above the installed one (by the package type's own ordering). A multi-branch
 * advisory can list only fixes on older release lines; pinning one of those is
 * a downgrade, never a patch.
 */
export function isUpgradeFix(c: Pick<PackageFixChoice, 'fixVersion' | 'installedVersion' | 'packageType'>): c is typeof c & { fixVersion: string } {
  return !!c.fixVersion && comparePackageVersions(c.fixVersion, c.installedVersion, c.packageType) > 0;
}

/** The plugin contract a version's stored record carries. */
export function contractOfRecord(r: PluginRecordData): PluginContractShape {
  return {
    pluginType: r.pluginType,
    commands: r.commands ?? [],
    installCommands: r.installCommands ?? [],
    requiredMetadata: r.requiredMetadata ?? [],
    requiredVars: r.requiredVars ?? [],
    metadataTypes: r.metadataTypes ?? {},
    varsTypes: r.varsTypes ?? {},
    secrets: r.secrets ?? [],
    env: r.env ?? {},
  };
}

function remainingOf(f: PluginScanFinding, reason: RemediationRemainingReason, extra: { requiredLevel?: LibraryUpgradeRequirement; detail?: string } = {}): RemediationRemainingFinding {
  return {
    id: f.id,
    severity: f.severity,
    purl: f.purl,
    packageName: f.packageName,
    packageType: f.packageType,
    packageVersion: f.packageVersion,
    fixedIn: f.fixedIn,
    ...(f.kev ? { kev: true } : {}),
    reason,
    ...extra,
  };
}

const errorCode = (err: unknown): string => {
  const c = (err as { code?: unknown })?.code;
  return typeof c === 'string' && /^[A-Z0-9_]{2,64}$/.test(c) ? c : 'BUILD_FAILED';
};

/** Strings a changed line may contain to count as one of these packages' lines (diff scope). */
function mentionsOf(targets: readonly FixTarget[]): string[] {
  const out = new Set<string>();
  for (const t of targets) {
    out.add(t.packageName);
    out.add(t.fixVersion);
    out.add(t.fixVersion.replace(/^v/, ''));
    out.add(t.installedVersion);
    const p = parsePurl(t.purl);
    if (p) { out.add(p.name); if (p.namespace) { out.add(p.namespace); out.add(`${p.namespace}:${p.name}`); } }
    for (const a of pinnedArgNames(t.packageName)) out.add(a);
  }
  return [...out];
}

export async function runRemediationEngine(input: EngineInput, ports: RemediationPorts): Promise<EngineOutcome> {
  const { plugin, orgId } = input;
  const smoke = (plugin.smokeTest ?? '').trim();
  const out: EngineOutcome = {
    candidate: null,
    cleared: [],
    remaining: [],
    fixMethods: [],
    versionBump: 'patch',
    upgradeLevel: null,
    majorUpgrade: false,
    askAgentPatch: false,
    hasSmokeTest: smoke !== '',
    error: null,
    sourceMissing: false,
  };
  const pushed: ImageRef[] = [];
  let selected: ImageRef | null = null;
  const work = fs.mkdtempSync(path.join(input.workRoot, 'rem-'));
  let seq = 0;
  const scratch = (label: string) => path.join(work, `${label}-${seq++}`);

  try {
    // Findings the scan recorded without package details (no purl / locations:
    // a CPE-only match) are never patched — there is nothing to aim a patch at.
    // Findings with no fixed version (a KEV-listed one is targeted for exactly this) go to the owner.
    const detailed = input.targeted.filter((f) => f.unremediable !== 'no_package_details');
    for (const f of input.targeted) if (f.unremediable === 'no_package_details') out.remaining.push(remainingOf(f, 'no_package_details'));
    let targets = detailed.filter((f) => f.fixedIn.length > 0);
    for (const f of detailed) if (f.fixedIn.length === 0) out.remaining.push(remainingOf(f, 'no_fix'));

    // -- the kept source --------------------------------------------------------------
    let source: OpenedSource | null = null;
    if (plugin.sourceKind === 'zip') {
      const zip = path.join(work, 'source.zip');
      let got: 'ok' | 'missing';
      try {
        got = await ports.fetchSource({ id: plugin.id, sourceKey: plugin.sourceKey, sourceSha256: plugin.sourceSha256, sourceKind: plugin.sourceKind }, zip);
      } catch (err) {
        if ((err as { code?: string }).code === 'SOURCE_CHECKSUM_MISMATCH') return { ...out, error: 'SOURCE_CHECKSUM_MISMATCH' };
        throw err;
      }
      if (got === 'ok') source = await ports.openSource(zip, work);
      else out.sourceMissing = true;
    }
    const originalTree = source ? readTree(source.dir) : null;
    const original: ImageRef | null = plugin.imageDigest ? { orgId, name: plugin.name, digest: plugin.imageDigest } : null;
    const configBefore: ImageConfigFacts | null = original ? await ports.imageConfig(original).catch(() => null) : null;
    const contractBefore = contractOfRecord(plugin.record);
    const originalFindings = plugin.originalFindings.length > 0 ? plugin.originalFindings : input.targeted;

    /** Build-gate scan + every verification check of one pushed candidate. */
    const evaluate = async (ref: ImageRef, version: string, aimed: readonly PluginScanFinding[], contextDir: string | null, scope: ScopeResult): Promise<{ gated: GatedScan; verify: VerifyResult }> => {
      const gated = await ports.scan(ref, { ...plugin.record, version });
      const configAfter = await ports.imageConfig(ref).catch(() => null);
      const contractAfter = contextDir ? await ports.contractOf(contextDir).catch(() => null) : contractBefore;
      const smokeResult = smoke === '' ? 'none' : await ports.smokeTest(ref, smoke).then(() => 'passed' as const, () => 'failed' as const);
      // An unreadable config / contract fails closed (two sentinels that never compare equal).
      const unreadable = (tag: string): ImageConfigFacts => ({ user: `\u0000${tag}`, entrypoint: null, cmd: null, workingDir: '' });
      const verify = verifyCandidate({
        targeted: aimed,
        original: originalFindings,
        scan: gated.scan,
        contract: { before: contractBefore, after: contractAfter ?? { ...contractBefore, pluginType: '\u0000unreadable' } },
        config: { before: configBefore ?? unreadable('before'), after: configAfter ?? unreadable('after') },
        smoke: smokeResult,
        scope,
      });
      return { gated, verify };
    };
    const broken = (v: VerifyResult) => v.failure === 'new_findings' || v.failure === 'patch_broke_plugin' || v.failure === 'patch_out_of_scope';

    // -- Stage 1: rebuild on a freshly pulled base ----------------------------------------
    let baseImage: ImageRef | null = original;
    let baseDir: string | null = source && source.buildType === 'build_image' && source.dockerfile ? source.dir : null;
    let stage1: Stage1Result | null = null;
    let stage1Failure: string | null = null;
    if (source && baseDir) {
      await input.onStage?.('rebuild');
      const dir = copyDir(source.dir, scratch('rebuild'));
      const dfPath = path.join(dir, source.dockerfile);
      let df = fs.readFileSync(dfPath, 'utf8');
      df = (await refreshPinnedBases(df, (r) => ports.resolveDigest(r))).dockerfile;
      const base = sharedBaseOf(df);
      if (base) {
        const baseLayers = new Set(await ports.layerIds(base.image).catch(() => [] as string[]));
        const inBase = targets.filter((f) => f.locations.some((l) => baseLayers.has(l.layerID)));
        if (inBase.length > 0) {
          const rebuilt = await ports.ensureSharedBase(base, inBase).catch(() => null);
          if (rebuilt) df = rewriteSharedBase(df, base, rebuilt);
        }
      }
      fs.writeFileSync(dfPath, df);
      try {
        const version = input.versionFor('patch');
        const digest = await ports.build({ orgId, name: plugin.name, version, contextDir: dir, dockerfile: source.dockerfile, buildArgs: source.buildArgs });
        const ref = { orgId, name: plugin.name, digest };
        pushed.push(ref);
        const { gated, verify } = await evaluate(ref, version, targets, dir, { ok: true });
        if (!broken(verify)) {
          stage1 = { ref, version, gated, verify, dir, dockerfile: df };
          for (const f of verify.cleared) out.cleared.push({ id: f.id, purl: f.purl, packageName: f.packageName, packageType: f.packageType, fromVersion: f.packageVersion, toVersion: null, method: 'rebuild' });
          if (verify.cleared.length > 0) out.fixMethods.push('rebuild');
          targets = verify.stillPresent;
          baseImage = ref;
          baseDir = dir;
        } else {
          stage1Failure = verify.detail;
        }
      } catch (err) {
        stage1Failure = errorCode(err);
      }
    }

    if (stage1 && stage1.verify.ok && targets.length === 0) {
      selected = stage1.ref;
      out.candidate = candidateOf(stage1, originalTree);
      return out;
    }

    // -- Stage 2: library remediation ----------------------------------------------------------
    if (targets.length > 0) await input.onStage?.('libraries');
    const plans: Plan[] = [];
    const unpatched: Array<{ target: FixTarget; findings: PluginScanFinding[]; requirement: LibraryUpgradeRequirement; reason: RemediationRemainingReason }> = [];
    const choices: PackageFixChoice[] = chooseFixVersion(targets);
    const baseTree = baseDir ? readTree(baseDir) : null;
    const dockerfileRel = source?.dockerfile ?? 'Dockerfile';
    for (const c of choices) {
      const findings = targets.filter((f) => keyOf(f) === c.purl);
      // Never a downgrade (or same-version) pin: a fix not strictly above what is installed is no fix.
      if (!isUpgradeFix(c)) { for (const f of findings) out.remaining.push(remainingOf(f, 'no_fix')); continue; }
      const level = effectiveLibraryUpgradeLevel(input.settings, c.packageType, plugin.name);
      const requirement = libraryUpgradeRequirement(c.installedVersion, c.fixVersion, c.packageType);
      if (requirement === 'owner') { for (const f of findings) out.remaining.push(remainingOf(f, 'go_module_major', { requiredLevel: 'owner' })); continue; }
      if (!libraryUpgradeAllowed(c.installedVersion, c.fixVersion, level, c.packageType)) {
        for (const f of findings) out.remaining.push(remainingOf(f, 'beyond_upgrade_level', { requiredLevel: requirement }));
        continue;
      }
      const target: FixTarget = { ...c, fixVersion: c.fixVersion };
      const spec = GRYPE_PACKAGE_TYPE_CATALOG[c.packageType];
      const patcher = SOURCE_PATCHERS[c.packageType];
      if (baseTree && patcher && patcher(baseTree, target, { dockerfile: dockerfileRel })) {
        plans.push({ kind: 'source', targets: [target], findings, requirement });
      } else if (spec.overlay && baseImage && configBefore && overlayCommand(target, c.locations)) {
        plans.push({ kind: 'overlay', targets: [target], findings, requirement });
      } else {
        const reason: RemediationRemainingReason = spec.compiled ? (source ? 'compiled_binary' : 'no_source') : (!source && !baseImage ? 'no_source' : 'no_patcher');
        unpatched.push({ target, findings, requirement, reason });
      }
    }

    // The ask agent drafts one patch for what no patcher fits (verified like any patch; propose-only).
    const askable = unpatched.filter((u) => u.reason === 'no_patcher' || u.reason === 'compiled_binary');
    if (askable.length > 0 && baseDir) {
      const drafted = await ports.askAgent({
        remediationId: input.remediationId,
        orgId,
        workdir: baseDir,
        findings: askable.flatMap((u) => u.findings.map((f) => remainingOf(f, u.reason))),
      }).catch(() => null);
      if (drafted?.diff) {
        try {
          applyPatch(baseTree ?? new Map(), drafted.diff);
          const req = askable.map((u) => u.requirement).reduce((a, b) => (RANK[b as LibraryUpgradeLevel] > RANK[a as LibraryUpgradeLevel] ? b : a));
          plans.push({ kind: 'agent', targets: askable.map((u) => u.target), findings: askable.flatMap((u) => u.findings), requirement: req, diff: drafted.diff });
          for (const u of askable) unpatched.splice(unpatched.indexOf(u), 1);
        } catch { /* the draft does not apply: the findings stay with the owner */ }
      }
    }
    for (const u of unpatched) for (const f of u.findings) out.remaining.push(remainingOf(f, u.reason));

    /** Build, gate and verify one set of plans as one candidate. */
    const attempt = async (set: Plan[]): Promise<Attempt> => {
      const bump = remediationVersionBump(set);
      const version = input.versionFor(bump);
      const aimed = set.flatMap((p) => p.findings);
      const fail = (failure: RemediationRemainingReason, detail: string): Attempt => ({
        plans: set,
        ref: null,
        version,
        gated: null,
        dir: null,
        dockerfile: null,
        verify: { ok: false, cleared: [], stillPresent: aimed, newFindings: [], failure, detail },
      });
      let fromRef = baseImage;
      let dir: string | null = null;
      let dockerfile: string | null = null;
      let scope: ScopeResult = { ok: true };
      const sourcePlans = set.filter((p) => p.kind !== 'overlay');
      const overlayPlans = set.filter((p) => p.kind === 'overlay');
      try {
        if (sourcePlans.length > 0) {
          if (!baseDir || !baseTree || !source) return fail('no_source', 'NO_SOURCE');
          dir = copyDir(baseDir, scratch('patch'));
          let tree = new Map(baseTree);
          const lockfiles: string[] = [];
          const runs: SourcePatch['regenerate'] = [];
          for (const p of sourcePlans) {
            if (p.kind === 'agent') { tree = applyPatch(tree, p.diff!); continue; }
            const patch = SOURCE_PATCHERS[p.targets[0]!.packageType]!(tree, p.targets[0]!, { dockerfile: dockerfileRel });
            if (!patch) return fail('no_patcher', 'PATCHER_DID_NOT_APPLY');
            for (const [k, v] of patch.files) tree.set(k, v);
            lockfiles.push(...patch.lockfiles);
            runs.push(...patch.regenerate);
          }
          writeChanged(dir, baseTree, tree);
          for (const r of runs) await ports.runTool(r, dir);
          const after = readTree(dir);
          scope = set.some((p) => p.kind === 'agent')
            ? { ok: true } // the ask-agent draft was scope-checked by its own pre-check; it is propose-only
            : scopeCheck({ before: baseTree, after, mentions: mentionsOf(set.flatMap((p) => p.targets)), lockfiles });
          if (!scope.ok) return fail('patch_out_of_scope', scope.detail ?? 'DIFF_SCOPE');
          dockerfile = after.get(dockerfileRel) ?? null;
          const digest = await ports.build({ orgId, name: plugin.name, version, contextDir: dir, dockerfile: dockerfileRel, buildArgs: source.buildArgs });
          fromRef = { orgId, name: plugin.name, digest };
          pushed.push(fromRef);
        }
        if (overlayPlans.length > 0) {
          if (!fromRef || !configBefore) return fail('no_source', 'NO_IMAGE');
          const commands = overlayPlans.map((p) => overlayCommand(p.targets[0]!, p.targets[0]!.locations)!).filter(Boolean);
          const df = overlayDockerfile({ baseRef: ports.imageReference(fromRef), user: configBefore.user, commands });
          if (!df) return fail('no_patcher', 'OVERLAY_UNRENDERABLE');
          const odir = scratch('overlay');
          fs.mkdirSync(odir, { recursive: true });
          fs.writeFileSync(path.join(odir, 'Dockerfile'), df);
          scope = scopeCheck({ before: new Map(), after: new Map(), mentions: [], lockfiles: [], overlayDockerfile: df });
          if (!scope.ok) return fail('patch_out_of_scope', scope.detail ?? 'DIFF_SCOPE');
          const digest = await ports.build({ orgId, name: plugin.name, version, contextDir: odir, dockerfile: 'Dockerfile', buildArgs: {} });
          fromRef = { orgId, name: plugin.name, digest };
          pushed.push(fromRef);
          dockerfile = df;
          // The overlay context rides along inside the patched context (or is it, without a source).
          if (dir) { fs.mkdirSync(path.join(dir, '.remediation'), { recursive: true }); fs.writeFileSync(path.join(dir, '.remediation', 'Dockerfile.overlay'), df); } else {dir = odir;}
        }
      } catch (err) {
        return fail('build_failed', errorCode(err));
      }
      const { gated, verify } = await evaluate(fromRef!, version, aimed, sourcePlans.length > 0 ? dir : null, scope);
      return { plans: set, ref: fromRef, version, gated, verify, dir, dockerfile };
    };

    let final: Attempt | null = null;
    const failedPlans = new Map<Plan, VerifyResult>();
    if (plans.length > 0) {
      const all = await attempt(plans);
      if (all.verify.ok) {final = all;} else if (plans.length === 1) {failedPlans.set(plans[0]!, all.verify);} else {
        // Retry once with each package alone, keep the ones that work.
        const singles: Attempt[] = [];
        for (const p of plans) singles.push(await attempt([p]));
        const good = singles.filter((s) => s.verify.ok);
        for (const s of singles) if (!s.verify.ok) failedPlans.set(s.plans[0]!, s.verify);
        if (good.length === 1) {final = good[0]!;} else if (good.length > 1) {
          const combined = await attempt(good.map((g) => g.plans[0]!));
          final = combined.verify.ok ? combined : good.reduce((a, b) => (b.verify.cleared.length > a.verify.cleared.length ? b : a));
        }
      }
    }
    for (const [p, v] of failedPlans) for (const f of p.findings) out.remaining.push(remainingOf(f, v.failure ?? 'still_present', v.detail ? { detail: v.detail } : {}));

    if (final) {
      selected = final.ref;
      const methodOf = new Map<string, { method: RemediationFixMethod; to: string }>();
      for (const p of final.plans) {
        const method: RemediationFixMethod = p.kind === 'source' ? 'source_patch' : p.kind === 'overlay' ? 'overlay' : 'ask_agent';
        for (const t of p.targets) methodOf.set(t.purl, { method, to: t.fixVersion });
      }
      for (const f of final.verify.cleared) {
        const m = methodOf.get(keyOf(f)) ?? { method: 'source_patch' as const, to: null as unknown as string };
        out.cleared.push({ id: f.id, purl: f.purl, packageName: f.packageName, packageType: f.packageType, fromVersion: f.packageVersion, toVersion: m.to ?? null, method: m.method });
        if (!out.fixMethods.includes(m.method)) out.fixMethods.push(m.method);
      }
      for (const f of final.verify.stillPresent) out.remaining.push(remainingOf(f, 'still_present'));
      const reqs = final.plans.map((p) => p.requirement).filter((r): r is LibraryUpgradeLevel => r !== 'owner');
      out.upgradeLevel = reqs.reduce<LibraryUpgradeLevel | null>((a, b) => (a === null || RANK[b] > RANK[a] ? b : a), null);
      out.majorUpgrade = reqs.includes('major');
      out.versionBump = remediationVersionBump(final.plans);
      out.askAgentPatch = final.plans.some((p) => p.kind === 'agent');
      const tree = final.dir ? readTree(final.dir) : new Map<string, string>();
      out.candidate = {
        ref: final.ref!,
        version: final.version,
        gated: final.gated!,
        patched: zipDir(final.dir!),
        diff: originalTree ? treeDiff(originalTree, tree) : treeDiff(new Map(), tree, 'remediation-overlay/'),
        dockerfile: final.dockerfile,
      };
    } else if (stage1 && stage1.verify.ok) {
      // Stage 2 could not add anything, but the rebuild alone passes the gate: publish what it cleared.
      selected = stage1.ref;
      out.candidate = candidateOf(stage1, originalTree);
      for (const f of targets) if (!out.remaining.some((r) => r.id === f.id && r.purl === f.purl)) out.remaining.push(remainingOf(f, 'still_present'));
    } else {
      // Nothing publishable: whatever Stage 1 cleared is not shipped either.
      for (const c of out.cleared.splice(0)) {
        const f = input.targeted.find((t) => t.id === c.id && t.purl === c.purl);
        if (f) out.remaining.push(remainingOf(f, 'still_present', stage1Failure ? { detail: stage1Failure } : {}));
      }
      out.fixMethods = [];
    }
    if (stage1Failure) for (const r of out.remaining) r.detail ??= `REBUILD_${stage1Failure}`.slice(0, 64);
    // Every targeted finding is accounted for exactly once.
    const accounted = new Set([...out.cleared, ...out.remaining].map((x) => `${x.id}|${x.purl}`));
    for (const f of input.targeted) if (!accounted.has(`${f.id}|${f.purl}`)) out.remaining.push(remainingOf(f, 'still_present'));
    return out;
  } finally {
    for (const ref of pushed) {
      if (selected && ref.digest === selected.digest) continue;
      await ports.discardImage(ref).catch((err) => void errorMessage(err));
    }
    fs.rmSync(work, { recursive: true, force: true });
  }

  function candidateOf(s: Stage1Result, originalTree: Map<string, string> | null): EngineCandidate {
    return { ref: s.ref, version: s.version, gated: s.gated, patched: zipDir(s.dir), diff: originalTree ? treeDiff(originalTree, readTree(s.dir)) : '', dockerfile: s.dockerfile };
  }
}
