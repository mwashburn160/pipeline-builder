// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Malware heuristics over a plugin PACKAGE's source (docs/plans/plugin-ecosystem.md
 * §4.2 gate 4, E8): the Dockerfile, the spec and every other text file in the
 * zip. A plugin runs inside a customer's CodeBuild with the customer's keys, so
 * the patterns looked for are the ones that abuse exactly that:
 *
 *  - crypto-miner signatures (xmrig, `stratum+tcp://`, cryptonight, …);
 *  - obfuscated execution (a base64/hex blob decoded into a shell or `eval`,
 *    `eval "$(… | base64 -d)"`, long single-line encoded payloads);
 *  - credential access (`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, the ECS /
 *    CodeBuild container-credential endpoints and variables, IMDS
 *    `169.254.169.254` / `fd00:ec2::254`, `~/.aws/credentials`,
 *    `/var/run/secrets`);
 *  - reverse shells and unchecked pipe-to-shell downloads;
 *  - secret-looking literals (`AKIA…`, `ghp_…`, `xoxb-…`, PEM private keys, a
 *    high-entropy value assigned to a `*_TOKEN` / `*_SECRET` / `*_PASSWORD` /
 *    `*_KEY` name).
 *
 * `high` findings fail the anonymous-submission gate; `medium` ones are shown
 * to moderators only. The CLI (`plugin validate` / `plugin publish`) runs the
 * same scan so an author sees it before uploading. Pure and bounded: files and
 * lines are size-capped, binary files are skipped, and findings are capped.
 */

import { pipeInstallers } from './plugin-lint.js';

export type HeuristicSeverity = 'high' | 'medium';

export interface HeuristicFinding {
  /** Rule id (stable; moderators filter on it). */
  id: string;
  severity: HeuristicSeverity;
  /** The file, relative to the package root. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** The offending line, trimmed and capped, with secret values masked. */
  excerpt: string;
  /** What the rule means. */
  message: string;
}

export interface HeuristicsReport {
  findings: HeuristicFinding[];
  /** Files scanned. */
  scannedFiles: number;
  /** Files skipped (binary, over the size cap, or past the total budget). */
  skippedFiles: string[];
}

export interface HeuristicsInputFile {
  path: string;
  content: string | Uint8Array;
}

/** A single file larger than this is not scanned (listed in `skippedFiles`). */
export const HEURISTICS_MAX_FILE_BYTES = 512 * 1024;
/** Total bytes scanned per package. */
export const HEURISTICS_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
/** Findings kept per package. */
export const HEURISTICS_MAX_FINDINGS = 200;
const EXCERPT_MAX = 160;
/** A line longer than this is scanned only for the encoded-blob rule (and truncated for the rest). */
const LINE_SCAN_MAX = 8 * 1024;

interface LineRule {
  id: string;
  severity: HeuristicSeverity;
  message: string;
  test: RegExp;
  /** Severity in documentation files (README, *.md), where mentioning a name isn't using it. */
  docSeverity?: HeuristicSeverity | null;
  /** Mask secret-looking values in the excerpt. */
  secret?: boolean;
  /** Only on code lines: a `#` / `//` comment that MENTIONS the pattern isn't using it. */
  codeOnly?: boolean;
}

const SHELL = String.raw`(?:sudo\s+)?(?:\/usr)?(?:\/bin\/)?(?:ba|da|z|k)?sh\b`;

