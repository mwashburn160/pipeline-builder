// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pipeline runners — the copy, badges and snippets every surface shares.
 *
 * The settings panel, the pipeline page's Re-run / Stop banners and the setup
 * guide all speak about the same runner, so the link to the panel, the
 * plain-language copy per error code and the install commands live here once.
 * Kept free of React and of the api client so the pipeline page can import it
 * without pulling the settings panel in.
 */

import {
  DEPLOY_SETUP_COMMAND, RUNNER_DELIVERY_FAILURE_CLASSES, TERMINAL_RUN_REQUEST_STATUSES as TERMINAL_RUN_REQUEST_STATUS_LIST,
  type RunnerDeliveryFailureClass, type RunnerErrorCode, type RunnerHealth, type RunnerStatus, type RunnersUnavailableReason, type RunRequestStatus,
} from '@pipeline-builder/api-core/pipeline-runners';
import type { BadgeColor } from '@/components/ui/Badge';
import type { PipelineRunner } from '@/lib/api/domains/pipelines';
import { ApiError } from '@/lib/api/errors';
import { orgSettingsHref } from '@/lib/org-settings-sections';

export { isTerminalExecutionStatus } from '@pipeline-builder/api-core/pipeline-runners';

/**
 * The one-runner-per-account rule, as every install surface states it. One
 * runner covers every region it lists, so an org never needs a second in the
 * same account; another org may install its own there.
 */
export const ONE_RUNNER_PER_ACCOUNT_COPY =
  'Install one runner per AWS account for this organization: one runner covers every region it allows. Another organization may install its own runner in the same account, but a shared AWS account is a shared trust boundary — anyone with AWS access there can reach both organizations\' pipelines.';

/** Anchor of the Pipeline runners card on Settings → Organization → Pipelines. */
export const PIPELINE_RUNNERS_ANCHOR = 'pipeline-runners';

/** Settings → Organization → Pipelines → Pipeline runners. The fragment alone
 *  also opens the tab and the section (registered in the settings page's `hashTabs`). */
export const PIPELINE_RUNNERS_HREF = orgSettingsHref('pipelines', PIPELINE_RUNNERS_ANCHOR);

type RunnerBadge = { label: string; color: BadgeColor };

/** The badge a runner's status shows INSTEAD of its health (null = show the health). */
const STATUS_BADGE: Readonly<Record<RunnerStatus, RunnerBadge | null>> = {
  revoked: { label: 'Revoked', color: 'gray' },
  pending: { label: 'Setup not finished', color: 'yellow' },
  active: null,
};

const HEALTH_BADGE: Readonly<Record<RunnerHealth, RunnerBadge>> = {
  healthy: { label: 'Healthy', color: 'green' },
  unreachable: { label: 'Unreachable', color: 'red' },
};

const UNKNOWN_BADGE: RunnerBadge = { label: 'Unknown', color: 'gray' };

/** Health badge per runner: a revoked or pending runner reads its status
 *  whatever its health; an active one reads its health. ("Update required" is
 *  a second badge, added by the panel.) */
export function runnerBadge(r: Pick<PipelineRunner, 'health' | 'status'>): RunnerBadge {
  return STATUS_BADGE[r.status] ?? HEALTH_BADGE[r.health] ?? UNKNOWN_BADGE;
}

/** Whether a runner still counts as installed (a revoked one stays listed, greyed, but reaches nothing). */
export function isLiveRunner(r: Pick<PipelineRunner, 'status'>): boolean {
  return r.status !== 'revoked';
}

/**
 * How many runners the org can run pipelines through (own plus shared by a
 * parent, revoked ones excluded), from `GET /pipelines/runners`. Null when it
 * is not known: no answer, or runners unavailable (the server lists none then).
 */
export function usableRunnerCount(
  dto: { available: boolean; own: ReadonlyArray<Pick<PipelineRunner, 'status'>>; inherited: ReadonlyArray<Pick<PipelineRunner, 'status'>> } | null | undefined,
): number | null {
  if (!dto || !dto.available) return null;
  return dto.own.filter(isLiveRunner).length + dto.inherited.filter(isLiveRunner).length;
}

