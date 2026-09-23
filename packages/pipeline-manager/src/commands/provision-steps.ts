// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, existsSync } from 'fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { diagnoseFailure, isAiConfigured, type AiOptions } from '../agent/ai.js';
import { bootstrapCommand, type BootstrapSpec } from '../agent/bootstrap.js';
import { createEnvFile, envFileMissing } from '../agent/env-file.js';
import { entrypointExists, runScript } from '../agent/executor.js';
import { waitHealthy, ensureMinikubeGateway } from '../agent/health.js';
import { checkHostPorts, discoverHostPorts, stackRunning } from '../agent/ports.js';
import { resolvePostSteps, type PostStep, type SkippedStep } from '../agent/post-steps.js';
import { checkPrereqs, gitAvailable, prereqsSatisfied, type PrereqCheck } from '../agent/prereqs.js';
import {
  assembleCommand,
  LOAD_STEPS,
  sparsePathsFor,
  teardownCommand,
  type AssembleResult,
  type TargetId,
  type TargetSpec,
} from '../agent/targets.js';
import { TOOLS_DIR, fetchTool, isFetchable } from '../agent/tools.js';
import { matchIssues } from '../agent/troubleshoot.js';
import { shellQuote } from '../config/cli.constants.js';
import { printSection, printKeyValue, printInfo, printWarning, printError, printSuccess } from '../utils/output-utils.js';

/**
 * The `provision` command's STEPS: one exported function per phase of a
 * provision run (port pre-flight, teardown, bootstrap+locate, the deploy
 * retry loop, the interactive load picker, post-steps, health, diagnose,
 * plan printing).
 *
 * Split out from `provision.ts` so that file holds only what it is about — the
 * ~40-option table and the sequencing narrative that calls these in order. The
 * steps are the part with behaviour worth testing on its own, and the repo
 * already calls them that (`test/provision-seams.test.ts`).
 *
 * Each step takes what it needs and returns what the next one needs: no
 * module-level mutable state crosses this boundary, so the two halves can be
 * read independently.
 */

/**
 * Post-deploy initialization mode (the single `--init <mode>` flag):
 *   - `auto`   — init-platform runs once the platform is up (register admin + load plugins/
 *                compliance/samples). On ec2 the instance does it itself on first boot; on
 *                local/minikube/eks `provision` runs it for you. This is the DEFAULT.
 *   - `manual` — don't self-init; surface the exact step for you to run yourself.
 *   - `skip`   — don't initialize at all (no register, no loads).
 */
export type InitMode = 'auto' | 'manual' | 'skip';
export const INIT_MODES: readonly InitMode[] = ['auto', 'manual', 'skip'];

/**
 * Resolve the init mode from `--init <mode>`, defaulting to `auto` when the flag is absent.
 * Returns `null` when `--init` was given an invalid value (caller errors).
 */
export function resolveInitMode(options: { init?: unknown }): InitMode | null {
  if (typeof options.init === 'string') { // --init <mode>
    const m = options.init.toLowerCase() as InitMode;
    return INIT_MODES.includes(m) ? m : null;
  }
  return 'auto'; // default
}

/**
 * Read one line of trimmed input from the terminal, owning the readline
 * lifecycle. Used directly for the destructive teardown gate (a y/N is too easy
 * to fat-finger, so we require the operator to TYPE the target id back), and as
 * the basis for `confirm`. Deliberately has no auto-accept.
 */
