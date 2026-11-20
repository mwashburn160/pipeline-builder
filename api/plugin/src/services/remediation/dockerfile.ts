// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Dockerfile text helpers for remediation (pure; no I/O except the injected
 * digest resolver):
 *  - Stage 1: refresh every `FROM <image>:<tag>@sha256:…` to the CURRENT digest
 *    of the same image and tag — never a new tag — in the working copy only;
 *  - which shared platform base (api-core PLUGIN_BASE_IMAGES) the final stage
 *    is built on, and pointing it at a rebuilt base;
 *  - a tool version pinned with a recognised `ARG <TOOL>_VERSION=` line (the
 *    `binary` patcher and `${X_VERSION}` install tokens).
 */

import { PLUGIN_BASE_IMAGES, type PluginBaseImage } from '@pipeline-builder/api-core';

/** One `FROM` instruction. */
export interface FromLine {
  /** 0-based line index in the Dockerfile. */
  line: number;
  /** The image reference as written. */
  image: string;
  /** `AS <name>`, lowercased; null when the stage is unnamed. */
  alias: string | null;
  /** `--platform=…` when present. */
  platform: string | null;
}

const FROM_RE = /^(\s*FROM\s+)((?:--[a-z-]+=\S+\s+)*)(\S+)(\s+AS\s+(\S+))?(\s*)$/i;
const DIGEST_SUFFIX_RE = /@sha256:[0-9a-f]{64}$/;

/** Every FROM line, in order. */
export function parseFromLines(dockerfile: string): FromLine[] {
  const out: FromLine[] = [];
  dockerfile.split('\n').forEach((raw, line) => {
    const m = FROM_RE.exec(raw.replace(/\r$/, ''));
    if (!m) return;
    const platform = /--platform=(\S+)/i.exec(m[2] ?? '')?.[1] ?? null;
    out.push({ line, image: m[3]!, alias: m[5]?.toLowerCase() ?? null, platform });
  });
  return out;
}

/** The final stage's FROM (what the published image is built on), or null. */
export function finalStageFrom(dockerfile: string): FromLine | null {
  const froms = parseFromLines(dockerfile);
  return froms.length > 0 ? froms[froms.length - 1]! : null;
}

function replaceImageOnLine(dockerfile: string, lineIndex: number, from: string, to: string): string {
  const lines = dockerfile.split('\n');
  const raw = lines[lineIndex] ?? '';
  const m = FROM_RE.exec(raw.replace(/\r$/, ''));
  if (!m || m[3] !== from) return dockerfile;
  lines[lineIndex] = `${m[1]}${m[2] ?? ''}${to}${m[4] ?? ''}${m[6] ?? ''}${raw.endsWith('\r') ? '\r' : ''}`;
  return lines.join('\n');
}

export interface PinRefresh { line: number; from: string; to: string }

/**
 * Stage 1's base refresh: every `FROM image:tag@sha256:…` re-resolved to the
 * current digest of `image:tag` (`--pull` alone cannot move a digest pin).
 * Skipped: refs without a tag (nothing to re-resolve within), build-arg refs
 * (`$`), previous-stage names, and refs the resolver cannot answer. The tag is
 * never changed.
 */
export async function refreshPinnedBases(
  dockerfile: string,
  resolveDigest: (imageWithTag: string) => Promise<string | null>,
): Promise<{ dockerfile: string; refreshed: PinRefresh[] }> {
  const froms = parseFromLines(dockerfile);
  const stages = new Set(froms.map((f) => f.alias).filter((a): a is string => a !== null));
  let out = dockerfile;
  const refreshed: PinRefresh[] = [];
  for (const f of froms) {
    if (f.image.includes('$') || stages.has(f.image.toLowerCase())) continue;
    if (!DIGEST_SUFFIX_RE.test(f.image)) continue;
    const withTag = f.image.replace(DIGEST_SUFFIX_RE, '');
    // A tag is the part after the LAST ':' that comes after the last '/'.
    const lastSlash = withTag.lastIndexOf('/');
    if (withTag.indexOf(':', lastSlash + 1) < 0) continue;
    const current = await resolveDigest(withTag).catch(() => null);
    if (!current || !/^sha256:[0-9a-f]{64}$/.test(current)) continue;
    const next = `${withTag}@${current}`;
    if (next === f.image) continue;
    out = replaceImageOnLine(out, f.line, f.image, next);
    refreshed.push({ line: f.line, from: f.image, to: next });
  }
  return { dockerfile: out, refreshed };
}

