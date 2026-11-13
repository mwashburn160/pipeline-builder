// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The managed toolchain RELEASE service (docs/plans/bootstrap-image-versioning.md
 * §1, §5, §6, §8, D1, D14): the platform default and the release lifecycle.
 *
 * A release is `pipeline-bootstrap@V` + `cdk-synth@V`, two system-org plugin
 * rows sharing one version, plus its `toolchain_release` row (written on
 * upload, see `PluginService.deployVersion`). Managed rows never use
 * `plugins.is_default`; THE platform default is the singleton
 * `toolchain_platform_default`, and only {@link setPlatformDefault} moves it
 * (D1): a console promotion (`set`), the fresh-install default (`initial`, D14)
 * or the yank-restore of the previous default (`restore`).
 *
 * Every read and write here is ELEVATED (`isSuperAdmin`): the release tables
 * are system-org only under RLS, and in-use checks span every org. Callers
 * authorize first — step-up for people (the Phase 5 console), the
 * `deploy-bootstrap` identity gate for `initial` (routes/toolchain.ts).
 */

import {
  AppError, ConflictError, ErrorCode, NotFoundError, SYSTEM_ORG_ID, ValidationError,
  exceedsVulnFloor, gatedFindingCount, gatedFixableCount, getStatusForErrorCode, lastScannedAt, pluginVulnFailOn,
  pluginVulnMaxFindings, recordAudit, toolchainFromMetadata,
  type PluginScanSummary, type RemoteAuditAction,
} from '@pipeline-builder/api-core';
import {
  executeRows, readCanaryGate, runWithTenantContext, schema, withTenantTx,
  type CanaryGateParams, type CanaryGateResult, type ToolchainDefaultKind,
} from '@pipeline-builder/pipeline-data';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { pluginService, type Plugin } from './plugin-service.js';
import { notifyToolchainHygiene } from './toolchain-hygiene.js';

type TenantTx = Parameters<Parameters<typeof withTenantTx>[0]>[0];

/** The two halves of a release, bootstrap first. */
export const TOOLCHAIN_HALVES = ['pipeline-bootstrap', 'cdk-synth'] as const;
const BOOTSTRAP = TOOLCHAIN_HALVES[0];

/** Who acted: a user id, or a service principal's `service:<name>` subject. */
export type ToolchainActor = string;

export interface SetPlatformDefaultInput {
  releaseVersion: string;
  kind: ToolchainDefaultKind;
  actor: ToolchainActor;
  /**
   * The default the caller saw (`null` = none). A mismatch is 409
   * TOOLCHAIN_DEFAULT_CHANGED, so two operators can't race. Required for
   * `set`; ignored for `initial` (which needs NO default) and `restore` (which
   * reads it under the lock).
   */
  expectedCurrentDefault?: string | null;
  /** A written reason that overrides the canary gate (`set` only). Recorded in history and the audit. */
  overrideReason?: string;
  /**
   * The canary gate's thresholds (N runs, M orgs, T points), as the console
   * sets them (Phase 5). Omitted fields take `DEFAULT_CANARY_GATE` (20 / 2 / 5).
   */
  canaryGate?: Partial<CanaryGateParams>;
  /**
   * `initial` ONLY: the operator's reason for accepting a release over the
   * fixable-Critical floor (`--accept-initial-vulnerabilities`). The only
   * override of the floor anywhere; audited.
   */
  acceptVulnerabilities?: string;
  /** Free-text reason for the history row (a restore carries the yank's). */
  reason?: string;
}

export interface SetPlatformDefaultResult {
  releaseVersion: string;
  previousReleaseVersion: string | null;
  kind: ToolchainDefaultKind;
  /** `false` when the release already was the default (nothing written). */
  changed: boolean;
}

/** The audit action of each way the platform default moves. */
const DEFAULT_AUDIT_ACTION: Readonly<Record<ToolchainDefaultKind, RemoteAuditAction>> = {
  set: 'toolchain.default.set',
  initial: 'toolchain.default.initial',
  restore: 'toolchain.default.restore',
};

/** What a change wants audited once its transaction has committed. */
interface PendingAudit {
  action: RemoteAuditAction;
  details: Record<string, unknown>;
}

function refusal(code: ErrorCode, message: string, details?: Record<string, unknown>): AppError {
  return new AppError(getStatusForErrorCode(code), code, message, details);
}

function elevated<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuperAdmin: true }, fn);
}

function nonEmpty(s: string | undefined): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