async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Interactive y/N confirmation; auto-true when `autoYes` (the `--yes` flag). */
export async function confirm(question: string, autoYes: boolean): Promise<boolean> {
  if (autoYes) return true;
  const answer = (await ask(`${question} [y/N] `)).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

/**
 * Host-port pre-flight (local/minikube). Ports are DERIVED from the target's cloned
 * deploy source (compose / setup.sh) so the list can't drift — hence this runs AFTER
 * the clone. A taken port makes a container/forward fail to bind mid-deploy (for the
 * gateway, a silent unreachable hang). Prints a ✓/✗ summary and returns false ONLY
 * when the caller must ABORT (a fatal local conflict). minikube ports are managed
 * forwards (setup.sh pkills/restarts them), so a conflict there warns but proceeds.
 * Remote targets (ec2/eks) bind nothing locally → returns true.
 */
export async function preflightPorts(spec: TargetSpec, target: TargetId, cwd: string): Promise<boolean> {
  const ports = discoverHostPorts(target, cwd, spec);
  if (ports.length === 0) return true;
  const portChecks = await checkHostPorts(ports);
  const taken = portChecks.filter((c) => !c.available);
  printSection('Port availability');
  for (const c of portChecks) printInfo(`${c.available ? '✓' : '✗'} ${String(c.port).padEnd(5)} — ${c.service}`);
  if (taken.length === 0) return true;
  // local PUBLISHES these ports at `docker compose up` time, so a conflict is fatal.
  // minikube's are kubectl port-forwards setup.sh pkills + restarts (and
  // ensureMinikubeGateway recovers), so a stale forward must NOT block a re-run.
  const fatal = target === 'docker';
  // …UNLESS the local stack is already running: those ports are held by YOUR OWN
  // stack, and `docker compose up` no-ops them — this is exactly how you re-run to
  // add loads/options. Don't block (the would-be conflict is a self-conflict).
  if (fatal && stackRunning(target, cwd, spec)) {
    printWarning(`\n${taken.length} port(s) are held by your already-running ${spec.label} stack — re-running just resumes it (no real conflict), so continuing.`);
    return true;
  }
  const lead = `${taken.length} required port(s) already in use: ${taken.map((c) => c.port).join(', ')}`;
  (fatal ? printError : printWarning)(fatal
    ? `\n${lead} — the deploy can't bind them and would fail mid-way. Free them and re-run:`
    : `\n${lead} — on minikube these are usually a previous run's port-forwards (setup.sh restarts them). Free any NON-minikube holder if the gateway stays unreachable:`);
  for (const c of taken) printInfo(`  • port ${c.port} (${c.service}) — find the holder:  lsof -i :${c.port}`);
  if (taken.some((c) => c.port === 5000)) {
    printInfo('  Note: on macOS, port 5000 is usually AirPlay Receiver — System Settings → General → AirDrop & Handoff → AirPlay Receiver (off).');
  }
  return !fatal;
}

/**
 * Teardown mode — the destroy counterpart of provisioning, gated HARDER than deploy:
 * AWS targets are irreversible, so the operator must TYPE the target id (--force
 * bypasses for CI; --yes alone does NOT). Terminal: owns its output + exitCode.
 */
export async function runTeardown(
  spec: TargetSpec,
  target: TargetId,
  cwd: string,
  executionId: string,
  opts: { stackName?: string; clusterName?: string; region?: string; domain?: string; hostedZoneId?: string; force?: boolean; yes?: boolean; json?: boolean },
): Promise<void> {
  const { command: downCommand, destructive } = teardownCommand(target, {
    stackName: opts.stackName,
    clusterName: opts.clusterName,
    region: opts.region,
    // eks teardown (bin/shutdown.sh) also cleans up the ACM cert + Route 53 alias for
    // the domain, so forward them when present.
    domain: opts.domain,
    hostedZoneId: opts.hostedZoneId,
    // Our typed gate IS the confirmation — assumeYes forwards a native `--yes` to any
    // script-based teardown (ec2 delete-stack has no prompt; eks shutdown.sh skips its own).
    assumeYes: true,
  });
  if (opts.json) {
    console.log(JSON.stringify({ success: true, executionId, target, teardown: true, destructive, destroys: spec.destroys, command: downCommand }, null, 2));
    return;
  }
  printSection(`Teardown plan — ${spec.label}`);
  printKeyValue({ 'Target': target, 'Destroys': spec.destroys, 'Stops cost': spec.cost });
  printSection('Command to run');
  printInfo(downCommand);
  if (destructive && !opts.force) {
    // Bind the confirmation to the resource actually destroyed: a custom name (ec2
    // --stack-name / eks --cluster-name) must be typed verbatim so a wrong name can't be
    // confirmed by habit; otherwise the target id.
    const resourceName = target === 'eks' ? opts.clusterName : opts.stackName;
    const confirmToken = resourceName ?? target;
    const noun = target === 'eks' ? (opts.clusterName ? 'cluster name' : 'target id') : (opts.stackName ? 'stack name' : 'target id');
    const token = await ask(`\nThis is IRREVERSIBLE. Type "${confirmToken}" to confirm teardown: `);
    if (token !== confirmToken) {
      printWarning(`That didn't match, so nothing was destroyed — you have to type the exact ${noun} to confirm.`);
      return;
    }
  } else if (!destructive && !opts.force && !(await confirm('\nProceed with teardown (stops the stack; on-disk data persists)?', opts.yes ?? false))) {
    printWarning('No problem — nothing was changed.');
    return;
  }
  printSection('Tearing down');
  const { code: downCode } = await runScript(downCommand, cwd, { capture: false });
  if (downCode !== 0) {
    printError(`\nTeardown failed (exit ${downCode}). Inspect the stack/containers and retry.`);
    process.exitCode = 1;
    return;
  }
  printSuccess('Teardown complete.');
}

/**
 * Run the deploy command (real, secrets unmasked, streamed + captured) with a
 * bounded auto-fix + retry loop — the deploy scripts are idempotent, so a fixed
 * re-run resumes rather than starting over. Returns whether it succeeded plus the
 * (possibly fix-adjusted) params, which the caller needs for SES guidance.
 */
export async function runDeployWithRetry(
  spec: TargetSpec,
  url: string | null,
  cwd: string,
  params: Record<string, unknown>,
  aiOpts: { provider?: string; model?: string },
  opts: { retries?: string; yes?: boolean },
): Promise<{ succeeded: boolean; runParams: Record<string, unknown> }> {
  // Bound retries so an unattended `--yes` run can't auto-re-run a 15–30 min
  // deploy an unbounded number of times on a persistently-retryable signature.
  const MAX_RETRIES = 5;
  const requestedRetries = Math.max(0, parseInt(opts.retries ?? '', 10) || 0);
  const maxAttempts = 1 + Math.min(requestedRetries, MAX_RETRIES);
  let runParams: Record<string, unknown> = params;
  let succeeded = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const realCommand = assembleCommand(spec, runParams, { mask: false }).command;
    printSection(attempt === 1 ? 'Deploying' : `Deploying — retry ${attempt - 1}`);
    if (attempt === 1) {
      printInfo(`Deploying ${spec.label} → ${url}`);
      printInfo(spec.deploys);
      printInfo('Streaming the deploy below — first run is the slow one (image pulls + cert generation).');
    }
    const { code, tail } = await runScript(realCommand, cwd, { capture: true });
    if (code === 0) { succeeded = true; break; }

    printError(`\nDeploy failed (exit ${code}).`);
    const issues = matchIssues(tail);
    if (issues.length > 0) {
      printSection('Likely cause');
      for (const i of issues) printInfo(`• ${i.cause}\n  → ${i.suggestion}`);
    }
    if (isAiConfigured(aiOpts)) {
      const diagnosis = await diagnoseFailure(redactSecrets(tail, spec, runParams), aiOpts);
      if (diagnosis) { printSection('Diagnosis'); printInfo(diagnosis); }
    }
    if (attempt >= maxAttempts) break;

    // Auto-fix: a retryable issue with a param we haven't already applied.
    const fix = issues.find((i) => i.retryable && i.paramFix && runParams[i.paramFix.key] !== i.paramFix.value);
    if (fix?.paramFix && await confirm(`\nApply fix and retry — ${fix.suggestion}`, opts.yes ?? false)) {
      runParams = { ...runParams, [fix.paramFix.key]: fix.paramFix.value };
      continue;
    }
    // Retryable but no param change (e.g. ACM DNS propagation) — offer a plain re-run.
    if (!fix && issues.some((i) => i.retryable) && await confirm('\nRetry the deploy (safe to re-run — it resumes where it left off)?', opts.yes ?? false)) {
      continue;
    }
    break;
  }
  return { succeeded, runParams };
}

