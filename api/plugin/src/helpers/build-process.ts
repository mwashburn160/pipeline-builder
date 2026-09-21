// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The subprocess runner every build tool goes through (buildctl, crane, syft,
 * cosign): bounded by a timeout, every output line secret-masked before it is
 * logged or streamed, and a bounded tail kept for the failure summary.
 */

import { spawn } from 'child_process';

import { createLogger } from '@pipeline-builder/api-core';

const logger = createLogger('build-process');

/** Receives each MASKED build output line as it is produced (for live SSE). */
export type BuildLineSink = (line: string, stream: 'stdout' | 'stderr') => void;

export interface BuildStreamOptions {
  /** Optional live sink for masked build log lines (owner-bound SSE stream). */
  onLine?: BuildLineSink;
}

export interface RunOptions extends BuildStreamOptions {
  /**
   * Return stdout RAW instead of logging/streaming it. For tools whose stdout is
   * data, not progress: `crane push` prints the pushed digest (which the masker's
   * long-hex rule would turn into `***`), `cosign verify-attestation` prints the
   * attestation JSON. stderr is still masked + logged as usual.
   */
  captureStdout?: boolean;
}

/** Last-N masked build lines retained for a bounded failure summary. */
export const BUILD_LOG_TAIL_LINES = 25;
/** Hard cap per streamed/summarized line so a pathological line can't bloat SSE. */
const BUILD_LOG_MAX_LINE_CHARS = 2000;
/** Ceiling on captured stdout — an SBOM attestation for a large image is a few MB. */
const MAX_CAPTURED_STDOUT_BYTES = 64 * 1024 * 1024;

/**
 * A build subprocess exited non-zero or timed out. Carries a bounded tail of the
 * last masked output lines + the exit reason so the worker can surface a useful
 * failure summary on the user's SSE stream instead of a generic "Build failed".
 */
export class BuildProcessError extends Error {
  readonly tail: string[];
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  constructor(message: string, opts: { tail: string[]; exitCode: number | null; timedOut: boolean }) {
    super(message);
    this.name = 'BuildProcessError';
    this.tail = opts.tail;
    this.exitCode = opts.exitCode;
    this.timedOut = opts.timedOut;
  }
}

// -----------------------------------------------------------------------------
// Secret masking
// -----------------------------------------------------------------------------

const SECRET_RE = /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIALS|AUTH)([=: ]+)([^\s"']+)/gi;
const BEARER_RE = /\b(BEARER)\s+(\S+)/gi;
// JWT-shaped (three base64url segments) or long base64 runs (≥32 chars).
const JWT_RE = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const LONG_B64_RE = /\b[A-Za-z0-9+/]{32,}={0,2}\b/g;

export function maskSecrets(line: string): string {
  return line
    .replace(SECRET_RE, '$1$2***')
    .replace(BEARER_RE, '$1 ***')
    .replace(JWT_RE, '***')
    .replace(LONG_B64_RE, '***');
}

// -----------------------------------------------------------------------------
// Process runner
// -----------------------------------------------------------------------------

/**
 * Run `binary args…`, resolving with captured stdout (`''` unless
 * `opts.captureStdout`) or rejecting with a {@link BuildProcessError}.
 */
export function run(binary: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv, opts?: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);

    // Bounded ring buffer of the last N MASKED lines — the failure summary the
    // worker surfaces on the user's SSE stream instead of a generic message.
    const tail: string[] = [];
    /** Record + (optionally) live-stream one already-masked output line. */
    const emit = (masked: string, stream: 'stdout' | 'stderr'): void => {
      logger.info(masked, { stream, binary });
      tail.push(masked);
      if (tail.length > BUILD_LOG_TAIL_LINES) tail.shift();
      if (opts?.onLine) {
        // A streaming-sink failure must NEVER fail the build (SSE is best-effort).
        try { opts.onLine(masked.slice(0, BUILD_LOG_MAX_LINE_CHARS), stream); } catch { /* ignore */ }
      }
    };

    const captured: Buffer[] = [];
    let capturedBytes = 0;
    let captureOverflow = false;

    // Per-stream line buffer so a chunked JWT (split mid-token across two data
    // events) still resolves to a single line before masking runs.
    const buffers = { stdout: '', stderr: '' };
    const pipe = (stream: 'stdout' | 'stderr') => (data: Buffer) => {
      if (stream === 'stdout' && opts?.captureStdout) {
        capturedBytes += data.length;
        if (capturedBytes > MAX_CAPTURED_STDOUT_BYTES) { captureOverflow = true; child.kill('SIGKILL'); return; }
        captured.push(data);
        return;
      }
      buffers[stream] += data.toString();
      const lines = buffers[stream].split('\n');
      buffers[stream] = lines.pop() ?? '';
      for (const line of lines) if (line) emit(maskSecrets(line), stream);
    };
    child.stdout.on('data', pipe('stdout'));
    child.stderr.on('data', pipe('stderr'));

    child.on('close', (code) => {
      clearTimeout(timer);
      for (const stream of ['stdout', 'stderr'] as const) {
        if (buffers[stream]) emit(maskSecrets(buffers[stream]), stream);
      }
      if (timedOut) reject(new BuildProcessError(`${binary} timed out after ${timeoutMs}ms`, { tail: [...tail], exitCode: code, timedOut: true }));
      else if (captureOverflow) reject(new BuildProcessError(`${binary} output exceeded ${MAX_CAPTURED_STDOUT_BYTES} bytes`, { tail: [...tail], exitCode: code, timedOut: false }));
      else if (code !== 0) reject(new BuildProcessError(`${binary} failed with exit code ${code}`, { tail: [...tail], exitCode: code, timedOut: false }));
      else resolve(Buffer.concat(captured).toString('utf-8'));
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}
