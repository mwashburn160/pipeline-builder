// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, existsSync } from 'fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { Command } from 'commander';
import { diagnoseFailure, isAiConfigured, parseGoal } from '../agent/ai.js';
import { bootstrapCommand, resolveBootstrap, type BootstrapSpec } from '../agent/bootstrap.js';
import { createEnvFile, envFileMissing } from '../agent/env-file.js';
import { entrypointExists, executionBlocked, runScript } from '../agent/executor.js';
import { deriveHealthUrl, waitHealthy, ensureMinikubeGateway } from '../agent/health.js';
import { checkHostPorts, discoverHostPorts, stackRunning } from '../agent/ports.js';
import { resolvePostSteps, type PostStep, type SkippedStep } from '../agent/post-steps.js';
import { checkPrereqs, gitAvailable, gitSupportsSparseCheckout, prereqsSatisfied } from '../agent/prereqs.js';
import {
  assembleCommand,
  isTargetId,
  LOAD_STEPS,
  sparsePathsFor,
  TARGETS,
  TARGET_IDS,
  teardownCommand,
  type TargetId,
  type TargetSpec,
} from '../agent/targets.js';
import { TOOLS_DIR, fetchTool, isFetchable, withToolsOnPath } from '../agent/tools.js';
import { matchIssues, sesPostDeployGuidance } from '../agent/troubleshoot.js';
import { printCommandHeader } from '../utils/command-utils.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { printSection, printKeyValue, printInfo, printWarning, printError, printSuccess } from '../utils/output-utils.js';

/**
 * Post-deploy initialization mode (the single `--init <mode>` flag):
 *   - `auto`   — the deploy self-runs init-platform once the platform is up (register admin
 *                + load plugins/compliance/samples). On ec2/fargate this happens on the
 *                deploy side (ec2: first boot; fargate: the 07-init ECS task); on local/
 *                minikube `provision` runs it for you. This is the DEFAULT.
 *   - `manual` — don't self-init; surface the exact step for you to run yourself.
 *   - `skip`   — don't initialize at all (no register, no loads).
 */
export type InitMode = 'auto' | 'manual' | 'skip';
const INIT_MODES: readonly InitMode[] = ['auto', 'manual', 'skip'];

/**
 * Resolve the init mode from the new `--init <mode>` flag, falling back to the DEPRECATED
 * aliases (`--no-init` → skip, `--auto-init` → auto, `--no-auto-init` → manual), then the
 * default (`auto`). Returns `null` when `--init` was given an invalid value (caller errors).
 */
