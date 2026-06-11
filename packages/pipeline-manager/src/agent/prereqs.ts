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

/** Docker Compose v2 (`docker compose`) or legacy v1 (`docker-compose`) — setup.sh needs one. */
function dockerComposeAvailable(): boolean {
  return read('docker compose version') !== null || has('docker-compose');
}

function awsIdentity(): string | null {
  if (!has('aws')) return null;
  return read('aws sts get-caller-identity --query Account --output text');
}

/** Parsed `git --version` as [major, minor], or null if git is absent/unparseable. */
function gitVersion(): [number, number] | null {
  const out = read('git --version');
  const m = out?.match(/(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** True when git is on PATH (required to bootstrap a clone at all). */
export function gitAvailable(): boolean {
  return gitVersion() !== null;
}

/**
 * Cone `sparse-checkout` (+ `--filter=blob:none`) needs git ≥ 2.27. Below that,
 * the bootstrap falls back to a (correct, just larger) full clone.
 */
export function gitSupportsSparseCheckout(): boolean {
  const v = gitVersion();
  return v !== null && (v[0] > 2 || (v[0] === 2 && v[1] >= 27));
}

/**
 * Build a PrereqCheck from a SINGLE presence evaluation. Collapses the repeated
 * `{ ok: probe(), detail: probe() ? a : b }` shape — which also called the probe
 * twice — into one place; the caller evaluates the probe once and passes the result.
 */
function check(name: string, present: boolean, presentDetail: string, missingDetail: string, required = true): PrereqCheck {
  return { name, ok: present, detail: present ? presentDetail : missingDetail, required };
}

/**
 * Run the read-only prerequisite checks for a target. Pure inspection — safe to
 * run unconditionally (the plan assembles this before the gated execution).
 */
export function checkPrereqs(target: TargetId, opts: { bootstrap?: boolean; withPlugins?: boolean } = {}): PrereqCheck[] {
  const checks: PrereqCheck[] = [];
  // setup.sh (local) + setup.sh (minikube) both generate the TLS cert + registry JWT key with openssl.
  const OPENSSL_TLS = 'install openssl — setup.sh generates the TLS cert + registry JWT key with it';

  // `--repo` bootstrap git-clones the platform repo first → git is required. A
  // git below 2.27 still works (full-clone fallback), so the version is advisory.
  if (opts.bootstrap) {
    const v = gitVersion();
    checks.push({ name: 'git', ok: v !== null, detail: v ? `on PATH (${v[0]}.${v[1]})` : 'install git', required: true });
    if (v !== null && !gitSupportsSparseCheckout()) {
      checks.push({ name: 'git ≥ 2.27', ok: false, detail: 'sparse clone needs git ≥ 2.27 — falling back to a full clone', required: false });
    }
  }

  if (target === 'local') {
    // deploy/local/bin/setup.sh hard-checks all of these at startup and aborts if
    // any is missing — mirror them here so provision blocks up front instead of
    // failing mid-deploy (e.g. the classic "yq is not installed").
    checks.push(check('Docker', dockerRunning(), 'daemon reachable', 'install Docker and start the daemon'));
    checks.push(check('Docker Compose', dockerComposeAvailable(), 'available', 'needs `docker compose` (v2 plugin) or `docker-compose` (v1)'));
    checks.push(check('yq', has('yq'), 'on PATH', 'install yq (macOS: `brew install yq`) — setup.sh requires it'));
    checks.push(check('openssl', has('openssl'), 'on PATH', OPENSSL_TLS));
    return checks;
  }

  if (target === 'minikube') {
    checks.push(check('Docker', dockerRunning(), 'daemon reachable', 'install Docker and start the daemon'));
    checks.push(check('minikube', has('minikube'), 'on PATH', 'install minikube'));
    checks.push(check('kubectl', has('kubectl'), 'on PATH', 'install kubectl'));
    checks.push(check('openssl', has('openssl'), 'on PATH', OPENSSL_TLS));
    // minikube's setup.sh doesn't need yq, but --with-plugins builds images
    // (build-plugin-images.sh / generate-plugins.sh) which do.
    if (opts.withPlugins) {
      checks.push(check('yq', has('yq'), 'on PATH', 'install yq (macOS: `brew install yq`) — required to build plugins'));
    }
    return checks;
  }

  // ec2 + fargate — both deploy via `aws cloudformation deploy`, so both need
  // the AWS CLI with working credentials (and nothing CDK/node-related). ec2's
  // instance self-bootstraps over UserData, so the CLI is its only host tool.
  const account = awsIdentity();
  checks.push(check('AWS CLI', has('aws'), 'on PATH', 'install the AWS CLI v2'));
  checks.push({ name: 'AWS credentials', ok: account !== null, detail: account ? `authenticated (account ${account})` : 'run `aws configure` / set AWS_PROFILE', required: true });
  // fargate runs init-secrets.sh on the host to generate the platform secrets
  // (JWT/refresh secrets, DB passwords, the registry's RSA signing key) with
  // openssl before the first deploy. ec2 bootstraps its secrets on the instance.
  if (target === 'fargate') {
    checks.push(check('openssl', has('openssl'), 'on PATH', 'install openssl — init-secrets.sh needs it to generate platform secrets'));
  }
  return checks;
}

/** True when every REQUIRED prerequisite passed. */
export function prereqsSatisfied(checks: readonly PrereqCheck[]): boolean {
  return checks.every((c) => c.ok || !c.required);
}