/**
 * Execute the post-install steps (register → loads → smoke → events → custom). On
 * EC2/EKS the register step + the events bundle (store-token → setup-events) are
 * SURFACED as ordered manual next-steps instead of auto-run: ec2 register must run
 * ON the box (the minikube user owns the cluster), and the events bundle needs a
 * registered platform + AWS creds. (eks register itself port-forwards, so it runs
 * from anywhere with kubectl access.) Sets exitCode on a step failure.
 */
export async function runPostSteps(
  postSteps: PostStep[],
  skippedSteps: SkippedStep[],
  target: TargetId,
  cwd: string,
  adminEnv: Record<string, string>,
  opts: { yes?: boolean; autoRun?: boolean; autoInit?: boolean },
): Promise<void> {
  // AWS targets with `--init auto`: the deploy self-runs init-platform, so there's no
  // register/loads step to surface here — confirm it and point at where to watch.
  if (opts.autoInit && target === 'ec2') {
    printInfo('\n✓ Init mode: auto — the instance runs init-platform itself on first boot');
    printInfo('  (register admin + build bootstrap image + load plugins/compliance/samples).');
    printInfo('  It takes ~30-60 min; watch progress:');
    printInfo('    aws ssm start-session --target <InstanceId>   # InstanceId stack output');
    printInfo('    sudo tail -f /var/log/user-data.log');
  } else if (opts.autoInit && target === 'eks') {
    printInfo('\n✓ Init mode: auto — setup.sh runs init-platform in its final phase');
    printInfo('  (register admin + build bootstrap image + load plugins/compliance/samples,');
    printInfo('  over a kubectl port-forward). Pass --init manual to run it yourself instead.');
  }
  if (postSteps.length === 0) return;
  for (const s of skippedSteps) printWarning(`Skipped post-step ${s.id}: ${s.reason}`);
  const isRemote = (id: string): boolean =>
    (target === 'ec2' || target === 'eks') && (id === 'register' || id.startsWith('store-token') || id === 'events');
  const runnable = postSteps.filter((s) => !isRemote(s.id));
  const remote = postSteps.filter((s) => isRemote(s.id));
  if (remote.length > 0) {
    if (target === 'ec2') {
      // EC2 runs the platform as a dedicated `minikube` user inside the instance: the
      // cluster, its kubeconfig, and the jwt-secret all belong to that user, and the
      // register step builds+pushes images against it. So it MUST run on the box as
      // `minikube` — print the exact landing sequence rather than a bare command.
      printInfo('\nNext — finish setup ON the instance (it builds images + reads the cluster, so it');
      printInfo('cannot run from here). Land on the box, become the `minikube` user, then run it:');
      printInfo('  aws ssm start-session --target <InstanceId>      # InstanceId stack output');
      printInfo('  sudo -iu minikube                                # owns the cluster + docker');
      printInfo('  cd /opt/pipeline/pipeline-builder                # the deployed checkout');
      for (const s of remote) printInfo(`  ${s.command}`);
    } else {
      // eks: init-platform port-forwards to svc/nginx, so register runs from anywhere with
      // kubectl access — no in-VPC requirement and no waiting on the ALB/DNS. (A --with-events
      // bundle, if present, additionally needs AWS creds + a registered platform.)
      printInfo('\nNext — run with kubectl access to the cluster (in this order):');
      for (const s of remote) printInfo(`  • ${s.label} — ${s.command}`);
    }
  }
  if (runnable.length === 0) return;
  // When the loads were picked interactively (autoRun), the user already opted in — skip
  // the redundant second confirm. Flag-driven / non-interactive runs still gate here.
  if (opts.autoRun || await confirm(`\nRun ${runnable.length} post-install step(s) now?`, opts.yes ?? false)) {
    if (opts.autoRun) printInfo(`\nRunning the ${runnable.length} post-install step(s) you selected…`);
    for (const s of runnable) {
      printSection(`Post-step: ${s.label}`);
      // register (local/minikube) logs into the platform, so it needs the admin creds
      // (PLATFORM_IDENTIFIER / PLATFORM_PASSWORD) on top of its step env.
      const needsCreds = s.id === 'register' || s.id.startsWith('store-token');
      const env = needsCreds ? { ...s.env, ...adminEnv } : s.env;
      // Loads/smoke are noisy + non-interactive → run QUIET (capture, show only on
      // failure). Exception: a register with no admin creds prompts, so it must stream.
      const interactiveRegister = s.id === 'register' && !adminEnv.PLATFORM_IDENTIFIER;
      const quiet = !interactiveRegister;
      if (quiet) printInfo(`${s.command}\n  …running (output shown only if it fails)`);
      else printInfo(s.command);
      const { code, tail } = await runScript(s.command, cwd, { quiet, capture: false, env });
      if (code !== 0) {
        if (quiet && tail) { printError('\n--- last output ---'); printInfo(tail); }
        printError(`\nPost-step '${s.id}' failed (exit ${code}). The platform is deployed; fix and re-run the step manually.`);
        process.exitCode = 1;
        break;
      }
      printSuccess(`${s.id} ✓`);
    }
  } else {
    printInfo('\nSkipped post-install steps. Run the commands above manually when ready.');
  }
}

