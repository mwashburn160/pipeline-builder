// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  STEP_BOOTSTRAP_CMD, extractMetadataEnv, resolveFailureBehavior, resolvePluginTemplates, wrapCommandsForFailureBehavior,
} from '@pipeline-builder/pipeline-core';
import { Command } from 'commander';
import { printCommandHeader } from '../utils/command-utils.js';
import { ERROR_CODES, handleError, ValidationError } from '../utils/error-handler.js';
import { printError, printInfo, printSection, printSuccess, printWarning } from '../utils/output-utils.js';
import {
  buildPluginImage, hasTool, imageUser, isRootUser, localImageTag, removeImage, spawnExec, type Exec,
} from '../utils/plugin-docker.js';
import { packageProblems, readPluginPackage } from '../utils/plugin-package.js';

/** Mount point of the sample workspace inside the container (the step's source dir). */
export const CONTAINER_WORKSPACE = '/workspace';

export interface TestPluginOptions {
  dir: string;
  image?: string;
  workspace?: string;
  env?: string[];
  metadata?: string[];
  var?: string[];
  keep?: boolean;
}

/** A plugin run that failed: the step would be red in CodeBuild. */
export class PluginTestFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginTestFailure';
  }
}

/** `KEY=VALUE` flags → a record (the value may itself contain `=`). */
export function parseKeyValues(pairs: string[] | undefined, flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new ValidationError(`${flag} expects KEY=VALUE (got "${pair}")`, flag, pair);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

/** What a run needs, resolved from the spec + flags (no side effects). */
export interface TestPlan {
  name: string;
  version: string;
  failureBehavior: 'fail' | 'warn' | 'ignore';
  /** Plain env passed as `-e KEY=VALUE`. */
  env: Record<string, string>;
  /** Secret NAMES passed as `-e NAME` (docker reads the value from this process's env). */
  secretNames: string[];
  missingOptionalSecrets: string[];
  installScript: string;
  buildScript: string;
  primaryOutputDirectory: string | undefined;
  smokeTest: string | undefined;
  timeoutMs: number | undefined;
}

/**
 * Resolve the spec the way the pipeline step does: `{{ … }}` templates against
 * the given pipeline metadata/vars, env = spec env ← non-namespaced metadata ←
 * `--env`, the step's WORKDIR bootstrap, and the build commands wrapped for the
 * effective failureBehavior (a security-category plugin is always `fail`).
 */
export function planPluginTest(
  spec: Record<string, unknown>,
  flags: { env?: Record<string, string>; metadata?: Record<string, string>; vars?: Record<string, string> },
  hostEnv: NodeJS.ProcessEnv = process.env,
): TestPlan {
  const metadata = { ...(spec.metadata as Record<string, string | number | boolean> ?? {}), ...(flags.metadata ?? {}) };
  let resolved: Record<string, unknown>;
  try {
    resolved = resolvePluginTemplates(spec as never, {
      pipeline: {
        projectName: 'plugin-test',
        project: 'plugin-test',
        orgId: 'local',
        organization: 'local',
        pipelineName: 'plugin-test',
        metadata,
        vars: flags.vars ?? {},
      },
    }) as unknown as Record<string, unknown>;
  } catch (err) {
    throw new PluginTestFailure(`${(err as Error).message} — supply the value with --metadata KEY=VALUE or --var KEY=VALUE`);
  }

  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : []);
  const env: Record<string, string> = {
    ...(resolved.env as Record<string, string> ?? {}),
    ...extractMetadataEnv(metadata),
    ...(flags.env ?? {}),
  };

  const secrets = Array.isArray(spec.secrets) ? spec.secrets as Array<{ name: string; required: boolean }> : [];
  const missingRequired = secrets.filter(s => s.required && !hostEnv[s.name]).map(s => s.name);
  if (missingRequired.length) {
    throw new PluginTestFailure(`Required secret(s) not set in your environment: ${missingRequired.join(', ')} — export them before running plugin test`);
  }
  const secretNames = secrets.filter(s => hostEnv[s.name]).map(s => s.name);
  for (const name of secretNames) delete env[name];

  const failureBehavior = resolveFailureBehavior(
    typeof spec.category === 'string' ? spec.category : undefined,
    spec.failureBehavior as 'fail' | 'warn' | 'ignore' | undefined,
  );
  const script = (commands: string[]): string => ['set -e', STEP_BOOTSTRAP_CMD, ...commands].join('\n');
  const timeout = typeof spec.timeout === 'number' && spec.timeout > 0 ? spec.timeout * 60_000 : undefined;

  return {
    name: String(spec.name),
    version: String(spec.version),
    failureBehavior,
    env,
    secretNames,
    missingOptionalSecrets: secrets.filter(s => !s.required && !hostEnv[s.name]).map(s => s.name),
    installScript: script(strings(resolved.installCommands)),
    buildScript: script(wrapCommandsForFailureBehavior(strings(resolved.commands), failureBehavior)),
    primaryOutputDirectory: typeof spec.primaryOutputDirectory === 'string' && spec.primaryOutputDirectory ? spec.primaryOutputDirectory : undefined,
    smokeTest: typeof spec.smokeTest === 'string' && spec.smokeTest.trim() ? spec.smokeTest : undefined,
    timeoutMs: timeout,
  };
}

