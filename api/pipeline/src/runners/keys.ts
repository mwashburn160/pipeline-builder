// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org runner signing keys: the effective-key rule, the key lifecycle and
 * the key-mode (inherit / own) transitions.
 *
 * Model (pipeline_runner_signing_keys): `next` (published, not signing) →
 * `active` (signs) → `retiring` (published only) → `retired` (row kept, private
 * key wiped). At most one of each published state per org (partial unique
 * indexes). The PKCS#8 PEM is generated here and stored only as
 * `encryptSecret(pem, orgId)`; no function in this module returns it.
 *
 * Effective key org: the org itself in `own` mode, else the nearest ancestor
 * in `own` mode (root orgs are always `own`). A runner is signed with the
 * effective key org of its OWNING org (`runner.orgId` from the database).
 * During a transition (a mode switch or an ancestry change) the previous
 * effective key org signs until `switch_at` and stays published until
 * `transition_until`, so the key a runner trusts never changes abruptly.
 *
 * Every change runs in one transaction with `SELECT … FOR UPDATE` on the org's
 * rows; a concurrent writer that loses the partial-unique-index race gets 409.
 * After COMMIT: an audit entry (kids only), an org notice, and a pub/sub
 * invalidation for the org plus every team whose effective key it is.
 */

import { createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { actorId, createLogger, errorMessage, SYSTEM_ORG_ID, type RemoteAuditAction } from '@pipeline-builder/api-core';
import {
  RUNNER_KEY_ACTIVATION_DELAY_MS,
  RUNNER_KEY_AGE_FOLLOWUP_DAYS,
  RUNNER_KEY_METRICS,
  RUNNER_KEY_RETIRE_WINDOW_MS,
  isRunnerKeyServiceUnavailable,
  runnerKeyAgeDays,
  runnerKeyRevokeConfirmation,
  type PublishedRunnerKeyState,
  type RunnerKeyMode,
  type RunnerKeyRetiredReason,
  type RunnerKeyRotationState,
  type RunnerKeyStatusRow,
  type RunnerKeyTransitionKind,
  type RunnerPublicJwk,
  type RunnerSigningKeyDto,
  type RunnerSigningKeySummary,
} from '@pipeline-builder/api-core/pipeline-runners';
import type { RunnerDeps } from './deps.js';
import { ed25519Jwk } from './jws.js';
import { sendKeyNotice, sendUnreadableKeyNotice, type KeyNoticeEvent } from './key-notices.js';
import { isUniqueViolation, type KeyRow, type KeySettingsRow, type KeyTx } from './key-store.js';
import { RunnerRouteError, runnersUnavailable } from './routing.js';
import { createRunRequestSigner, type ResolvedSigner } from './signing.js';
import { tunable } from './vocabulary.js';

const logger = createLogger('runner-keys');

/** The audit target type of a key event. */
const KEY_TARGET = 'pipeline_runner_signing_key';
/** The sweep's actor id. */
const SYSTEM_ACTOR = actorId({ userId: null });
/** The audit actions of key events (the shared catalog's `pipeline.runner.key.*` members). */
export type KeyAuditAction = Extract<RemoteAuditAction, `pipeline.runner.key.${string}`>;

/** The public JWK of a stored key, rebuilt from its kid and x only (nothing else in the row is published). */
const publicJwkOf = (kid: string, x: string): RunnerPublicJwk => ({ kty: 'OKP', crv: 'Ed25519', x, kid, use: 'sig', alg: 'EdDSA' });

const lc = (s: string) => s.toLowerCase();
const uniq = (xs: readonly (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x).map(lc))];

// -- The effective key org ------------------------------------------------------

/** An active transition, wherever on the chain it is recorded. */
export interface ActiveTransition {
  /** The org whose row holds it. */
  onOrgId: string;
  kind: RunnerKeyTransitionKind;
  previousKeyOrgId: string | null;
  /** null = an ancestry change the sweep has not recorded yet (the previous org keeps signing). */
  switchAt: Date | null;
  until: Date | null;
}

/** Who signs and who is published for one runner-owning org. */
export interface KeyContext {
  ownerOrgId: string;
  /** The owner, then its ancestors nearest first. */
  chain: string[];
  isRoot: boolean;
  /** The owner's own mode. */
  mode: RunnerKeyMode;
  settings: Map<string, KeySettingsRow>;
  effectiveOrgId: string;
  transition: ActiveTransition | null;
  /** The org whose `active` key signs right now. */
  signingOrgId: string;
  /** The transition's previous effective key org (published alongside), if any. */
  previousOrgId: string | null;
}

/** Mode of `chain[i]` (root orgs are always `own`; a missing row is `inherit` for a team). */
function modeAt(chain: string[], settings: Map<string, KeySettingsRow>, i: number): RunnerKeyMode {
  if (i === chain.length - 1) return 'own';
  return settings.get(chain[i]!)?.mode ?? 'inherit';
}