/**
 * Sparse-clone the platform repo (when --repo, or accepted via the interactive
 * offer), repoint cwd into it, and verify the deploy entrypoint exists. Owns the
 * cwd/bootstrapped state. Sets exitCode on a hard failure (clone error / missing
 * entrypoint); a plain decline leaves exitCode
 * untouched. Returns ok:false when the caller must abort.
 */
export async function bootstrapAndLocate(
  spec: TargetSpec,
  bootstrap: BootstrapSpec,
  bootstrapCmd: string | null,
  sparsePaths: readonly string[],
  startCwd: string,
  opts: { yes?: boolean },
): Promise<{ cwd: string; bootstrapped: boolean; ok: boolean }> {
  let cwd = startCwd;
  let bootstrapped = false;
  // Shared by `--repo` and the interactive offer. Repoints cwd + sets bootstrapped;
  // `bootstrapped` records whether we created the clone (vs. an existing checkout) —
  // only then can the caller additively sparse-fetch load folders.
  const bootstrapClone = async (): Promise<boolean> => {
    const cmd = bootstrapCommand(bootstrap);
    printSection('Bootstrap');
    printInfo(cmd);
    const { code } = await runScript(cmd, cwd, { capture: false });
    if (code !== 0) {
      printError(`\nThe clone didn't finish (exit ${code}). Double-check the repo URL / ref (or your network) and give it another go.`);
      process.exitCode = 1;
      return false;
    }
    cwd = path.resolve(cwd, bootstrap.workdir);
    bootstrapped = true;
    printSuccess(`Repo is ready — continuing from ${cwd}`);
    const absent = sparsePaths.filter((p) => !existsSync(path.join(cwd, p)));
    if (absent.length > 0) {
      printError(`\nThe sparse clone is missing ${absent.join(', ')} — that ref may not have those folders. Try a different --ref.`);
      process.exitCode = 1;
      return false;
    }
    return true;
  };

  // `--repo`: clone up front (must precede the entrypoint check).
  if (bootstrapCmd) {
    printInfo(`\nBootstrap → clone ${bootstrap.repo} @ ${bootstrap.ref} into ${bootstrap.workdir} (sparse).`);
    if (!(await confirm('Go ahead with the clone?', opts.yes ?? false))) {
      printWarning('No problem — nothing was changed. Re-run whenever you\'re ready.');
      return { cwd, bootstrapped, ok: false };
    }
    if (!(await bootstrapClone())) return { cwd, bootstrapped, ok: false };
  }

  // The deploy entrypoint must exist relative to cwd. If it doesn't and we haven't
  // bootstrapped, gracefully OFFER to clone (interactive only) so a fresh machine can
  // proceed without re-running with --repo.
  if (!entrypointExists(spec, cwd)) {
    const interactive = Boolean(process.stdin.isTTY) && !opts.yes;
    if (!bootstrapCmd && interactive && gitAvailable()) {
      printInfo(`\nLooks like you're not inside a pipeline-builder checkout, so the ${spec.label} deploy scripts aren't here yet.`);
      if (await confirm(`Want me to sparse-clone them into ${bootstrap.workdir} and keep going?`, false)) {
        if (!(await bootstrapClone())) return { cwd, bootstrapped, ok: false };
      }
    }
    if (!entrypointExists(spec, cwd)) {
      printWarning(`\nI couldn't find ${spec.dir}/${spec.entrypoint} from ${cwd}.`);
      printInfo('Two easy ways forward:');
      printInfo('  • cd into your pipeline-builder checkout and re-run, or');
      printInfo(`  • add --repo and I'll bootstrap a fresh sparse clone for you${gitAvailable() ? '.' : ' (once git is installed).'}`);
      process.exitCode = 1;
      return { cwd, bootstrapped, ok: false };
    }
  }
  return { cwd, bootstrapped, ok: true };
}

