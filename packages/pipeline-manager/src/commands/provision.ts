// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, existsSync } from 'fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { Command } from 'commander';
import { diagnoseFailure, isAiConfigured, parseGoal } from '../agent/ai.js';
import { bootstrapCommand, resolveBootstrap } from '../agent/bootstrap.js';
import { entrypointExists, executionBlocked, runScript } from '../agent/executor.js';
import { deriveHealthUrl, waitHealthy } from '../agent/health.js';
import { resolvePostSteps } from '../agent/post-steps.js';
import { checkPrereqs, gitAvailable, gitSupportsSparseCheckout, prereqsSatisfied } from '../agent/prereqs.js';
import { TOOLS_DIR, fetchTool, isFetchable, withToolsOnPath } from '../agent/tools.js';
import { createEnvFile, envFileMissing } from '../agent/env-file.js';
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
import { matchIssues, sesPostDeployGuidance } from '../agent/troubleshoot.js';
import { printCommandHeader } from '../utils/command-utils.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { printSection, printKeyValue, printInfo, printWarning, printError, printSuccess } from '../utils/output-utils.js';

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
 * Builder PLATFORM (local/minikube/EC2/Fargate). Phase 1 is READ-ONLY (prereq
 * checks, NL-goal parsing, command assembly, failure diagnosis); `--execute`
 * gates a real deploy. With `--repo` it can bootstrap a fresh machine by sparsely
 * cloning only the deploy folders the selected target + options need, then runs
 * post-install steps (register admin, opt-in loads, smoke test, custom commands).
 *
 * @param program - The root Commander program instance to attach the command to.
 */
