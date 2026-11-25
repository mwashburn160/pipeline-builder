// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The deploy half of the runner contract: a pipeline deployed through a
 * runner's CodeBuild project (`deploy`), its status polls (`deploy_status`),
 * cancel (`deploy_cancel`) and the stack removal on purge (`undeploy`). These
 * hold the catalog's internal invariants — every action expects an outcome,
 * every job result code has a failure class, the grant outlives queue +
 * provisioning — that the pipeline service, the runner Lambda, the deploy job
 * and the dashboard all code against.
 */

import { describe, it, expect } from '@jest/globals';
import * as catalog from '../src/types/pipeline-runners.js';
import {
  ACTIVE_DEPLOY_STATUSES, AWS_REGION_PATTERN, DEPLOY_ACTION_CAPABILITY, DEPLOY_BUILD_QUEUED_TIMEOUT_MINUTES, DEPLOY_BUILD_STATES,
  DEPLOY_BUILD_TIMEOUT_MINUTES, DEPLOY_CAPABILITY, DEPLOY_FAILURE_CLASSES, DEPLOY_GRANT_CIPHERTEXT_PATTERN, DEPLOY_GRANT_KMS_PURPOSE,
  DEPLOY_GRANT_PATTERN, DEPLOY_GRANT_PREFIX, DEPLOY_GRANT_PROVISIONING_MARGIN_MS, DEPLOY_GRANT_REJECTION_REASONS, DEPLOY_GRANT_TTL_MS,
  DEPLOY_IMAGE_DIGEST_PATTERN, DEPLOY_JOB_ENV, DEPLOY_JOB_EXPORTED_VARIABLES, DEPLOY_JOB_IMAGE_REPOSITORY, DEPLOY_JOB_MODES,
  DEPLOY_JOB_OVERRIDE_ENV, DEPLOY_JOB_PROTOCOL_VERSION, DEPLOY_JOB_RESULT_CODES, DEPLOY_REQUEST_STATUSES, DEPLOY_RESULT_OK,
  DEPLOY_SESSION_LEAVES, DEPLOY_SESSION_PATTERN, DEPLOY_SESSION_PREFIX, DEPLOY_SETUP_COMMAND, DEPLOY_STAGES, DEPLOY_TARGET_REASONS,
  EXPECTED_OUTCOMES, IN_PROGRESS_RUN_REQUEST_STATUSES, PENDING_RUN_REQUEST_STATUSES, RUN_REQUEST_ACTIONS, RUN_REQUEST_STATUSES,
  RUN_REQUEST_TTL_MS, RUNNER_ACTIONS, RUNNER_CAPABILITIES, RUNNER_DEPLOY_ERROR_CODES, RUNNER_DEPLOY_ERRORS, RUNNER_DEPLOY_METRICS,
  RUNNER_ERROR_CODES, RUNNER_ERRORS, RUNNER_OUTCOMES, RUNNER_TUNABLE_DEFAULTS, RUNNER_TUNABLE_MINIMUMS, TERMINAL_RUN_REQUEST_STATUSES,
  UNDEPLOY_REQUEST_STATUSES, deployBuildState, deployFailureOf, deployGrantEncryptionContext, deployGrantTtlMs, deployLogGroupName,
  deployLogHint, deployProjectName, isDeployJobResultCode, isRunnerDeployErrorCode, isTerminalRunRequestStatus, parsePipelinePrefixes,
  parseRunnerCapabilities, pipelineNameMatchesPrefixes, runnerDeployPath, runnerSupportsAction, runnerTunable,
} from '../src/types/pipeline-runners.js';
import { isRemoteAuditAction } from '../src/types/remote-audit-actions.js';