function emitAudit(actor: ToolchainActor, a: PendingAudit, outcome: 'success' | 'failure' = 'success'): void {
  recordAudit({
    action: a.action,
    actorId: actor,
    orgId: SYSTEM_ORG_ID,
    targetType: 'toolchain-release',
    targetId: typeof a.details.releaseVersion === 'string' ? a.details.releaseVersion : undefined,
    outcome,
    details: a.details,
  });
}

/** Run `fn`; a typed refusal is audited as `action` with outcome `failure` and `details.refusal`, then rethrown. */
async function auditRefusal<T>(actor: ToolchainActor, action: RemoteAuditAction, releaseVersion: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) emitAudit(actor, { action, details: { releaseVersion, refusal: err.code } }, 'failure');
    throw err;
  }
}

// -- Reads -------------------------------------------------------------------

/** Serialize every platform-default change, even when no default row exists yet to lock. */
async function lockPlatformDefault(tx: TenantTx): Promise<string | null> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('toolchain_platform_default'))`);
  const [row] = await tx.select({ releaseVersion: schema.toolchainPlatformDefault.releaseVersion })
    .from(schema.toolchainPlatformDefault)
    .where(eq(schema.toolchainPlatformDefault.singleton, true))
    .for('update');
  return row?.releaseVersion ?? null;
}

/** The release's live (not soft-deleted) halves, keyed by name. */
async function releaseHalves(tx: TenantTx, releaseVersion: string): Promise<Map<string, Plugin>> {
  const rows = await tx.select().from(schema.plugin).where(and(
    eq(schema.plugin.orgId, SYSTEM_ORG_ID),
    inArray(schema.plugin.name, [...TOOLCHAIN_HALVES]),
    eq(schema.plugin.version, releaseVersion),
    isNull(schema.plugin.deletedAt),
  )) as Plugin[];
  return new Map(rows.map((r) => [r.name, r]));
}

async function releaseRowExists(tx: TenantTx, releaseVersion: string): Promise<boolean> {
  const [row] = await tx.select({ v: schema.toolchainRelease.releaseVersion }).from(schema.toolchainRelease)
    .where(eq(schema.toolchainRelease.releaseVersion, releaseVersion));
  return row !== undefined;
}

async function wasEverDefault(tx: TenantTx, releaseVersion: string): Promise<boolean> {
  const [row] = await tx.select({ id: schema.toolchainDefaultHistory.id }).from(schema.toolchainDefaultHistory)
    .where(eq(schema.toolchainDefaultHistory.releaseVersion, releaseVersion)).limit(1);
  return row !== undefined;
}

function isYanked(row: Plugin): boolean {
  return row.yankedAt !== null || row.lifecycle === 'yanked';
}

function isDeprecated(row: Plugin): boolean {
  return row.deprecatedAt !== null || row.lifecycle === 'deprecated';
}

/** Gated findings over the floor for one half — waiver/KEV-aware, the raw scanner counts when the summary can't answer. */
function floorBreach(row: Plugin): { gated: number; flagged: boolean } | null {
  const max = pluginVulnMaxFindings();
  const gated = gatedFindingCount(
    row.scanSummary as PluginScanSummary | null,
    { pluginName: row.name, orgId: row.orgId, pluginVersion: row.version, imageDigest: row.imageDigest },
    pluginVulnFailOn(),
  ) ?? gatedFixableCount(row);
  // A nightly-rescan flag is the floor breached since the build.
  const flagged = row.scanFlaggedAt !== null;
  return flagged || exceedsVulnFloor(gated, max) ? { gated, flagged } : null;
}

/**
 * The §6 canary gate: at least N synth runs across at least M orgs (each org
 * capped at ceil(N/M)), with a failure rate within T points of the CURRENT
 * default's — a query over the run rows api/reporting stamps with the release
 * from the platform's deployed manifest (pipeline-data `readCanaryGate`).
 * Read in this transaction, under the platform-default lock, so the baseline
 * is the default the change replaces. ADVISORY: outcomes are customer-reported,
 * so it informs the operator and an override records a reason.
 */
function canaryGate(tx: TenantTx, releaseVersion: string, currentDefault: string | null, params?: Partial<CanaryGateParams>): Promise<CanaryGateResult> {
  return readCanaryGate(tx, releaseVersion, currentDefault, params);
}

/** One line naming what the gate is short of. */
function describeGate(g: CanaryGateResult): string {
  const parts: string[] = [];
  if (g.shortfalls.includes('runs')) parts.push(`${g.countedRuns} of ${g.params.minRuns} synth runs (at most ${g.perOrgCap} per org)`);
  if (g.shortfalls.includes('orgs')) parts.push(`${g.orgs} of ${g.params.minOrgs} orgs`);
  if (g.shortfalls.includes('failure-rate')) {
    parts.push(g.pointsAboveDefault === null
      ? 'no failure rate yet'
      : `failure rate ${g.failureRate}% is ${g.pointsAboveDefault} points over the default's ${g.baselineFailureRate}% (at most ${g.params.maxFailurePointsAboveDefault})`);
  }
  return parts.join('; ');
}