/**
 * Interactive opt-in loads, offered AFTER the clone (so we only ask once the operator
 * has agreed to proceed). Prompts per load, additively sparse-fetches the picked
 * folders into a bootstrapped sparse clone, then re-resolves the post-install steps
 * with the selections. Returns the chosen ids + the recomputed steps.
 */
export async function resolveLoadsInteractively(
  target: TargetId,
  url: string | null,
  region: string | undefined,
  cwd: string,
  bootstrapped: boolean,
  bootstrap: BootstrapSpec,
  postStepFlags: { init: boolean; autoInit: boolean; buildBootstrap: boolean; smokeTest: boolean; events: boolean; steps: string[] },
): Promise<{ enabledLoadIds: string[]; steps: PostStep[]; skipped: SkippedStep[] }> {
  const prompts: Record<string, string> = {
    plugins: 'Load plugins?',
    samples: 'Load sample pipeline templates?',
    compliance: 'Load compliance rules?',
  };
  printSection('Optional post-install loads');
  const chosen: string[] = [];
  for (const s of LOAD_STEPS) {
    if (await confirm(prompts[s.id] ?? `Load ${s.id}?`, false)) chosen.push(s.id);
  }
  // Additive sparse re-sync: materialize ONLY the picked loads' folders (the partial
  // clone fetches their blobs on demand). Only when we created a SPARSE clone — a
  // normal checkout already has every folder, and the git<2.27 full-clone fallback
  // (bootstrap.full) is non-sparse, where `sparse-checkout add` would switch it to
  // cone mode and PRUNE the already-materialized deploy folders.
  if (bootstrapped && !bootstrap.full) {
    const absent = sparsePathsFor(target, chosen).filter((p) => !existsSync(path.join(cwd, p)));
    if (absent.length > 0) {
      printSection('Fetching selected load folders');
      const addCmd = `git sparse-checkout add ${absent.map((p) => `'${p}'`).join(' ')} && git checkout ${shellQuote(bootstrap.ref)}`;
      printInfo(addCmd);
      const { code } = await runScript(addCmd, cwd, { capture: false });
      if (code !== 0) {
        printWarning(`Couldn't fetch ${absent.join(', ')} — the matching load step(s) may fail. Re-run with --repo to refresh the clone.`);
      }
    }
  }
  const resolved = resolvePostSteps({
    target,
    url,
    region,
    enabledLoadIds: chosen,
    ...postStepFlags,
    buildBootstrap: postStepFlags.buildBootstrap || chosen.includes('plugins'),
  });
  return { enabledLoadIds: chosen, steps: resolved.steps, skipped: resolved.skipped };
}