/** `docker run` arguments for one phase (secret VALUES never appear here). */
export function dockerRunArgs(image: string, workspace: string, plan: Pick<TestPlan, 'env' | 'secretNames'>, script: string): string[] {
  return [
    'run', '--rm',
    '-v', `${workspace}:${CONTAINER_WORKSPACE}`, '-w', CONTAINER_WORKSPACE,
    ...Object.entries(plan.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...plan.secretNames.flatMap(name => ['-e', name]),
    // CodeBuild runs a step's commands under /bin/sh, so the test does too.
    '--entrypoint', '/bin/sh',
    image, '-c', script,
  ];
}

/** Copy the sample workspace to a scratch dir the container's uid 1000 can write. */
export function prepareWorkspace(source: string | undefined): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-manager-plugin-test-'));
  if (source) {
    const src = path.resolve(source);
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new ValidationError(`--workspace is not a directory: ${src}`, 'workspace', src);
    fs.cpSync(src, ws, { recursive: true });
  }
  // The container runs as the image's user (uid 1000), not the host user.
  // Executable bits are kept (a `gradlew`), symlinks are left alone (never
  // chmod through a link to something outside the scratch dir).
  const open = (p: string): void => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return;
    const ownerExecutable = Math.floor((st.mode % 0o1000) / 0o100) % 2 === 1;
    fs.chmodSync(p, st.isDirectory() || ownerExecutable ? 0o777 : 0o666);
    if (st.isDirectory()) for (const e of fs.readdirSync(p)) open(path.join(p, e));
  };
  open(ws);
  return ws;
}

/** Where the step's primary output lands on the host, honouring a relative WORKDIR. */
export function outputPath(workspace: string, plan: Pick<TestPlan, 'env' | 'primaryOutputDirectory'>): string | null {
  if (!plan.primaryOutputDirectory) return null;
  const workdir = plan.env.WORKDIR ?? './';
  const base = workdir.startsWith('/')
    ? (workdir.startsWith(CONTAINER_WORKSPACE) ? path.join(workspace, path.relative(CONTAINER_WORKSPACE, workdir)) : null)
    : path.join(workspace, workdir);
  return base === null ? null : path.join(base, plan.primaryOutputDirectory);
}

/**
 * Build (or take) the image, then run the plugin as its CodeBuild step would:
 * install phase, build phase (failureBehavior applied), the primary output
 * check, then the spec's smokeTest. Any failure throws — a step that can't run
 * or that fails is red, never green.
 */
