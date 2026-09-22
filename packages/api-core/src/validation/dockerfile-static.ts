// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * STATIC reading of a plugin's own Dockerfile (plugin-ecosystem §3.1a, G55;
 * W0.6 `runAsRoot`): its `LABEL` instructions and its final `USER`, without
 * building anything.
 *
 * - Only the plugin's OWN instructions count. The built image's config also
 *   carries every label inherited from its base image, and those describe the
 *   base image, not the plugin — so labels are never read from an image.
 * - Only the FINAL stage counts (plus any earlier stage it is built `FROM`):
 *   labels and `USER` set in a discarded build stage never reach the image.
 * - A value containing `$` is ignored: build arguments aren't known at upload,
 *   so the static text is not what the image would carry.
 * - Values are untrusted text, exactly like the spec.
 *
 * Handles the `# escape=` parser directive, line continuations (with comment
 * lines inside a continuation skipped, as Docker does), `key=value` pairs with
 * double quotes (backslash escapes) or single quotes (literal), and the legacy
 * `LABEL key value` form.
 */

/** Max Dockerfile text read (bytes). Larger inputs are truncated, never parsed whole. */
const MAX_DOCKERFILE_CHARS = 256 * 1024;

interface Stage {
  /** Lowercased `AS` alias, if any. */
  alias: string | null;
  /** Lowercased base reference (`FROM <base>`). */
  base: string;
  /** The base reference as written (image refs are case-sensitive in tags). */
  rawBase: string;
  labels: Map<string, string>;
  /** Last `USER` in the stage (raw), or null when the stage sets none. */
  user: string | null;
}

/** What the plugin's Dockerfile itself declares for its final image. */
export interface DockerfileFacts {
  /** The final image's own labels (later instructions win). */
  labels: Record<string, string>;
  /** The final image's own `USER`, or null when the Dockerfile sets none. */
  finalUser: string | null;
  /**
   * The external image the final stage is ultimately built `FROM` (following
   * stage aliases), as written; null when there is no `FROM`, it is `scratch`,
   * or it depends on a build argument (`$`), which isn't known statically.
   */
  baseImage: string | null;
}

/** The escape character from a leading `# escape=` directive (default `\`). */
function escapeCharOf(lines: string[]): string {
  for (const line of lines) {
    const t = line.trim();
    if (t === '') continue;
    const m = /^#\s*escape\s*=\s*([`\\])\s*$/i.exec(t);
    if (m) return m[1]!;
    // Parser directives must come first; any other directive-shaped comment is
    // skipped, anything else ends the directive block.
    if (!/^#\s*\w+\s*=/.test(t)) break;
  }
  return '\\';
}

/** Physical lines → logical instructions (continuations joined, comments dropped). */
function logicalLines(content: string): string[] {
  const lines = content.slice(0, MAX_DOCKERFILE_CHARS).replace(/\r\n?/g, '\n').split('\n');
  const esc = escapeCharOf(lines);
  const out: string[] = [];
  let current: string | null = null;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (current === null && (trimmed === '' || trimmed.startsWith('#'))) continue;
    // Docker skips comment and empty lines inside a continuation.
    if (current !== null && (trimmed === '' || trimmed.startsWith('#'))) continue;
    const continued = raw.replace(/\s+$/, '').endsWith(esc);
    const body = continued ? raw.replace(/\s+$/, '').slice(0, -1) : raw;
    current = current === null ? body : `${current}${body}`;
    if (!continued) {
      out.push(current.trim());
      current = null;
    }
  }
  if (current !== null && current.trim()) out.push(current.trim());
  return out;
}

/**
 * Split `LABEL` arguments into words, honouring double quotes (with backslash
 * escapes) and single quotes (literal). Returns null on an unterminated quote.
 */
