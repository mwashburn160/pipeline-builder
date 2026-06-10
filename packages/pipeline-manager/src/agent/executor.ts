// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Gated, out-of-loop execution. The deploy runs as a child process streaming to
 * the TERMINAL (never back into the model loop — a 15-30 min apply must not hold
 * an LLM turn open). For the deploy we also capture a tail of output so a failure
 * can be diagnosed; interactive steps (init-platform) get full stdio passthrough.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import type { PrereqCheck } from './prereqs.js';
import type { InputSpec, TargetSpec } from './targets.js';

/**
 * Decide whether execution is allowed. Returns a human-readable block reason, or
 * null when it is safe to proceed. Deterministic — the gate is never the model's
 * call; a failing prereq or a missing required input hard-blocks.
 */
export function executionBlocked(
  prereqs: readonly PrereqCheck[],
  missing: readonly InputSpec[],
): string | null {
  const failed = prereqs.filter((c) => c.required && !c.ok);
  if (failed.length > 0) return `unmet prerequisites: ${failed.map((c) => c.name).join(', ')}`;
  if (missing.length > 0) return `missing required inputs: ${missing.map((m) => `--${m.flag}`).join(', ')}`;
  return null;
}

/** True when the target's entrypoint exists relative to `cwd` (i.e. run from the repo root). */
export function entrypointExists(target: TargetSpec, cwd: string): boolean {
  return existsSync(join(cwd, target.dir, target.entrypoint));
}

export interface RunResult {
  readonly code: number;
  /** Last ~8 KB of combined output (capture mode only) — used for failure diagnosis. */
  readonly tail: string;
}

/**
 * Run a shell command from `cwd`, streaming to the terminal. With `capture`,
 * stdout/stderr are tee'd and the tail retained (for diagnosis); without it,
 * stdio is fully inherited so interactive prompts work (init-platform).
 */
export function runScript(command: string, cwd: string, opts: { capture?: boolean } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    if (!opts.capture) {
      const child = spawn('bash', ['-lc', command], { cwd, stdio: 'inherit' });
      child.on('close', (code) => resolve({ code: code ?? 1, tail: '' }));
      child.on('error', () => resolve({ code: 1, tail: '' }));
      return;
    }
    const child = spawn('bash', ['-lc', command], { cwd, stdio: ['inherit', 'pipe', 'pipe'] });
    let tail = '';
    const cap = (chunk: Buffer): void => {
      process.stdout.write(chunk);
      tail = (tail + chunk.toString()).slice(-8000);
    };
    child.stdout?.on('data', cap);
    child.stderr?.on('data', cap);
    child.on('close', (code) => resolve({ code: code ?? 1, tail }));
    child.on('error', (err) => resolve({ code: 1, tail: `${tail}\n${String(err)}` }));
  });
}