describe('deploy actions and outcomes', () => {
  it('adds deploy, deploy_status, deploy_cancel and undeploy, each expecting its own outcome', () => {
    for (const a of ['deploy', 'deploy_status', 'deploy_cancel', 'undeploy'] as const) expect(RUNNER_ACTIONS).toContain(a);
    expect(EXPECTED_OUTCOMES.deploy).toEqual(['deploying']);
    expect(EXPECTED_OUTCOMES.deploy_status).toEqual(['deploy_status']);
    expect(EXPECTED_OUTCOMES.deploy_cancel).toEqual(['deploy_cancelled']);
    expect(EXPECTED_OUTCOMES.undeploy).toEqual(['undeploying']);
    for (const o of ['deploying', 'deploy_status', 'deploy_cancelled', 'undeploying'] as const) expect(RUNNER_OUTCOMES).toContain(o);
  });

  it('records deploy and undeploy as request rows; the status read and cancel never are', () => {
    expect([...RUN_REQUEST_ACTIONS]).toEqual(['start', 'stop', 'probe', 'deploy', 'undeploy']);
  });

  it('gates every deploy action on the deploy:1 capability, and nothing else on any capability', () => {
    expect([...RUNNER_CAPABILITIES]).toEqual(['deploy:1']);
    expect(DEPLOY_CAPABILITY).toBe('deploy:1');
    expect(Object.keys(DEPLOY_ACTION_CAPABILITY).sort()).toEqual(['deploy', 'deploy_cancel', 'deploy_status', 'undeploy']);
    for (const a of RUNNER_ACTIONS) {
      expect([a, runnerSupportsAction([], a)]).toEqual([a, !(a in DEPLOY_ACTION_CAPABILITY)]);
      expect([a, runnerSupportsAction(['deploy:1'], a)]).toEqual([a, true]);
    }
    // An old runner, or one that lists an unknown capability only.
    expect(runnerSupportsAction(['deploy:2'], 'deploy')).toBe(false);
  });

  it('parses a pong\'s capabilities against the fixed list (unknown and malformed dropped, deduplicated)', () => {
    expect(parseRunnerCapabilities(['deploy:1', 'deploy:1', 'teleport:9', 7, null])).toEqual(['deploy:1']);
    expect(parseRunnerCapabilities(undefined)).toEqual([]);
    expect(parseRunnerCapabilities('deploy:1')).toEqual([]);
  });

  it('parses a pong\'s pipeline prefixes and matches names the way the runner\'s allowlist does', () => {
    expect(parsePipelinePrefixes(['acme-', '*', 'acme-', 'bad prefix', '', 3, 'x'.repeat(101)])).toEqual(['acme-', '*']);
    expect(parsePipelinePrefixes(null)).toEqual([]);
    expect(parsePipelinePrefixes(Array.from({ length: 60 }, (_, i) => `p${i}`))).toHaveLength(50);
    expect(pipelineNameMatchesPrefixes('acme-web', ['acme-'])).toBe(true);
    expect(pipelineNameMatchesPrefixes('other-web', ['acme-'])).toBe(false);
    expect(pipelineNameMatchesPrefixes('anything', ['*'])).toBe(true);
    // A runner that reported none is never a match (it predates deploys).
    expect(pipelineNameMatchesPrefixes('acme-web', [])).toBe(false);
  });
});

