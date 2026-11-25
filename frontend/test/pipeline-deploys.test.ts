// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The deploy-through-a-runner copy (src/lib/pipeline-deploys.ts):
 *  - every deploy result code, failure class, stage, status and target reason
 *    has copy (the Records are exhaustive at compile time; this pins that the
 *    copy says something concrete — a next step, a command where one fixes it);
 *  - a failed deploy reads its code's copy, a runner catalog code reads the
 *    runner banner's copy with the class's next step, no code reads the class;
 *  - the stage steps mark done / current / pending, `cleaning` only when used;
 *  - the runner catalog's deploy codes carry real copy, not the phase-0
 *    placeholder.
 */

import { describe, it, expect } from '@jest/globals';
import {
  DEPLOY_FAILURE_CLASSES, DEPLOY_REQUEST_STATUSES, DEPLOY_SETUP_COMMAND, DEPLOY_STAGES, DEPLOY_TARGET_REASONS,
  RUNNER_DEPLOY_ERROR_CODES, RUNNER_ERROR_CODES,
} from '@pipeline-builder/api-core/pipeline-runners';
import {
  DEPLOY_ERROR_COPY, DEPLOY_FAILURE_CLASS_COPY, DEPLOY_STAGE_LABEL, DEPLOY_STATUS_LABEL, DEPLOY_TARGET_REASON_COPY,
  deployFailureCopy, deployStageSteps, deployTargetLabel, isActiveDeployStatus, logHintGuidance,
} from '../src/lib/pipeline-deploys';
import { RUNNER_ERROR_COPY } from '../src/lib/pipeline-runners';

describe('deploy copy is exhaustive', () => {
  it('every deploy result code has a title, a body and at least one next step', () => {
    for (const code of RUNNER_DEPLOY_ERROR_CODES) {
      const c = DEPLOY_ERROR_COPY[code];
      expect({ code, ok: !!c && c.title.length > 10 && c.body.length > 20 && c.nextSteps.length > 0 }).toEqual({ code, ok: true });
    }
    expect(Object.keys(DEPLOY_ERROR_COPY).sort()).toEqual([...RUNNER_DEPLOY_ERROR_CODES].sort());
  });

  it('a code fixed by a command names the command', () => {
    expect(DEPLOY_ERROR_COPY.CDK_NOT_BOOTSTRAPPED.nextSteps.join(' ')).toContain('pipeline-manager infra bootstrap --region');
    expect(DEPLOY_ERROR_COPY.CDK_BOOTSTRAP_OUTDATED.nextSteps.join(' ')).toContain('pipeline-manager infra bootstrap --region');
    expect(DEPLOY_ERROR_COPY.DEPLOY_IMAGE_PULL_FAILED.nextSteps.join(' ')).toContain('infra store-token --scope registry:push');
    // No privileged-mode setting exists on the runner: the fix is a CLI deploy from a machine with Docker.
    expect(DEPLOY_ERROR_COPY.DEPLOY_NEEDS_PRIVILEGED.nextSteps.join(' ')).toContain('pipeline-manager pipeline deploy');
    expect(JSON.stringify(DEPLOY_ERROR_COPY)).not.toMatch(/DeployPrivileged|privileged mode/i);
    expect(DEPLOY_ERROR_COPY.CDK_BOOTSTRAP_OUTDATED.body).toMatch(/version 21/);
  });

  it('every failure class, stage, status and target reason has copy', () => {
    for (const k of DEPLOY_FAILURE_CLASSES) expect(DEPLOY_FAILURE_CLASS_COPY[k].nextStep.length).toBeGreaterThan(20);
    for (const s of DEPLOY_STAGES) expect(DEPLOY_STAGE_LABEL[s].length).toBeGreaterThan(3);
    for (const s of DEPLOY_REQUEST_STATUSES) expect(DEPLOY_STATUS_LABEL[s].length).toBeGreaterThan(3);
    for (const r of DEPLOY_TARGET_REASONS) expect(DEPLOY_TARGET_REASON_COPY[r].length).toBeGreaterThan(10);
    expect(DEPLOY_TARGET_REASON_COPY.deploy_not_enabled).toContain(DEPLOY_SETUP_COMMAND);
  });
});