const LINE_RULES: readonly LineRule[] = [
  {
    id: 'miner-signature',
    severity: 'high',
    message: 'Crypto-miner signature',
    test: /\bxmrig\b|stratum\+(?:tcp|ssl|tls):\/\/|\bcryptonight\b|\bminerd\b|\bnicehash\b|\bcpuminer\b|\bxmr-stak\b|\bethminer\b|\bnbminer\b|\bphoenixminer\b|\blolminer\b|\bsupportxmr\b|\bminexmr\b|\bmoneroocean\b/i,
  },
  {
    id: 'obfuscated-exec',
    severity: 'high',
    message: 'Encoded payload decoded straight into a shell or eval',
    test: new RegExp(String.raw`base64\s+(?:-d|-D|--decode)\b[^\n]*\|\s*${SHELL}|\beval\b[^\n]*\$\([^\n]*base64\s+(?:-d|-D|--decode)|\bxxd\s+-r\b[^\n]*\|\s*${SHELL}|(?:\\x[0-9a-fA-F]{2}){8,}[^\n]*\|\s*${SHELL}|\bexec\s*\(\s*(?:base64\.b64decode|__import__\(\s*['"](?:base64|zlib)['"])|\beval\s*\(\s*(?:atob|Buffer\.from)\s*\(`, 'i'),
  },
  {
    id: 'reverse-shell',
    severity: 'high',
    message: 'Reverse-shell pattern',
    test: /\/dev\/tcp\/\d|\bnc(?:at)?\b[^\n]*\s-(?:e|c)\s+\S*sh\b|\bncat\b[^\n]*--(?:exec|sh-exec)\b|\bsocat\b[^\n]*\bexec:/i,
  },
  {
    id: 'credential-access',
    severity: 'high',
    docSeverity: 'medium',
    codeOnly: true,
    message: 'Reads cloud or build credentials',
    test: /\bAWS_SECRET_ACCESS_KEY\b|\bAWS_SESSION_TOKEN\b|\bAWS_CONTAINER_CREDENTIALS_(?:RELATIVE|FULL)_URI\b|\bAWS_CONTAINER_AUTHORIZATION_TOKEN(?:_FILE)?\b|\bCODEBUILD_[A-Z0-9_]*(?:TOKEN|CREDENTIAL|SECRET|AUTH)[A-Z0-9_]*\b|169\.254\.169\.254|169\.254\.170\.2|fd00:ec2::254|\.aws\/credentials|\/var\/run\/secrets\b/,
  },
  {
    id: 'pipe-to-shell',
    severity: 'high',
    docSeverity: null,
    codeOnly: true,
    message: 'Download piped straight into a shell',
    test: new RegExp(String.raw`\b(?:curl|wget)\b[^\n|]*\|\s*${SHELL}`, 'i'),
  },
  {
    id: 'secret-literal',
    severity: 'high',
    message: 'Secret-looking literal',
    secret: true,
    test: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b|\bxox[bap]-[A-Za-z0-9-]{10,}|-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----|\bglpat-[A-Za-z0-9_-]{20,}\b|\bsk_live_[A-Za-z0-9]{16,}\b/,
  },
];