export function provision(program: Command): void {
  program
    .command('provision')
    .description('AI-assisted installer for the platform (local/minikube/EC2/Fargate): advise, --execute to deploy, or --teardown to remove')
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
    .option('-y, --yes', 'Auto-accept the execution approval prompt (for CI / non-interactive)', false)
    .option('--execute', 'Run the deploy (gated: needs approval, refuses on failed prereqs / missing inputs)', false)
    .option('--retries <n>', 'Auto-fix + retry attempts after a failure (deploy scripts are idempotent)', '1')
    .option('--teardown', 'Tear down an existing deployment instead of creating one (gated; AWS targets require a typed confirmation)', false)
    .option('--stack-name <name>', 'Stack name (EC2) / stack prefix (Fargate) to tear down — defaults to the deploy default')
    .option('--force', 'Skip the teardown typed-confirmation (DANGEROUS — for CI/automation only)', false)
    .option('--no-init', 'Skip the post-deploy register/init-platform step')
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
    .option('--json', 'Output the plan as JSON (never executes)', false)
    .action(async (options) => {
      const executionId = printCommandHeader('Provision (advisor)');

      try {
        // 1. Assemble params from explicit flags (flags always win over NL parse).
        const params: Record<string, unknown> = {
          region: options.region,
          domain: options.domain,
          hostedZoneId: options.hostedZoneId,
          deployMode: options.deployMode,
          keyPair: options.keyPair,
          instanceType: options.instanceType,
          ghcrToken: options.ghcrToken,
          // Commander tri-states `email`: undefined (neither), true (--email),
          // false (--no-email). SES is on by default, so only --no-email is
          // load-bearing (it emits `--no-email` into the deploy command).
          email: options.email === true,
          noEmail: options.email === false,
          emailFrom: options.emailFrom,
          emailFromName: options.emailFromName,
          alertEmail: options.alertEmail,
          noCreateSesIdentity: options.skipSesIdentity,
        };
        const aiOpts = { provider: options.aiProvider, model: options.model };

        // Bootstrap (sparse clone) + post-install selections.
        const wantBootstrap = options.repo !== undefined && options.repo !== false;
        const withAll = options.withAll === true;
        const enabledLoadIds = LOAD_STEPS.filter((s) => withAll || options[s.flag] === true).map((s) => s.id);
        const postStepFlags = {
          init: options.init !== false,
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
          } else {
            printWarning('A --prompt was given but no AI key is set — ignoring it and using flags only. Set ANTHROPIC_API_KEY (or --ai-provider + its key).');
          }
        }

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
          if (!target) return;
        }

        // 4. Need a target to assemble a plan.
        if (!target) {
          printError(`No target specified. Pass --target <${TARGET_IDS.join('|')}> or describe the goal with --prompt.`);
          process.exitCode = 1;
          return;
        }

        const spec = TARGETS[target];
        let cwd = process.cwd();

        // 4b. Teardown mode — the destroy counterpart of provisioning. Gated harder
        // than deploy: AWS targets are irreversible, so we require the operator to
        // TYPE the target id (--force bypasses for CI; --yes alone does NOT).
        if (options.teardown) {
          const { command: downCommand, destructive } = teardownCommand(target, {
            stackName: options.stackName,
            region: options.region,
            // Our typed gate IS the confirmation — forward --yes so the native
            // script (Fargate) doesn't also block on stdin we're inheriting.
            assumeYes: true,
          });

          if (options.json) {
            console.log(JSON.stringify({ success: true, executionId, target, teardown: true, destructive, destroys: spec.destroys, command: downCommand }, null, 2));
            return;
          }

          printSection(`Teardown plan — ${spec.label}`);
          printKeyValue({ 'Target': target, 'Destroys': spec.destroys, 'Stops cost': spec.cost });
          printSection('Command to run');
          printInfo(downCommand);

          if (!options.execute) {
            printWarning('\nAdvisor mode — nothing was executed. Re-run with --execute to tear down.');
            return;
          }

          if (destructive && !options.force) {
            const token = await ask(`\nThis is IRREVERSIBLE. Type "${target}" to confirm teardown: `);
            if (token !== target) {
              printWarning('That didn\'t match, so nothing was destroyed — you have to type the exact target id to confirm.');
              return;
            }
          } else if (!destructive && !options.force && !(await confirm('\nProceed with teardown (stops the stack; on-disk data persists)?', options.yes))) {
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
          return;
        }

        // Make previously-fetched single-binary tools (e.g. yq) visible to the
        // prereq checks + the deploy — they live in the tools cache, not on the
        // system PATH. (Both `has()` and the deploy's `bash -lc` inherit this.)
        withToolsOnPath();
        let prereqs = checkPrereqs(target, { bootstrap: wantBootstrap, withPlugins: enabledLoadIds.includes('plugins') });
        const { command, missing } = assembleCommand(spec, params);
        const url = deriveHealthUrl(target, params);

        // Sparse bootstrap clone command (common base + target + selected loads).
        const sparsePaths = sparsePathsFor(target, enabledLoadIds);
        const bootstrap = resolveBootstrap(
          { repo: typeof options.repo === 'string' ? options.repo : undefined, ref: options.ref, workdir: options.workdir, full: !gitSupportsSparseCheckout() },
          sparsePaths,
        );
        const bootstrapCmd = wantBootstrap ? bootstrapCommand(bootstrap) : null;

        // Resolve post-install steps (register → smoke → events → custom).
        const { steps: postSteps, skipped: skippedSteps } = resolvePostSteps({
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

        // 5. Print the plan (shared by advisor + execute).
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
          for (const s of skippedSteps) printWarning(`skipped ${s.id}: ${s.reason}`);
        }

        // 6. Advisor mode (default) — stop here, nothing executed.
        if (!options.execute) {
          printWarning('\nAdvisor mode — nothing was executed. Re-run with --execute to deploy (gated by approval).');
          return;
        }

        // 7. Any missing required prereq that's a single static binary (e.g. yq)
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

        // 7b. Gated execution. Check prereqs / required inputs first — this also
        // catches a missing `git` when bootstrapping.
        const blocked = executionBlocked(prereqs, missing);
        if (blocked) {
          printError(`Can't start just yet — ${blocked}. Resolve that and re-run.`);
          process.exitCode = 1;
          return;
        }

        // 7a. Sparse-clone the platform repo, repoint cwd, and verify the tree.
        // Shared by `--repo` (below) and the interactive offer in 7b. Returns
        // false (and sets exitCode) on failure — with a friendly message.
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
          if (!(await confirm('Go ahead with the clone?', options.yes))) {
            printWarning('No problem — nothing was changed. Re-run whenever you\'re ready.');
            return;
          }
          if (!(await bootstrapClone())) return;
        }

        // 7b. The deploy entrypoint must exist relative to cwd. If it doesn't and
        // we haven't bootstrapped, gracefully OFFER to clone (interactive only),
        // so a fresh machine can proceed without re-running with --repo.
        if (!entrypointExists(spec, cwd)) {
          const interactive = Boolean(process.stdin.isTTY) && !options.yes;
          if (!bootstrapCmd && interactive && gitAvailable()) {
            printInfo(`\nLooks like you're not inside a pipeline-builder checkout, so the ${spec.label} deploy scripts aren't here yet.`);
            if (await confirm(`Want me to sparse-clone them into ${bootstrap.workdir} and keep going?`, false)) {
              if (!(await bootstrapClone())) return;
            }
          }
          if (!entrypointExists(spec, cwd)) {
            printWarning(`\nI couldn't find ${spec.dir}/${spec.entrypoint} from ${cwd}.`);
            printInfo('Two easy ways forward:');
            printInfo('  • cd into your pipeline-builder checkout and re-run, or');
            printInfo(`  • add --repo and I'll bootstrap a fresh sparse clone for you${gitAvailable() ? '.' : ' (once git is installed).'}`);
            process.exitCode = 1;
            return;
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
        if (!(await confirm('\nProceed with this deploy?', options.yes))) {
          printWarning('No problem — nothing was changed.');
          return;
        }

        // 7c. Run the deploy out-of-loop (real command, secrets unmasked, streamed +
        // captured), with a bounded auto-fix + retry loop — the deploy scripts are
        // idempotent, so a fixed re-run resumes rather than starting over.
        const maxAttempts = 1 + Math.max(0, parseInt(options.retries, 10) || 0);
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
          if (fix?.paramFix && await confirm(`\nApply fix and retry — ${fix.suggestion}`, options.yes)) {
            runParams = { ...runParams, [fix.paramFix.key]: fix.paramFix.value };
            continue;
          }
          // Retryable but no param change (e.g. ACM DNS propagation) — offer a plain re-run.
          if (!fix && issues.some((i) => i.retryable) && await confirm('\nRetry the deploy (it is idempotent and will resume)?', options.yes)) {
            continue;
          }
          break;
        }
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
          printInfo(`Polling ${url}/health …`);
          const health = await waitHealthy(url, { onTick: (m) => printInfo(m) });
          (health.healthy ? printSuccess : printWarning)(`${health.url} — ${health.detail}`);
        }

        // 7f. Post-install steps (register + opt-in loads, smoke test, events, custom).
        // register runs init-platform; for EC2/Fargate it must run from inside the
        // VPC, so we surface the command there instead of executing it locally.
        if (postSteps.length > 0) {
          for (const s of skippedSteps) printWarning(`Skipped post-step ${s.id}: ${s.reason}`);
          const isRemoteRegister = (id: string): boolean => id === 'register' && (target === 'ec2' || target === 'fargate');
          const runnable = postSteps.filter((s) => !isRemoteRegister(s.id));
          for (const s of postSteps) {
            if (isRemoteRegister(s.id)) {
              printInfo('\nNext (run from inside the VPC): register admin + load plugins —');
              printInfo(`  ${s.command}`);
            }
          }
          if (runnable.length > 0 && await confirm(`\nRun ${runnable.length} post-install step(s) now?`, options.yes)) {
            for (const s of runnable) {
              printSection(`Post-step: ${s.label}`);
              // Steps that log into the platform (register + store-token) need the
              // admin creds (PLATFORM_IDENTIFIER / PLATFORM_PASSWORD) on top of their
              // own step env. setup-events does NOT log in — it reads PLATFORM_SECRET_NAME,
              // AWS creds, and the region from the AWS environment — so it's excluded.
              const needsCreds = s.id === 'register' || s.id === 'store-token';
              const env = needsCreds ? { ...s.env, ...adminEnv } : s.env;
              // These steps (plugin/sample/compliance loads, smoke, events) are noisy
              // and non-interactive, so run them QUIETLY — capture the output and only
              // surface it on failure. The exception is a register with no admin creds:
              // init-platform.sh prompts for them, so it must stream to the terminal.
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
          } else if (runnable.length > 0) {
            printInfo('\nSkipped post-install steps. Run the commands above manually when ready.');
          }
        }
      } catch (error) {
        handleError(error, ERROR_CODES.GENERAL, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'provision', executionId },
        });
      }
    });
}