describe('deployFailureCopy', () => {
  it('a deploy result code reads its own copy', () => {
    expect(deployFailureCopy('CFN_DEPLOY_FAILED', 'cloudformation')).toBe(DEPLOY_ERROR_COPY.CFN_DEPLOY_FAILED);
  });

  it('a runner catalog code reads the runner copy, with the class next step', () => {
    const c = deployFailureCopy('DEPLOY_NOT_ENABLED', 'account_setup');
    expect(c.title).toBe(RUNNER_ERROR_COPY.DEPLOY_NOT_ENABLED.title);
    expect(c.nextSteps).toContain(DEPLOY_FAILURE_CLASS_COPY.account_setup.nextStep);
  });

  it('expired reads the not-delivered copy; no code reads the class; an unknown code is named', () => {
    expect(deployFailureCopy('RUN_REQUEST_EXPIRED', 'platform').title).toMatch(/not delivered/i);
    expect(deployFailureCopy(null, 'timeout').nextSteps).toEqual([DEPLOY_FAILURE_CLASS_COPY.timeout.nextStep]);
    expect(deployFailureCopy('SOMETHING_NEW', null).body).toContain('SOMETHING_NEW');
  });
});

describe('deployStageSteps', () => {
  it('marks the stages before the current one done, the rest pending, and skips cleaning unless used', () => {
    const steps = deployStageSteps('synthesizing', 'deploying');
    expect(steps.map((s) => s.stage)).not.toContain('cleaning');
    expect(steps.find((s) => s.stage === 'fetching')?.state).toBe('done');
    expect(steps.find((s) => s.stage === 'synthesizing')?.state).toBe('current');
    expect(steps.find((s) => s.stage === 'deploying')?.state).toBe('pending');
    expect(steps.map((s) => s.stage)).not.toContain('removing');
  });

  it('shows cleaning when the job is cleaning, and every step done once deployed', () => {
    expect(deployStageSteps('cleaning', 'deploying').map((s) => s.stage)).toContain('cleaning');
    expect(deployStageSteps('done', 'deployed').every((s) => s.state === 'done')).toBe(true);
  });

  it('a failed deploy marks the stage it ended in failed', () => {
    expect(deployStageSteps('deploying', 'failed').find((s) => s.stage === 'deploying')?.state).toBe('failed');
  });
});

describe('helpers', () => {
  it('active statuses', () => {
    expect(['queued', 'delivering', 'deploying'].every(isActiveDeployStatus)).toBe(true);
    expect(['deployed', 'failed', 'expired', 'cancelled'].some(isActiveDeployStatus)).toBe(false);
  });

  it('a target label reads "<label> (<region>)" and names a sharing org', () => {
    expect(deployTargetLabel({ label: 'prod', isOwn: true, ownerOrgName: null }, 'us-east-1')).toBe('prod (us-east-1)');
    expect(deployTargetLabel({ label: 'prod', isOwn: false, ownerOrgName: 'Acme' }, 'eu-west-1')).toBe('prod (eu-west-1), shared by Acme');
  });

  it('the log hint names the project, the log group and the build, and the runner\'s account', () => {
    const g = logHintGuidance({ project: 'pipeline-builder-runner-deploy-r1', logGroup: '/aws/codebuild/pipeline-builder-runner-deploy-r1', buildId: 'pipeline-builder-runner-deploy-r1:abc' });
    expect(g).toMatch(/CloudWatch in the runner's AWS account/);
  });
});

describe('the runner catalog\'s deploy codes', () => {
  it('carry real copy (no phase-0 placeholder)', () => {
    const deployCodes = RUNNER_ERROR_CODES.filter((c) => /DEPLOY|DEPLOYABLE|DEPLOYED/.test(c));
    expect(deployCodes.length).toBeGreaterThanOrEqual(15);
    for (const code of deployCodes) {
      const c = RUNNER_ERROR_COPY[code];
      expect({ code, ok: !!c && c.body.length > 40 }).toEqual({ code, ok: true });
    }
    expect(RUNNER_ERROR_COPY.RUNNER_DEPLOY_UNSUPPORTED.body).toContain(DEPLOY_SETUP_COMMAND);
    expect(RUNNER_ERROR_COPY.DEPLOY_NOT_ENABLED.body).toContain(DEPLOY_SETUP_COMMAND);
  });
});