/** `NAME=value` / `NAME: value` / `ENV NAME value` assignments to a secret-looking name. */
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY|_KEY))\b["']?\s*(?:[:=]|\s)\s*["']?([^\s"'`,;)]{16,})/i;
/** A long single-token base64 or hex run (an embedded payload). */
const ENCODED_BLOB = /[A-Za-z0-9+/]{240,}={0,2}|\b[0-9a-fA-F]{240,}\b/;

/** Shannon entropy of `s`, in bits per character. */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Whether a secret-assignment value looks like a real credential (not a placeholder or a reference). */
function looksLikeSecretValue(value: string): boolean {
  if (/[$]|\{\{|<|>|\*{3,}|x{6,}|changeme|example|placeholder|your[-_]/i.test(value)) return false;
  return shannonEntropy(value) >= 3.5;
}

function isDocFile(path: string): boolean {
  return /(^|\/)readme(\.[a-z]+)?$/i.test(path) || /\.(md|markdown|rst|txt|adoc)$/i.test(path);
}

function mask(line: string): string {
  return line
    .replace(/\b((?:AKIA|ASIA)[0-9A-Z]{4})[0-9A-Z]{12}\b/g, '$1…')
    .replace(/\b(gh[pousr]_|github_pat_|xox[bap]-|glpat-|sk_live_)[A-Za-z0-9_-]+/g, '$1…')
    .replace(SECRET_ASSIGNMENT, (m, _name: string, value: string) => m.replace(value, `${value.slice(0, 4)}…`));
}

function excerptOf(line: string, secret: boolean): string {
  const t = (secret ? mask(line) : line).trim();
  return t.length > EXCERPT_MAX ? `${t.slice(0, EXCERPT_MAX - 1)}…` : t;
}

/** Whether a decoded buffer looks binary (a NUL in its first 8 KiB). */
function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

function asText(content: string | Uint8Array): { text: string | null; bytes: number } {
  if (typeof content === 'string') return { text: content.includes('\u0000') ? null : content, bytes: Buffer.byteLength(content) };
  if (isBinary(content)) return { text: null, bytes: content.length };
  return { text: Buffer.from(content).toString('utf8'), bytes: content.length };
}

/**
 * Scan a plugin package's files. `files` paths are package-relative; a
 * Dockerfile is recognised by name (`Dockerfile`, `*.Dockerfile`,
 * `Dockerfile.*`). Deterministic: findings come back in file then line order.
 */
export function scanPluginSourceHeuristics(files: readonly HeuristicsInputFile[]): HeuristicsReport {
  const findings: HeuristicFinding[] = [];
  const skippedFiles: string[] = [];
  const seen = new Set<string>();
  let scannedFiles = 0;
  let budget = HEURISTICS_MAX_TOTAL_BYTES;

  const add = (f: HeuristicFinding): void => {
    const key = `${f.id}|${f.path}|${f.line}`;
    if (seen.has(key) || findings.length >= HEURISTICS_MAX_FINDINGS) return;
    seen.add(key);
    findings.push(f);
  };

  for (const file of files) {
    const { text, bytes } = asText(file.content);
    if (text === null || bytes > HEURISTICS_MAX_FILE_BYTES || bytes > budget) {
      skippedFiles.push(file.path);
      continue;
    }
    budget -= bytes;
    scannedFiles++;
    const doc = isDocFile(file.path);
    const lines = text.replace(/\r\n?/g, '\n').split('\n');

    lines.forEach((raw, idx) => {
      const line = idx + 1;
      if (ENCODED_BLOB.test(raw)) {
        add({ id: 'encoded-blob', severity: 'medium', path: file.path, line, excerpt: excerptOf(raw, false), message: 'Long single-line encoded payload' });
      }
      const scan = raw.length > LINE_SCAN_MAX ? raw.slice(0, LINE_SCAN_MAX) : raw;
      const comment = /^\s*(#|\/\/)/.test(scan);
      for (const rule of LINE_RULES) {
        if (rule.codeOnly && comment) continue;
        if (!rule.test.test(scan)) continue;
        const severity = doc && rule.docSeverity !== undefined ? rule.docSeverity : rule.severity;
        if (severity === null) continue;
        add({ id: rule.id, severity, path: file.path, line, excerpt: excerptOf(scan, rule.secret === true), message: rule.message });
      }
      const assignment = SECRET_ASSIGNMENT.exec(scan);
      if (assignment && looksLikeSecretValue(assignment[2]!)) {
        add({
          id: 'secret-default',
          severity: doc ? 'medium' : 'high',
          path: file.path,
          line,
          excerpt: excerptOf(scan, true),
          message: `High-entropy value assigned to ${assignment[1]}`,
        });
      }
    });

    // Dockerfile RUN lines that pipe a download into a shell, continuation-joined
    // (the line rule above only sees one physical line).
    if (/(^|\/)(Dockerfile(\.[^/]+)?|[^/]+\.Dockerfile)$/i.test(file.path)) {
      for (const instruction of pipeInstallers(text)) {
        const firstLine = lines.findIndex((l) => l.trim() !== '' && instruction.startsWith(l.trim().replace(/\\\s*$/, '').trim()));
        add({
          id: 'pipe-to-shell',
          severity: 'high',
          path: file.path,
          line: firstLine >= 0 ? firstLine + 1 : 1,
          excerpt: excerptOf(instruction, false),
          message: 'Download piped straight into a shell',
        });
      }
    }
  }

  return { findings, scannedFiles, skippedFiles };
}

/** The findings that fail a gate (`high`). */
export function blockingHeuristics(report: Pick<HeuristicsReport, 'findings'>): HeuristicFinding[] {
  return report.findings.filter((f) => f.severity === 'high');
}