/** What an "Update required" runner tells its admin to do. */
export const RUNNER_UPDATE_COPY = 'Re-run pipeline-manager infra setup-runner to update';

/** Where an error's banner points the reader. */
export type RunnerErrorLink = 'install' | 'test' | 'runners' | null;

export interface RunnerErrorCopy {
  /** The headline (bold). */
  title: string;
  /** What to do about it. */
  body: string;
  /** A link to the runners panel, or none where the fix is elsewhere (a redeploy). */
  link: RunnerErrorLink;
}

/**
 * The catalog codes deliberately left to the generic sentence
 * ({@link runnerErrorCopy}'s fallback). Every OTHER code needs copy below: a
 * code added to api-core's catalog fails to compile until it is in one or the other.
 *
 * `DUPLICATE` never reaches a reader: the dispatcher retries it until the
 * request expires (the banner then reads RUN_REQUEST_EXPIRED), and the only
 * other place a runner's answer is shown — the panel's Test — signs a fresh
 * `jti` per ping, which a conforming runner cannot call a duplicate.
 */
type GenericCopyCode = 'DUPLICATE';

/**
 * Plain-language copy per Re-run / Stop error code — both the synchronous
 * refusals of `POST …/executions` (NO_RUNNER, RUNNER_UNREACHABLE, …) and the
 * `errorCode` of a queued request that failed.
 */