// -- The guards + write ------------------------------------------------------

/** One §8 guard's verdict, in the order the service applies them. */
export interface DefaultGuardCheck {
  code: ErrorCode;
  ok: boolean;
  /** Why it fails (or why it passes when that needs saying: waived, accepted). */
  detail?: string;
  /** The refusal {@link setPlatformDefault} throws when this guard fails. */
  refusal?: AppError;
  /** The canary gate's numbers (the canary guard only, when evaluated). */
  gate?: CanaryGateResult;
  /** The vulnerability floor's breaches (the floor guard only). */
  breaches?: Array<{ name: string; gated: number; flagged: boolean }>;
  /** The floor was breached but accepted (`initial` + `acceptVulnerabilities`). */
  accepted?: boolean;
}

/**
 * Evaluate every §8 guard for making `input.releaseVersion` the default over
 * `current` — the ONE implementation behind both {@link setPlatformDefault}
 * (which throws the first failing guard's refusal) and the console's
 * default-preview (which shows them all). When the pair is incomplete the
 * later guards can't be judged and are reported failed as "not checked".
 */
async function evaluateGuards(tx: TenantTx, input: Pick<SetPlatformDefaultInput, 'releaseVersion' | 'kind' | 'acceptVulnerabilities' | 'canaryGate'>, current: string | null): Promise<DefaultGuardCheck[]> {
  const { releaseVersion, kind } = input;
  const notChecked = (code: ErrorCode): DefaultGuardCheck => ({ code, ok: false, detail: 'Not checked: the release is not a complete, live pair.' });

  // Pair: both halves, one version, active, unyanked, not deprecated, and the release registered.
  const halves = await releaseHalves(tx, releaseVersion);
  const missing = TOOLCHAIN_HALVES.filter((n) => !halves.has(n));
  const notLive = [...halves.values()]
    .filter((r) => !r.isActive || isYanked(r) || isDeprecated(r))
    .map((r) => ({ name: r.name, state: isYanked(r) ? 'yanked' : isDeprecated(r) ? 'deprecated' : 'inactive' }));
  if (missing.length > 0 || notLive.length > 0 || !(await releaseRowExists(tx, releaseVersion))) {
    const message = `Release ${releaseVersion} is not a complete, live pair`
      + `${missing.length ? ` (missing: ${missing.join(', ')})` : ''}${notLive.length ? ` (${notLive.map((n) => `${n.name} is ${n.state}`).join(', ')})` : ''}.`;
    return [
      { code: ErrorCode.TOOLCHAIN_GUARD_PAIR_INCOMPLETE, ok: false, detail: message, refusal: refusal(ErrorCode.TOOLCHAIN_GUARD_PAIR_INCOMPLETE, message, { releaseVersion, missing, notLive }) },
      notChecked(ErrorCode.TOOLCHAIN_GUARD_UNSCANNED),
      notChecked(ErrorCode.TOOLCHAIN_GUARD_VULN_FLOOR),
      notChecked(ErrorCode.TOOLCHAIN_GUARD_METADATA),
      notChecked(ErrorCode.TOOLCHAIN_GUARD_CANARY_GATE),
    ];
  }
  const out: DefaultGuardCheck[] = [{ code: ErrorCode.TOOLCHAIN_GUARD_PAIR_INCOMPLETE, ok: true }];
  const rows = TOOLCHAIN_HALVES.map((n) => halves.get(n)!);

  // Scan: both halves scanned.
  const unscanned = rows.filter((r) => lastScannedAt(r) === null).map((r) => r.name);
  if (unscanned.length > 0) {
    const message = `Release ${releaseVersion} is not scanned yet (${unscanned.join(', ')}); wait for the scan to finish.`;
    out.push({ code: ErrorCode.TOOLCHAIN_GUARD_UNSCANNED, ok: false, detail: message, refusal: refusal(ErrorCode.TOOLCHAIN_GUARD_UNSCANNED, message, { releaseVersion, unscanned }) });
  } else {
    out.push({ code: ErrorCode.TOOLCHAIN_GUARD_UNSCANNED, ok: true });
  }

  // Floor: within PLUGIN_VULN_MAX_FINDINGS gated (fixable / KEV) findings. The
  // only override is `acceptVulnerabilities`, on the initial default.
  const max = pluginVulnMaxFindings();
  const breaches = rows.flatMap((r) => {
    const b = floorBreach(r);
    return b ? [{ name: r.name, gated: b.gated, flagged: b.flagged }] : [];
  });
  const accepted = breaches.length > 0 && kind === 'initial' && nonEmpty(input.acceptVulnerabilities);
  if (breaches.length > 0 && !accepted) {
    const message = `Release ${releaseVersion} is over the vulnerability floor (${breaches.map((b) => `${b.name}: ${b.gated} gated`).join(', ')}; at most ${max} allowed). `
      + (kind === 'initial'
        ? 'Produce a patched release, or accept it explicitly with --accept-initial-vulnerabilities "<reason>".'
        : 'Produce a patched release.');
    out.push({
      code: ErrorCode.TOOLCHAIN_GUARD_VULN_FLOOR,
      ok: false,
      detail: message,
      breaches,
      refusal: refusal(ErrorCode.TOOLCHAIN_GUARD_VULN_FLOOR, message, { releaseVersion, maxFindings: max, failOn: pluginVulnFailOn(), breaches }),
    });
  } else {
    out.push({ code: ErrorCode.TOOLCHAIN_GUARD_VULN_FLOOR, ok: true, breaches, ...(accepted ? { accepted: true, detail: 'Over the floor, accepted for the initial default.' } : {}) });
  }

  // Metadata: the bootstrap carries a complete `toolchain`.
  if (toolchainFromMetadata(halves.get(BOOTSTRAP)!.metadata) === null) {
    const message = `${BOOTSTRAP}@${releaseVersion} carries no complete toolchain metadata; rebuild the release with deploy/bin/sync-image-tags.sh.`;
    out.push({ code: ErrorCode.TOOLCHAIN_GUARD_METADATA, ok: false, detail: message, refusal: refusal(ErrorCode.TOOLCHAIN_GUARD_METADATA, message, { releaseVersion }) });
  } else {
    out.push({ code: ErrorCode.TOOLCHAIN_GUARD_METADATA, ok: true });
  }

  // Canary gate: waived for initial, restore and a former default; otherwise
  // passed (an override with a written reason is the caller's decision). The
  // refusal carries the gate's numbers, for the console to show.
  if (kind !== 'set') {
    out.push({ code: ErrorCode.TOOLCHAIN_GUARD_CANARY_GATE, ok: true, detail: `Waived for ${kind === 'initial' ? 'the initial default' : 'a restore'}.` });
  } else if (await wasEverDefault(tx, releaseVersion)) {
    out.push({ code: ErrorCode.TOOLCHAIN_GUARD_CANARY_GATE, ok: true, detail: 'Waived: the release has already been the platform default.' });
  } else {
    const gate = await canaryGate(tx, releaseVersion, current, input.canaryGate);
    if (gate.passed) {
      out.push({ code: ErrorCode.TOOLCHAIN_GUARD_CANARY_GATE, ok: true, gate });
    } else {
      const message = `Release ${releaseVersion} has not passed the canary gate (${describeGate(gate)}); promote it with a written override reason, or wait for the canary.`;
      out.push({ code: ErrorCode.TOOLCHAIN_GUARD_CANARY_GATE, ok: false, detail: message, gate, refusal: refusal(ErrorCode.TOOLCHAIN_GUARD_CANARY_GATE, message, { releaseVersion, gate }) });
    }
  }
  return out;
}

