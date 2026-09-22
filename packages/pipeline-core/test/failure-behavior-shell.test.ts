// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `failureBehavior` wrapping, checked the only way that means anything: by
 * running the rendered commands through a real POSIX shell.
 *
 * The handler used to be appended as TEXT after each command, which broke on
 * two perfectly ordinary inputs:
 *  - a trailing `# comment` commented the handler out, so
 *    `npm audit # informational || true` exited 1 and failed a step that was
 *    explicitly marked `ignore`;
 *  - a heredoc ending in its terminator became `EOF || true`, which is not a
 *    terminator, so the heredoc never closed and swallowed the rest.
 * A string-shape assertion would not have caught either; a shell does.
 */

import { spawnSync } from 'node:child_process';
import { describe, it, expect } from '@jest/globals';
import { wrapCommandsForFailureBehavior } from '../src/core/metadata-helpers.js';

/** Run the commands as CodeBuild would — one shell, in order, `set -e`. */
function run(commands: string[]): { status: number | null; stdout: string } {
  const script = ['set -e', ...commands].join('\n');
  const r = spawnSync('sh', ['-c', script], { encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout };
}

describe('failureBehavior wrapping (executed)', () => {
  it('ignore: a failing command with a trailing comment does not fail the step', () => {
    const r = run(wrapCommandsForFailureBehavior(['false # informational', 'echo after'], 'ignore'));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('after');
  });

  it('warn: a failing command with a trailing comment warns, reports its exit code, and continues', () => {
    const r = run(wrapCommandsForFailureBehavior(['sh -c "exit 3" # noisy', 'echo after'], 'warn'));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Command failed with exit code 3');
    expect(r.stdout).toContain('after');
  });

  it('ignore: a heredoc still terminates, and the next command still runs', () => {
    const r = run(wrapCommandsForFailureBehavior(['cat <<EOF\nhello\nEOF', 'echo after'], 'ignore'));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('hello\nafter\n');
  });

  it('fail: leaves commands untouched, so a failure still fails the step', () => {
    expect(run(wrapCommandsForFailureBehavior(['false', 'echo after'], 'fail')).status).not.toBe(0);
  });
});