const COPY = {
  NO_RUNNER: {
    // The expected first-run state: every run goes through a runner.
    title: 'This pipeline needs a runner.',
    body: 'Install a runner in the pipeline\'s AWS account (one per account per organization), then run it again.',
    link: 'install',
  },
  RUNNER_UNREACHABLE: {
    title: 'The pipeline runner is unreachable.',
    body: 'The platform could not deliver to it several times in a row, so requests are paused. Check the runner stack in your AWS account, then test the runner.',
    link: 'test',
  },
  RUNNER_NOT_ELIGIBLE: {
    title: 'This run was not sent: its runner no longer serves this pipeline.',
    body: 'The runner was un-shared from this team, or the team moved, after the run was queued. Run it again to find a runner that serves it now.',
    link: 'runners',
  },
  PIPELINE_NOT_FOUND_IN_RUNNERS: {
    title: 'None of your pipeline runners found this pipeline.',
    body: 'Each runner looked for a pipeline tagged with this pipeline\'s id in its allowed regions. Check the runner covers the account and region it was deployed to.',
    link: 'runners',
  },
  AMBIGUOUS_RUNNER: {
    title: 'More than one pipeline runner found this pipeline.',
    body: 'The platform will not guess which to use. Each organization should have one runner per AWS account: remove the extra runner, or narrow a runner\'s regions or pipeline prefix.',
    link: 'runners',
  },
  AMBIGUOUS_PIPELINE: {
    title: 'Two pipelines in the runner\'s AWS account claim to be this one.',
    body: 'They carry the same pb.pipeline-id tag — a duplicate deployment. Remove the duplicate, then try again.',
    link: null,
  },
  PIPELINE_NOT_TAGGED: {
    title: 'The pipeline in your AWS account has no pb.pipeline-id tag.',
    body: 'It was deployed before tagging, or outside the platform. Redeploy it with pipeline-manager pipeline deploy, then try again.',
    link: null,
  },
  PIPELINE_IDENTITY_MISMATCH: {
    title: 'The pipeline the runner found is not this pipeline.',
    body: 'Its pb.pipeline-id tag names another pipeline, so the link was cleared. Redeploy this pipeline with pipeline-manager pipeline deploy, then try again.',
    link: null,
  },
  RUNNER_REFUSED: {
    title: 'The pipeline runner refused the request.',
    body: 'The pipeline is outside the runner\'s allowed regions or pipeline prefixes — settings only your AWS account can change. Redeploy the runner stack with a wider allowlist if this pipeline should be covered.',
    link: 'runners',
  },
  SIGNATURE_INVALID: {
    title: 'The pipeline runner rejected the platform\'s signature.',
    body: 'Either the runner cannot fetch its organization\'s current public keys (its JWKS URL), or its clock is off. Platform operators have been alerted; test the runner once it is fixed.',
    link: 'test',
  },
  RUNNER_PERMISSION_DENIED: {
    title: 'The runner\'s AWS role was not allowed to act on this pipeline.',
    body: 'Redeploy the runner stack (pipeline-manager infra setup-runner), or restore its role if it was edited.',
    link: 'runners',
  },
  RUN_REQUEST_EXPIRED: {
    title: 'The request was not delivered to the pipeline runner within 10 minutes, so it expired.',
    body: 'Nothing was started or stopped. The runner may be down or unreachable — test it, then try again.',
    link: 'runners',
  },
  RUNNER_PENDING: {
    title: 'The pipeline runner\'s setup is not finished.',
    body: 'Finish pipeline-manager infra setup-runner (it registers the runner and waits for its first answer), then try again.',
    link: 'runners',
  },
  RUNNER_REVOKED: {
    title: 'The pipeline runner was revoked.',
    body: 'Install a new runner in that AWS account, then try again.',
    link: 'install',
  },
  RUNNER_LIMIT: {
    title: 'Your organization has reached its pipeline runner limit.',
    body: 'Revoke a runner you no longer use before registering another.',
    link: 'runners',
  },
  RUN_REQUEST_RATE_LIMITED: {
    title: 'Too many Re-run and Stop requests for this pipeline.',
    body: 'Wait a minute, then try again.',
    link: null,
  },
  RUNNER_PING_FAILED: {
    title: 'The pipeline runner did not answer the platform\'s ping.',
    body: 'Check the runner stack is deployed and its Function URL is reachable, then test it again.',
    link: 'test',
  },
  RUNNER_UPDATE_REQUIRED: {
    title: 'The pipeline runner needs an update.',
    body: 'Re-run pipeline-manager infra setup-runner to update it, then try again.',
    link: 'runners',
  },
  TOO_MANY_PENDING: {
    title: 'Too many requests are already waiting for this pipeline runner.',
    body: 'Wait for them to finish or expire, then try again.',
    link: 'runners',
  },
  PIPELINE_NOT_FOUND: {
    // A LINKED runner's answer: the platform clears the link and re-discovers
    // once on its own, so this surfaces only when that could not help.
    title: 'The pipeline runner could not find this pipeline in its AWS account.',
    body: 'No pipeline in its allowed regions carries this pipeline\'s pb.pipeline-id tag — it may have been deleted, or moved to another account or region. Redeploy it with pipeline-manager pipeline deploy, or check the runner\'s regions, then try again.',
    link: 'runners',
  },
  NOT_YET_VISIBLE: {
    // Retried for a minute before it is recorded.
    title: 'The pipeline runner cannot see this pipeline yet.',
    body: 'AWS has not finished indexing a freshly deployed pipeline\'s tags, and the runner waited a minute for it. Nothing was started or stopped. Wait a few minutes, then try again.',
    link: null,
  },
  RUNNER_ERROR: {
    // A runner answer the platform could not use (an unknown code, a malformed
    // success). Do NOT say nothing happened: a malformed success may have run.
    title: 'The pipeline runner gave an answer the platform could not use.',
    body: 'Check the Runs tab before trying again. The runner may be out of date — re-run pipeline-manager infra setup-runner to update it — or failing; its Lambda\'s logs in your AWS account say why.',
    link: 'test',
  },
  NO_MATCH: {
    title: 'The pipeline runner did not find this pipeline.',
    body: 'No pipeline in its allowed regions carries this pipeline\'s pb.pipeline-id tag. Redeploy the pipeline, or check the runner\'s regions.',
    link: 'runners',
  },
  RUNNERS_UNAVAILABLE: {
    // The platform pause toggle is on, or secret encryption is not set up.
    title: 'Pipeline runs are paused on this platform.',
    body: 'Your platform operator has paused all runner traffic, or has not finished setting runners up. Nothing is started or stopped until they turn it back on. pipeline-manager pipeline run with your own AWS credentials still works.',
    link: null,
  },
  RUNNER_KEY_UNREADABLE: {
    title: 'Your signing key can\'t be read.',
    body: 'Runs through your runners are paused until your platform operator fixes it.',
    link: 'runners',
  },
  RUNNER_KEY_MISSING: {
    title: 'Your organization has no runner signing key yet.',
    body: 'A key is created when you register your first runner, or generate one in Settings → Pipeline runners.',
    link: 'runners',
  },
  RUNNER_KEY_EXISTS: {
    title: 'Your organization already has a signing key.',
    body: 'Rotate it instead.',
    link: 'runners',
  },
  RUNNER_KEY_TRANSITION_IN_PROGRESS: {
    title: 'A key rotation or key-mode change is already in progress.',
    body: 'Wait for it to finish (up to about 75 minutes), or finish it from the Signing key card.',
    link: 'runners',
  },
  RUNNER_KEY_NO_ROTATION: {
    title: 'There is no rotation to cancel or finish.',
    body: 'Reload the Signing key card to see the current state.',
    link: 'runners',
  },
  RUNNER_KEY_RETIRE_TOO_EARLY: {
    title: 'The old key can\'t be removed yet.',
    body: 'Runners may still be using it. Finish now is available once the time shown on the card has passed.',
    link: 'runners',
  },
  RUNNER_KEY_INHERITED: {
    title: 'This organization uses its parent\'s signing key.',
    body: 'Switch to your own key (Use our own key) before changing it, or ask the parent organization\'s admins.',
    link: 'runners',
  },
  RUNNER_KEY_MODE_ROOT_ORG: {
    title: 'A top-level organization always uses its own key.',
    body: 'Only sub-organizations can inherit a key.',
    link: null,
  },
  RUNNER_KEY_CONFIRMATION_MISMATCH: {
    title: 'The confirmation doesn\'t match.',
    body: 'Type the last 6 characters of the active key id.',
    link: null,
  },
  // -- Deploying a pipeline through a runner (the pipeline service's answers to POST …/deploys) --
  RUNNER_DEPLOY_UNSUPPORTED: {
    title: 'This pipeline runner cannot deploy pipelines.',
    body: `Its stack was set up without deploys, or its bundle is too old to speak them. Update it with ${DEPLOY_SETUP_COMMAND} in its AWS account, then try again.`,
    link: 'runners',
  },
  DEPLOY_RUNNER_REQUIRED: {
    title: 'Choose a pipeline runner to deploy through.',
    body: 'More than one runner can deploy this pipeline, and the platform will not pick one for you. Choose one from the list, then deploy.',
    link: null,
  },
  RUNNER_NOT_DEPLOYABLE: {
    title: 'That pipeline runner cannot deploy this pipeline.',
    body: 'It is not enabled for deploys, needs an update, is not answering, or its regions or pipeline prefixes do not cover this pipeline. Choose another runner, or fix it in its settings.',
    link: 'runners',
  },
  ALREADY_DEPLOYED: {
    title: 'This pipeline is already deployed.',
    body: 'Deploys through a runner are for a pipeline that was never deployed. Start it with Run pipeline, or redeploy changes with pipeline-manager pipeline deploy.',
    link: null,
  },
  DEPLOY_IN_PROGRESS: {
    title: 'This pipeline is already being deployed.',
    body: 'Another deploy of it is running (through another runner, or from another tab). Follow that one, or wait for it to finish before starting another.',
    link: null,
  },
  DEPLOY_REGION_NOT_ALLOWED: {
    title: 'The runner cannot deploy into that region.',
    body: 'A runner deploys only into the regions its stack allows. Choose one of its regions, or widen its region allowlist by re-running pipeline-manager infra setup-runner.',
    link: 'runners',
  },
  TOOLCHAIN_TOO_OLD_FOR_DEPLOY: {
    title: 'This pipeline\'s toolchain is too old to deploy through a runner.',
    body: 'Its pinned toolchain release ships a deploy image the platform cannot drive. Upgrade the pipeline\'s toolchain to the current release (Edit pipeline → Toolchain), then deploy again.',
    link: null,
  },
  DEPLOY_NOT_CANCELLABLE: {
    title: 'This deploy has already finished.',
    body: 'There is nothing left to cancel — it ended while the request was on its way. The deploy\'s result is shown below.',
    link: null,
  },
  DEPLOY_RATE_LIMITED: {
    title: 'Too many deploys this hour.',
    body: 'Your organization has started as many deploys through runners as the platform allows in an hour. Wait a while, then try again; pipeline-manager pipeline deploy with your own AWS credentials still works.',
    link: null,
  },
  TOO_MANY_DEPLOYS: {
    title: 'The pipeline runner is busy with other deploys.',
    body: 'It already runs as many deploys at once as the platform allows. Wait for one of them to finish, or choose another runner, then try again.',
    link: null,
  },
  DEPLOY_GRANT_INVALID: {
    title: 'The deploy job\'s one-time credential was refused.',
    body: 'It was already used, expired, or is for a deploy no longer running. Start the deploy again; platform operators are alerted when a credential is reused.',
    link: null,
  },
  // -- A runner's answers to a deploy --
  DEPLOY_NOT_ENABLED: {
    title: 'Deploys are not enabled on this pipeline runner.',
    body: `Its stack was set up without --enable-deploy. Re-run ${DEPLOY_SETUP_COMMAND} in its AWS account to turn deploys on, then try again.`,
    link: 'runners',
  },
  PIPELINE_ALREADY_DEPLOYED: {
    title: 'This pipeline already exists in the runner\'s AWS account.',
    body: 'The runner found a pipeline tagged with this pipeline\'s id, so nothing was deployed. The platform links the pipeline to that runner; reload to see it.',
    link: null,
  },
  DEPLOY_BUSY: {
    title: 'The runner\'s deploy project is at its concurrent build limit.',
    body: 'Other deploys are running in that account. The platform delivers the deploy again on its own; if it expires, try again once they finish.',
    link: null,
  },
  DEPLOY_BUILD_NOT_FOUND: {
    title: 'The runner could not find this deploy\'s build.',
    body: 'Its deploy project has no build for this request — it may have been deleted in the account. Reload to see the deploy\'s recorded result, then deploy again if needed.',
    link: null,
  },
} satisfies Record<Exclude<RunnerErrorCode, GenericCopyCode>, RunnerErrorCopy>;