/**
 * The §8 guards for making `releaseVersion` the platform default over the
 * CURRENT default, as `setPlatformDefault({ kind: 'set' })` would judge them —
 * no lock, no write (the console's default-preview). Elevated read.
 */
export async function previewPlatformDefaultGuards(
  releaseVersion: string,
  canaryGateParams?: Partial<CanaryGateParams>,
): Promise<{ currentDefault: string | null; guards: DefaultGuardCheck[] }> {
  return elevated(() => withTenantTx(async (tx) => {
    const [row] = await tx.select({ releaseVersion: schema.toolchainPlatformDefault.releaseVersion }).from(schema.toolchainPlatformDefault)
      .where(eq(schema.toolchainPlatformDefault.singleton, true));
    const current = row?.releaseVersion ?? null;
    const guards = await evaluateGuards(tx, { releaseVersion, kind: 'set', ...(canaryGateParams ? { canaryGate: canaryGateParams } : {}) }, current);
    return { currentDefault: current, guards };
  }));
}

/**
 * Apply a platform-default change inside `tx` (which the caller opened,
 * elevated): lock the singleton, run the §8 guards, write the default, its
 * history row, and clear the release's canary rows. Returns the result and the
 * audit to emit after COMMIT.
 */
async function applyPlatformDefault(tx: TenantTx, input: SetPlatformDefaultInput): Promise<{ result: SetPlatformDefaultResult; audit: PendingAudit | null }> {
  const { releaseVersion, kind } = input;
  if (nonEmpty(input.acceptVulnerabilities) && kind !== 'initial') {
    throw new ValidationError('acceptVulnerabilities overrides the vulnerability floor for the initial default only');
  }
  if (nonEmpty(input.overrideReason) && kind !== 'set') {
    throw new ValidationError('overrideReason overrides the canary gate, which only a set has');
  }
  if (kind === 'set' && input.expectedCurrentDefault === undefined) {
    throw new ValidationError('expectedCurrentDefault is required to set the platform default (null when none exists)');
  }

  const current = await lockPlatformDefault(tx);

  if (kind === 'initial' && current !== null) {
    throw new ConflictError(
      `The platform default is already set (${current}); the initial default is set once, on a fresh install. Use the Toolchain console to change it.`,
      ErrorCode.TOOLCHAIN_INITIAL_ALREADY_SET,
      { currentDefault: current },
    );
  }
  if (kind === 'set' && input.expectedCurrentDefault !== current) {
    throw new ConflictError(
      `The platform default changed (expected ${input.expectedCurrentDefault ?? 'none'}, now ${current ?? 'none'}); review the current default and try again.`,
      ErrorCode.TOOLCHAIN_DEFAULT_CHANGED,
      { expectedCurrentDefault: input.expectedCurrentDefault, currentDefault: current },
    );
  }
  if (current === releaseVersion) {
    return { result: { releaseVersion, previousReleaseVersion: current, kind, changed: false }, audit: null };
  }

  const checks = await evaluateGuards(tx, input, current);
  for (const c of checks) {
    if (c.ok || !c.refusal) continue;
    // The canary gate, overridden with a written reason (set only).
    if (c.code === ErrorCode.TOOLCHAIN_GUARD_CANARY_GATE && nonEmpty(input.overrideReason)) continue;
    throw c.refusal;
  }
  const gateCheck = checks.find((c) => c.code === ErrorCode.TOOLCHAIN_GUARD_CANARY_GATE);
  const gateOverride: { reason: string; gate: CanaryGateResult } | undefined = gateCheck && !gateCheck.ok && gateCheck.gate && nonEmpty(input.overrideReason)
    ? { reason: input.overrideReason.trim(), gate: gateCheck.gate }
    : undefined;
  const floorCheck = checks.find((c) => c.code === ErrorCode.TOOLCHAIN_GUARD_VULN_FLOOR);
  const breaches = floorCheck?.breaches ?? [];
  const acceptedVulnerabilities = floorCheck?.accepted === true;

  const now = new Date();
  await tx.insert(schema.toolchainPlatformDefault)
    .values({ singleton: true, releaseVersion, setAt: now, setBy: input.actor })
    .onConflictDoUpdate({ target: schema.toolchainPlatformDefault.singleton, set: { releaseVersion, setAt: now, setBy: input.actor } });
  const historyReason = gateOverride?.reason ?? (acceptedVulnerabilities ? input.acceptVulnerabilities!.trim() : null) ?? (nonEmpty(input.reason) ? input.reason.trim() : null);
  await tx.insert(schema.toolchainDefaultHistory).values({
    releaseVersion, previousReleaseVersion: current, setBy: input.actor, setAt: now, reason: historyReason, kind,
  });
  // The promoted release is everyone's now: its canary cohort is done.
  await tx.delete(schema.toolchainRollout).where(eq(schema.toolchainRollout.releaseVersion, releaseVersion));

  return {
    result: { releaseVersion, previousReleaseVersion: current, kind, changed: true },
    audit: {
      action: DEFAULT_AUDIT_ACTION[kind],
      details: {
        releaseVersion,
        previousReleaseVersion: current,
        ...(gateOverride ? { gateOverride } : {}),
        ...(acceptedVulnerabilities ? { acceptVulnerabilities: input.acceptVulnerabilities!.trim(), breaches } : {}),
        ...(kind === 'restore' && nonEmpty(input.reason) ? { reason: input.reason.trim() } : {}),
      },
    },
  };
}

