// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The resolved props reach the CDK app as a file. They used to ride in one
 * environment variable, and a pipeline whose plugin records summed past
 * 128 KiB could not start the app on Linux (E2BIG). This starts a REAL child
 * process with props well past that, the way `cdk` starts the app.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, it, expect } from '@jest/globals';
import { PIPELINE_PROPS_FILE_ENV, readPropsFile, withPropsFile } from '../src/utils/props-file.js';

/** Linux's cap on one environment string (MAX_ARG_STRLEN). */
const ONE_ENV_VAR_LIMIT = 128 * 1024;

describe('props file', () => {
  it('hands a child process props far larger than one environment variable can hold', () => {
    const props = { pipelineId: 'p-1', resolvedPlugins: { big: { name: 'big', scan: 'x'.repeat(3 * ONE_ENV_VAR_LIMIT) } } };
    const echoed = withPropsFile(props, (env) => {
      expect(env[PIPELINE_PROPS_FILE_ENV]!.length).toBeLessThan(1024);
      return execFileSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(process.env.${PIPELINE_PROPS_FILE_ENV}, 'utf-8'))`], {
        env: { ...process.env, ...env },
        maxBuffer: 16 * ONE_ENV_VAR_LIMIT,
      }).toString();
    });
    expect(JSON.parse(echoed)).toEqual(props);
  });

  it('reads back what was written, and removes the file afterwards', () => {
    let file = '';
    const read = withPropsFile({ a: 1 }, (env) => {
      file = env[PIPELINE_PROPS_FILE_ENV]!;
      return readPropsFile<{ a: number }>(env);
    });
    expect(read).toEqual({ a: 1 });
    expect(existsSync(file)).toBe(false);
  });

  it('removes the file when the command throws', () => {
    let file = '';
    expect(() => withPropsFile({ a: 1 }, (env) => { file = env[PIPELINE_PROPS_FILE_ENV]!; throw new Error('cdk failed'); })).toThrow('cdk failed');
    expect(existsSync(file)).toBe(false);
  });

  it('says how to set it when the variable is missing, and names an unreadable file', () => {
    expect(() => readPropsFile({})).toThrow(/PIPELINE_PROPS_FILE is not set.*pipeline synth --id/);
    expect(() => readPropsFile({ [PIPELINE_PROPS_FILE_ENV]: '/nonexistent/props.json' })).toThrow(/Can't read the pipeline props file \/nonexistent\/props.json/);
  });
});