export function resolveInitMode(options: { init?: unknown; autoInit?: unknown }): InitMode | null {
  if (typeof options.init === 'string') {                      // --init <mode>
    const m = options.init.toLowerCase() as InitMode;
    return INIT_MODES.includes(m) ? m : null;
  }
  if (options.init === false) return 'skip';                   // deprecated --no-init
  if (options.autoInit === true) return 'auto';                // deprecated --auto-init
  if (options.autoInit === false) return 'manual';             // deprecated --no-auto-init
  return 'auto';                                               // default
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
async function confirm(question: string, autoYes: boolean): Promise<boolean> {
  if (autoYes) return true;
  const answer = (await ask(`${question} [y/N] `)).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

/** Commander collector: accumulate repeated `--post-step` values in order. */
function collectStep(value: string, acc: string[]): string[] {
  return [...acc, value];
}

/**
 * Host-port pre-flight (local/minikube). Ports are DERIVED from the target's cloned
 * deploy source (compose / setup.sh) so the list can't drift — hence this runs AFTER
 * the clone. A taken port makes a container/forward fail to bind mid-deploy (for the
 * gateway, a silent unreachable hang). Prints a ✓/✗ summary and returns false ONLY
 * when the caller must ABORT (a fatal local conflict). minikube ports are managed
 * forwards (setup.sh pkills/restarts them), so a conflict there warns but proceeds.
 * Remote targets (ec2/fargate) bind nothing locally → returns true.
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
  const fatal = target === 'local';
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
  opts: { stackName?: string; region?: string; force?: boolean; yes?: boolean; json?: boolean },
): Promise<void> {
  const { command: downCommand, destructive } = teardownCommand(target, {
    stackName: opts.stackName,
    region: opts.region,
    // Our typed gate IS the confirmation — forward --yes so the native script
    // (Fargate) doesn't also block on stdin we're inheriting.
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
    // Bind the confirmation to the resource actually destroyed: a custom --stack-name must
    // be typed verbatim (so a wrong name can't be confirmed by habit); otherwise the target id.
    const confirmToken = opts.stackName ?? target;
    const noun = opts.stackName ? 'stack name' : 'target id';
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
  const maxAttempts = 1 + Math.max(0, parseInt(opts.retries ?? '', 10) || 0);
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
 * EC2/Fargate, register + the events bundle (store-token → setup-events) need a
 * reachable, REGISTERED platform that's only true inside the VPC, so those are
 * SURFACED as ordered manual next-steps instead of auto-run (they'd fail locally).
 * Sets exitCode on a step failure; the platform is already deployed by this point.
 */
export async function runPostSteps(
  postSteps: PostStep[],
  skippedSteps: SkippedStep[],
  target: TargetId,
  cwd: string,
  adminEnv: Record<string, string>,
  opts: { yes?: boolean; autoRun?: boolean; autoInit?: boolean },
): Promise<void> {
  // AWS --auto-init: the deploy self-runs init-platform once the platform is up, so there's
  // no register/loads step to surface here — confirm it and point at the right log.
  if (opts.autoInit && target === 'ec2') {
    printInfo('\n✓ Auto-init enabled — the instance runs init-platform itself on first boot');
    printInfo('  (register admin + build bootstrap image + load plugins/compliance/samples).');
    printInfo('  It takes ~30-60 min; watch progress:');
    printInfo('    aws ssm start-session --target <InstanceId>   # InstanceId stack output');
    printInfo('    sudo tail -f /var/log/user-data.log');
  } else if (opts.autoInit && target === 'fargate') {
    printInfo('\n✓ Auto-init enabled — a one-shot ECS task (07-init) runs init-platform once the');
    printInfo('  platform is up (register admin + build base images + load plugins/compliance/samples).');
    printInfo('  It takes ~30-60 min; watch progress:');
    printInfo('    aws logs tail /ecs/<StackPrefix>-init --follow   # StackPrefix from the init stack');
  }
  if (postSteps.length === 0) return;
  for (const s of skippedSteps) printWarning(`Skipped post-step ${s.id}: ${s.reason}`);
  const isRemote = (id: string): boolean =>
    (target === 'ec2' || target === 'fargate') && (id === 'register' || id === 'store-token' || id === 'events');
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
      printInfo('\nNext (run from inside the VPC, in this order):');
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
      const needsCreds = s.id === 'register' || s.id === 'store-token';
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
 * entrypoint), matching the old inline behavior; a plain decline leaves exitCode
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
    samples: 'Load sample pipelines?',
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
      const addCmd = `git sparse-checkout add ${absent.map((p) => `'${p}'`).join(' ')} && git checkout '${bootstrap.ref}'`;
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
 * Registers the `provision` command — an AI-assisted installer for the Pipeline
 * Builder PLATFORM (local/minikube/EC2/Fargate). It prints the assembled plan
 * (prereq checks, NL-goal parsing, command assembly) and then DEPLOYS, gated by
 * confirmation prompts (`--yes` to auto-accept; `--json` is the only non-executing
 * mode, printing the plan for tooling). With `--repo` it can bootstrap a fresh
 * machine by sparsely cloning only the deploy folders the selected target +
 * options need, then runs post-install steps (register admin, opt-in loads,
 * smoke test, custom commands). `--teardown` removes a deployment instead.
 *
 * @param program - The root Commander program instance to attach the command to.
 */
export function provision(program: Command): void {
  program
    .command('provision')
    .description('AI-assisted installer for the platform (local/minikube/EC2/Fargate): deploys it (gated by confirmation prompts), or --teardown to remove')
    .option('-t, --target <target>', `Deploy target: ${TARGET_IDS.join(' | ')}`)
    .option('-p, --prompt <text>', 'Natural-language goal (parsed into params when an AI key is set)')
    .option('--region <region>', 'AWS region (EC2/Fargate)')
    .option('--domain <domain>', 'Fully-qualified domain name (EC2/Fargate)')
    .option('--hosted-zone-id <id>', 'Public Route 53 hosted zone ID (EC2/Fargate)')
    .option('--deploy-mode <mode>', 'public | private (EC2/Fargate)')
    .option('--key-pair <name>', 'EC2 key pair (EC2)')
    .option('--instance-type <type>', 'EC2 instance type (EC2)')
    .option('--ghcr-token <token>', 'GitHub PAT (read:packages) — masked in output')
    .option('--email', 'Enable SES transactional email (on by default for AWS)')
    .option('--no-email', 'Skip SES (transactional email is provisioned by default on AWS)')
    .option('--email-from <addr>', 'SES From address')
    .option('--email-from-name <name>', 'SES From display name')
    .option('--alert-email <addr>', 'Subscribe an address to the bounce/complaint SNS topic')
    .option('--skip-ses-identity', 'Skip SES identity creation (domain already verified)')
    .option('--ai-provider <provider>', 'AI provider (anthropic|openai|google|xai|bedrock)')
    .option('--model <model>', 'AI model id')
    .option('--diagnose <file>', 'Diagnose a CloudFormation/deploy failure from a file (needs an AI key)')
    .option('-y, --yes', 'Auto-accept all confirmation prompts (for CI / non-interactive)', false)
    .option('--retries <n>', 'Auto-fix + retry attempts after a failure (deploy scripts are idempotent)', '1')
    .option('--teardown', 'Tear down an existing deployment instead of creating one (gated; AWS targets require a typed confirmation)', false)
    .option('--stack-name <name>', 'Stack name (EC2) / stack prefix (Fargate) for the deploy AND teardown — defaults to the per-target default (set it to run a second environment)')
    .option('--force', 'Skip the teardown typed-confirmation (DANGEROUS — for CI/automation only)', false)
    .option('--init <mode>', 'Post-deploy initialization: auto (DEFAULT — register admin + load plugins/compliance/samples; on ec2/fargate the deploy does it itself: ec2 on first boot, fargate via a one-shot ECS task), manual (don\'t self-init — surface the step for you to run, e.g. to set real admin creds), or skip (do nothing). local/minikube run init for you unless skip.')
    // Deprecated aliases — kept working for back-compat; --init is the documented form.
    .option('--no-init', '[deprecated] alias for --init skip')
    .option('--auto-init', '[deprecated] alias for --init auto')
    .option('--no-auto-init', '[deprecated] alias for --init manual')
    // Bootstrap (sparse clone) — provision a fresh machine in one command.
    .option('--repo [url]', 'Bootstrap: git-clone the platform repo first (sparse — only the needed deploy folders), then run from it (no value = the upstream default)')
    .option('--ref <ref>', 'Git branch/tag to check out when bootstrapping (default: main)')
    .option('--workdir <dir>', 'Directory to clone into / run from when bootstrapping (default: pipeline-builder)')
    // Post-install loads — each opt-in step also adds its deploy folder to the sparse clone.
    .option('--with-plugins', 'Post-install: build + load plugins (adds deploy/plugins, deploy/codebuild)', false)
    .option('--with-compliance', 'Post-install: load sample compliance rules/policies (adds deploy/compliance)', false)
    .option('--with-samples', 'Post-install: load sample pipelines (adds deploy/samples)', false)
    .option('--with-all', 'Post-install: plugins + compliance + samples', false)
    .option('--build-bootstrap', 'Build + publish the CodeBuild bootstrap image during register (adds deploy/codebuild)', false)
    .option('--with-smoke-test', 'Post-install: read-only API reachability check', false)
    .option('--with-events', 'Post-install (AWS): event ingestion bundle — store-token (JWT → Secrets Manager) then setup-events (EventBridge/Lambda)', false)
    .option('--post-step <cmd>', 'Run an extra command after the loads (repeatable, in order)', collectStep, [])
    .option('--admin-email <addr>', 'Admin email for non-interactive register (sets PLATFORM_IDENTIFIER)')
    .option('--admin-password <pw>', 'Admin password for non-interactive register (sets PLATFORM_PASSWORD)')
    .option('--json', 'Print the plan as JSON and exit WITHOUT running (the only non-executing mode — for tooling/CI inspection)', false)
    .action(async (options) => {
      const executionId = printCommandHeader('Provision');

      try {
        // Resolve the single post-deploy init mode (auto|manual|skip) from --init or its
        // deprecated aliases. Two internal signals derive from it: whether init happens at
        // all, and whether the DEPLOY self-runs it (vs. we surface it).
        const initMode = resolveInitMode(options);
        if (initMode === null) {
          printError(`Invalid --init value '${String(options.init)}'. Use one of: ${INIT_MODES.join(' | ')}.`);
          process.exitCode = 1;
          return;
        }
        const initEnabled = initMode !== 'skip';     // skip → no register/loads at all
        const selfInit = initMode === 'auto';        // auto → the deploy initializes itself

        // 1. Assemble params from explicit flags (flags always win over NL parse).
        const params: Record<string, unknown> = {
          region: options.region,
          domain: options.domain,
          hostedZoneId: options.hostedZoneId,
          deployMode: options.deployMode,
          keyPair: options.keyPair,
          instanceType: options.instanceType,
          // Deploy-time stack identity (ec2 emits --stack-name, fargate --stack-prefix; both
          // read this key). Same option drives teardown. Undefined → each script's default.
          stackName: options.stackName,
          ghcrToken: options.ghcrToken,
          // email/noEmail are coerced AFTER the NL merge below — parseGoal can return
          // `email`, so pre-coercing here (never-undefined) would let the merge's
          // `=== undefined` guard silently drop an AI-parsed email choice. Left out of
          // this literal on purpose; resolved a few lines down.
          emailFrom: options.emailFrom,
          emailFromName: options.emailFromName,
          alertEmail: options.alertEmail,
          noCreateSesIdentity: options.skipSesIdentity,
          // The AWS deploy scripts (ec2/fargate setup.sh) self-init by default, so we only
          // need to emit the load-bearing `--no-auto-init` when the mode is NOT auto (manual
          // or skip both mean "don't let the deploy init itself"). `--auto-init` (a no-op
          // reaffirm) is never emitted. Non-AWS targets ignore these (not in their specs).
          noAutoInit: !selfInit,
        };
        const aiOpts = { provider: options.aiProvider, model: options.model };

        // Bootstrap (sparse clone) + post-install selections.
        const wantBootstrap = options.repo !== undefined && options.repo !== false;
        const withAll = options.withAll === true;
        const anyLoadFlag = withAll || LOAD_STEPS.some((s) => options[s.flag] === true);
        let enabledLoadIds: string[] = LOAD_STEPS.filter((s) => withAll || options[s.flag] === true).map((s) => s.id);
        // With no --with-* flags, an interactive run offers each load — but AFTER the
        // clone, so the questions come once you've agreed to proceed (not up front).
        // Each picked load's folder is then fetched via an additive sparse re-sync.
        // Flags / --yes / --json / non-interactive shells skip the prompts.
        let willPromptLoads = !options.yes && !options.json && Boolean(process.stdin.isTTY) && !anyLoadFlag;
        const postStepFlags = {
          init: initEnabled,
          // selfInit (mode auto) drops the surfaced register step on ec2/fargate in
          // resolvePostSteps, so a self-initializing AWS deploy doesn't also print a manual
          // register step. For manual mode it's false → the step is surfaced.
          autoInit: selfInit,
          buildBootstrap: options.buildBootstrap === true || enabledLoadIds.includes('plugins'),
          smokeTest: options.withSmokeTest === true,
          events: options.withEvents === true,
          steps: (options.postStep ?? []) as string[],
        };
        // Admin credentials forwarded as env so register runs non-interactively.
        const adminEnv: Record<string, string> = {};
        if (typeof options.adminEmail === 'string') adminEnv.PLATFORM_IDENTIFIER = options.adminEmail;
        if (typeof options.adminPassword === 'string') adminEnv.PLATFORM_PASSWORD = options.adminPassword;

        // 2. Optionally parse a natural-language goal to fill any GAPS (best-effort).
        let target: TargetId | undefined = isTargetId(options.target) ? options.target : undefined;
        if (options.prompt) {
          if (isAiConfigured(aiOpts)) {
            const parsed = await parseGoal(options.prompt, aiOpts);
            if (parsed) {
              if (!target && isTargetId(parsed.target)) target = parsed.target;
              for (const [k, v] of Object.entries(parsed)) {
                if (k !== 'target' && params[k] === undefined && v !== undefined) params[k] = v;
              }
            }
          } else if (!options.json) {
            // Don't print human text before a --json plan (it would corrupt the stream).
            printWarning('A --prompt was given but no AI key is set — ignoring it and using flags only. Set ANTHROPIC_API_KEY (or --ai-provider + its key).');
          }
        }

        // Resolve email NOW (after the NL merge): an explicit --email/--no-email flag wins,
        // else an AI-parsed `email` (merged into params.email above) decides, else default-on.
        // Coerce to the two load-bearing keys assembleCommand emits.
        const emailChoice = options.email !== undefined
          ? options.email
          : (typeof params.email === 'boolean' ? params.email : undefined);
        params.email = emailChoice === true;
        params.noEmail = emailChoice === false;

        // 3. Optional failure diagnosis (independent of a deploy plan).
        if (options.diagnose) {
          let failureText: string;
          try {
            failureText = readFileSync(options.diagnose, 'utf-8');
          } catch {
            printError(`Cannot read --diagnose file: ${options.diagnose}`);
            process.exitCode = 1;
            return;
          }
          const diagnosis = isAiConfigured(aiOpts) ? await diagnoseFailure(failureText, aiOpts) : null;
          // With --json, the diagnosis IS the machine-readable output — emit it
          // alone (don't also print text, which would corrupt the JSON stream).
          if (options.json) {
            console.log(JSON.stringify({ success: true, executionId, diagnosis }, null, 2));
            return;
          }
          if (diagnosis) {
            printSection('Failure diagnosis');
            printInfo(diagnosis);
          } else {
            printWarning('Diagnosis unavailable (no AI key configured or the model could not be reached).');
          }
          // --diagnose is a read-only inspection mode: return whether or not a target was
          // given, so it never falls through into a (possibly --yes) deploy.
          return;
        }

        // In `auto` mode the AWS deploy loads plugins/compliance/samples itself (ec2: on the
        // box; fargate: the 07-init task), so the local load picker — and the load-folder
        // fetch it triggers — is pointless. Skip both (the deploy has its own checkout).
        // `--init manual` restores the local loads/prompts.
        if (selfInit && (target === 'ec2' || target === 'fargate')) {
          willPromptLoads = false;
          enabledLoadIds = [];
        }

        // 4. Need a target to assemble a plan.
        if (!target) {
          printError(`No target specified. Pass --target <${TARGET_IDS.join('|')}> or describe the goal with --prompt.`);
          process.exitCode = 1;
          return;
        }

        const spec = TARGETS[target];
        let cwd = process.cwd();

        // 4b. Teardown mode — the destroy counterpart of provisioning (see runTeardown).
        if (options.teardown) {
          await runTeardown(spec, target, cwd, executionId, options);
          return;
        }

        // Make previously-fetched single-binary tools (e.g. yq) visible to the
        // prereq checks + the deploy — they live in the tools cache, not on the
        // system PATH. (Both `has()` and the deploy's `bash -lc` inherit this.)
        withToolsOnPath();
        // Hard-require plugin prereqs (e.g. yq on minikube) only when plugins is EXPLICITLY
        // selected — NOT on the willPromptLoads guess, which would block/prompt before the
        // user has even been asked whether they want plugins. If they pick plugins in the
        // interactive prompt, we re-check + offer to fetch right after that selection (below).
        let prereqs = checkPrereqs(target, { bootstrap: wantBootstrap, withPlugins: enabledLoadIds.includes('plugins') });
        const { command, missing } = assembleCommand(spec, params);
        const url = deriveHealthUrl(target, params);

        // Sparse bootstrap clone command (common base + target + selected loads).
        // Interactive loads are chosen AFTER the clone, so the clone stays minimal —
        // each picked load's folder is fetched then via an additive sparse re-sync.
        const sparsePaths = sparsePathsFor(target, enabledLoadIds);
        const bootstrap = resolveBootstrap(
          { repo: typeof options.repo === 'string' ? options.repo : undefined, ref: options.ref, workdir: options.workdir, full: !gitSupportsSparseCheckout() },
          sparsePaths,
        );
        const bootstrapCmd = wantBootstrap ? bootstrapCommand(bootstrap) : null;

        // Resolve post-install steps (register → smoke → events → custom). Re-resolved
        // after the post-clone load prompts (see below) when those run interactively.
        let { steps: postSteps, skipped: skippedSteps } = resolvePostSteps({
          target,
          url,
          region: typeof params.region === 'string' ? params.region : undefined,
          enabledLoadIds,
          ...postStepFlags,
        });

        if (options.json) {
          console.log(JSON.stringify({
            success: true,
            executionId,
            target,
            prereqs,
            prereqsSatisfied: prereqsSatisfied(prereqs),
            missingInputs: missing.map((m) => ({ flag: m.flag, description: m.description })),
            bootstrap: bootstrapCmd,
            sparsePaths: wantBootstrap ? sparsePaths : null,
            command,
            postSteps: postSteps.map((s) => ({ id: s.id, label: s.label, command: s.command })),
            skippedPostSteps: skippedSteps,
          }, null, 2));
          return;
        }

        // 5. Print the plan (shown before the gated execution below).
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

        // 6. Any missing required prereq that's a single static binary (e.g. yq)
        // can be fetched into the tools cache instead of a system install — no
        // brew/apt. Offer it, then re-check (the cache dir is already on PATH).
        const fetchable = prereqs.filter((c) => !c.ok && c.required && isFetchable(c.name));
        if (fetchable.length > 0) {
          const names = fetchable.map((c) => c.name).join(', ');
          if (await confirm(`\n${names} not installed — fetch the official static binary into ${TOOLS_DIR} (no system install)?`, options.yes)) {
            for (const c of fetchable) {
              printInfo(`Fetching ${c.name}…`);
              if (!fetchTool(c.name)) printWarning(`Couldn't fetch ${c.name} — install it manually and re-run.`);
            }
            prereqs = checkPrereqs(target, { bootstrap: wantBootstrap, withPlugins: enabledLoadIds.includes('plugins') });
          }
        }

        // The ECS service-linked role (fargate) is advisory, not a fetchable tool — offer to
        // create it on confirm (mirrors the tool-fetch above). Creating it up front lets the
        // FIRST ECS cluster create succeed instead of failing on the not-yet-ready-role race.
        // Idempotent + safe; never blocks (advisory check; the deploy also self-heals on retry).
        const slrMissing = prereqs.find((c) => c.name === 'ECS service-linked role' && !c.ok);
        if (slrMissing) {
          if (await confirm('\nECS service-linked role (AWSServiceRoleForECS) is missing — create it now? (lets the first ECS cluster create succeed cleanly)', options.yes)) {
            printInfo('Creating AWSServiceRoleForECS…');
            const { code } = await runScript('aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com', cwd, { quiet: true, capture: false });
            if (code === 0) {
              printSuccess('ECS service-linked role created.');
              prereqs = checkPrereqs(target, { bootstrap: wantBootstrap, withPlugins: enabledLoadIds.includes('plugins') });
            } else {
              printWarning('Could not create it (it may already exist, or you lack iam:CreateServiceLinkedRole) — the deploy still self-heals on retry if needed.');
            }
          }
        }

        // 7b. Gated execution. Check prereqs / required inputs first — this also
        // catches a missing `git` when bootstrapping.
        const blocked = executionBlocked(prereqs, missing);
        if (blocked) {
          printError(`Can't start just yet — ${blocked}. Resolve that and re-run.`);
          process.exitCode = 1;
          return;
        }

        // Commit gate — confirm BEFORE any side effect (clone, .env, deploy) so a "No"
        // leaves nothing behind. The port check + optional loads + .env below are part of
        // executing the agreed-to plan.
        if (!(await confirm(`\nProceed with provisioning ${spec.label}?`, options.yes))) {
          printWarning('No problem — nothing was changed.');
          return;
        }

        // 7a/7b. Sparse-clone (if --repo or accepted interactively) + locate the deploy
        // entrypoint, repointing cwd into the clone. See bootstrapAndLocate.
        const located = await bootstrapAndLocate(spec, bootstrap, bootstrapCmd, sparsePaths, cwd, options);
        cwd = located.cwd;
        const bootstrapped = located.bootstrapped;
        if (!located.ok) return;

        // Host-port pre-flight — now that the deploy source is on disk (post-clone),
        // derive the ports from it (compose / setup.sh) and stop on a fatal conflict
        // before deploying. See preflightPorts.
        if (!(await preflightPorts(spec, target, cwd))) {
          process.exitCode = 1;
          return;
        }

        // Opt-in loads — offered AFTER the clone (see resolveLoadsInteractively); it
        // prompts, additively sparse-fetches the picked folders, and re-resolves the
        // post-install steps with the selections.
        if (willPromptLoads) {
          const loaded = await resolveLoadsInteractively(
            target,
            url,
            typeof params.region === 'string' ? params.region : undefined,
            cwd,
            bootstrapped,
            bootstrap,
            postStepFlags,
          );
          enabledLoadIds = loaded.enabledLoadIds;
          postSteps = loaded.steps;
          skippedSteps = loaded.skipped;
          // Now that plugins may have been picked, re-check the plugin-specific prereqs we
          // deliberately didn't hard-require up front (e.g. yq for minikube plugin builds).
          // Offer to fetch any fetchable one; warn (don't block — the platform still deploys)
          // if it can't be resolved, so the later plugin build doesn't fail opaquely.
          if (enabledLoadIds.includes('plugins')) {
            const pluginPrereqs = checkPrereqs(target, { bootstrap: wantBootstrap, withPlugins: true });
            const pluginGaps = pluginPrereqs.filter((c) => !c.ok && c.required && !prereqs.some((p) => p.name === c.name));
            for (const c of pluginGaps) {
              if (isFetchable(c.name) && await confirm(`\n${c.name} is needed to build plugins but isn't installed — fetch the static binary into ${TOOLS_DIR}?`, options.yes)) {
                printInfo(`Fetching ${c.name}…`);
                if (!fetchTool(c.name)) printWarning(`Couldn't fetch ${c.name} — install it before the plugin build runs.`);
              } else {
                printWarning(`${c.name} missing — the plugin load/build step may fail. ${c.detail}`);
              }
            }
          }
        }
        // local/minikube's setup.sh REQUIRES a `.env` and aborts without it — create
        // it from .env.example with generated secrets so the deploy is non-interactive.
        // ec2/fargate also ship a `.env.example`, but their setup.sh never reads a
        // local `.env` (the instance handles its own; Fargate uses Secrets Manager via
        // init-secrets.sh), so we must NOT generate one for them.
        if ((target === 'local' || target === 'minikube') && envFileMissing(cwd, spec.dir)) {
          if (await confirm(`\n${spec.dir}/.env not found — create it from .env.example (generates secrets; edit later for optional integrations like OAuth)?`, options.yes)) {
            const n = createEnvFile(cwd, spec.dir);
            printSuccess(`Created ${spec.dir}/.env — ${n} secret(s) generated.`);
          } else {
            printWarning('Continuing without .env — setup.sh will abort if it stays missing.');
          }
        }
        // 7c. Run the deploy with a bounded auto-fix + retry loop (see runDeployWithRetry).
        const { succeeded, runParams } = await runDeployWithRetry(spec, url, cwd, params, aiOpts, options);
        if (!succeeded) { process.exitCode = 1; return; }
        printSuccess('Deploy command completed.');

        // 7d. SES post-deploy guidance (async DKIM + sandbox + bounce topic).
        // SES is provisioned BY DEFAULT on AWS deploys, so surface the guidance
        // for ec2/fargate unless the operator opted out with --no-email.
        const sesProvisioned = (target === 'ec2' || target === 'fargate') && runParams.noEmail !== true;
        if (sesProvisioned) {
          printSection('SES — next steps');
          for (const line of sesPostDeployGuidance()) printInfo(`• ${line}`);
        }

        // 7e. Verify health (CREATE_COMPLETE != serving).
        if (url) {
          printSection('Verifying health');
          // Minikube reaches the gateway via a kubectl port-forward that setup.sh
          // backgrounds and that can die/fail to bind — (re)start it before polling
          // so we don't sit at the gate on a dead forward while the pods are fine.
          if (target === 'minikube') {
            await ensureMinikubeGateway(url, { onInfo: (m) => printInfo(m) });
          }
          printInfo(`Polling ${url}/health …`);
          const health = await waitHealthy(url, { onTick: (m) => printInfo(m) });
          // Green only when fully ready; a "health OK but /ready never came" proceed-
          // anyway state is healthy:true but degraded → warn so it doesn't read as done.
          (health.healthy && health.ready ? printSuccess : printWarning)(`${health.url} — ${health.detail}`);
        }

        // 7f. Post-install steps (register + opt-in loads, smoke test, events, custom).
        // See runPostSteps — it surfaces register + the events bundle as manual in-VPC
        // next-steps on EC2/Fargate instead of auto-running (and failing) them locally.
        // autoRun (skip the second confirm) only when the user actually PICKED a load in the
        // interactive prompt — declining every load shouldn't silently run register unprompted.
        const autoRanLoads = willPromptLoads && enabledLoadIds.length > 0;
        await runPostSteps(postSteps, skippedSteps, target, cwd, adminEnv, { yes: options.yes, autoRun: autoRanLoads, autoInit: postStepFlags.autoInit });
      } catch (error) {
        handleError(error, ERROR_CODES.GENERAL, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'provision', executionId },
        });
      }
    });
}