/**
 * Set THE platform default (D1) through the §8 guards, in one transaction with
 * the singleton locked. Audited `toolchain.default.<kind>`; a refusal is the
 * same action with outcome `failure`.
 */
export async function setPlatformDefault(input: SetPlatformDefaultInput): Promise<SetPlatformDefaultResult> {
  const action = DEFAULT_AUDIT_ACTION[input.kind];
  return auditRefusal(input.actor, action, input.releaseVersion, async () => {
    const { result, audit } = await elevated(() => withTenantTx((tx) => applyPlatformDefault(tx, input)));
    if (audit) emitAudit(input.actor, audit);
    // §10 hygiene: org defaults this move left more than K releases behind. Best-effort, after COMMIT.
    if (result.changed) void notifyToolchainHygiene({ kind: 'behind', platformDefault: result.releaseVersion, previousDefault: result.previousReleaseVersion });
    return result;
  });
}

// -- Release lifecycle (console service functions; routes are Phase 5) -------

export interface ReleaseLifecycleInput {
  releaseVersion: string;
  actor: ToolchainActor;
}

/** Both halves (live), or 404 when the release has neither. */
async function requireHalves(tx: TenantTx, releaseVersion: string): Promise<Plugin[]> {
  const halves = await releaseHalves(tx, releaseVersion);
  if (halves.size === 0) throw new NotFoundError(`Toolchain release ${releaseVersion} not found`);
  return [...halves.values()];
}