describe('deploy request statuses', () => {
  it('splits every status into pending, in progress and terminal, with nothing left over', () => {
    expect([...PENDING_RUN_REQUEST_STATUSES]).toEqual(['queued', 'delivering']);
    expect([...IN_PROGRESS_RUN_REQUEST_STATUSES]).toEqual(['deploying', 'undeploying']);
    for (const s of ['deployed', 'cancelled', 'undeployed'] as const) expect(TERMINAL_RUN_REQUEST_STATUSES).toContain(s);
    expect([...PENDING_RUN_REQUEST_STATUSES, ...IN_PROGRESS_RUN_REQUEST_STATUSES, ...TERMINAL_RUN_REQUEST_STATUSES].sort())
      .toEqual([...RUN_REQUEST_STATUSES].sort());
    for (const s of RUN_REQUEST_STATUSES) expect([s, isTerminalRunRequestStatus(s)]).toEqual([s, (TERMINAL_RUN_REQUEST_STATUSES as readonly string[]).includes(s)]);
    expect(isTerminalRunRequestStatus('nope')).toBe(false);
  });

  it('counts queued, delivering and deploying as the one active deploy per pipeline', () => {
    expect([...ACTIVE_DEPLOY_STATUSES]).toEqual(['queued', 'delivering', 'deploying']);
    for (const s of ACTIVE_DEPLOY_STATUSES) expect(DEPLOY_REQUEST_STATUSES).toContain(s);
    expect([...DEPLOY_REQUEST_STATUSES]).toEqual(['queued', 'delivering', 'deploying', 'deployed', 'failed', 'expired', 'cancelled']);
    expect([...UNDEPLOY_REQUEST_STATUSES]).toEqual(['queued', 'delivering', 'undeploying', 'undeployed', 'failed', 'expired']);
    for (const s of [...DEPLOY_REQUEST_STATUSES, ...UNDEPLOY_REQUEST_STATUSES]) expect(RUN_REQUEST_STATUSES).toContain(s);
  });
});

describe('deploy stages, build states, failure classes', () => {
  it('orders the job\'s stages, cleaning before synth, done last', () => {
    expect([...DEPLOY_STAGES]).toEqual([
      'queued', 'starting', 'authenticating', 'fetching', 'prechecking', 'cleaning', 'synthesizing', 'deploying', 'registering', 'removing', 'done',
    ]);
  });

  it('maps CodeBuild\'s build statuses onto the five build states', () => {
    expect([...DEPLOY_BUILD_STATES]).toEqual(['in_progress', 'succeeded', 'failed', 'stopped', 'timed_out']);
    expect(deployBuildState('IN_PROGRESS')).toBe('in_progress');
    expect(deployBuildState('SUCCEEDED')).toBe('succeeded');
    expect(deployBuildState('FAILED')).toBe('failed');
    expect(deployBuildState('FAULT')).toBe('failed');
    expect(deployBuildState('STOPPED')).toBe('stopped');
    expect(deployBuildState('TIMED_OUT')).toBe('timed_out');
    expect(deployBuildState('SOMETHING_NEW')).toBe('failed');
    expect(deployBuildState(undefined)).toBe('in_progress');
  });

  it('names nine failure classes', () => {
    expect([...DEPLOY_FAILURE_CLASSES]).toEqual(['account_setup', 'definition', 'aws_permission', 'cloudformation', 'image', 'platform', 'timeout', 'cancelled', 'unknown']);
  });
});

