// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The `provision` command: its ~40-option table, and the sequencing narrative
 * that runs a provision end to end.
 *
 * The phases themselves live in `./provision-steps.ts` — one exported function
 * each — so this file can be read as what it is: which flags exist, and in what
 * order the steps run behind which gates.
 */

import { Command } from 'commander';
import {
  INIT_MODES,
  bootstrapAndLocate,
  buildParams,
  confirm,
  ensureLocalEnvFile,
  offerToolFetch,
  preflightPorts,
  printPlan,
  recheckPluginPrereqs,
  resolveInitMode,
  resolveLoadsInteractively,
  runDeployWithRetry,
  runDiagnose,
  runPostSteps,
  runTeardown,
  verifyHealth,
} from './provision-steps.js';
import { isAiConfigured, parseGoal } from '../agent/ai.js';
import { bootstrapCommand, resolveBootstrap } from '../agent/bootstrap.js';
import { executionBlocked } from '../agent/executor.js';
import { deriveHealthUrl } from '../agent/health.js';
import { resolvePostSteps } from '../agent/post-steps.js';
import { checkPrereqs, gitSupportsSparseCheckout, prereqsSatisfied } from '../agent/prereqs.js';
import {
  assembleCommand,
  isTargetId,
  LOAD_STEPS,
  sparsePathsFor,
  TARGETS,
  TARGET_IDS,
  type TargetId,
} from '../agent/targets.js';
import { withToolsOnPath } from '../agent/tools.js';
import { sesPostDeployGuidance } from '../agent/troubleshoot.js';
import { printCommandHeader } from '../utils/command-utils.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { printSection, printInfo, printWarning, printError, printSuccess } from '../utils/output-utils.js';

/** Commander collector: accumulate repeated `--post-step` values in order. */
function collectStep(value: string, acc: string[]): string[] {
  return [...acc, value];
}

