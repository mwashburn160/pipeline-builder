// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * How the resolved pipeline props reach the CDK app (`boilerplate.ts`): as a
 * JSON file whose path is in `PIPELINE_PROPS_FILE`, never as the props
 * themselves in the environment. Linux refuses to start a process with any
 * single environment variable over 128 KiB (E2BIG), and the resolved props
 * carry every step's plugin record, so a large pipeline outgrows it. The
 * path passes through `cdk` to the app it starts; the file is readable by the
 * current user only, and removed once the CDK command returns.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The environment variable naming the props file. */
export const PIPELINE_PROPS_FILE_ENV = 'PIPELINE_PROPS_FILE';

/**
 * Write `props` to a fresh private file, run `fn` with the environment that
 * names it, and remove the file whatever `fn` does.
 */
export function withPropsFile<T>(props: Record<string, unknown>, fn: (env: Record<string, string>) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-props-'));
  try {
    const file = join(dir, 'props.json');
    writeFileSync(file, JSON.stringify(props), { mode: 0o600 });
    return fn({ [PIPELINE_PROPS_FILE_ENV]: file });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Read the props the CLI handed the CDK app. Throws with the fix when the file is missing or unreadable. */
export function readPropsFile<T>(env: NodeJS.ProcessEnv = process.env): T {
  const file = env[PIPELINE_PROPS_FILE_ENV];
  if (!file) {
    throw new Error(
      `${PIPELINE_PROPS_FILE_ENV} is not set. `
      + 'Use "pipeline-manager pipeline synth --id <id>" or "pipeline-manager pipeline deploy --id <id>", which resolve the pipeline and set it.',
    );
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf-8');
  } catch (error) {
    throw new Error(`Can't read the pipeline props file ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`The pipeline props file ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
