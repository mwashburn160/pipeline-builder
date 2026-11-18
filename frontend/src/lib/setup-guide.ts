// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org setup guide's shell commands, built in ONE place so the first-run
 * onboarding step, the "finish setting up" popup and the Downloads page cannot
 * drift apart (they used to be three hand-written copies, and they had).
 *
 * Every command here is meant to be copied in order into a fresh shell and work:
 *
 *  1. Prerequisites — `PLATFORM_BASE_URL` first (`setup-events` reads it
 *     directly and `auth login` defaults to it), then the browser sign-in, then
 *     the password: `store-token` creates a service account and issues a key,
 *     and both writes are step-up gated, so it needs the password even with a
 *     session. It is read without echo so it never lands in shell history.
 *  2. The platform credential (CDK synth/deploy, plugin lookup), the
 *     `registry:push` credential (synth wires it into every build image's pull
 *     credentials, so builds cannot start without it), and the
 *     `pipeline_registry:write` credential (the platform key cannot register a
 *     deployed pipeline, and event ingest attributes events through that
 *     registry). Same set as the CLI's own `provision` post-steps, plus the
 *     registration key its `deploy --store-tokens` warns about.
 *  3. The `reporting:ingest` credential. The reporting service accepts machine
 *     event writes ONLY from a token whose scope is exactly `reporting:ingest`,
 *     so the ingestion Lambda must read this secret — hence `--scoped-ingest`
 *     on step 4. Without it every forwarded event is a 403.
 *  4. `setup-events` (± `--with-dora`).
 */

/**
 * MAJOR.MINOR of the CLI's `engines.node` floor (packages/pipeline-manager).
 * A frontend test reads that package.json and fails when this drifts.
 */
export const CLI_MIN_NODE = '26.13';

/** Pre-filled region; the CLI's own default when nothing is set. */
export const DEFAULT_SETUP_REGION = 'us-east-1';

/** An AWS region code (`us-east-1`, `ap-southeast-2`, `us-gov-west-1`). */
const AWS_REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d+$/;

/**
 * Whether `value` is a region code. The value is pasted into a shell command the
 * admin will run, so anything else is refused rather than quoted.
 */
export function isAwsRegion(value: string): boolean {
  return AWS_REGION_RE.test(value);
}

export interface SetupCommandInput {
  /** The platform origin the browser is on (nginx serves both the app and /api). */
  origin: string;
  /** A region code; callers fall back to {@link DEFAULT_SETUP_REGION} when invalid. */
  region: string;
  withDora: boolean;
}

export interface SetupCommands {
  prerequisites: string;
  /** Every `store-token` line, in order (platform, registry, registration, ingest). */
  tokens: string;
  setupEvents: string;
}

/** Build the guide's commands. `region` must already be a valid region code. */
export function setupCommands({ origin, region, withDora }: SetupCommandInput): SetupCommands {
  const r = isAwsRegion(region) ? region : DEFAULT_SETUP_REGION;
  return {
    prerequisites: [
      `export PLATFORM_BASE_URL=${origin}`,
      'pipeline-manager auth login',
      "printf 'Platform password: '; read -rs PLATFORM_PASSWORD; echo; export PLATFORM_PASSWORD",
    ].join('\n'),
    tokens: [
      `pipeline-manager infra store-token --expires-days 30 --schedule --region ${r}`,
      `pipeline-manager infra store-token --scope registry:push --expires-days 30 --schedule --region ${r}`,
      `pipeline-manager infra store-token --scope pipeline_registry:write --expires-days 30 --schedule --region ${r}`,
      `pipeline-manager infra store-token --scope reporting:ingest --expires-days 30 --schedule --region ${r}`,
    ].join('\n'),
    setupEvents: `pipeline-manager infra setup-events --scoped-ingest --region ${r}${withDora ? ' --with-dora' : ''}`,
  };
}

/** Service-account names `store-token` issues keys on (see its SCOPE_CATALOG). */
export const PLATFORM_ACCOUNT_NAME = 'platform-automation';
export const REGISTRY_ACCOUNT_NAME = 'registry-push';
export const REGISTRATION_ACCOUNT_NAME = 'pipeline-register';
export const INGEST_ACCOUNT_NAME = 'reporting-ingest';

// ---------------------------------------------------------------------------
// Progress — what the platform can SEE of the guide having been followed.
// ---------------------------------------------------------------------------

/** One checklist row's state. `unknown` = the viewer may not read it, or the read failed. */
export type SetupItemState = 'done' | 'missing' | 'attention' | 'unknown';

export interface SetupItemStatus {
  state: SetupItemState;
  /** One line for the row; null when there is nothing beyond the label to say. */
  detail: string | null;
}

/** The slice of a service account the checklist reads. */
export interface SetupAccountLike {
  name: string;
  disabled: boolean;
  keys: ReadonlyArray<{ status: string; expiresAt: string; lastUsedAt: string | null }>;
}

/**
 * Whether `store-token` has issued a live key on `accountName`. `null` accounts
 * means the list could not be read (no `service_accounts:manage`, or an error) —
 * reported as unknown, never as missing, so nobody is told to redo a step that
 * may well be done.
 *
 * This proves the KEY exists on the platform. Whether it also reached Secrets
 * Manager is not observable from here; the events row below is what shows the
 * whole chain working.
 */
export function keyStatus(accounts: ReadonlyArray<SetupAccountLike> | null, accountName: string): SetupItemStatus {
  if (!accounts) return { state: 'unknown', detail: 'You can’t view service accounts in this organization.' };
  const account = accounts.find((a) => a.name === accountName);
  if (!account) return { state: 'missing', detail: 'Not issued yet.' };
  if (account.disabled) return { state: 'attention', detail: 'The service account is disabled.' };
  const live = account.keys.filter((k) => k.status === 'active');
  if (live.length === 0) return { state: 'attention', detail: 'No active key — it expired or was revoked. Run store-token again.' };
  const latest = live.reduce((a, b) => (Date.parse(b.expiresAt) > Date.parse(a.expiresAt) ? b : a));
  return { state: 'done', detail: `Active key, expires ${latest.expiresAt.slice(0, 10)}.` };
}

// ---------------------------------------------------------------------------
// The popup's "Remind me later" — per browser, per org, for a day.
// ---------------------------------------------------------------------------

/** How long "Remind me later" (and leaving first-run onboarding) holds the popup off. */
export const SETUP_GUIDE_SNOOZE_MS = 24 * 60 * 60 * 1000;

const snoozeKey = (orgId: string) => `pb.setupGuide.snoozedUntil.${orgId}`;

/**
 * Hold the popup off on this browser. Deliberately local: "later" is a
 * convenience for the person at this keyboard, while "don't show again" is the
 * org-wide, server-side decision. Storage can be unavailable (private window,
 * blocked site data) — then the popup simply comes back on the next page load.
 */
export function snoozeSetupGuide(orgId: string, now = Date.now()): void {
  try { window.localStorage.setItem(snoozeKey(orgId), String(now + SETUP_GUIDE_SNOOZE_MS)); } catch { /* storage unavailable */ }
}

export function isSetupGuideSnoozed(orgId: string, now = Date.now()): boolean {
  try {
    const until = Number(window.localStorage.getItem(snoozeKey(orgId)));
    return Number.isFinite(until) && until > now;
  } catch {
    return false;
  }
}