/** Resolve the effective key org, the transition in force and the signing org of `orgId`. */
export async function resolveKeyContext(deps: RunnerDeps, orgId: string, now: Date = new Date(deps.now())): Promise<KeyContext> {
  const owner = lc(orgId);
  // Strict: a failed lookup throws rather than make a team look like a root org.
  const chain = [owner, ...(await deps.hierarchy.ancestors(owner, undefined, { strict: true })).map(lc)];
  const settings = new Map((await deps.keyStore.settings(chain)).map((r) => [lc(r.orgId), r]));
  let transition: ActiveTransition | null = null;
  let effectiveOrgId = chain[chain.length - 1]!;
  for (let i = 0; i < chain.length; i++) {
    const row = settings.get(chain[i]!);
    if (!transition && row?.transitionKind && row.transitionUntil && row.transitionUntil > now) {
      transition = {
        onOrgId: chain[i]!,
        kind: row.transitionKind,
        previousKeyOrgId: row.previousKeyOrgId ? lc(row.previousKeyOrgId) : null,
        switchAt: row.switchAt,
        until: row.transitionUntil,
      };
    }
    if (modeAt(chain, settings, i) === 'own') { effectiveOrgId = chain[i]!; break; }
  }
  // An ancestry change the sweep has not recorded yet: keep the last resolved org signing.
  const stored = settings.get(owner)?.effectiveKeyOrgId;
  if (!transition && stored && lc(stored) !== effectiveOrgId) {
    transition = { onOrgId: owner, kind: 'ancestry', previousKeyOrgId: lc(stored), switchAt: null, until: null };
  }
  const previousOrgId = transition?.previousKeyOrgId && transition.previousKeyOrgId !== effectiveOrgId ? transition.previousKeyOrgId : null;
  const beforeSwitch = !!previousOrgId && (!transition!.switchAt || now < transition!.switchAt);
  return {
    ownerOrgId: owner,
    chain,
    isRoot: chain.length === 1,
    mode: modeAt(chain, settings, 0),
    settings,
    effectiveOrgId,
    transition,
    signingOrgId: beforeSwitch ? previousOrgId! : effectiveOrgId,
    previousOrgId,
  };
}

// -- Signing --------------------------------------------------------------------

/** Mark (or clear) an org's key as unreadable on this replica, keeping the alert gauge current. */
function noteReadable(deps: RunnerDeps, orgId: string, readable: boolean): void {
  const set = deps.keyCaches.unreadable;
  const wasUnreadable = set.has(orgId);
  if (readable) set.delete(orgId); else set.add(orgId);
  // Only a change moves the gauge; the operator is told once per org per replica.
  if (wasUnreadable === readable) deps.metrics.gauge(RUNNER_KEY_METRICS.unreadable, {}, set.size);
  if (!readable && !wasUnreadable) void sendUnreadableKeyNotice(deps, orgId);
}

/**
 * A transient key-service failure (KMS config lookup or KMS unreachable: not
 * the key's fault) as 409 RUNNERS_UNAVAILABLE with reason `key_service` —
 * never the operator pause (logged; no unreadable gauge, no operator notice), else null.
 */
function keyServiceRefusal(err: unknown, orgId: string): RunnerRouteError | null {
  if (!isRunnerKeyServiceUnavailable(err)) return null;
  logger.warn('Runner signing key service unavailable; retried later', { orgId, source: err.source, error: errorMessage(err) });
  return runnersUnavailable(err.reason ?? 'key_service');
}

/**
 * Decrypt one key row into a KeyObject. A transient key-service failure is
 * RUNNERS_UNAVAILABLE; any other failure (a real decrypt failure of the
 * ciphertext) is RUNNER_KEY_UNREADABLE (logged without material).
 */
async function privateKeyOf(deps: RunnerDeps, row: KeyRow): Promise<KeyObject> {
  try {
    if (!row.privateKeyEnc) throw new Error('key has no private part');
    const pem = await deps.secrets.decrypt(row.privateKeyEnc, row.orgId);
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 key');
    noteReadable(deps, lc(row.orgId), true);
    return key;
  } catch (err) {
    const transient = keyServiceRefusal(err, row.orgId);
    if (transient) throw transient;
    logger.error('Runner signing key could not be decrypted', { orgId: row.orgId, kid: row.kid, error: errorMessage(err) });
    noteReadable(deps, lc(row.orgId), false);
    throw new RunnerRouteError('RUNNER_KEY_UNREADABLE', "Your organization's runner signing key can't be read. Runs through your runners are paused until your platform operator fixes it.");
  }
}

/**
 * The signer for a runner-owning org (uncached; `deps.signerFor` caches it).
 * Throws RUNNER_KEY_MISSING when there is no active key to sign with.
 */
export async function buildOrgSigner(deps: RunnerDeps, orgId: string): Promise<ResolvedSigner> {
  const ctx = await resolveKeyContext(deps, orgId);
  const versionOrgIds = uniq([...ctx.chain, ctx.previousOrgId]);
  // Read the version FIRST: a change landing after it makes the poll drop this entry.
  const version = await deps.keyStore.version(versionOrgIds);
  const rows = await deps.keyStore.publishedKeys(uniq([ctx.signingOrgId, ctx.previousOrgId]));
  const activeOf = (org: string | null) => (org ? rows.find((r) => lc(r.orgId) === org && r.state === 'active') : undefined);
  // inherit → own: the new key promotes at the first sweep after switch_at; until then the previous org signs.
  const row = activeOf(ctx.signingOrgId) ?? (ctx.signingOrgId === ctx.effectiveOrgId ? activeOf(ctx.previousOrgId) : undefined);
  if (!row) {
    throw new RunnerRouteError('RUNNER_KEY_MISSING', 'Your organization has no runner signing key yet. A key is created when you register your first runner, or generate one in Settings → Pipeline runners.');
  }
  const key = await privateKeyOf(deps, row);
  return { signer: createRunRequestSigner(key, undefined, deps.now), versionOrgIds, version };
}

// -- Public keys ------------------------------------------------------------------

/** The order published keys are listed in: the signing key first. */
const STATE_ORDER = { active: 0, next: 1, retiring: 2 } as const satisfies Record<PublishedRunnerKeyState, number>;

/**
 * The public keys runner `runnerId` trusts: its owner's effective key org's
 * next/active/retiring keys, plus a transition's previous org's active and
 * retiring keys. null for an unknown or revoked runner, or one with no keys.
 */