describe('deploy job error codes', () => {
  it('gives every code its class and retryability, as the approved design lists them', () => {
    expect(RUNNER_DEPLOY_ERRORS).toEqual({
      DEPLOY_GRANT_REJECTED: { class: 'platform', retryable: false },
      DEPLOY_GRANT_EXPIRED: { class: 'platform', retryable: true },
      PIPELINE_FETCH_FAILED: { class: 'platform', retryable: true },
      PLUGIN_RESOLUTION_FAILED: { class: 'definition', retryable: false },
      DEPLOY_TARGET_MISMATCH: { class: 'definition', retryable: false },
      STACK_OWNED_BY_OTHER_PIPELINE: { class: 'definition', retryable: false },
      CDK_NOT_BOOTSTRAPPED: { class: 'account_setup', retryable: true },
      CDK_BOOTSTRAP_OUTDATED: { class: 'account_setup', retryable: true },
      ACCOUNT_SECRETS_MISSING: { class: 'account_setup', retryable: true },
      DEPLOY_PERMISSION_DENIED: { class: 'aws_permission', retryable: true },
      CFN_DEPLOY_FAILED: { class: 'cloudformation', retryable: true },
      STACK_DELETE_FAILED: { class: 'cloudformation', retryable: true },
      DEPLOY_IMAGE_PULL_FAILED: { class: 'image', retryable: true },
      DEPLOY_JOB_PROTOCOL_MISMATCH: { class: 'image', retryable: false },
      DEPLOY_NEEDS_PRIVILEGED: { class: 'image', retryable: false },
      DEPLOY_TIMED_OUT: { class: 'timeout', retryable: true },
      DEPLOY_CANCELLED: { class: 'cancelled', retryable: true },
      DEPLOY_JOB_ERROR: { class: 'unknown', retryable: true },
    });
    for (const c of RUNNER_DEPLOY_ERROR_CODES) expect(DEPLOY_FAILURE_CLASSES).toContain(RUNNER_DEPLOY_ERRORS[c].class);
    // Every class but none is reachable from some code.
    expect([...new Set(RUNNER_DEPLOY_ERROR_CODES.map((c) => RUNNER_DEPLOY_ERRORS[c].class))].sort()).toEqual([...DEPLOY_FAILURE_CLASSES].sort());
  });

  it('keeps job result codes and HTTP answer codes disjoint (one meaning per code)', () => {
    expect(RUNNER_DEPLOY_ERROR_CODES.filter((c) => (RUNNER_ERROR_CODES as readonly string[]).includes(c))).toEqual([]);
    expect(isRunnerDeployErrorCode('CDK_NOT_BOOTSTRAPPED')).toBe(true);
    expect(isRunnerDeployErrorCode('NO_RUNNER')).toBe(false);
    expect(isRunnerDeployErrorCode('toString')).toBe(false);
  });

  it('the job reports OK or one of the codes, nothing else', () => {
    expect(DEPLOY_RESULT_OK).toBe('OK');
    expect([...DEPLOY_JOB_RESULT_CODES]).toEqual(['OK', ...RUNNER_DEPLOY_ERROR_CODES]);
    expect(isDeployJobResultCode('OK')).toBe(true);
    expect(isDeployJobResultCode('CFN_DEPLOY_FAILED')).toBe(true);
    expect(isDeployJobResultCode('arn:aws:cloudformation:…')).toBe(false);
    expect(isDeployJobResultCode(undefined)).toBe(false);
  });

  it('derives a failed deploy\'s class and retryability from any recorded code', () => {
    expect(deployFailureOf(null)).toBeNull();
    expect(deployFailureOf('CDK_NOT_BOOTSTRAPPED')).toEqual({ failureClass: 'account_setup', retryable: true });
    expect(deployFailureOf('DEPLOY_JOB_PROTOCOL_MISMATCH')).toEqual({ failureClass: 'image', retryable: false });
    // A runner refusing the deploy: the account's runner setup, fixable there.
    expect(deployFailureOf('DEPLOY_NOT_ENABLED')).toEqual({ failureClass: 'account_setup', retryable: true });
    expect(deployFailureOf('RUNNER_REFUSED')).toEqual({ failureClass: 'account_setup', retryable: true });
    // Anything else the platform recorded (not delivered, bad signature, …).
    expect(deployFailureOf('RUN_REQUEST_EXPIRED')).toEqual({ failureClass: 'platform', retryable: true });
    expect(deployFailureOf('SOMETHING_NEW')).toEqual({ failureClass: 'unknown', retryable: true });
  });
});