/**
 * Registers the `provision` command — an AI-assisted installer for the Pipeline
 * Builder PLATFORM (local/minikube/EC2/EKS). It prints the assembled plan
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
    .description('AI-assisted installer for the platform (local/minikube/EC2/EKS): deploys it (gated by confirmation prompts), or --teardown to remove')
    .option('-t, --target <target>', `Deploy target: ${TARGET_IDS.join(' | ')}`)
    .option('-p, --prompt <text>', 'Natural-language goal (parsed into params when an AI key is set)')
    .option('--region <region>', 'AWS region (EC2/EKS)')
    .option('--domain <domain>', 'Fully-qualified domain name (EC2/EKS)')
    .option('--hosted-zone-id <id>', 'Public Route 53 hosted zone ID (EC2/EKS)')
    .option('--deploy-mode <mode>', 'public | private (EC2/EKS)')
    .option('--key-pair <name>', 'EC2 key pair (EC2)')
    .option('--instance-type <type>', 'EC2 instance type (EC2)')
    .option('--lean', 'EC2: trim optional observability/admin services so the core stack + mesh fits a t3.xlarge (pair with --instance-type t3.xlarge)')
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
    .option('--stack-name <name>', 'CloudFormation stack name (EC2) for the deploy AND teardown — defaults to pipeline-builder (set it to run a second environment)')
    .option('--cluster-name <name>', 'EKS cluster name for the deploy AND teardown — defaults to pipeline-builder')
    .option('--force', 'Skip the teardown typed-confirmation (DANGEROUS — for CI/automation only)', false)
    .option('--init <mode>', 'Post-deploy initialization: auto (DEFAULT — register admin + load plugins/compliance/samples; on ec2 the instance does it itself on first boot), manual (don\'t self-init — surface the step for you to run, e.g. to set real admin creds), or skip (do nothing). local/minikube/eks run init via provision unless skip.')
    // Bootstrap (sparse clone) — provision a fresh machine in one command.
    .option('--repo [url]', 'Bootstrap: git-clone the platform repo first (sparse — only the needed deploy folders), then run from it (no value = the upstream default)')
    .option('--ref <ref>', 'Git branch/tag to check out when bootstrapping (default: main)')
    .option('--workdir <dir>', 'Directory to clone into / run from when bootstrapping (default: pipeline-builder)')
    // Post-install loads — each opt-in step also adds its deploy folder to the sparse clone.
    .option('--with-plugins', 'Post-install: build + load plugins (adds deploy/plugins, deploy/codebuild)', false)
    .option('--with-compliance', 'Post-install: load sample compliance rules/policies (adds deploy/compliance)', false)
    .option('--with-samples', 'Post-install: load sample pipeline templates (adds deploy/samples)', false)
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
        // Resolve the single post-deploy init mode (auto|manual|skip) from --init. Two internal signals derive from it: whether init happens at
        // all, and whether the DEPLOY self-runs it (vs. we surface it).
        const initMode = resolveInitMode(options);
        if (initMode === null) {
          printError(`Invalid --init value '${String(options.init)}'. Use one of: ${INIT_MODES.join(' | ')}.`);
          process.exitCode = 1;
          return;
        }
        const initEnabled = initMode !== 'skip'; // skip → no register/loads at all
        const selfInit = initMode === 'auto'; // auto → the deploy initializes itself

        // 1. Assemble params from explicit flags (flags always win over NL parse).
        const params = buildParams(options, selfInit);
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
          // selfInit (mode auto) drops the surfaced register step on the AWS targets in
          // resolvePostSteps, so a self-initializing ec2/eks deploy doesn't also print a manual
          // register step. For manual mode (or local/minikube) the register step is surfaced.
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
          await runDiagnose(options.diagnose, options.json === true, aiOpts, executionId);
          return;
        }

        // With `--init auto` (the default) the EC2 instance loads plugins/compliance/samples
        // itself on the box (bootstrap.sh hardcodes LOAD_*=y), so the local load picker — and
        // the load-folder fetch it triggers — is pointless. Skip both (the instance has its
        // own checkout).
        if (selfInit && target === 'ec2') {
          willPromptLoads = false;
          enabledLoadIds = [];
        } else if (selfInit && target === 'eks' && !anyLoadFlag) {
          // `--init auto` on eks initializes like ec2: NO interactive picker — default to
          // loading ALL of plugins + compliance + samples (setup.sh's final phase hardcodes
          // LOAD_*=y). setup.sh runs the loads itself (over a kubectl port-forward), but we
          // still resolve them here so the sparse clone fetches the folders setup.sh builds
          // from. Explicit `--with-*` flags override; `--init manual` / `--init skip` opt out.
          willPromptLoads = false;
          enabledLoadIds = LOAD_STEPS.map((s) => s.id);
          postStepFlags.buildBootstrap = options.buildBootstrap === true || enabledLoadIds.includes('plugins');
        }
        // minikube/local keep the interactive picker (local-dev; no `--init auto` load parity).

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
        printPlan({ spec, target, prereqs, missing, bootstrap, bootstrapCmd, sparsePaths, command, postSteps, skippedSteps });

        // 6. Offer to fetch any missing single-binary prereq (see offerToolFetch).
        prereqs = await offerToolFetch(prereqs, options.yes, () => checkPrereqs(target, { bootstrap: wantBootstrap, withPlugins: enabledLoadIds.includes('plugins') }));

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
          if (enabledLoadIds.includes('plugins')) {
            await recheckPluginPrereqs(target, wantBootstrap, prereqs, options.yes);
          }
        }
        await ensureLocalEnvFile(target, spec, cwd, options.yes);

        // 7c. Run the deploy with a bounded auto-fix + retry loop (see runDeployWithRetry).
        const { succeeded, runParams } = await runDeployWithRetry(spec, url, cwd, params, aiOpts, options);
        if (!succeeded) { process.exitCode = 1; return; }
        printSuccess('Deploy command completed.');

        // 7d. SES post-deploy guidance (async DKIM + sandbox + bounce topic).
        // SES is provisioned BY DEFAULT on AWS deploys, so surface the guidance
        // for ec2/eks unless the operator opted out with --no-email.
        const sesProvisioned = (target === 'ec2' || target === 'eks') && runParams.noEmail !== true;
        if (sesProvisioned) {
          printSection('SES — next steps');
          for (const line of sesPostDeployGuidance()) printInfo(`• ${line}`);
        }

        // 7e. Verify health (CREATE_COMPLETE != serving).
        if (url) await verifyHealth(target, url);

        // 7f. Post-install steps (register + opt-in loads, smoke test, events, custom).
        // See runPostSteps — it surfaces register + the events bundle as manual in-VPC
        // next-steps on EC2/EKS instead of auto-running (and failing) them locally.
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