export async function publicKeysForRunner(deps: RunnerDeps, runnerId: string): Promise<{ ownerOrgId: string; keys: RunnerPublicJwk[] } | null> {
  const runner = await deps.store.getRunner(runnerId);
  if (!runner || runner.status === 'revoked') return null;
  const ctx = await resolveKeyContext(deps, runner.orgId);
  const rows = await deps.keyStore.publishedKeys(uniq([ctx.effectiveOrgId, ctx.previousOrgId]));
  const keep = rows.filter((r) => lc(r.orgId) === ctx.effectiveOrgId || (r.state === 'active' || r.state === 'retiring'));
  keep.sort((a, b) => (lc(a.orgId) === ctx.effectiveOrgId ? 0 : 1) - (lc(b.orgId) === ctx.effectiveOrgId ? 0 : 1) || STATE_ORDER[a.state as PublishedRunnerKeyState] - STATE_ORDER[b.state as PublishedRunnerKeyState]);
  const seen = new Set<string>();
  const keys: RunnerPublicJwk[] = [];
  for (const r of keep) {
    if (seen.has(r.kid)) continue;
    seen.add(r.kid);
    keys.push(publicJwkOf(r.kid, r.publicJwk.x));
  }
  return keys.length > 0 ? { ownerOrgId: lc(runner.orgId), keys } : null;
}

// -- Inheritance fan-out ------------------------------------------------------------

/**
 * The teams whose runners verify with `orgId`'s keys: descendants whose
 * effective key org it is, plus orgs in a transition from or to it.
 */
export async function inheritingOrgs(deps: RunnerDeps, orgId: string): Promise<string[]> {
  const org = lc(orgId);
  const out = new Set<string>();
  let descendants: string[] = [];
  try { descendants = (await deps.hierarchy.descendants(org)).map(lc).filter((d) => d !== org); } catch { /* fewer, never more */ }
  for (const d of descendants) {
    const ctx = await resolveKeyContext(deps, d);
    if (ctx.effectiveOrgId === org || ctx.previousOrgId === org) out.add(d);
  }
  for (const row of await deps.keyStore.transitions()) {
    if (row.previousKeyOrgId && lc(row.previousKeyOrgId) === org && lc(row.orgId) !== org) out.add(lc(row.orgId));
  }
  return [...out];
}

/** After a committed change: drop every replica's cache entries for the org and its inheriting teams. */
async function publishChange(deps: RunnerDeps, orgId: string, extra: readonly string[] = []): Promise<string[]> {
  let teams: string[] = [];
  try { teams = await inheritingOrgs(deps, orgId); } catch (err) {
    logger.warn('Could not resolve inheriting teams; the version poll covers them', { error: errorMessage(err) });
  }
  const orgIds = uniq([orgId, ...extra, ...teams]);
  deps.publishKeyInvalidation({ kind: 'keys', orgIds });
  return orgIds;
}

// -- Key material ---------------------------------------------------------------------

interface NewKey { kid: string; publicJwk: RunnerPublicJwk; privateKeyEnc: string }

/** A fresh Ed25519 pair, the private half encrypted for `orgId`. The PEM never leaves this function. */
async function newKeyMaterial(deps: RunnerDeps, orgId: string): Promise<NewKey> {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = ed25519Jwk(privateKey);
  let privateKeyEnc: string;
  try {
    privateKeyEnc = await deps.secrets.encrypt(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), orgId);
  } catch (err) {
    const transient = keyServiceRefusal(err, orgId);
    if (transient) throw transient;
    logger.error('Runner signing key could not be encrypted', { orgId, error: errorMessage(err) });
    noteReadable(deps, orgId, false);
    throw new RunnerRouteError('RUNNER_KEY_UNREADABLE', "Your organization's runner signing key can't be stored. Your platform operator must fix secret encryption.");
  }
  return { kid: jwk.kid, publicJwk: publicJwkOf(jwk.kid, jwk.x), privateKeyEnc };
}

const RETIRED = (now: Date, reason: RunnerKeyRetiredReason): Partial<KeyRow> => ({
  state: 'retired', retiredAt: now, retiredReason: reason, privateKeyEnc: null, retireAfter: null,
});

// -- Transactions ---------------------------------------------------------------------

interface OrgView { keys: KeyRow[]; settings: KeySettingsRow | null; mode: RunnerKeyMode }

const byState = (keys: KeyRow[], state: PublishedRunnerKeyState) => keys.find((k) => k.state === state);