export async function runPluginTest(options: TestPluginOptions, exec: Exec = spawnExec): Promise<{ outputFiles: number | null }> {
  const pkg = readPluginPackage(options.dir);
  const problems = await packageProblems(pkg);
  if (problems.length) {
    for (const p of problems) printError(`  • ${p}`);
    throw new ValidationError(`The plugin has ${problems.length} validation problem(s); run "plugin validate" and fix them first`);
  }
  const spec = pkg.spec as unknown as Record<string, unknown>;
  if (spec.pluginType === 'ManualApprovalStep') {
    throw new ValidationError('A ManualApprovalStep runs no commands, so there is nothing to test');
  }
  if (!hasTool(exec, 'docker')) throw new PluginTestFailure('docker is not available — plugin test runs the plugin in its image');

  const plan = planPluginTest(spec, {
    env: parseKeyValues(options.env, '--env'),
    metadata: parseKeyValues(options.metadata, '--metadata'),
    vars: parseKeyValues(options.var, '--var'),
  });

  const workspace = prepareWorkspace(options.workspace);
  let image = options.image;
  let built: string | null = null;
  try {
    if (!image) {
      if (pkg.buildType === 'build_image') {
        built = localImageTag(plan.name, plan.version);
        printSection('Building image', built);
        const buildArgs = (spec.buildArgs as Record<string, string>) ?? {};
        const error = buildPluginImage(exec, { dir: pkg.dir, dockerfile: path.join(pkg.dir, pkg.dockerfileName), tag: built, buildArgs });
        if (error) throw new PluginTestFailure(error);
        image = built;
      } else if (pkg.buildType === 'prebuilt') {
        const r = exec('docker', ['load', '-i', path.join(pkg.dir, 'image.tar')]);
        const loaded = /Loaded image(?: ID)?: (\S+)/.exec(r.stdout)?.[1];
        if (r.status !== 0 || !loaded) throw new PluginTestFailure(`docker load image.tar failed: ${(r.stderr || r.stdout).trim()}`);
        image = loaded;
      } else {
        throw new ValidationError('A metadata_only plugin has no image of its own; pass the image it runs in with --image');
      }
    }
    if (!image) throw new PluginTestFailure('No image to run');
    const user = imageUser(exec, image);
    if ('error' in user) throw new PluginTestFailure(user.error);
    if (isRootUser(user.user)) {
      throw new PluginTestFailure(`The image runs as root (USER '${user.user || '(unset)'}'); end the Dockerfile with \`USER 1000:1000\``);
    }

    printInfo('Running plugin', {
      image,
      runsAs: user.user,
      workspace,
      failureBehavior: plan.failureBehavior,
      env: Object.keys(plan.env),
      secrets: plan.secretNames,
    });
    if (plan.missingOptionalSecrets.length) printWarning('Optional secrets not set (the step runs without them)', { secrets: plan.missingOptionalSecrets });

    for (const [phase, script] of [['install', plan.installScript], ['build', plan.buildScript]] as const) {
      printSection(`Phase: ${phase}`);
      const r = exec('docker', dockerRunArgs(image, workspace, plan, script), { inherit: true, timeoutMs: plan.timeoutMs });
      if (r.error) throw new PluginTestFailure(`${phase} phase did not complete: ${r.error.message}`);
      if (r.status !== 0) throw new PluginTestFailure(`${phase} phase failed (exit ${r.status})`);
    }

    let outputFiles: number | null = null;
    const out = outputPath(workspace, plan);
    if (plan.primaryOutputDirectory && out === null) {
      printWarning('WORKDIR is outside the workspace; primaryOutputDirectory cannot be checked on the host');
    } else if (out) {
      if (!fs.existsSync(out) || !fs.statSync(out).isDirectory()) {
        throw new PluginTestFailure(`primaryOutputDirectory '${plan.primaryOutputDirectory}' was not created`);
      }
      outputFiles = fs.readdirSync(out).length;
      if (outputFiles === 0) throw new PluginTestFailure(`primaryOutputDirectory '${plan.primaryOutputDirectory}' is empty`);
      printSuccess(`primaryOutputDirectory '${plan.primaryOutputDirectory}' has ${outputFiles} entr${outputFiles === 1 ? 'y' : 'ies'}`);
    } else {
      printWarning('The spec declares no primaryOutputDirectory; no output to check');
    }

    if (plan.smokeTest) {
      printSection('Smoke test', plan.smokeTest);
      const r = exec('docker', ['run', '--rm', '--entrypoint', '/bin/bash', image, '-c', plan.smokeTest], { inherit: true });
      if (r.error || r.status !== 0) throw new PluginTestFailure(`smokeTest failed: ${plan.smokeTest}`);
    } else {
      printWarning('The spec declares no smokeTest');
    }
    return { outputFiles };
  } finally {
    if (options.keep) printInfo('Workspace kept', { workspace });
    else fs.rmSync(workspace, { recursive: true, force: true });
    if (built && !options.keep) removeImage(exec, built);
  }
}

/**
 * Register `plugin test` — run a plugin's install + build commands locally in
 * its image against a sample workspace, check its primary output, and run its
 * smokeTest. Exits non-zero on any failure.
 *
 * Usage:
 *   pipeline-manager plugin test --dir ./my-linter --workspace ./sample-app
 *   pipeline-manager plugin test --dir ./my-linter --image my-linter:dev --metadata STAGE=dev
 */
export function testPlugin(program: Command): void {
  program
    .command('test')
    .description('Run a plugin\'s install + build commands locally in its image against a sample workspace')
    .option('--dir <path>', 'Plugin directory', '.')
    .option('--image <ref>', 'Use this image instead of building the plugin\'s Dockerfile')
    .option('--workspace <path>', 'Sample workspace copied in as the step\'s source (default: empty)')
    .option('--env <KEY=VALUE>', 'Extra environment variable (repeatable)', collect)
    .option('--metadata <KEY=VALUE>', 'Pipeline metadata value (repeatable; also exported as env, as in the pipeline)', collect)
    .option('--var <KEY=VALUE>', 'Pipeline var for {{ pipeline.vars.* }} (repeatable)', collect)
    .option('--keep', 'Keep the scratch workspace and built image for inspection', false)
    .action(async (options: TestPluginOptions) => {
      const executionId = printCommandHeader('Test Plugin');
      try {
        const result = await runPluginTest(options);
        printSuccess('Plugin test passed', { executionId, outputEntries: result.outputFiles });
      } catch (err) {
        handleError(err, err instanceof ValidationError ? ERROR_CODES.VALIDATION : ERROR_CODES.GENERAL, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'plugin test', executionId },
        });
      }
    });
}
