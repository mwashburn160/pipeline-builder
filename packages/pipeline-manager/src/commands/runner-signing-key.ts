// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `runner signing-key status|generate|rotate|finish` — the organization's
 * runner signing key from the command line, for scripts and for orgs that keep
 * settings as code. The same routes the Signing key card in Settings →
 * Organization → Pipeline runners calls:
 *
 *   status    GET  /api/pipelines/runners                 (its `signingKey`)
 *   generate  POST /api/pipelines/runners/signing-key     (first key, created active)
 *   rotate    POST /api/pipelines/runners/signing-key/rotate (new key, signs in 10 min)
 *   finish    POST /api/pipelines/runners/signing-key/finish (retire the old key once its hour is up)
 *
 * Every write needs org_settings:write, an MFA-grade session and a step-up.
 * The key pair is generated and kept on the platform: only key ids, states and
 * dates ever reach this command, and only those are printed.
 */

import {
  type RunnerSigningKeyDto, type RunnerSigningKeySummary, type RunnersUnavailableReason,
} from '@pipeline-builder/api-core/pipeline-runners';
import { Command } from 'commander';
import { runnersUnavailableMessage } from './setup-runner.js';
import { buildStepUpProvider, chooseStepUp } from './store-token.js';
import { auditLog } from '../utils/audit-log.js';
import { createAuthenticatedClientAsync, printCommandHeader, printSslWarning, withSslOptions } from '../utils/command-utils.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { printKeyValue, printSection, printSuccess, printWarning, setMachineOutput } from '../utils/output-utils.js';
import { STEP_UP_HEADER, type StepUpProvider } from '../utils/service-account.js';

const RUNNERS_ROUTE = '/api/pipelines/runners';
const SIGNING_KEY_ROUTE = `${RUNNERS_ROUTE}/signing-key`;
const PANEL = 'Settings → Organization → Pipeline runners';

export const SIGNING_KEY_ACTIONS = ['status', 'generate', 'rotate', 'finish'] as const;
export type SigningKeyAction = (typeof SIGNING_KEY_ACTIONS)[number];

/** The write each action makes (status reads the runner list). */
const WRITE_ROUTES: Readonly<Record<Exclude<SigningKeyAction, 'status'>, string>> = {
  generate: SIGNING_KEY_ROUTE,
  rotate: `${SIGNING_KEY_ROUTE}/rotate`,
  finish: `${SIGNING_KEY_ROUTE}/finish`,
};

export interface SigningKeyApi {
  get<T = unknown>(url: string): Promise<T>;
  post<T = unknown>(url: string, data?: unknown, headers?: Record<string, string>): Promise<T>;
}

export interface SigningKeyDeps {
  platform: SigningKeyApi;
  /** Asked only for a write. */
  stepUp: StepUpProvider;
}

function unwrap<T>(body: unknown): T {
  const b = body as { data?: T };
  return (b && typeof b === 'object' && b.data !== undefined ? b.data : body) as T;
}

/** What to do about each refusal the key routes answer with. */
const KEY_REFUSALS: Readonly<Record<string, string>> = {
  RUNNER_KEY_EXISTS: 'Your organization already has a signing key. Rotate it instead: pipeline-manager runner signing-key rotate.',
  RUNNER_KEY_MISSING: 'Your organization has no runner signing key yet. Create one: pipeline-manager runner signing-key generate.',
  RUNNER_KEY_TRANSITION_IN_PROGRESS: 'A key rotation or key-mode change is already in progress. Wait for it to finish (up to about 75 minutes), '
    + 'or run "pipeline-manager runner signing-key finish" once the old key may be removed.',
  RUNNER_KEY_NO_ROTATION: 'There is no rotation to finish. Check the current state: pipeline-manager runner signing-key status.',
  RUNNER_KEY_RETIRE_TOO_EARLY: 'The old key can\'t be removed yet: runners may still be using it. '
    + 'Finish is allowed once the time "pipeline-manager runner signing-key status" shows under Retiring has passed.',
  RUNNER_KEY_INHERITED: `This organization uses its parent's signing key. Switch to your own key (Use our own key) under ${PANEL} before changing it, `
    + 'or ask the parent organization\'s admins.',
  RUNNER_KEY_UNREADABLE: 'Your signing key can\'t be read. Runs through your runners are paused until your platform operator fixes it.',
};