/** Run `fn` with the org's rows locked; a lost one-per-state race becomes `onConflict`. */
async function withOrgLocked<T>(deps: RunnerDeps, orgId: string, isRoot: boolean, fn: (tx: KeyTx, view: OrgView) => Promise<T>, onConflict: () => RunnerRouteError): Promise<T> {
  try {
    return await deps.keyStore.transaction(async (tx) => {
      const settings = await tx.lockSettings(orgId);
      const keys = await tx.lockKeys(orgId);
      const mode: RunnerKeyMode = isRoot ? 'own' : settings?.mode ?? 'inherit';
      return fn(tx, { keys, settings, mode });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw onConflict();
    throw err;
  }
}

const inherited = () => new RunnerRouteError('RUNNER_KEY_INHERITED', "This organization uses its parent's signing key. Switch to your own key (Use our own key) before changing it, or ask the parent organization's admins.");
const inProgress = () => new RunnerRouteError('RUNNER_KEY_TRANSITION_IN_PROGRESS', 'A key rotation or key-mode change is already in progress. Wait for it to finish (up to about 75 minutes), or finish it from the Signing key card.');
const exists = () => new RunnerRouteError('RUNNER_KEY_EXISTS', 'Your organization already has a signing key. Rotate it instead.');
const missing = () => new RunnerRouteError('RUNNER_KEY_MISSING', 'Your organization has no runner signing key yet. Generate one in Settings → Pipeline runners.');
const noRotation = () => new RunnerRouteError('RUNNER_KEY_NO_ROTATION', 'There is no rotation to cancel or finish. Reload the Signing key card to see the current state.');

function transitionActive(s: KeySettingsRow | null, now: Date): boolean {
  return !!s?.transitionKind && !!s.transitionUntil && s.transitionUntil > now;
}

/** Who did it, for audit and `created_by`. */
export interface KeyActor { userId: string | null; system?: boolean; reason?: string }

function audit(deps: RunnerDeps, actor: KeyActor, orgId: string, action: KeyAuditAction, targetId: string, details: Record<string, unknown>, extra: { targetType?: string; affectedOrgId?: string } = {}): void {
  deps.audit({
    action,
    actorId: actor.userId ? actorId({ userId: actor.userId }) : SYSTEM_ACTOR,
    orgId,
    targetType: extra.targetType ?? KEY_TARGET,
    targetId,
    details,
    ...(extra.affectedOrgId ? { affectedOrgId: extra.affectedOrgId } : {}),
  });
}

async function afterChange(deps: RunnerDeps, orgId: string, notice: KeyNoticeEvent | null, extra: readonly string[] = []): Promise<void> {
  const affected = await publishChange(deps, orgId, extra);
  if (notice) await sendKeyNotice(deps, affected, notice);
}

async function rootness(deps: RunnerDeps, orgId: string): Promise<boolean> {
  return (await deps.hierarchy.ancestors(orgId, undefined, { strict: true })).length === 0;
}

// -- Org-admin operations ----------------------------------------------------------------

/** Generate the org's first key, created `active` (no runner trusts any key of it yet). */
export async function generateOrgKey(deps: RunnerDeps, orgId: string, actor: KeyActor, opts: { auto?: boolean; onBehalfOfOrgId?: string } = {}): Promise<{ kid: string }> {
  const org = lc(orgId);
  const isRoot = await rootness(deps, org);
  const material = await newKeyMaterial(deps, org);
  const now = new Date(deps.now());
  await withOrgLocked(deps, org, isRoot, async (tx, v) => {
    if (v.mode === 'inherit') throw inherited();
    if (v.keys.length > 0) throw exists();
    await tx.insertKey({ orgId: org, ...material, state: 'active', activatesAt: now, createdBy: actor.userId });
    if (!v.settings) await tx.upsertSettings(org, { mode: 'own', effectiveKeyOrgId: org, updatedBy: actor.userId });
  }, exists);
  const onBehalfOfOrgId = opts.onBehalfOfOrgId ? lc(opts.onBehalfOfOrgId) : undefined;
  audit(deps, actor, org, 'pipeline.runner.key.generate', material.kid, {
    kid: material.kid, state: 'active', ...(opts.auto ? { auto: true } : {}), ...(onBehalfOfOrgId ? { onBehalfOfOrgId } : {}),
  });
  await afterChange(deps, org, { kind: 'generate', kid: material.kid, auto: !!opts.auto, forTeam: !!onBehalfOfOrgId });
  return { kid: material.kid };
}

/**
 * Called before a runner registers: when the registering org's effective key
 * org has no key at all, create one `active` for it (audited `.generate`,
 * `auto: true`). That is the org itself (a root org, or a team in `own` mode),
 * or — for an inheriting team — the ancestor whose key it inherits, usually
 * the root org. A key made for an ancestor is the system actor's, on behalf
 * of the team (`details.onBehalfOfOrgId`): the team's user is no actor in the
 * ancestor's audit trail and no `created_by` of its key. A lost race with
 * another registration is fine.
 */
export async function ensureOrgKeyForFirstRunner(deps: RunnerDeps, orgId: string, userId: string | null = null): Promise<void> {
  const ctx = await resolveKeyContext(deps, orgId);
  if (ctx.transition) return;
  const keys = await deps.keyStore.publishedKeys([ctx.effectiveOrgId]);
  if (keys.length > 0) return;
  const forAncestor = ctx.effectiveOrgId !== ctx.ownerOrgId;
  try {
    await generateOrgKey(deps, ctx.effectiveOrgId, forAncestor ? { userId: null, system: true } : { userId },
      { auto: true, ...(forAncestor ? { onBehalfOfOrgId: ctx.ownerOrgId } : {}) });
  } catch (err) {
    if (err instanceof RunnerRouteError && err.code === 'RUNNER_KEY_EXISTS') return;
    throw err;
  }
}

/** Publish a `next` key that starts signing in 10 minutes. */
export async function rotateOrgKey(deps: RunnerDeps, orgId: string, actor: KeyActor): Promise<{ kid: string; activatesAt: Date }> {
  const org = lc(orgId);
  const isRoot = await rootness(deps, org);
  const material = await newKeyMaterial(deps, org);
  const now = new Date(deps.now());
  const activatesAt = new Date(now.getTime() + RUNNER_KEY_ACTIVATION_DELAY_MS);
  const previousKid = await withOrgLocked(deps, org, isRoot, async (tx, v) => {
    if (v.mode === 'inherit') throw inherited();
    const active = byState(v.keys, 'active');
    if (byState(v.keys, 'next') || byState(v.keys, 'retiring') || transitionActive(v.settings, now)) throw inProgress();
    if (!active) throw missing();
    await tx.insertKey({ orgId: org, ...material, state: 'next', activatesAt, createdBy: actor.userId });
    return active.kid;
  }, inProgress);
  audit(deps, actor, org, 'pipeline.runner.key.rotate', material.kid, { kid: material.kid, activatesAt: activatesAt.toISOString(), previousKid });
  await afterChange(deps, org, { kind: 'rotate', kid: material.kid, activatesAt });
  return { kid: material.kid, activatesAt };
}

/** Withdraw a `next` key before it activates (it is retired, `cancelled`). */
export async function cancelOrgKeyRotation(deps: RunnerDeps, orgId: string, actor: KeyActor): Promise<{ kid: string }> {
  const org = lc(orgId);
  const isRoot = await rootness(deps, org);
  const now = new Date(deps.now());
  const kid = await withOrgLocked(deps, org, isRoot, async (tx, v) => {
    if (v.mode === 'inherit') throw inherited();
    const next = byState(v.keys, 'next');
    if (!next) throw noRotation();
    // The key an inherit → own switch is waiting on can't be withdrawn (the org would have no key).
    if (!byState(v.keys, 'active') && transitionActive(v.settings, now)) throw inProgress();
    await tx.updateKey(next.id, RETIRED(now, 'cancelled'));
    return next.kid;
  }, inProgress);
  audit(deps, actor, org, 'pipeline.runner.key.cancel', kid, { kid });
  await afterChange(deps, org, null);
  return { kid };
}

/** Retire the `retiring` key once its `retire_after` has passed. */
export async function finishOrgKeyRotation(deps: RunnerDeps, orgId: string, actor: KeyActor): Promise<{ kid: string }> {
  const org = lc(orgId);
  const isRoot = await rootness(deps, org);
  const now = new Date(deps.now());
  const kid = await withOrgLocked(deps, org, isRoot, async (tx, v) => {
    if (v.mode === 'inherit') throw inherited();
    const retiring = byState(v.keys, 'retiring');
    if (!retiring) throw noRotation();
    if (!retiring.retireAfter || retiring.retireAfter > now) {
      throw new RunnerRouteError('RUNNER_KEY_RETIRE_TOO_EARLY', `The old key can't be removed yet: runners may still be using it. Finish now is available after ${retiring.retireAfter?.toISOString() ?? 'the time shown on the card'}.`);
    }
    await tx.updateKey(retiring.id, RETIRED(now, 'finished'));
    return retiring.kid;
  }, inProgress);
  audit(deps, actor, org, 'pipeline.runner.key.finish', kid, { kid });
  await afterChange(deps, org, null);
  return { kid };
}

/**
 * Emergency revoke: retire the active key now and promote `next` (or create a
 * new active key). `confirm` (org admins) must be the last 6 characters of the
 * active kid; the system-org operator path passes `null`.
 *
 * A team switching own → inherit keeps signing with its own key until
 * `switch_at`: the operator may revoke that key too. It is retired now (a
 * pending `next` with it), no new team key is made, and signing moves to the
 * inherited key at once (`switch_at` brought forward to now). The answer's
 * `activeKid` is then the inherited key's (null when that org has none yet).
 */
export async function revokeOrgKey(deps: RunnerDeps, orgId: string, actor: KeyActor, confirm: string | null): Promise<{ revokedKid: string | null; activeKid: string | null }> {
  const org = lc(orgId);
  const isRoot = await rootness(deps, org);
  const material = await newKeyMaterial(deps, org);
  const now = new Date(deps.now());
  const result = await withOrgLocked(deps, org, isRoot, async (tx, v) => {
    const active = byState(v.keys, 'active');
    const leaving = v.mode === 'inherit' && !!actor.system && !!active && v.settings?.transitionKind === 'to_inherit' && transitionActive(v.settings, now);
    if (v.mode === 'inherit' && !leaving) throw inherited();
    if (leaving) {
      await tx.updateKey(active!.id, RETIRED(now, 'revoked'));
      const pending = byState(v.keys, 'next');
      if (pending) await tx.updateKey(pending.id, RETIRED(now, 'mode_switch'));
      await tx.upsertSettings(org, { mode: 'inherit', switchAt: now });
      const target = v.settings?.effectiveKeyOrgId ? lc(v.settings.effectiveKeyOrgId) : null;
      const inheritedKeys = target ? await deps.keyStore.publishedKeys([target]) : [];
      return { revokedKid: active!.kid, activeKid: byState(inheritedKeys, 'active')?.kid ?? null };
    }
    if (!active && !actor.system) throw missing();
    if (confirm !== null && (!active || confirm.trim() !== runnerKeyRevokeConfirmation(active.kid))) {
      throw new RunnerRouteError('RUNNER_KEY_CONFIRMATION_MISMATCH', "The confirmation doesn't match. Type the last 6 characters of the active key id.");
    }
    if (active) await tx.updateKey(active.id, RETIRED(now, 'revoked'));
    const next = byState(v.keys, 'next');
    if (next) {
      await tx.updateKey(next.id, { state: 'active', activatesAt: now });
      return { revokedKid: active?.kid ?? null, activeKid: next.kid };
    }
    await tx.insertKey({ orgId: org, ...material, state: 'active', activatesAt: now, createdBy: actor.userId });
    if (!v.settings) await tx.upsertSettings(org, { mode: 'own', effectiveKeyOrgId: org, updatedBy: actor.userId });
    return { revokedKid: active?.kid ?? null, activeKid: material.kid };
  }, inProgress);
  if (actor.system) {
    audit(deps, actor, SYSTEM_ORG_ID, 'pipeline.runner.key.system_revoke', result.revokedKid ?? result.activeKid ?? org,
      { kid: result.revokedKid, newActiveKid: result.activeKid, ...(actor.reason ? { reason: actor.reason } : {}) }, { affectedOrgId: org });
  } else {
    audit(deps, actor, org, 'pipeline.runner.key.revoke', result.revokedKid ?? result.activeKid ?? org, { kid: result.revokedKid, newActiveKid: result.activeKid });
  }
  await afterChange(deps, org, { kind: 'revoke', kid: result.revokedKid, newActiveKid: result.activeKid, bySystem: !!actor.system });
  return result;
}

/**
 * Switch a team between inheriting its parent's key and owning one.
 *  - inherit → own: the team's first key is created `next` (signs after 10 min);
 *    the parent's keys stay published for its runners until 1 h after that.
 *  - own → inherit: the parent's keys are published now; signing moves to them
 *    after 10 min; the team's keys become `retiring` then and retire 1 h later.
 */
export async function setOrgKeyMode(deps: RunnerDeps, orgId: string, mode: RunnerKeyMode, actor: KeyActor): Promise<{ from: RunnerKeyMode; to: RunnerKeyMode; switchAt: Date; until: Date }> {
  const org = lc(orgId);
  const ctx = await resolveKeyContext(deps, org);
  if (ctx.isRoot) throw new RunnerRouteError('RUNNER_KEY_MODE_ROOT_ORG', 'A top-level organization always uses its own key. Only sub-organizations can inherit a key.');
  if (ctx.mode === mode) throw new RunnerRouteError('VALIDATION_ERROR', `This organization already uses ${mode === 'own' ? 'its own key' : "its parent's key"}.`);
  if (ctx.transition) throw inProgress();
  const now = new Date(deps.now());
  const switchAt = new Date(now.getTime() + RUNNER_KEY_ACTIVATION_DELAY_MS);
  const until = new Date(switchAt.getTime() + RUNNER_KEY_RETIRE_WINDOW_MS);
  const material = mode === 'own' ? await newKeyMaterial(deps, org) : null;
  // The effective key org once the switch is made: the team itself, or its nearest own ancestor.
  let newEffective = org;
  if (mode === 'inherit') {
    newEffective = ctx.chain[ctx.chain.length - 1]!;
    for (let i = 1; i < ctx.chain.length; i++) if (modeAt(ctx.chain, ctx.settings, i) === 'own') { newEffective = ctx.chain[i]!; break; }
  }
  const from = ctx.mode;
  await withOrgLocked(deps, org, false, async (tx, v) => {
    if (v.mode === mode) throw new RunnerRouteError('VALIDATION_ERROR', 'The key mode already changed.');
    if (transitionActive(v.settings, now) || byState(v.keys, 'next') || byState(v.keys, 'retiring')) throw inProgress();
    if (mode === 'own') {
      // A team that once owned keys keeps none published (they were retired on the way to inherit).
      await tx.insertKey({ orgId: org, ...material!, state: 'next', activatesAt: switchAt, createdBy: actor.userId });
    }
    await tx.upsertSettings(org, {
      mode,
      modeChangedAt: now,
      effectiveKeyOrgId: newEffective,
      transitionKind: mode === 'own' ? 'to_own' : 'to_inherit',
      previousKeyOrgId: ctx.effectiveOrgId,
      switchAt,
      transitionUntil: until,
      updatedBy: actor.userId,
    });
  }, inProgress);
  audit(deps, actor, org, 'pipeline.runner.key.mode', org, { from, to: mode, switchAt: switchAt.toISOString(), until: until.toISOString() }, { targetType: 'organization' });
  await afterChange(deps, org, { kind: 'mode', from, to: mode, switchAt }, [ctx.effectiveOrgId]);
  return { from, to: mode, switchAt, until };
}

// -- The sweep ---------------------------------------------------------------------------

/** `next` keys whose `activates_at` passed become `active`; the old active becomes `retiring` for 1 h. */
export async function promoteDueKeys(deps: RunnerDeps, now: Date = new Date(deps.now())): Promise<void> {
  for (const orgId of await deps.keyStore.orgsWithDueNext(now)) {
    try {
      const done = await deps.keyStore.transaction(async (tx) => {
        const keys = await tx.lockKeys(orgId);
        const next = byState(keys, 'next');
        if (!next || next.activatesAt > now) return null;
        const active = byState(keys, 'active');
        const retiring = byState(keys, 'retiring');
        // The indexes aren't deferrable: free the retiring slot, then the active one, then promote.
        if (retiring && active) await tx.updateKey(retiring.id, RETIRED(now, 'finished'));
        if (active) await tx.updateKey(active.id, { state: 'retiring', retireAfter: new Date(now.getTime() + RUNNER_KEY_RETIRE_WINDOW_MS) });
        await tx.updateKey(next.id, { state: 'active', activatesAt: now });
        return { kid: next.kid, previousKid: active?.kid ?? null };
      });
      if (!done) continue;
      audit(deps, { userId: null, system: true }, orgId, 'pipeline.runner.key.promote', done.kid, done);
      await afterChange(deps, orgId, { kind: 'promote', ...done });
    } catch (err) {
      logger.warn('Runner key promotion failed; retried next sweep', { orgId, error: errorMessage(err) });
    }
  }
}

/** `retiring` keys whose `retire_after` passed are retired (private key wiped). */
export async function retireDueKeys(deps: RunnerDeps, now: Date = new Date(deps.now())): Promise<void> {
  for (const orgId of await deps.keyStore.orgsWithDueRetiring(now)) {
    try {
      const done = await deps.keyStore.transaction(async (tx) => {
        const settings = await tx.lockSettings(orgId);
        const retiring = byState(await tx.lockKeys(orgId), 'retiring');
        if (!retiring || !retiring.retireAfter || retiring.retireAfter > now) return null;
        const reason: RunnerKeyRetiredReason = settings?.mode === 'inherit' ? 'mode_switch' : 'finished';
        await tx.updateKey(retiring.id, RETIRED(now, reason));
        return { kid: retiring.kid, reason };
      });
      if (!done) continue;
      audit(deps, { userId: null, system: true }, orgId, 'pipeline.runner.key.retire', done.kid, done);
      await afterChange(deps, orgId, null);
    } catch (err) {
      logger.warn('Runner key retirement failed; retried next sweep', { orgId, error: errorMessage(err) });
    }
  }
}

/**
 * Mode-switch and ancestry bookkeeping:
 *  - own → inherit: at `switch_at` the team's active key becomes `retiring`
 *    (until `transition_until`) and a pending `next` is withdrawn;
 *  - at `transition_until` the transition is cleared;
 *  - every runner-owning org's effective key org is compared with the one last
 *    recorded; a change (a team moved, or its parent deleted) starts an
 *    `ancestry` transition with the same 10-minute and 1-hour windows.
 */
export async function advanceKeyTransitions(deps: RunnerDeps, now: Date = new Date(deps.now())): Promise<void> {
  for (const row of await deps.keyStore.transitions()) {
    const orgId = lc(row.orgId);
    try {
      const changed = await deps.keyStore.transaction(async (tx) => {
        const s = await tx.lockSettings(orgId);
        if (!s?.transitionKind) return false;
        let did = false;
        if (s.transitionKind === 'to_inherit' && s.mode === 'inherit' && s.switchAt && s.switchAt <= now) {
          const keys = await tx.lockKeys(orgId);
          const next = byState(keys, 'next');
          if (next) { await tx.updateKey(next.id, RETIRED(now, 'mode_switch')); did = true; }
          const active = byState(keys, 'active');
          if (active) {
            const retiring = byState(keys, 'retiring');
            if (retiring) await tx.updateKey(retiring.id, RETIRED(now, 'mode_switch'));
            await tx.updateKey(active.id, { state: 'retiring', retireAfter: s.transitionUntil ?? now });
            did = true;
          }
        }
        if (s.transitionUntil && s.transitionUntil <= now) {
          await tx.upsertSettings(orgId, { mode: s.mode, transitionKind: null, previousKeyOrgId: null, switchAt: null, transitionUntil: null });
          did = true;
        }
        return did;
      });
      if (changed) await afterChange(deps, orgId, null);
    } catch (err) {
      logger.warn('Runner key transition step failed; retried next sweep', { orgId, error: errorMessage(err) });
    }
  }

  // Ancestry changes, for every org that owns runners.
  const owners = [...(await deps.keyStore.runnerCounts()).keys()].map(lc);
  for (const orgId of owners) {
    try {
      const ctx = await resolveKeyContext(deps, orgId, now);
      const row = ctx.settings.get(orgId);
      const recorded = row?.effectiveKeyOrgId ? lc(row.effectiveKeyOrgId) : null;
      if (recorded === ctx.effectiveOrgId) continue;
      const chainTransition = ctx.transition && ctx.transition.onOrgId !== orgId && ctx.transition.switchAt !== null;
      const ownTransition = transitionActive(row ?? null, now);
      const startAncestry = !!recorded && !chainTransition && !ownTransition;
      const switchAt = new Date(now.getTime() + RUNNER_KEY_ACTIVATION_DELAY_MS);
      await deps.keyStore.transaction(async (tx) => {
        const s = await tx.lockSettings(orgId);
        const mode: RunnerKeyMode = s?.mode ?? (ctx.isRoot ? 'own' : 'inherit');
        if (startAncestry && !transitionActive(s, now)) {
          await tx.upsertSettings(orgId, {
            mode,
            effectiveKeyOrgId: ctx.effectiveOrgId,
            transitionKind: 'ancestry',
            previousKeyOrgId: recorded,
            switchAt,
            transitionUntil: new Date(switchAt.getTime() + RUNNER_KEY_RETIRE_WINDOW_MS),
          });
        } else {
          // First resolution, or the change is already covered by a transition: just record it.
          await tx.upsertSettings(orgId, { mode, effectiveKeyOrgId: ctx.effectiveOrgId });
        }
      });
      if (startAncestry) {
        audit(deps, { userId: null, system: true }, orgId, 'pipeline.runner.key.mode', orgId,
          { from: recorded, to: ctx.effectiveOrgId, switchAt: switchAt.toISOString(), until: new Date(switchAt.getTime() + RUNNER_KEY_RETIRE_WINDOW_MS).toISOString(), ancestry: true },
          { targetType: 'organization' });
        await afterChange(deps, orgId, null, [recorded!, ctx.effectiveOrgId]);
      }
    } catch (err) {
      logger.warn('Runner key ancestry check failed; retried next sweep', { orgId, error: errorMessage(err) });
    }
  }
}

/**
 * Age reminders (an org notice when an active key reaches
 * RUNNER_KEY_MAX_AGE_DAYS, and again 30 days later — each recorded so it is
 * sent once), and the key gauges.
 */
export async function sendKeyAgeReminders(deps: RunnerDeps, now: Date = new Date(deps.now())): Promise<void> {
  const maxAge = tunable('RUNNER_KEY_MAX_AGE_DAYS');
  const active = await deps.keyStore.activeKeys();
  let oldest = 0;
  let overAge = 0;
  for (const key of active) {
    const age = runnerKeyAgeDays(key.activatesAt, now);
    oldest = Math.max(oldest, age);
    if (age < maxAge) continue;
    overAge++;
    const followup = age >= maxAge + RUNNER_KEY_AGE_FOLLOWUP_DAYS;
    const due = !key.ageReminderSentAt || (followup && !key.ageFollowupSentAt);
    if (!due) continue;
    const isFollowup = !!key.ageReminderSentAt;
    try {
      const claimed = await deps.keyStore.transaction(async (tx) => {
        const row = await tx.lockKeyById(key.id);
        if (!row || row.state !== 'active') return false;
        if (isFollowup ? row.ageFollowupSentAt : row.ageReminderSentAt) return false;
        await tx.updateKey(row.id, isFollowup ? { ageFollowupSentAt: now } : { ageReminderSentAt: now });
        return true;
      });
      if (!claimed) continue;
      let teams: string[] = [];
      try { teams = await inheritingOrgs(deps, key.orgId); } catch { /* the org itself is told regardless */ }
      await sendKeyNotice(deps, [key.orgId, ...teams], { kind: 'age', kid: key.kid, ageDays: age, followup: isFollowup });
    } catch (err) {
      logger.warn('Runner key age reminder failed; retried next sweep', { orgId: key.orgId, error: errorMessage(err) });
    }
  }
  try {
    const counts = await deps.keyStore.countByState();
    for (const [state, n] of Object.entries(counts)) deps.metrics.gauge(RUNNER_KEY_METRICS.keys, { state }, n);
  } catch { /* gauges are best effort */ }
  deps.metrics.gauge(RUNNER_KEY_METRICS.ageDays, {}, oldest);
  deps.metrics.gauge(RUNNER_KEY_METRICS.overAge, {}, overAge);
  deps.metrics.gauge(RUNNER_KEY_METRICS.unreadable, {}, deps.keyCaches.unreadable.size);
}

// -- Read models -------------------------------------------------------------------------

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function summary(row: KeyRow, now: Date): RunnerSigningKeySummary {
  return {
    kid: row.kid,
    state: row.state as PublishedRunnerKeyState,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy ?? null,
    activatesAt: row.activatesAt.toISOString(),
    retireAfter: row.state === 'retiring' ? iso(row.retireAfter) : null,
    ageDays: row.state === 'next' ? 0 : runnerKeyAgeDays(row.activatesAt, now),
  };
}

function rotationOf(keys: KeyRow[]): RunnerKeyRotationState {
  if (keys.some((k) => k.state === 'next')) return 'pending';
  if (keys.some((k) => k.state === 'retiring')) return 'overlap';
  return 'none';
}

/** Whether the org's effective (signing) key can be decrypted right now. */
async function isUnreadable(deps: RunnerDeps, orgId: string): Promise<boolean> {
  try {
    await deps.signerFor(orgId);
    return false;
  } catch (err) {
    return err instanceof RunnerRouteError && err.code === 'RUNNER_KEY_UNREADABLE';
  }
}

/** `signingKey` on GET /pipelines/runners: ids, states and dates only. */
export async function signingKeyDto(deps: RunnerDeps, orgId: string): Promise<RunnerSigningKeyDto> {
  const org = lc(orgId);
  const now = new Date(deps.now());
  const ctx = await resolveKeyContext(deps, org, now);
  const own = await deps.keyStore.publishedKeys([org]);
  const pick = (state: PublishedRunnerKeyState) => { const r = byState(own, state); return r ? summary(r, now) : null; };
  let inheritedFrom: RunnerSigningKeyDto['inheritedFrom'] = null;
  if (ctx.mode === 'inherit') {
    const parentKeys = await deps.keyStore.publishedKeys([ctx.effectiveOrgId]);
    const names = await deps.hierarchy.names([ctx.effectiveOrgId]);
    inheritedFrom = {
      orgId: ctx.effectiveOrgId,
      orgName: names[ctx.effectiveOrgId] ?? ctx.effectiveOrgId,
      activeKid: byState(parentKeys, 'active')?.kid ?? null,
      rotation: rotationOf(parentKeys),
    };
  }
  const teams = ctx.mode === 'own' ? await inheritingOrgs(deps, org) : [];
  const teamNames = teams.length > 0 ? await deps.hierarchy.names(teams) : {};
  const counts = await deps.keyStore.runnerCounts(ctx.mode === 'own' ? [org, ...teams] : [org]);
  const s = ctx.settings.get(org);
  return {
    mode: ctx.mode,
    isRootOrg: ctx.isRoot,
    active: pick('active'),
    next: pick('next'),
    retiring: pick('retiring'),
    rotation: rotationOf(own),
    inheritedFrom,
    inheritingTeams: teams.length,
    inheritingTeamNames: teams.map((t) => teamNames[t] ?? t),
    inheritingRunners: ctx.mode === 'own' ? [...counts.values()].reduce((a, b) => a + b, 0) : 0,
    transition: s?.transitionKind && s.switchAt && s.transitionUntil && s.transitionUntil > now
      ? { kind: s.transitionKind, switchAt: s.switchAt.toISOString(), until: s.transitionUntil.toISOString() }
      : null,
    unreadable: await isUnreadable(deps, org),
    maxAgeDays: tunable('RUNNER_KEY_MAX_AGE_DAYS'),
  };
}

/** Filters of the operator table. */
export interface KeyStatusFilter {
  mode?: RunnerKeyMode;
  rotation?: RunnerKeyRotationState;
  overAge?: boolean;
  unreadable?: boolean;
  inTransition?: boolean;
}

/** The operator table: every org with keys, a key-mode row or runners. Never key material. */
export async function listKeyStatus(deps: RunnerDeps, filter: KeyStatusFilter = {}): Promise<RunnerKeyStatusRow[]> {
  const now = new Date(deps.now());
  const maxAge = tunable('RUNNER_KEY_MAX_AGE_DAYS');
  const counts = await deps.keyStore.runnerCounts();
  const orgIds = uniq([...(await deps.keyStore.keyOrgIds()), ...counts.keys()]).sort();
  const names = orgIds.length > 0 ? await deps.hierarchy.names(orgIds) : {};
  const rows: RunnerKeyStatusRow[] = [];
  for (const orgId of orgIds) {
    const ctx = await resolveKeyContext(deps, orgId, now);
    const keys = await deps.keyStore.publishedKeys([orgId]);
    const active = byState(keys, 'active');
    const keyAgeDays = active ? runnerKeyAgeDays(active.activatesAt, now) : null;
    const inheritName = ctx.mode === 'inherit' ? (await deps.hierarchy.names([ctx.effectiveOrgId]))[ctx.effectiveOrgId] ?? null : null;
    rows.push({
      orgId,
      orgName: names[orgId] ?? null,
      mode: ctx.mode,
      inheritedFrom: ctx.mode === 'inherit' ? { orgId: ctx.effectiveOrgId, orgName: inheritName } : null,
      activeKid: active?.kid ?? null,
      keyAgeDays,
      rotation: rotationOf(keys),
      inTransition: !!ctx.transition,
      overAge: keyAgeDays !== null && keyAgeDays >= maxAge,
      unreadable: deps.keyCaches.unreadable.has(orgId) || deps.keyCaches.unreadable.has(ctx.effectiveOrgId),
      runnerCount: counts.get(orgId) ?? 0,
    });
  }
  return rows.filter((r) => (filter.mode === undefined || r.mode === filter.mode)
    && (filter.rotation === undefined || r.rotation === filter.rotation)
    && (!filter.overAge || r.overAge)
    && (!filter.unreadable || r.unreadable)
    && (!filter.inTransition || r.inTransition));
}