/**
 * Redact secret param values (e.g. the ghcr token) from captured deploy output
 * before it is sent to the LLM for diagnosis. The deploy runs with secrets
 * unmasked, so although the current scripts don't echo them, this keeps a future
 * script's stray echo (or a verbose sub-tool) from crossing the third-party-LLM
 * boundary.
 */
function redactSecrets(text: string, spec: TargetSpec, params: Record<string, unknown>): string {
  let out = text;
  for (const input of [...spec.required, ...spec.optional]) {
    if (!input.secret) continue;
    const value = params[input.key];
    if (typeof value === 'string' && value.length >= 4) out = out.split(value).join('***');
  }
  return out;
}

/**
 * Assemble deploy params from explicit flags (flags always win over the NL
 * parse, which only fills gaps).
 */
export function buildParams(options: Record<string, unknown>, selfInit: boolean): Record<string, unknown> {
  return {
    region: options.region,
    domain: options.domain,
    hostedZoneId: options.hostedZoneId,
    deployMode: options.deployMode,
    keyPair: options.keyPair,
    instanceType: options.instanceType,
    // ec2 LEAN mode (boolean) → assembleCommand emits `--lean`, which setup.sh
    // forwards to the CFN `Lean` param. Only ec2's spec lists it; other targets ignore it.
    lean: options.lean === true,
    // Deploy-time resource identity: ec2 emits --stack-name (key stackName), eks emits
    // --cluster-name (key clusterName). Both also drive teardown. Undefined → defaults.
    stackName: options.stackName,
    clusterName: options.clusterName,
    ghcrToken: options.ghcrToken,
    // email/noEmail are coerced AFTER the NL merge below — parseGoal can return
    // `email`, so pre-coercing here (never-undefined) would let the merge's
    // `=== undefined` guard silently drop an AI-parsed email choice. Left out of
    // this literal on purpose; resolved a few lines down.
    emailFrom: options.emailFrom,
    emailFromName: options.emailFromName,
    alertEmail: options.alertEmail,
    noCreateSesIdentity: options.skipSesIdentity,
    // The AWS deploys self-init by default (ec2 on first boot, eks in setup.sh's final
    // phase), so we emit the load-bearing `--no-auto-init` when the mode is NOT auto
    // (manual/skip = "don't let the deploy init itself"). `--auto-init` (a no-op reaffirm)
    // is never emitted. Only ec2/eks carry these flags in their spec; other targets ignore it.
    noAutoInit: !selfInit,
  };
}