/** {@link COPY}, indexable by any string (a server may send a code this build does not know). */
export const RUNNER_ERROR_COPY: Readonly<Record<string, RunnerErrorCopy>> = COPY;

/** Every code the Re-run / Stop banner has specific copy for. (Not api-core's
 *  `RUNNER_ERROR_CODES`, which is the whole catalog.) */
const CODES_WITH_COPY: ReadonlySet<string> = new Set(Object.keys(RUNNER_ERROR_COPY));

/**
 * RUNNERS_UNAVAILABLE's copy by its `details.reason`: only a real operator
 * pause says "paused"; a key-service outage is transient and retried on its own.
 */
export const RUNNERS_UNAVAILABLE_COPY = {
  paused: COPY.RUNNERS_UNAVAILABLE,
  encryption_not_configured: {
    title: 'Pipeline runners are not set up on this platform.',
    body: 'Secret encryption for runner signing keys is not configured — ask your platform operator. pipeline-manager pipeline run with your own AWS credentials still works.',
    link: null,
  },
  key_service: {
    title: 'Runs can\'t be signed right now because the key service is unreachable.',
    body: 'Queued runs retry automatically.',
    link: null,
  },
} satisfies Record<RunnersUnavailableReason, RunnerErrorCopy>;

/**
 * The copy for a code (a generic sentence for an unknown one). `reason` is a
 * RUNNERS_UNAVAILABLE refusal's `details.reason` (an unknown one reads as the pause copy).
 */