async function removeRollout(tx: TenantTx, releaseVersion: string): Promise<number> {
  const removed = await tx.delete(schema.toolchainRollout)
    .where(eq(schema.toolchainRollout.releaseVersion, releaseVersion))
    .returning({ orgId: schema.toolchainRollout.orgId });
  return removed.length;
}

/**
 * Deprecate a release (both halves): it keeps resolving, but stops being
 * eligible for NEW org defaults and pins, and its canary rows are removed.
 * Audited `toolchain.release.deprecate`.
 */
export async function deprecateRelease(input: ReleaseLifecycleInput & { message?: string | null }): Promise<{ plugins: Plugin[]; removedRollout: number }> {
  return auditRefusal(input.actor, 'toolchain.release.deprecate', input.releaseVersion, async () => {
    const out = await elevated(() => withTenantTx(async (tx) => {
      const halves = await requireHalves(tx, input.releaseVersion);
      const now = new Date();
      const updated: Plugin[] = [];
      for (const row of halves) {
        const [u] = await tx.update(schema.plugin).set({
          deprecatedAt: row.deprecatedAt ?? now,
          deprecationMessage: input.message ?? null,
          ...(isYanked(row) ? {} : { lifecycle: 'deprecated' as const }),
          updatedAt: now,
          updatedBy: input.actor,
        }).where(eq(schema.plugin.id, row.id)).returning();
        updated.push(u as Plugin);
      }
      return { plugins: updated, removedRollout: await removeRollout(tx, input.releaseVersion) };
    }));
    await pluginService.afterManagedWrite(out.plugins, input.actor);
    emitAudit(input.actor, {
      action: 'toolchain.release.deprecate',
      details: { releaseVersion: input.releaseVersion, message: input.message ?? null, removedRolloutOrgs: out.removedRollout },
    });
    // §10 hygiene: the orgs whose default it is. Best-effort, after COMMIT.
    void notifyToolchainHygiene({ kind: 'deprecated', releaseVersion: input.releaseVersion, message: input.message ?? null });
    return out;
  });
}

/**
 * Yank a release (both halves) and remove its canary rows. Existing pins and
 * org defaults keep resolving it with a warning (exact selection).
 *
 * Yanking THE platform default restores the default it replaced — the
 * `previous_release_version` of the history row that made it the default —
 * through {@link setPlatformDefault}'s guards (`kind: 'restore'`, canary gate
 * waived), in the same transaction. With no previous default, or one that no
 * longer passes the guards, the yank is refused 409 TOOLCHAIN_DEFAULT_REQUIRED.
 * Nothing else is ever promoted implicitly (`promoteNextDefault` is never
 * reached for a managed name). Audited `toolchain.release.yank` (+
 * `toolchain.default.restore`).
 */
