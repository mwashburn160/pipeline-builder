// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The machine-readable reason a synth failed, as ONE log line.
 *
 * A CodePipeline action failure event only carries CodeBuild's generic
 * summary ("Error while executing command: pipeline-manager pipeline synth …
 * exit status 1") — never the build's output — so the reason a plugin was
 * refused (not installed, denied by policy, signature failure) was readable only
 * by opening the build log. `pipeline-manager pipeline synth` prints this line
 * when it fails inside CodeBuild; the events Lambda finds it in the failed
 * build's CloudWatch log stream and attaches it to the execution event.
 *
 * Dependency-free so the events Lambda can bundle it.
 */

/** Prefix of the line; the JSON payload follows after one space. */
export const SYNTH_FAILURE_MARKER = 'PB_SYNTH_FAILURE';

/** Caps keep the payload well inside the reporting ingest's 8 KB `detail` bound. */
const MAX_MESSAGE = 1000;
const MAX_PLUGINS = 10;
const MAX_PLUGIN_MESSAGE = 300;

/** One plugin the synth refused. */
export interface SynthFailurePlugin {
  readonly plugin: string;
  readonly code: string;
  readonly message: string;
}

/** The structured synth failure. */
export interface SynthFailure {
  /** One code for the whole failure: the refusal code when all agree, else `PLUGINS_REFUSED` / `SYNTH_FAILED`. */
  readonly code: string;
  readonly message: string;
  readonly plugins: readonly SynthFailurePlugin[];
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Build the failure from the refusals (empty for a failure that is not a plugin refusal). */
export function synthFailure(message: string, plugins: readonly SynthFailurePlugin[] = []): SynthFailure {
  const codes = [...new Set(plugins.map((p) => p.code))];
  const code = plugins.length === 0 ? 'SYNTH_FAILED' : codes.length === 1 ? codes[0]! : 'PLUGINS_REFUSED';
  return {
    code,
    message: clip(message, MAX_MESSAGE),
    plugins: plugins.slice(0, MAX_PLUGINS).map((p) => ({
      plugin: clip(p.plugin, 100),
      code: clip(p.code, 100),
      message: clip(p.message, MAX_PLUGIN_MESSAGE),
    })),
  };
}

/** The single log line for a failure. Newlines never appear inside it (JSON-escaped). */
export function formatSynthFailure(failure: SynthFailure): string {
  return `${SYNTH_FAILURE_MARKER} ${JSON.stringify(failure)}`;
}

/**
 * Parse a log line (or a CloudWatch event message, which may carry a
 * timestamp prefix) back into the failure. Returns null for any line that is
 * not a well-formed failure line.
 */
export function parseSynthFailure(line: string): SynthFailure | null {
  const at = line.indexOf(`${SYNTH_FAILURE_MARKER} {`);
  if (at === -1) return null;
  try {
    const parsed = JSON.parse(line.slice(at + SYNTH_FAILURE_MARKER.length + 1).trim()) as Partial<SynthFailure>;
    if (typeof parsed.code !== 'string' || typeof parsed.message !== 'string') return null;
    const plugins = Array.isArray(parsed.plugins)
      ? parsed.plugins.filter((p): p is SynthFailurePlugin =>
        !!p && typeof p.plugin === 'string' && typeof p.code === 'string' && typeof p.message === 'string')
      : [];
    return { ...synthFailure(parsed.message, plugins), code: clip(parsed.code, 100) };
  } catch {
    return null;
  }
}