/** Turn a key-route refusal into what to do; anything else is rethrown as-is. */
export function explainSigningKeyError(err: unknown): never {
  const e = err as { status?: number; response?: { status?: number; data?: { code?: string; errorCode?: string; error?: { code?: string } } } };
  const data = e?.response?.data;
  const code = data?.error?.code ?? data?.errorCode ?? data?.code;
  const status = e?.status ?? e?.response?.status;
  if (code && KEY_REFUSALS[code]) throw new Error(`${KEY_REFUSALS[code]} (${code})`);
  if (code === 'RUNNERS_UNAVAILABLE') throw new Error(runnersUnavailableMessage(null));
  if (status === 429) throw new Error('Too many signing-key changes for your organization this hour. Try again later.');
  throw err;
}

/** Run one action: the org's signing-key state after it. Never contains key material (the platform sends none). */
export async function runSigningKeyAction(action: SigningKeyAction, deps: SigningKeyDeps): Promise<RunnerSigningKeyDto> {
  try {
    if (action === 'status') {
      const list = unwrap<{ available?: boolean; unavailableReason?: RunnersUnavailableReason | null; signingKey?: RunnerSigningKeyDto | null }>(
        await deps.platform.get(RUNNERS_ROUTE),
      );
      if (list.available === false || !list.signingKey) throw new Error(runnersUnavailableMessage(list.unavailableReason));
      return list.signingKey;
    }
    const headers = { [STEP_UP_HEADER]: await deps.stepUp() };
    return unwrap<RunnerSigningKeyDto>(await deps.platform.post(WRITE_ROUTES[action], {}, headers));
  } catch (err) {
    return explainSigningKeyError(err);
  }
}

type KeyView = Pick<RunnerSigningKeySummary, 'kid' | 'state' | 'createdAt' | 'createdBy' | 'activatesAt' | 'retireAfter' | 'ageDays'>;

/** A summary with exactly its documented fields: whatever else a response carries is never printed. */
function keyView(k: RunnerSigningKeySummary | null | undefined): KeyView | null {
  if (!k) return null;
  return { kid: k.kid, state: k.state, createdAt: k.createdAt, createdBy: k.createdBy, activatesAt: k.activatesAt, retireAfter: k.retireAfter, ageDays: k.ageDays };
}

/** The printable (and --json) view: key ids, states and dates only, by allowlist. */
export function signingKeyView(dto: RunnerSigningKeyDto): Record<string, unknown> {
  return {
    mode: dto.mode,
    isRootOrg: dto.isRootOrg,
    rotation: dto.rotation,
    active: keyView(dto.active),
    next: keyView(dto.next),
    retiring: keyView(dto.retiring),
    inheritedFrom: dto.inheritedFrom
      ? { orgId: dto.inheritedFrom.orgId, orgName: dto.inheritedFrom.orgName, activeKid: dto.inheritedFrom.activeKid, rotation: dto.inheritedFrom.rotation }
      : null,
    inheritingTeams: dto.inheritingTeams,
    inheritingRunners: dto.inheritingRunners,
    transition: dto.transition ? { kind: dto.transition.kind, switchAt: dto.transition.switchAt, until: dto.transition.until } : null,
    unreadable: dto.unreadable,
    maxAgeDays: dto.maxAgeDays,
  };
}

/** Human-readable lines for the terminal. */
export function signingKeyLines(dto: RunnerSigningKeyDto): Record<string, string> {
  const out: Record<string, string> = { Mode: dto.mode === 'inherit' ? 'inherit (uses the parent organization\'s key)' : 'own' };
  if (dto.inheritedFrom) out['Inherited From'] = `${dto.inheritedFrom.orgName} (active ${dto.inheritedFrom.activeKid ?? 'none'})`;
  if (dto.active) {
    out.Active = `${dto.active.kid} (signing since ${dto.active.activatesAt}, ${dto.active.ageDays} days)`;
    if (dto.active.ageDays >= dto.maxAgeDays) out['Key Age'] = `${dto.active.ageDays} days old, consider rotating`;
  } else if (!dto.inheritedFrom) {
    out.Active = 'none';
  }
  if (dto.next) out.Next = `${dto.next.kid} (starts signing around ${dto.next.activatesAt})`;
  if (dto.retiring) out.Retiring = `${dto.retiring.kid} (removed at ${dto.retiring.retireAfter ?? 'unknown'}; finish allowed after that)`;
  out.Rotation = dto.rotation;
  if (dto.transition) out.Transition = `${dto.transition.kind} (switches ${dto.transition.switchAt}, completes ${dto.transition.until})`;
  if (dto.inheritingTeams > 0) out['Used By'] = `${dto.inheritingTeams} team(s), ${dto.inheritingRunners} runner(s)`;
  if (dto.unreadable) out.Unreadable = 'yes: runs through your runners are paused until your platform operator fixes it';
  return out;
}