export async function yankRelease(input: ReleaseLifecycleInput & { reason: string }): Promise<{ plugins: Plugin[]; restored: SetPlatformDefaultResult | null; removedRollout: number }> {
  if (!nonEmpty(input.reason)) throw new ValidationError('A yank needs a reason');
  return auditRefusal(input.actor, 'toolchain.release.yank', input.releaseVersion, async () => {
    const out = await elevated(() => withTenantTx(async (tx) => {
      const halves = await requireHalves(tx, input.releaseVersion);
      const current = await lockPlatformDefault(tx);

      let restored: { result: SetPlatformDefaultResult; audit: PendingAudit | null } | null = null;
      if (current === input.releaseVersion) {
        const [made] = await tx.select({ previous: schema.toolchainDefaultHistory.previousReleaseVersion })
          .from(schema.toolchainDefaultHistory)
          .where(eq(schema.toolchainDefaultHistory.releaseVersion, input.releaseVersion))
          .orderBy(desc(schema.toolchainDefaultHistory.setAt))
          .limit(1);
        const previous = made?.previous ?? null;
        const required = (cause: string | null): ConflictError => new ConflictError(
          `${input.releaseVersion} is the platform default and there is no live previous default to restore`
            + `${previous ? ` (${previous}: ${cause})` : ''}; set another default first.`,
          ErrorCode.TOOLCHAIN_DEFAULT_REQUIRED,
          { releaseVersion: input.releaseVersion, previousReleaseVersion: previous, cause },
        );
        if (!previous) throw required(null);
        try {
          restored = await applyPlatformDefault(tx, { releaseVersion: previous, kind: 'restore', actor: input.actor, reason: `yank of ${input.releaseVersion}: ${input.reason.trim()}` });
        } catch (err) {
          if (err instanceof AppError && err.statusCode === 409) throw required(err.code);
          throw err;
        }
      }

      const now = new Date();
      const yanked: Plugin[] = [];
      for (const row of halves) {
        const [u] = await tx.update(schema.plugin).set({
          lifecycle: 'yanked', yankedAt: row.yankedAt ?? now, yankReason: input.reason.trim(), isDefault: false, updatedAt: now, updatedBy: input.actor,
        }).where(eq(schema.plugin.id, row.id)).returning();
        yanked.push(u as Plugin);
      }
      return { plugins: yanked, restored, removedRollout: await removeRollout(tx, input.releaseVersion) };
    }));
    await pluginService.afterManagedWrite(out.plugins, input.actor);
    if (out.restored?.audit) emitAudit(input.actor, out.restored.audit);
    emitAudit(input.actor, {
      action: 'toolchain.release.yank',
      details: {
        releaseVersion: input.releaseVersion,
        reason: input.reason.trim(),
        removedRolloutOrgs: out.removedRollout,
        ...(out.restored ? { restoredReleaseVersion: out.restored.result.releaseVersion } : {}),
      },
    });
    // §10 hygiene: orgs whose default it is, and owners of pipelines pinned to it. Best-effort, after COMMIT.
    void notifyToolchainHygiene({ kind: 'yanked', releaseVersion: input.releaseVersion, reason: input.reason.trim() });
    return { plugins: out.plugins, restored: out.restored?.result ?? null, removedRollout: out.removedRollout };
  });
}

/** Why a release can't be deleted: every reference, by kind. */
export interface ReleaseReferences {
  platformDefault: boolean;
  orgDefaults: number;
  canaryOrgs: number;
  pinnedPipelines: number;
  /** Pipelines deploying / declaring either half (`deleteBlockers`, both rows). */
  deployedPipelines: number;
}

function inUse(refs: ReleaseReferences): boolean {
  return refs.platformDefault || refs.orgDefaults > 0 || refs.canaryOrgs > 0 || refs.pinnedPipelines > 0 || refs.deployedPipelines > 0;
}

