// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The catalog's STATIC plugin checks (deploy/bin/test-plugins.sh), for a plugin
 * directory outside the repo: the spec fields the catalog tooling requires and
 * the Dockerfile rules (deploy/plugins/README.md "Dockerfile rules"). Shared
 * from api-core so the CLI (`plugin validate --lint`, `plugin publish`) and the
 * plugin service (AI generation) apply ONE implementation (plugin-ecosystem W6):
 *
 *  - the final stage ends as a non-root `USER`, set in the plugin's own Dockerfile;
 *  - every download goes through `fetch-verified` (no raw curl/wget, no `ADD <url>`
 *    without `--checksum=`);
 *  - no pipe-to-shell installers;
 *  - no secrets in `ENV`/`ARG`; apt caches cleaned; a `WORKDIR`;
 *  - the spec never downloads a tool at runtime.
 *
 * Only the repo-layout rules (name = directory, category = parent directory)
 * are left to test-plugins.sh: a publisher's plugin doesn't live in that tree.
 * Warnings never fail; errors do.
 */

import { parseDockerfile } from './dockerfile-static.js';

export interface PluginLintFinding {
  level: 'error' | 'warning';
  message: string;
}

/** Spec fields test-plugins.sh requires on every plugin. */
export const PLUGIN_LINT_REQUIRED_FIELDS: readonly string[] = ['name', 'description', 'keywords', 'category', 'version', 'pluginType', 'computeType', 'timeout', 'failureBehavior', 'secrets'];
/** …and on every CodeBuildStep. */
export const PLUGIN_LINT_CODEBUILD_FIELDS: readonly string[] = ['primaryOutputDirectory', 'dockerfile', 'installCommands', 'commands'];

/** Logical Dockerfile instructions: comment lines dropped, `\` continuations joined. */
export function dockerfileInstructions(content: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (const raw of content.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*#/.test(raw)) continue;
    if (/\\\s*$/.test(raw)) {
      buf += `${raw.replace(/\\\s*$/, '')} `;
      continue;
    }
    buf += raw;
    if (/\S/.test(buf)) out.push(buf.trim());
    buf = '';
  }
  if (/\S/.test(buf)) out.push(buf.trim());
  return out;
}

const instructionOf = (line: string): string => (/^(\S+)/.exec(line)?.[1] ?? '').toUpperCase();

/** RUN instructions that pipe into a shell (`curl … | bash`). */
export function pipeInstallers(content: string): string[] {
  return dockerfileInstructions(content).filter(l =>
    instructionOf(l) === 'RUN' && /(^|[^|])\|\s*(sudo\s+)?(\/usr)?(\/bin\/)?(ba|da|z|k)?sh(\s|$)/.test(l));
}