const DONE: Readonly<Record<Exclude<SigningKeyAction, 'status'>, string>> = {
  generate: 'Signing key generated. Your runners verify requests with a key only this organization uses.',
  rotate: 'Rotation started: the new key is published now and starts signing in about 10 minutes. The old key stays valid for 1 hour after that.',
  finish: 'Rotation finished: the old key is retired.',
};

function signingKeyCommand(parent: Command, action: SigningKeyAction, description: string): void {
  const cmd = parent.command(action).description(description).option('--json', 'Output the result as JSON', false);
  if (action !== 'status') {
    cmd
      .option('-p, --password <password>', 'Password for the step-up the key writes require (prefer PLATFORM_PASSWORD)')
      .option('--step-up <method>', 'auto, password, totp or browser', 'auto')
      .option('--no-browser', 'With browser step-up: print the approval URL instead of opening a browser');
  }
  withSslOptions(cmd).action(async (options) => {
    const executionId = printCommandHeader(`Runner Signing Key: ${action}`, undefined, { quiet: options.json });
    if (options.json) setMachineOutput(true);
    try {
      printSslWarning(options.verifySsl);
      const client = await createAuthenticatedClientAsync(options);
      const password = (options.password as string | undefined) || process.env.PLATFORM_PASSWORD;
      const stepUp: StepUpProvider = async () => buildStepUpProvider(
        chooseStepUp({ requested: options.stepUp, password, interactive: !!process.stdin.isTTY && !options.json }),
        client,
        { password, verifySsl: options.verifySsl, browser: options.browser, purpose: `${action} your organization's runner signing key` },
      )();
      const dto = await runSigningKeyAction(action, { platform: client, stepUp });
      if (action !== 'status') auditLog('runner-signing-key', { executionId, action, kid: dto.next?.kid ?? dto.active?.kid ?? null });
      if (options.json) {
        console.log(JSON.stringify({ success: true, action, signingKey: signingKeyView(dto) }, null, 2));
        return;
      }
      console.log('');
      printSection('Runner Signing Key');
      printKeyValue(signingKeyLines(dto));
      if (dto.unreadable) printWarning('Your signing key can\'t be read. Contact your platform operator.');
      if (action !== 'status') printSuccess(DONE[action]);
    } catch (error) {
      handleError(error, ERROR_CODES.API_REQUEST, { exit: true, context: { command: `runner signing-key ${action}`, executionId } });
    }
  });
}

/** Help shared by the group. */
const SIGNING_KEY_HELP = `
The platform signs every request to your runners with your organization's own Ed25519
key; each runner verifies it against its own key set
(<platform>/api/pipelines/runner/runners/<runnerId>/jwks.json). The private key never
leaves the platform: these commands only see key ids and dates.

A top-level organization's key is created with its first runner. Rotate publishes a new
key that starts signing about 10 minutes later; the old one stays published for 1 hour
after that, then "finish" (or the platform's sweep) retires it. A sub-organization that
inherits its parent's key changes it from the parent. Cancelling a rotation, emergency
revoke and switching between your own and an inherited key are on ${PANEL}.
`;

/**
 * Registers `runner signing-key status|generate|rotate|finish` under `runner`.
 *
 * @example
 * ```bash
 * pipeline-manager runner signing-key status --json
 * pipeline-manager runner signing-key rotate
 * pipeline-manager runner signing-key finish
 * ```
 */
export function runnerSigningKey(runner: Command): void {
  const group = runner.command('signing-key').description('Your organization\'s runner signing key (status, generate, rotate, finish)')
    .addHelpText('after', SIGNING_KEY_HELP);
  signingKeyCommand(group, 'status', 'Show the signing key: active, next and retiring key ids and dates, mode and rotation state');
  signingKeyCommand(group, 'generate', 'Generate your organization\'s first signing key (step-up)');
  signingKeyCommand(group, 'rotate', 'Start a rotation: publish a new key that signs in about 10 minutes (step-up)');
  signingKeyCommand(group, 'finish', 'Retire the old key once its 1-hour overlap has passed (step-up)');
}