function splitWords(args: string): string[] | null {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (c === '"') {
      inWord = true;
      let j = i + 1;
      for (; j < args.length && args[j] !== '"'; j++) {
        if (args[j] === '\\' && j + 1 < args.length) j++;
        word += args[j];
      }
      if (j >= args.length) return null;
      i = j;
    } else if (c === '\'') {
      inWord = true;
      const end = args.indexOf('\'', i + 1);
      if (end < 0) return null;
      word += args.slice(i + 1, end);
      i = end;
    } else if (c === '\\' && i + 1 < args.length) {
      inWord = true;
      word += args[++i];
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      inWord = true;
      word += c;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/** The `key → value` pairs of one `LABEL` instruction's arguments. */
export function parseLabelArgs(args: string): Array<[string, string]> {
  const trimmed = args.trim();
  // Legacy form: `LABEL key value with spaces` (no `=` in the first word).
  const firstWord = /^\S+/.exec(trimmed)?.[0] ?? '';
  if (firstWord && !firstWord.includes('=')) {
    const words = splitWords(trimmed);
    if (!words || words.length < 2) return [];
    return [[words[0]!, words.slice(1).join(' ')]];
  }
  const words = splitWords(trimmed);
  if (!words) return [];
  const pairs: Array<[string, string]> = [];
  for (const w of words) {
    const eq = w.indexOf('=');
    if (eq <= 0) continue;
    pairs.push([w.slice(0, eq), w.slice(eq + 1)]);
  }
  return pairs;
}

/** Parse what `content` declares for its final image. Never throws. */
export function parseDockerfile(content: string | null | undefined): DockerfileFacts {
  const stages: Stage[] = [];
  for (const line of logicalLines(content ?? '')) {
    const m = /^(\S+)\s*(.*)$/s.exec(line);
    if (!m) continue;
    const instruction = m[1]!.toUpperCase();
    const args = m[2] ?? '';
    if (instruction === 'FROM') {
      // FROM [--platform=…] <image> [AS <name>]
      const words = args.split(/\s+/).filter((w) => w && !w.startsWith('--'));
      const asIdx = words.findIndex((w) => w.toLowerCase() === 'as');
      stages.push({
        base: (words[0] ?? '').toLowerCase(),
        rawBase: words[0] ?? '',
        alias: asIdx >= 0 && words[asIdx + 1] ? words[asIdx + 1]!.toLowerCase() : null,
        labels: new Map(),
        user: null,
      });
      continue;
    }
    const stage = stages[stages.length - 1];
    if (!stage) continue; // Instructions before the first FROM (ARG) set nothing on the image.
    if (instruction === 'LABEL') {
      for (const [k, v] of parseLabelArgs(args)) {
        if (v.includes('$') || k.includes('$')) {
          stage.labels.delete(k);
          continue;
        }
        stage.labels.set(k, v);
      }
    } else if (instruction === 'USER') {
      stage.user = args.trim() || null;
    }
  }

  if (stages.length === 0) return { labels: {}, finalUser: null, baseImage: null };

  // The final stage, preceded by the chain of earlier stages it is built FROM
  // (its own content, not a base image's), oldest first.
  const chain: Stage[] = [];
  let cursor: Stage | undefined = stages[stages.length - 1];
  const seen = new Set<Stage>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    chain.unshift(cursor);
    const base: string = cursor.base;
    const idx = stages.indexOf(cursor);
    cursor = stages.slice(0, idx).reverse().find((s) => s.alias !== null && s.alias === base);
  }

  const labels: Record<string, string> = {};
  let finalUser: string | null = null;
  for (const s of chain) {
    for (const [k, v] of s.labels) labels[k] = v;
    if (s.user !== null) finalUser = s.user;
  }
  const root = chain[0]!.rawBase;
  const baseImage = root === '' || root.includes('$') || root.toLowerCase() === 'scratch' ? null : root;
  return { labels, finalUser, baseImage };
}

/** The OCI annotation keys the catalog reads (§3.1a). */
export const OCI_LABELS = {
  title: 'org.opencontainers.image.title',
  description: 'org.opencontainers.image.description',
  licenses: 'org.opencontainers.image.licenses',
  url: 'org.opencontainers.image.url',
  source: 'org.opencontainers.image.source',
  documentation: 'org.opencontainers.image.documentation',
} as const;
