// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Local container tooling for `plugin test` and `plugin publish`: building a
 * plugin's image with docker (buildx when present), inspecting it, and
 * detecting optional scanners (syft, grype). Every call goes through an
 * injectable {@link Exec} so the commands are unit-testable without docker.
 */

import { spawnSync, type SpawnSyncOptions } from 'child_process';
import crypto from 'crypto';

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not start or was killed by the timeout. */
  error?: Error;
}

export interface ExecOptions {
  /** Stream output to the terminal instead of capturing it. */
  inherit?: boolean;
  /** Extra environment for the child (merged over the CLI's own). */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  cwd?: string;
}

/** Run a program (never through a shell) and wait for it. */
export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => ExecResult;

export const spawnExec: Exec = (cmd, args, opts = {}) => {
  const options: SpawnSyncOptions = {
    encoding: 'utf-8',
    stdio: opts.inherit ? 'inherit' : 'pipe',
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: 'SIGKILL' } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    maxBuffer: 64 * 1024 * 1024,
  };
  const r = spawnSync(cmd, args, options);
  return {
    status: r.status,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
    ...(r.error ? { error: r.error } : {}),
  };
};

/** True when `cmd` runs (`<cmd> --version` exits 0). */
export function hasTool(exec: Exec, cmd: string, versionArgs: string[] = ['--version']): boolean {
  const r = exec(cmd, versionArgs);
  return !r.error && r.status === 0;
}

/** A throwaway local tag for a plugin image. */
export function localImageTag(name: string, version: string): string {
  const safe = `${name}-${version}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return `pipeline-manager-test/${safe}:${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Build the plugin image from its directory: `docker buildx build --load` when
 * buildx is available, else `docker build`. Output streams to the terminal.
 * Returns an error message, or null on success.
 */
export function buildPluginImage(exec: Exec, opts: {
  dir: string; dockerfile: string; tag: string; buildArgs?: Record<string, string>;
}): string | null {
  const buildArgs = Object.entries(opts.buildArgs ?? {}).flatMap(([k, v]) => ['--build-arg', `${k}=${v}`]);
  const useBuildx = hasTool(exec, 'docker', ['buildx', 'version']);
  const args = [...(useBuildx ? ['buildx', 'build', '--load'] : ['build']), '-t', opts.tag, '-f', opts.dockerfile, ...buildArgs, opts.dir];
  const r = exec('docker', args, { inherit: true });
  if (r.error) return `docker could not run: ${r.error.message}`;
  if (r.status !== 0) {
    return `image build failed (exit ${r.status}). Plugin bases (pipeline-<eco>-base) must exist locally: build them with deploy/bin/build-plugin-images.sh, or pass --image`;
  }
  return null;
}

/** The image's configured `USER` (empty string = root by default). */
export function imageUser(exec: Exec, image: string): { user: string } | { error: string } {
  const r = exec('docker', ['image', 'inspect', '--format', '{{.Config.User}}', image]);
  if (r.error || r.status !== 0) return { error: `cannot inspect image ${image}: ${(r.stderr || r.error?.message || '').trim()}` };
  return { user: r.stdout.trim() };
}

/** True when a configured `USER` (name or uid, optional group) resolves to root. */
export function isRootUser(user: string): boolean {
  const u = user.split(':')[0]!.trim();
  return u === '' || u === 'root' || u === '0';
}

/** Remove a throwaway image (best effort). */
export function removeImage(exec: Exec, image: string): void {
  exec('docker', ['rmi', '-f', image]);
}