/**
 * `--diagnose <file>`: explain a deploy failure with the configured model. A
 * read-only inspection mode — the caller returns afterwards whether or not a
 * target was given, so it never falls through into a (possibly --yes) deploy.
 */
export async function runDiagnose(file: string, json: boolean, aiOpts: AiOptions, executionId: string): Promise<void> {
  let failureText: string;
  try {
    failureText = readFileSync(file, 'utf-8');
  } catch {
    printError(`Cannot read --diagnose file: ${file}`);
    process.exitCode = 1;
    return;
  }
  const diagnosis = isAiConfigured(aiOpts) ? await diagnoseFailure(failureText, aiOpts) : null;
  // With --json, the diagnosis IS the machine-readable output — emit it
  // alone (don't also print text, which would corrupt the JSON stream).
  if (json) {
    console.log(JSON.stringify({ success: true, executionId, diagnosis }, null, 2));
    return;
  }
  if (diagnosis) {
    printSection('Failure diagnosis');
    printInfo(diagnosis);
  } else {
    printWarning('Diagnosis unavailable (no AI key configured or the model could not be reached).');
  }
}

/** Print the provision plan (shown before the gated execution). */
export function printPlan(p: {
  spec: TargetSpec;
  target: TargetId;
  prereqs: PrereqCheck[];
  missing: AssembleResult['missing'];
  bootstrap: BootstrapSpec;
  bootstrapCmd: string | null;
  sparsePaths: string[];
  command: string;
  postSteps: PostStep[];
  skippedSteps: SkippedStep[];
}): void {
  const { spec, target, prereqs, missing, bootstrap, bootstrapCmd, sparsePaths, command, postSteps, skippedSteps } = p;
  printSection(`Provision plan — ${spec.label}`);
  printKeyValue({ 'Target': target, 'Best for': spec.bestFor, 'Cost': spec.cost });

  printSection('Prerequisites');
  for (const c of prereqs) printInfo(`${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}`);
  if (!prereqsSatisfied(prereqs)) printWarning('Resolve the failing prerequisites above before deploying.');

  if (missing.length > 0) {
    printSection('Missing required inputs');
    for (const m of missing) printInfo(`  --${m.flag}  (${m.description})`);
  }

  if (bootstrapCmd) {
    printSection('Bootstrap (sparse git clone, runs first)');
    printInfo(`Clone ${bootstrap.repo} @ ${bootstrap.ref} → ${bootstrap.workdir}; folders: ${sparsePaths.join(', ')}`);
    printInfo(bootstrapCmd);
  }

  printSection('Command to run');
  printInfo(command);

  if (postSteps.length > 0 || skippedSteps.length > 0) {
    printSection('Post-install steps');
    for (const s of postSteps) printInfo(`• ${s.label}\n    ${s.command}`);
    for (const s of skippedSteps) printWarning(`Skipped ${s.id}: ${s.reason}`);
  }
}

/**
 * Plugins were picked interactively: re-check the plugin-specific prereqs that
 * were deliberately not hard-required up front (e.g. yq for minikube plugin
 * builds). Offer to fetch any fetchable one; warn (don't block — the platform
 * still deploys) if it can't be resolved, so the later plugin build doesn't
 * fail opaquely.
 */