function inUseError(releaseVersion: string, refs: ReleaseReferences): ConflictError {
  const parts = [
    refs.platformDefault ? 'it is the platform default' : null,
    refs.orgDefaults ? `${refs.orgDefaults} org default${refs.orgDefaults === 1 ? '' : 's'}` : null,
    refs.canaryOrgs ? `${refs.canaryOrgs} canary org${refs.canaryOrgs === 1 ? '' : 's'}` : null,
    refs.pinnedPipelines ? `${refs.pinnedPipelines} pipeline pin${refs.pinnedPipelines === 1 ? '' : 's'}` : null,
    refs.deployedPipelines ? `${refs.deployedPipelines} deployed pipeline${refs.deployedPipelines === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  return new ConflictError(
    `Toolchain release ${releaseVersion} is in use (${parts.join(', ')}) and cannot be deleted.`,
    ErrorCode.PLUGIN_VERSION_IN_USE,
    { reason: 'in_use', releaseVersion, ...refs },
  );
}

async function tableReferences(tx: TenantTx, releaseVersion: string): Promise<Omit<ReleaseReferences, 'deployedPipelines'>> {
  const [row] = await executeRows<{ platform_default: boolean; org_defaults: string | number; canary_orgs: string | number; pins: string | number }>(tx, sql`
    SELECT
      EXISTS (SELECT 1 FROM toolchain_platform_default WHERE release_version = ${releaseVersion}) AS platform_default,
      (SELECT count(*) FROM org_toolchain_default WHERE release_version = ${releaseVersion}) AS org_defaults,
      (SELECT count(*) FROM toolchain_rollout WHERE release_version = ${releaseVersion}) AS canary_orgs,
      (SELECT count(*) FROM pipelines WHERE deleted_at IS NULL AND props->'toolchain'->>'release' = ${releaseVersion}) AS pins
  `);
  return {
    platformDefault: row?.platform_default === true,
    orgDefaults: Number(row?.org_defaults ?? 0),
    canaryOrgs: Number(row?.canary_orgs ?? 0),
    pinnedPipelines: Number(row?.pins ?? 0),
  };
}

/** Postgres foreign_key_violation — a reference that landed between the check and the delete. */
function isForeignKeyViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth += 1) {
    if ((e as { code?: unknown }).code === '23503') return true;
  }
  return false;
}

/**
 * Delete a release: soft-delete both halves and remove its `toolchain_release`
 * row, in one transaction. Refused 409 PLUGIN_VERSION_IN_USE while anything
 * references it — the platform default, an org default, a canary cohort, a
 * pipeline's `toolchain.release` pin, or a pipeline deploying either half (the
 * generic `deleteBlockers` path, for both rows). The FK RESTRICTs on the
 * default / org-default / rollout tables back the check up against a race.
 * Audited `toolchain.release.delete`.
 */
export async function deleteRelease(input: ReleaseLifecycleInput): Promise<{ plugins: Plugin[] }> {
  return auditRefusal(input.actor, 'toolchain.release.delete', input.releaseVersion, async () => {
    const out = await elevated(async () => {
      const halves = await withTenantTx((tx) => releaseHalves(tx, input.releaseVersion));
      // The generic in-use path (declared / deployed / exposures, the org's
      // configs), per half. Read before the write transaction: it opens its own.
      let deployedPipelines = 0;
      for (const row of halves.values()) {
        const blockers = await pluginService.deleteBlockers(row, SYSTEM_ORG_ID);
        deployedPipelines = Math.max(deployedPipelines, blockers.inUse, blockers.frozen || blockers.listed ? 1 : 0);
      }
      try {
        return await withTenantTx(async (tx) => {
          await lockPlatformDefault(tx);
          const registered = await releaseRowExists(tx, input.releaseVersion);
          if (halves.size === 0 && !registered) throw new NotFoundError(`Toolchain release ${input.releaseVersion} not found`);
          const refs: ReleaseReferences = { ...(await tableReferences(tx, input.releaseVersion)), deployedPipelines };
          if (inUse(refs)) throw inUseError(input.releaseVersion, refs);
          if (registered) await tx.delete(schema.toolchainRelease).where(eq(schema.toolchainRelease.releaseVersion, input.releaseVersion));
          return { plugins: await pluginService.tombstoneManagedRows(tx, [...halves.values()].map((r) => r.id), input.actor) };
        });
      } catch (err) {
        if (isForeignKeyViolation(err)) {
          throw new ConflictError(
            `Toolchain release ${input.releaseVersion} became referenced while it was being deleted; try again.`,
            ErrorCode.PLUGIN_VERSION_IN_USE,
            { reason: 'in_use', releaseVersion: input.releaseVersion },
          );
        }
        throw err;
      }
    });
    await pluginService.afterManagedWrite(out.plugins, input.actor, 'deleted');
    emitAudit(input.actor, {
      action: 'toolchain.release.delete',
      details: { releaseVersion: input.releaseVersion, plugins: out.plugins.map((p) => ({ name: p.name, digest: p.imageDigest ?? null })) },
    });
    return out;
  });
}