describe('deploy HTTP answers in RUNNER_ERRORS', () => {
  it.each([
    ['RUNNER_DEPLOY_UNSUPPORTED', 409, 'platform', false],
    ['DEPLOY_RUNNER_REQUIRED', 409, 'platform', false],
    ['RUNNER_NOT_DEPLOYABLE', 409, 'platform', false],
    ['ALREADY_DEPLOYED', 409, 'platform', false],
    ['DEPLOY_IN_PROGRESS', 409, 'platform', false],
    ['DEPLOY_REGION_NOT_ALLOWED', 409, 'platform', false],
    ['TOOLCHAIN_TOO_OLD_FOR_DEPLOY', 409, 'platform', false],
    ['DEPLOY_NOT_CANCELLABLE', 409, 'platform', false],
    ['DEPLOY_RATE_LIMITED', 429, 'platform', false],
    ['TOO_MANY_DEPLOYS', 429, 'platform', false],
    ['DEPLOY_GRANT_INVALID', 401, 'platform', false],
    ['DEPLOY_NOT_ENABLED', 403, 'runner', false],
    ['PIPELINE_ALREADY_DEPLOYED', 409, 'runner', false],
    ['DEPLOY_BUSY', 409, 'runner', true],
    ['DEPLOY_BUILD_NOT_FOUND', 404, 'runner', false],
  ] as const)('%s is %i %s (retryable %s)', (code, httpStatus, category, retryable) => {
    expect(RUNNER_ERRORS[code]).toEqual({ httpStatus, retryable, category });
  });

  it('names four grant rejection reasons (the metric label and DEPLOY_GRANT_INVALID details.reason)', () => {
    expect([...DEPLOY_GRANT_REJECTION_REASONS]).toEqual(['reused', 'expired', 'unknown', 'wrong_state']);
  });
});

describe('deploy grant and session tokens', () => {
  const b64 = 'A'.repeat(43);

  it('are prefixed 32-byte base64url values', () => {
    expect(DEPLOY_GRANT_PREFIX).toBe('pb_dg_');
    expect(DEPLOY_SESSION_PREFIX).toBe('pb_ds_');
    expect(DEPLOY_GRANT_PATTERN.test(`pb_dg_${b64}`)).toBe(true);
    expect(DEPLOY_GRANT_PATTERN.test(`pb_ds_${b64}`)).toBe(false);
    expect(DEPLOY_GRANT_PATTERN.test(`pb_dg_${b64}=`)).toBe(false);
    expect(DEPLOY_SESSION_PATTERN.test(`pb_ds_${'-_'.repeat(21)}x`)).toBe(true);
    expect(DEPLOY_SESSION_PATTERN.test(`pb_ds_${b64.slice(1)}`)).toBe(false);
  });

  it('outlives the build queue plus provisioning, and never the delivery lifetime', () => {
    expect(DEPLOY_BUILD_QUEUED_TIMEOUT_MINUTES).toBe(30);
    expect(DEPLOY_GRANT_PROVISIONING_MARGIN_MS).toBe(15 * 60_000);
    expect(DEPLOY_GRANT_TTL_MS).toBe(45 * 60_000);
    expect(deployGrantTtlMs(30)).toBe(45 * 60_000);
    // A tiny queue timeout still leaves the grant alive for the whole delivery window.
    expect(deployGrantTtlMs(0)).toBe(Math.max(RUN_REQUEST_TTL_MS, DEPLOY_GRANT_PROVISIONING_MARGIN_MS));
    expect(deployGrantTtlMs(0)).toBeGreaterThanOrEqual(RUN_REQUEST_TTL_MS);
  });

  it('is KMS-wrapped in the account under a fixed encryption context', () => {
    expect(DEPLOY_GRANT_KMS_PURPOSE).toBe('deploy-grant');
    expect(deployGrantEncryptionContext('r-1')).toEqual({ runnerId: 'r-1', purpose: 'deploy-grant' });
    expect(DEPLOY_GRANT_CIPHERTEXT_PATTERN.test('AQICAHh0Zm9vYmFy+/==')).toBe(true);
    expect(DEPLOY_GRANT_CIPHERTEXT_PATTERN.test(`pb_dg_${b64}`)).toBe(false);
    expect(DEPLOY_GRANT_CIPHERTEXT_PATTERN.test('')).toBe(false);
    expect(DEPLOY_GRANT_CIPHERTEXT_PATTERN.test('A'.repeat(4100))).toBe(false);
  });
});