export async function recheckPluginPrereqs(target: TargetId, wantBootstrap: boolean, prereqs: PrereqCheck[], yes: boolean): Promise<void> {
  const pluginPrereqs = checkPrereqs(target, { bootstrap: wantBootstrap, withPlugins: true });
  const pluginGaps = pluginPrereqs.filter((c) => !c.ok && c.required && !prereqs.some((p) => p.name === c.name));
  for (const c of pluginGaps) {
    if (isFetchable(c.name) && await confirm(`\n${c.name} is needed to build plugins but isn't installed — fetch the static binary into ${TOOLS_DIR}?`, yes)) {
      printInfo(`Fetching ${c.name}…`);
      if (!fetchTool(c.name)) printWarning(`Couldn't fetch ${c.name} — install it before the plugin build runs.`);
    } else {
      printWarning(`${c.name} missing — the plugin load/build step may fail. ${c.detail}`);
    }
  }
}

/**
 * local/minikube's setup.sh REQUIRES a `.env` and aborts without it — create
 * it from .env.example with generated secrets so the deploy is non-interactive.
 * ec2 and eks don't need a local `.env`: ec2 bootstraps its secrets on the
 * instance, and eks's setup.sh creates the k8s secrets itself.
 */
export async function ensureLocalEnvFile(target: TargetId, spec: TargetSpec, cwd: string, yes: boolean): Promise<void> {
  if ((target !== 'docker' && target !== 'minikube') || !envFileMissing(cwd, spec.dir)) return;
  if (await confirm(`\n${spec.dir}/.env not found — create it from .env.example (generates secrets; edit later for optional integrations like OAuth)?`, yes)) {
    const n = createEnvFile(cwd, spec.dir);
    printSuccess(`Created ${spec.dir}/.env — ${n} secret(s) generated.`);
  } else {
    printWarning('Continuing without .env — setup.sh will abort if it stays missing.');
  }
}

/**
 * Any missing required prereq that's a single static binary (e.g. yq) can be
 * fetched into the tools cache instead of a system install — no brew/apt.
 * Offer it, then re-check (the cache dir is already on PATH). Returns the
 * (possibly refreshed) prereq list.
 */
export async function offerToolFetch(prereqs: PrereqCheck[], yes: boolean, recheck: () => PrereqCheck[]): Promise<PrereqCheck[]> {
  const fetchable = prereqs.filter((c) => !c.ok && c.required && isFetchable(c.name));
  if (fetchable.length === 0) return prereqs;
  const names = fetchable.map((c) => c.name).join(', ');
  if (!(await confirm(`\n${names} not installed — fetch the official static binary into ${TOOLS_DIR} (no system install)?`, yes))) return prereqs;
  for (const c of fetchable) {
    printInfo(`Fetching ${c.name}…`);
    if (!fetchTool(c.name)) printWarning(`Couldn't fetch ${c.name} — install it manually and re-run.`);
  }
  return recheck();
}

/** Verify health after the deploy (CREATE_COMPLETE != serving). */
export async function verifyHealth(target: TargetId, url: string): Promise<void> {
  printSection('Verifying health');
  // Minikube reaches the gateway via a kubectl port-forward that setup.sh
  // backgrounds and that can die/fail to bind — (re)start it before polling
  // so we don't sit at the gate on a dead forward while the pods are fine.
  if (target === 'minikube') {
    await ensureMinikubeGateway(url, { onInfo: (m) => printInfo(m) });
  }
  printInfo(`Polling ${url}/health …`);
  // Fresh EKS legitimately needs longer than the 300s default: Karpenter provisions
  // nodes, ~10 services cold-pull images, the ALB provisions (~2-3 min), and the
  // Route 53 alias propagates. Give it 15 min before surfacing the not-reachable note.
  const healthTimeoutMs = target === 'eks' ? 900_000 : undefined;
  const health = await waitHealthy(url, { timeoutMs: healthTimeoutMs, onTick: (m) => printInfo(m) });
  // Green only when fully ready; a "health OK but /ready never came" proceed-
  // anyway state is healthy:true but degraded → warn so it doesn't read as done.
  (health.healthy && health.ready ? printSuccess : printWarning)(`${health.url} — ${health.detail}`);
}
