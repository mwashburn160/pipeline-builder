// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
import * as readline from 'node:readline/promises';
import { Command } from 'commander';
import { diagnoseFailure, isAiConfigured, parseGoal } from '../agent/ai.js';
import { entrypointExists, executionBlocked, runScript } from '../agent/executor.js';
import { deriveHealthUrl, waitHealthy } from '../agent/health.js';
import { checkPrereqs, prereqsSatisfied } from '../agent/prereqs.js';
import {
  assembleCommand,
  isTargetId,
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
 * Registers the `provision` command — an advisor that helps deploy the Pipeline
 * Builder PLATFORM (local/minikube/EC2/Fargate). Phase 1 is READ-ONLY: it checks
 * prerequisites, parses a natural-language goal (when an AI key is configured),
 * assembles the exact deploy command, and can diagnose a failure — but it never
 * executes anything (gated execution lands in a later phase).
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
    .option('--no-init', 'Skip the post-deploy init-platform step (local/minikube)')
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
        const cwd = process.cwd();

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
              printWarning('Confirmation did not match — aborted. Nothing was destroyed.');
              return;
            }
          } else if (!destructive && !options.force && !(await confirm('\nProceed with teardown (stops the stack; on-disk data persists)?', options.yes))) {
            printWarning('Aborted — nothing was executed.');
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

        const prereqs = checkPrereqs(target);
        const { command, missing } = assembleCommand(spec, params);

        if (options.json) {
          console.log(JSON.stringify({
            success: true,
            executionId,
            target,
            prereqs,
            prereqsSatisfied: prereqsSatisfied(prereqs),
            missingInputs: missing.map((m) => ({ flag: m.flag, description: m.description })),
            command,
            postDeploy: spec.postDeploy ?? null,
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

        printSection('Command to run');
        printInfo(command);

        // 6. Advisor mode (default) — stop here, nothing executed.
        if (!options.execute) {
          if (spec.postDeploy) {
            printInfo('\nThen initialize the platform (register admin + load plugins):');
            printInfo(`  ${spec.postDeploy}`);
          }
          printWarning('\nAdvisor mode — nothing was executed. Re-run with --execute to deploy (gated by approval).');
          return;
        }

        // 7. Gated execution.
        if (!entrypointExists(spec, cwd)) {
          printError(`Cannot find ${spec.dir}/${spec.entrypoint} from here. Run --execute from the pipeline-builder repo root.`);
          process.exitCode = 1;
          return;
        }
        const blocked = executionBlocked(prereqs, missing);
        if (blocked) {
          printError(`Refusing to execute — ${blocked}.`);
          process.exitCode = 1;
          return;
        }
        if (!(await confirm('\nProceed with this deploy?', options.yes))) {
          printWarning('Aborted — nothing was executed.');
          return;
        }

        // 7a. Run the deploy out-of-loop (real command, secrets unmasked, streamed +
        // captured), with a bounded auto-fix + retry loop — the deploy scripts are
        // idempotent, so a fixed re-run resumes rather than starting over.
        const maxAttempts = 1 + Math.max(0, parseInt(options.retries, 10) || 0);
        let runParams: Record<string, unknown> = params;
        let succeeded = false;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const realCommand = assembleCommand(spec, runParams, { mask: false }).command;
          printSection(attempt === 1 ? 'Deploying' : `Deploying — retry ${attempt - 1}`);
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

        // 7b. SES post-deploy guidance (async DKIM + sandbox + bounce topic).
        // SES is provisioned BY DEFAULT on AWS deploys, so surface the guidance
        // for ec2/fargate unless the operator opted out with --no-email.
        const sesProvisioned = (target === 'ec2' || target === 'fargate') && runParams.noEmail !== true;
        if (sesProvisioned) {
          printSection('SES — next steps');
          for (const line of sesPostDeployGuidance()) printInfo(`• ${line}`);
        }

        // 7c. Verify health (CREATE_COMPLETE != serving).
        const url = deriveHealthUrl(target, runParams);
        if (url) {
          printSection('Verifying health');
          printInfo(`Polling ${url}/health …`);
          const health = await waitHealthy(url, { onTick: (m) => printInfo(m) });
          (health.healthy ? printSuccess : printWarning)(`${health.url} — ${health.detail}`);
        }

        // 7d. Initialize the platform (register admin + load plugins).
        if (options.init === false) {
          printInfo('\nSkipped init-platform (--no-init). Run it later to register admin + load plugins.');
        } else if (target === 'local' || target === 'minikube') {
          if (await confirm('\nRun init-platform now (register admin + load plugins)?', options.yes)) {
            printSection('Initializing platform');
            await runScript(`./deploy/bin/init-platform.sh ${target}`, cwd);
          } else {
            printInfo(`\nLater: ./deploy/bin/init-platform.sh ${target}`);
          }
        } else {
          // EC2/Fargate: init must run from inside the VPC, not the operator machine.
          printInfo('\nNext (from inside the VPC): register admin + load plugins —');
          printInfo(`  ${spec.postDeploy}`);
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