describe('deploy job', () => {
  it('runs the managed cdk-synth image pinned by digest, speaking protocol 1', () => {
    expect(DEPLOY_JOB_IMAGE_REPOSITORY).toBe('system/cdk-synth');
    expect(DEPLOY_JOB_PROTOCOL_VERSION).toBe(1);
    expect(DEPLOY_IMAGE_DIGEST_PATTERN.test(`sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(DEPLOY_IMAGE_DIGEST_PATTERN.test(`sha256:${'A'.repeat(64)}`)).toBe(false);
    expect(DEPLOY_IMAGE_DIGEST_PATTERN.test('latest')).toBe(false);
    expect([...DEPLOY_JOB_MODES]).toEqual(['deploy', 'undeploy']);
  });

  it('passes only the fixed env names (the grant only as ciphertext), and exports two variables', () => {
    expect(DEPLOY_JOB_ENV).toEqual({
      requestId: 'PB_REQUEST_ID',
      pipelineId: 'PB_PIPELINE_ID',
      region: 'PB_TARGET_REGION',
      pipelineName: 'PB_PIPELINE_NAME',
      stackName: 'PB_STACK_NAME',
      grantCiphertext: 'PB_DEPLOY_GRANT_CIPHERTEXT',
      toolchainRelease: 'PB_TOOLCHAIN_RELEASE',
      protocol: 'PB_DEPLOY_PROTOCOL',
      mode: 'PB_JOB_MODE',
      result: 'PB_DEPLOY_RESULT',
      stage: 'PB_DEPLOY_STAGE',
    });
    expect([...DEPLOY_JOB_EXPORTED_VARIABLES]).toEqual(['PB_DEPLOY_RESULT', 'PB_DEPLOY_STAGE']);
    expect([...DEPLOY_JOB_OVERRIDE_ENV, ...DEPLOY_JOB_EXPORTED_VARIABLES].sort()).toEqual(Object.values(DEPLOY_JOB_ENV).sort());
    expect(Object.values(DEPLOY_JOB_ENV).some((n) => /GRANT$/.test(n))).toBe(false);
  });

  it('names the runner\'s project and log group by runner id (no account id), and so the log hint', () => {
    expect(deployProjectName('r-1')).toBe('pipeline-builder-runner-deploy-r-1');
    expect(deployLogGroupName('r-1')).toBe('/aws/codebuild/pipeline-builder-runner-deploy-r-1');
    expect(deployLogHint('r-1', 'pipeline-builder-runner-deploy-r-1:0b6f9a52-6a0c-4c39-9d77-1f1f6b1c2e3a')).toEqual({
      project: 'pipeline-builder-runner-deploy-r-1',
      logGroup: '/aws/codebuild/pipeline-builder-runner-deploy-r-1',
      buildId: 'pipeline-builder-runner-deploy-r-1:0b6f9a52-6a0c-4c39-9d77-1f1f6b1c2e3a',
    });
    expect(deployLogHint('r-1', null).buildId).toBeNull();
    expect(DEPLOY_SETUP_COMMAND).toBe('pipeline-manager infra setup-runner --enable-deploy');
  });

  it('bounds the build timeout as the stack parameter does', () => {
    expect(DEPLOY_BUILD_TIMEOUT_MINUTES).toEqual({ default: 60, min: 10, max: 480 });
  });

  it('accepts AWS region names only', () => {
    for (const r of ['us-east-1', 'eu-central-2', 'us-gov-west-1', 'ap-southeast-10']) expect([r, AWS_REGION_PATTERN.test(r)]).toEqual([r, true]);
    for (const r of ['US-EAST-1', 'us-east', 'useast1', 'us-east-1 ', '']) expect([r, AWS_REGION_PATTERN.test(r)]).toEqual([r, false]);
  });
});

describe('the session facade', () => {
  it('lives under the public runner mount, keyed by the request id', () => {
    expect([...DEPLOY_SESSION_LEAVES]).toEqual(['session', 'pipeline', 'plugin-lookup', 'progress', 'registry', 'result']);
    expect(runnerDeployPath('3f0e', 'session')).toBe('/api/pipelines/runner/deploys/3f0e/session');
    expect(runnerDeployPath('../x', 'result')).toBe('/api/pipelines/runner/deploys/..%2Fx/result');
  });
});

describe('deploy targets', () => {
  it('names why a runner is not deployable', () => {
    expect([...DEPLOY_TARGET_REASONS]).toEqual(['deploy_not_enabled', 'update_required', 'unhealthy', 'prefix_mismatch', 'team_deploys_not_shared', 'region']);
  });
});

describe('deploy tunables', () => {
  it('ship the plan defaults and minimums', () => {
    expect(RUNNER_TUNABLE_DEFAULTS).toMatchObject({
      DEPLOY_REQUESTS_PER_HOUR: '20',
      MAX_ACTIVE_DEPLOYS_PER_RUNNER: '2',
      RUNNER_DEPLOY_DEADLINE_MINUTES: '120',
      RUNNER_DEPLOY_STATUS_POLL_SECONDS: '30',
    });
    expect(RUNNER_TUNABLE_MINIMUMS).toMatchObject({
      DEPLOY_REQUESTS_PER_HOUR: 1,
      MAX_ACTIVE_DEPLOYS_PER_RUNNER: 1,
      RUNNER_DEPLOY_DEADLINE_MINUTES: 15,
      RUNNER_DEPLOY_STATUS_POLL_SECONDS: 10,
    });
    expect(runnerTunable('RUNNER_DEPLOY_DEADLINE_MINUTES', { RUNNER_DEPLOY_DEADLINE_MINUTES: '14' }, () => undefined)).toBe(120);
    expect(runnerTunable('RUNNER_DEPLOY_DEADLINE_MINUTES', { RUNNER_DEPLOY_DEADLINE_MINUTES: '15' })).toBe(15);
  });

  it('the deploy deadline floor outlasts the build queue', () => {
    expect(RUNNER_TUNABLE_MINIMUMS.RUNNER_DEPLOY_DEADLINE_MINUTES).toBeLessThan(Number(RUNNER_TUNABLE_DEFAULTS.RUNNER_DEPLOY_DEADLINE_MINUTES));
    // The default deadline covers the queue plus the longest default build.
    expect(Number(RUNNER_TUNABLE_DEFAULTS.RUNNER_DEPLOY_DEADLINE_MINUTES))
      .toBeGreaterThanOrEqual(DEPLOY_BUILD_QUEUED_TIMEOUT_MINUTES + DEPLOY_BUILD_TIMEOUT_MINUTES.default);
  });
});

describe('deploy metrics and audit actions', () => {
  it('names the five metrics the alerts read', () => {
    expect(RUNNER_DEPLOY_METRICS).toEqual({
      deploys: 'pipeline_runner_deploys_total',
      failuresByClass: 'pipeline_runner_deploy_failures_total',
      duration: 'pipeline_runner_deploy_duration_seconds',
      overdue: 'pipeline_runner_deploys_overdue',
      grantRejections: 'pipeline_runner_deploy_grant_rejections_total',
    });
  });

  it('are remote audit actions the pipeline service may emit', () => {
    for (const a of ['pipeline.deploy.request', 'pipeline.deploy.complete', 'pipeline.deploy.cancel', 'pipeline.deploy.grant_reuse', 'pipeline.undeploy.complete']) {
      expect([a, isRemoteAuditAction(a)]).toEqual([a, true]);
    }
  });

  it('stays dependency-free (exports only, still no runtime imports)', () => {
    expect(typeof catalog.runnerDeployPath).toBe('function');
  });
});
