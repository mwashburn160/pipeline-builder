// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A stand-in `cdk` executable, so `pipeline synth` runs its REAL synthesis
 * without the AWS CDK CLI installed and without AWS credentials.
 *
 * What the CDK CLI does for `cdk synth --app="node boilerplate.js"
 * --output=DIR` is: start the app with `CDK_OUTDIR=DIR`, then read the cloud
 * assembly it wrote. The shim does the first half and nothing else. The app it
 * starts is the CLI's own `src/boilerplate.ts`, bundled with esbuild (workspace
 * packages and aws-cdk-lib stay external, so the synth runs the real
 * pipeline-core `PipelineBuilder` from the built libs) — the source under test,
 * not a stale `dist/`.
 *
 * Every invocation's argv is appended to `cdk-invocations.jsonl` so a test can
 * assert the command the CLI built.
 */

import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface CdkShim {
  /** Directory to prepend to PATH. */
  binDir: string;
  /** JSON-lines log of every shim invocation's argv. */
  logFile: string;
  /** Remove the bundled CDK app (the shim itself lives in the caller's temp dir). */
  cleanup(): void;
}

export function installCdkShim(workDir: string): CdkShim {
  // Under the package's node_modules so the bundle's bare imports
  // (@pipeline-builder/*, aws-cdk-lib, constructs) resolve exactly as the CLI's
  // do — and exactly TWO levels below the package root, the depth of
  // dist/config/cli.constants.js, which reads `../../package.json` relative to
  // itself for the CLI version.
  const bundleDir = join(PACKAGE_ROOT, 'node_modules', '.pm-e2e');
  mkdirSync(bundleDir, { recursive: true });
  const bundle = join(bundleDir, `boilerplate-${process.pid}.mjs`);
  buildSync({
    entryPoints: [join(PACKAGE_ROOT, 'src', 'boilerplate.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
  });

  const binDir = join(workDir, 'bin');
  const logFile = join(workDir, 'cdk-invocations.jsonl');
  mkdirSync(binDir, { recursive: true });
  const shim = join(binDir, 'cdk');
  writeFileSync(shim, `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + '\\n');
if (args[0] === '--version') { console.log('2.1148.1 (pipeline-manager e2e shim)'); process.exit(0); }
if (args[0] !== 'synth') { console.error('cdk shim: only "synth" is emulated'); process.exit(2); }
const value = (flag) => { const a = args.find((x) => x.startsWith(flag + '=')); return a && a.slice(flag.length + 1); };
const app = value('--app');
const output = value('--output') || 'cdk.out';
if (!app || !/^node \\S*boilerplate\\.js$/.test(app)) { console.error('cdk shim: unexpected --app ' + app); process.exit(2); }
const r = spawnSync(process.execPath, [${JSON.stringify(bundle)}], {
  stdio: 'inherit',
  env: { ...process.env, CDK_OUTDIR: output, NODE_OPTIONS: '' },
});
process.exit(r.status === null ? 1 : r.status);
`);
  chmodSync(shim, 0o755);
  return { binDir, logFile, cleanup: () => rmSync(bundle, { force: true }) };
}
