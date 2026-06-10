// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic, READ-ONLY prerequisite checks per target. No LLM, no mutation —
 * every command here only inspects (presence checks, `aws sts get-caller-identity`,
 * `docker info`). This is the kind of thing a script does better than an agent,
 * so it stays deterministic; the LLM is reserved for NL parsing + diagnosis.
 */

import { execSync } from 'child_process';
import type { TargetId } from './targets.js';

export interface PrereqCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** A failing required check blocks deployment; advisory ones are warnings. */
  readonly required: boolean;
}

/** True if `cmd` is on PATH. */
function has(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Run a read-only command; return its trimmed stdout or null on failure. */
function read(cmd: string): string | null {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).toString().trim();
  } catch {
    return null;
  }
}

function dockerRunning(): boolean {
  return has('docker') && read('docker info --format "{{.ServerVersion}}"') !== null;
}

function awsIdentity(): string | null {
  if (!has('aws')) return null;
  return read('aws sts get-caller-identity --query Account --output text');
}

/**
 * Run the read-only prerequisite checks for a target. Pure inspection — safe to
 * run unconditionally (Phase-1 advisor calls this before assembling the command).
 */
export function checkPrereqs(target: TargetId): PrereqCheck[] {
  const checks: PrereqCheck[] = [];

  if (target === 'local') {
    checks.push({
      name: 'Docker',
      ok: dockerRunning(),
      detail: dockerRunning() ? 'daemon reachable' : 'install Docker and start the daemon',
      required: true,
    });
    return checks;
  }

  if (target === 'minikube') {
    checks.push({ name: 'Docker', ok: dockerRunning(), detail: dockerRunning() ? 'daemon reachable' : 'install Docker and start the daemon', required: true });
    checks.push({ name: 'minikube', ok: has('minikube'), detail: has('minikube') ? 'on PATH' : 'install minikube', required: true });
    checks.push({ name: 'kubectl', ok: has('kubectl'), detail: has('kubectl') ? 'on PATH' : 'install kubectl', required: true });
    return checks;
  }

  // ec2 + fargate — both need the AWS CLI with working credentials.
  const account = awsIdentity();
  checks.push({ name: 'AWS CLI', ok: has('aws'), detail: has('aws') ? 'on PATH' : 'install the AWS CLI v2', required: true });
  checks.push({
    name: 'AWS credentials',
    ok: account !== null,
    detail: account ? `authenticated (account ${account})` : 'run `aws configure` / set AWS_PROFILE',
    required: true,
  });
  return checks;
}

/** True when every REQUIRED prerequisite passed. */
export function prereqsSatisfied(checks: readonly PrereqCheck[]): boolean {
  return checks.every((c) => c.ok || !c.required);
}