/** curl/wget DOWNLOADS in RUN, and `ADD <url>` without `--checksum=`. */
export function rawDownloads(content: string): string[] {
  const found: string[] = [];
  for (const line of dockerfileInstructions(content)) {
    const instr = instructionOf(line);
    if (instr === 'ADD' && /https?:\/\//.test(line) && !/--checksum=/.test(line)) {
      found.push(`ADD ${line}`);
      continue;
    }
    if (instr !== 'RUN') continue;
    const body = line.replace(/^\s*run\s+/i, '');
    for (let part of body.split(/&&|\|\||;|\||\$\(|`|\(|\{/)) {
      for (;;) {
        part = part.replace(/^\s+/, '');
        const prefix = /^(if|then|do|else|elif|while|until|!|sudo|exec|command|time|--[a-z-]+(=\S*)?|[A-Za-z_][A-Za-z0-9_]*=\S*)\s+/.exec(part);
        if (!prefix) break;
        part = part.slice(prefix[0].length);
      }
      if (/^(curl|wget)(\s|$)/.test(part) && (/:\/\//.test(part) || /\$/.test(part) || /\s(-o|-O|--output|--output-document)([\s=]|$)/.test(part))) {
        found.push(part.trim());
      }
    }
  }
  return found;
}

/** Lint a Dockerfile against the catalog's rules. */
export function lintPluginDockerfile(content: string): PluginLintFinding[] {
  const findings: PluginLintFinding[] = [];
  const err = (message: string) => findings.push({ level: 'error', message });
  const instructions = dockerfileInstructions(content);
  if (!instructions.some(l => instructionOf(l) === 'FROM')) {
    err('Dockerfile: missing FROM instruction');
    return findings;
  }
  if (!instructions.some(l => instructionOf(l) === 'WORKDIR')) err('Dockerfile: missing WORKDIR instruction');
  if (/^(ENV|ARG)\s+(.*TOKEN|.*SECRET|.*PASSWORD|.*API_KEY|.*PRIVATE_KEY)/m.test(content)) {
    err('Dockerfile: potential secret in an ENV/ARG instruction (pass secrets at run time via the spec\'s `secrets`)');
  }
  const finalUser = parseDockerfile(content).finalUser;
  const userPart = (finalUser ?? '').split(':')[0];
  if (!finalUser) err('Dockerfile: the final stage sets no USER (end with `USER 1000:1000`)');
  else if (userPart === 'root' || userPart === '0') err(`Dockerfile: the final stage runs as root (USER ${finalUser}); end with \`USER 1000:1000\``);
  const pipes = pipeInstallers(content);
  if (pipes.length) err(`Dockerfile: pipes a download into a shell (use a pinned release via fetch-verified, a fetch-apt-key apt repo, or an ecosystem base): ${pipes[0]!.slice(0, 160)}`);
  const downloads = rawDownloads(content);
  if (downloads.length) err(`Dockerfile: raw download not via fetch-verified: ${downloads[0]!.slice(0, 160)}`);
  if (/apt-get install/.test(content) && !/rm -rf \/var\/lib\/apt\/lists/.test(content)) {
    err('Dockerfile: missing apt cache cleanup (rm -rf /var/lib/apt/lists/*)');
  }
  return findings;
}

/** Lint the spec document (as parsed) the way test-plugins.sh does. */
export function lintPluginSpec(spec: Record<string, unknown>, specText: string): PluginLintFinding[] {
  const findings: PluginLintFinding[] = [];
  const err = (message: string) => findings.push({ level: 'error', message });
  for (const f of PLUGIN_LINT_REQUIRED_FIELDS) if (!(f in spec)) err(`plugin-spec.yaml: missing required field: ${f}`);
  if (spec.pluginType === 'CodeBuildStep' || spec.pluginType === undefined) {
    for (const f of PLUGIN_LINT_CODEBUILD_FIELDS) if (!(f in spec)) err(`plugin-spec.yaml: missing CodeBuild field: ${f}`);
  }
  if (typeof spec.version === 'string' && !/^\d+\.\d+\.\d+$/.test(spec.version)) {
    err(`plugin-spec.yaml: catalog versions are plain semver x.y.z (got ${spec.version})`);
  }
  if (typeof spec.description !== 'string' || spec.description.trim() === '') err('plugin-spec.yaml: empty description');
  if ('keywords' in spec && (!Array.isArray(spec.keywords) || spec.keywords.length === 0)) err('plugin-spec.yaml: empty keywords list');
  const download = /(curl|wget)\s.*https?:\/\/[^\s"]*(releases\/download\/|\.tar\.gz|\.tgz|\.tar\.xz|\.zip)/.exec(specText);
  if (download) err(`plugin-spec.yaml: downloads a tool at runtime (bake it into the image via fetch-verified): ${download[0].slice(0, 160)}`);
  if (/^\s*- \|/m.test(specText) && !/set -e/.test(specText)) {
    findings.push({ level: 'warning', message: 'plugin-spec.yaml: multi-line command(s) without `set -e` — intermediate failures will silently pass' });
  }
  return findings;
}