export function runnerErrorCopy(code: string | null | undefined, reason?: unknown): RunnerErrorCopy {
  if (code === 'RUNNERS_UNAVAILABLE' && typeof reason === 'string' && Object.hasOwn(RUNNERS_UNAVAILABLE_COPY, reason)) {
    return RUNNERS_UNAVAILABLE_COPY[reason as RunnersUnavailableReason];
  }
  if (code && Object.hasOwn(RUNNER_ERROR_COPY, code)) return RUNNER_ERROR_COPY[code];
  return {
    title: 'The pipeline runner could not complete the request.',
    body: code ? `It answered ${code}.` : 'It gave no reason.',
    link: 'runners',
  };
}

/** Whether an error is one of the runner Re-run / Stop refusals. */
export function isRunnerError(err: unknown): err is ApiError {
  return err instanceof ApiError && !!err.code && CODES_WITH_COPY.has(err.code);
}

/**
 * Copy for a failed Test ping's `errorCode` when it is a DELIVERY failure class
 * (the request never got a runner answer) rather than a catalog code. The
 * classes are api-core's `RUNNER_DELIVERY_FAILURE_CLASSES` (the pipeline
 * service's `last_delivery_error` vocabulary); keying the record by that type
 * makes a new class without copy a compile error.
 */