/** `plugin-base:26.10@sha256:…` / `<host>/library/plugin-base:26.10` → `plugin-base:26.10`. */
function bareNameTag(image: string): string {
  const noDigest = image.replace(DIGEST_SUFFIX_RE, '');
  const last = noDigest.split('/').pop() ?? noDigest;
  return last.toLowerCase();
}

/** The shared platform base the final stage is built on (api-core PLUGIN_BASE_IMAGES), or null. */
export function sharedBaseOf(dockerfile: string): PluginBaseImage | null {
  const f = finalStageFrom(dockerfile);
  if (!f) return null;
  const nameTag = bareNameTag(f.image);
  return PLUGIN_BASE_IMAGES.find((b) => b.image.toLowerCase() === nameTag) ?? null;
}

/** Point every FROM of `base` (by name and tag) at `ref` (a rebuilt base, by digest). */
export function rewriteSharedBase(dockerfile: string, base: PluginBaseImage, ref: string): string {
  let out = dockerfile;
  for (const f of parseFromLines(dockerfile)) {
    if (bareNameTag(f.image) === base.image.toLowerCase()) out = replaceImageOnLine(out, f.line, f.image, ref);
  }
  return out;
}

// -- pinned tool ARGs -----------------------------------------------------------

/** The ARG names that pin `packageName` (`TERRAFORM_VERSION` for terraform; GO_VERSION / GOLANG_VERSION for Go's stdlib). */
export function pinnedArgNames(packageName: string): string[] {
  const n = packageName.trim().toLowerCase();
  if (n === 'stdlib' || n === 'go' || n === 'golang') return ['GO_VERSION', 'GOLANG_VERSION'];
  const snake = n.replace(/^@/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  return snake ? [`${snake}_VERSION`] : [];
}

export interface PinnedArg { line: number; name: string; value: string; prefix: string }

const ARG_RE = /^(\s*ARG\s+)([A-Za-z_][A-Za-z0-9_]*)=("?)(v?)([^\s"]+)("?)(\s*)$/;

/** An `ARG <NAME>=<version>` line pinning one of `names`, or null. */
export function findPinnedArg(dockerfile: string, names: readonly string[]): PinnedArg | null {
  const wanted = new Set(names);
  const lines = dockerfile.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = ARG_RE.exec(lines[i]!.replace(/\r$/, ''));
    if (m && wanted.has(m[2]!)) return { line: i, name: m[2]!, value: m[5]!, prefix: m[4] ?? '' };
  }
  return null;
}

/** Set a pinned ARG's default to `version` (keeping a `v` prefix the line had). */
export function bumpPinnedArg(dockerfile: string, arg: PinnedArg, version: string): string {
  const lines = dockerfile.split('\n');
  const raw = lines[arg.line] ?? '';
  const m = ARG_RE.exec(raw.replace(/\r$/, ''));
  if (!m) return dockerfile;
  const v = version.replace(/^v/, '');
  lines[arg.line] = `${m[1]}${m[2]}=${m[3]}${m[4] ?? ''}${v}${m[6]}${m[7] ?? ''}${raw.endsWith('\r') ? '\r' : ''}`;
  return lines.join('\n');
}

/** The ARG a `${NAME}` / `$NAME` reference names, when the token is exactly such a reference with an optional prefix. */
export function argReference(token: string): string | null {
  const m = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(token);
  return m ? m[1]! : null;
}