export const DELIVERY_FAILURE_COPY: Readonly<Record<RunnerDeliveryFailureClass, { title: string; body: string }>> = {
  timeout: {
    title: 'The runner did not answer in time.',
    body: 'Its Lambda may be throttled, cold-starting slowly or stuck. Check the runner stack in your AWS account, then test again.',
  },
  conn_refused: {
    title: 'The platform could not connect to the runner\'s URL.',
    body: 'Check the runner stack is deployed and its Function URL (or API Gateway) is reachable — an IP allowlist must include the platform\'s addresses.',
  },
  dns_nxdomain: {
    title: 'The runner\'s URL no longer exists.',
    body: 'Its Function URL or API Gateway was deleted. Re-run pipeline-manager infra setup-runner to redeploy it.',
  },
  aws_403_url_gone: {
    title: 'AWS refused the request before it reached the runner.',
    body: 'The Function URL was deleted or its auth type changed, or an API Gateway allowlist blocks the platform. Re-run pipeline-manager infra setup-runner.',
  },
  http_5xx: {
    title: 'The runner failed while answering.',
    body: 'Its Lambda\'s logs in your AWS account say why. Fix it, then test again.',
  },
  http_429: {
    title: 'The runner is throttled.',
    body: 'AWS is rate-limiting its Lambda. Wait a minute, then test again.',
  },
};

const DELIVERY_FAILURE_CLASS_SET: ReadonlySet<string> = new Set(RUNNER_DELIVERY_FAILURE_CLASSES);

function isDeliveryFailureClass(code: string | null | undefined): code is RunnerDeliveryFailureClass {
  return !!code && DELIVERY_FAILURE_CLASS_SET.has(code);
}

/** The sentence a failed Test ping shows for its `errorCode`. */
export function runnerTestFailureCopy(code: string | null | undefined): string {
  const c = isDeliveryFailureClass(code) ? DELIVERY_FAILURE_COPY[code] : runnerErrorCopy(code);
  return `${c.title} ${c.body}`;
}

/** Run-request states nothing further happens after. */
export const TERMINAL_RUN_REQUEST_STATUSES: ReadonlySet<RunRequestStatus> = new Set(TERMINAL_RUN_REQUEST_STATUS_LIST);

/** A bare egress address as the CIDR `--allow-ip` wants (`/32`, `/128`). */
export function asCidr(ip: string): string {
  const v = ip.trim();
  if (v.includes('/')) return v;
  return v.includes(':') ? `${v}/128` : `${v}/32`;
}

/** One POSIX-shell word, literal whatever it holds (`$`, backticks, quotes):
 *  single-quoted, an embedded `'` closed, escaped and reopened. A JSON string
 *  is double-quoted, which a shell still expands `$(…)` and backticks inside. */
function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** The install command for a runner in `region`; `allowIps` = the API Gateway variant. */
export function setupRunnerCommand(opts: { region: string; label?: string; allowIps?: string[] }): string {
  const parts = ['pipeline-manager infra setup-runner', `--region ${opts.region || '<region>'}`];
  if (opts.allowIps && opts.allowIps.length > 0) parts.push('--api-gateway', `--allow-ip ${opts.allowIps.map(asCidr).join(' ')}`);
  if (opts.label?.trim()) parts.push(`--label ${shellQuote(opts.label.trim())}`);
  return parts.join(' ');
}
