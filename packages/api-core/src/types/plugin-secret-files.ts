// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Credential files that must never ride inside a plugin package — ONE keyed
 * catalog shared by both ends: the plugin service refuses an uploaded ZIP that
 * carries one, and the CLI's packer (`pipeline-manager plugin publish`) refuses
 * to pack one, so a developer's `.env` or SSH key is caught on their machine
 * before it is uploaded.
 *
 * A plugin directory is packed wholesale, so such a file would be uploaded,
 * staged in object storage, sent to BuildKit as build context — and, under the
 * usual `COPY . .`, baked into an image that may be published.
 *
 * Most kinds are decided by the file's path inside the package
 * (case-insensitive). A few are decided by CONTENT, because the name alone is
 * shared with harmless files: a `.pem` may be a CA certificate, a `.json` is
 * usually config, an `.npmrc` usually just names a registry. For those the
 * name only makes the file a candidate ({@link secretFileNeedsContent}) and
 * the caller passes the first {@link SECRET_FILE_CONTENT_SCAN_BYTES} of it —
 * the server reads the ZIP entry, the CLI the local file.
 *
 * Allowed on purpose: dotenv templates (`.env.example`, `example.env`, …:
 * they document variables, they hold no values), public keys (`*.pub`, a
 * `PUBLIC KEY` PEM), certificate-only files, and a token line whose value is
 * only an env-var reference (`_authToken=${NPM_TOKEN}`, how CI injects it).
 * Dependency-free.
 */

/** Words that mark a dotenv file as a template rather than real values (any dot segment of the name). */
const DOTENV_TEMPLATE_WORDS = new Set(['example', 'sample', 'template', 'dist', 'defaults']);

/** How much of a content-decided file the caller reads and passes (a key or token sits near the top). */
export const SECRET_FILE_CONTENT_SCAN_BYTES = 1024 * 1024;

export interface SecretFileKind {
  /** Human label used in the refusal message. */
  readonly label: string;
  /**
   * True when the entry (lowercased package path, `/`-separated; `base` its
   * last segment) is this kind — or, for a kind with {@link content}, is a
   * candidate whose content decides.
   */
  readonly matches: (entry: string, base: string) => boolean;
  /** For a content-decided kind: true when the file's (leading) text holds the credential. */
  readonly content?: (text: string, base: string) => boolean;
}

const isTemplateName = (base: string): boolean => base.split('.').some((seg) => DOTENV_TEMPLATE_WORDS.has(seg));
const atPath = (entry: string, p: string): boolean => entry === p || entry.endsWith(`/${p}`);

/** A PEM private-key block of any flavour (PKCS#8, RSA, EC, OPENSSH, ENCRYPTED, PGP). */
const PRIVATE_KEY_PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
/** Text that is plainly public material: a certificate, a public key PEM/PGP block, an OpenSSH public key line. */
const PUBLIC_MATERIAL = /-----BEGIN (?:CERTIFICATE|TRUSTED CERTIFICATE|X509 CRL|[A-Z0-9 ]*PUBLIC KEY(?: BLOCK)?)-----|^(?:ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9-@.]+) [A-Za-z0-9+/=]+/m;

/** A token value that is real (not empty, not just a `${VAR}` / `$VAR` reference). */
function isLiteralToken(raw: string): boolean {
  const v = raw.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  return v.length > 0 && !/^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/.test(v);
}
const anyLine = (text: string, re: RegExp): boolean =>
  text.split(/\r?\n/).some((line) => { const m = re.exec(line); return m !== null && isLiteralToken(m[1] ?? ''); });

export const SECRET_FILE_KINDS = {
  dotenv: {
    label: 'dotenv file',
    // `.env`, `.env.production`, and `prod.env`; never a template (`.env.example`, `example.env`).
    matches: (_entry, base) => (base === '.env' || base.startsWith('.env.') || (base.endsWith('.env') && base.length > 4))
      && !isTemplateName(base),
  },
  direnv: {
    label: 'direnv file',
    matches: (_entry, base) => base === '.envrc',
  },
  ssh_private_key: {
    label: 'SSH private key',
    matches: (_entry, base) => /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/.test(base),
  },
  aws_credentials: {
    label: 'AWS credentials file',
    matches: (entry) => atPath(entry, '.aws/credentials'),
  },
  docker_config: {
    label: 'Docker registry credentials',
    matches: (entry) => atPath(entry, '.docker/config.json'),
  },
  kubeconfig: {
    label: 'Kubernetes kubeconfig',
    matches: (entry) => atPath(entry, '.kube/config'),
  },
  gcloud_adc: {
    label: 'gcloud application-default credentials',
    matches: (_entry, base) => base === 'application_default_credentials.json',
  },
  netrc: {
    label: 'netrc credentials file',
    matches: (_entry, base) => base === '.netrc' || base === '_netrc',
  },
  git_credentials: {
    label: 'git credentials file',
    matches: (_entry, base) => base === '.git-credentials',
  },
  pypirc: {
    label: 'PyPI credentials file',
    matches: (_entry, base) => base === '.pypirc',
  },
  pkcs12: {
    label: 'PKCS#12 key bundle',
    matches: (_entry, base) => base.endsWith('.p12') || base.endsWith('.pfx'),
  },
  // -- Content-decided kinds (the name makes a candidate; the text decides) --
  private_key: {
    label: 'private key',
    matches: (_entry, base) => base.endsWith('.pem') || base.endsWith('.key'),
    // A `.pem` is refused only for a private-key block (a CA bundle is fine);
    // a `.key` unless it is plainly public material (an apt/PGP signing key, a
    // public-key PEM) — an opaque one (DER, a Rails `master.key`) is a secret.
    content: (text, base) => PRIVATE_KEY_PEM.test(text)
      || (base.endsWith('.key') && text.trim().length > 0 && !PUBLIC_MATERIAL.test(text)),
  },
  gcp_service_account: {
    label: 'cloud service-account key',
    matches: (_entry, base) => base.endsWith('.json'),
    content: (text) => /"type"\s*:\s*"service_account"/.test(text) && /"private_key"\s*:\s*"/.test(text),
  },
  npmrc_token: {
    label: 'npm auth token (.npmrc)',
    matches: (_entry, base) => base === '.npmrc',
    content: (text) => anyLine(text, /^\s*(?:\/\/\S*:)?_auth(?:token)?\s*=(.*)$/i),
  },
  yarnrc_token: {
    label: 'npm auth token (.yarnrc.yml)',
    matches: (_entry, base) => base === '.yarnrc.yml' || base === '.yarnrc.yaml',
    content: (text) => anyLine(text, /^\s*npmAuthToken\s*:(.*)$/),
  },
} as const satisfies Record<string, SecretFileKind>;

export type SecretFileKindKey = keyof typeof SECRET_FILE_KINDS;

const KIND_ENTRIES = Object.entries(SECRET_FILE_KINDS) as [SecretFileKindKey, SecretFileKind][];

/** Normalise a ZIP entry name / relative path: `\` and a leading `./`; lowercase. Null for a directory entry. */
function normalise(fileName: string): { entry: string; base: string } | null {
  if (fileName.endsWith('/')) return null;
  const entry = fileName.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  return { entry, base: entry.slice(entry.lastIndexOf('/') + 1) };
}

/**
 * True when the path alone cannot decide and the caller must pass the file's
 * leading {@link SECRET_FILE_CONTENT_SCAN_BYTES} to {@link secretFileKind}.
 * False for a path a name-only kind already refuses, or one no kind concerns.
 */
export function secretFileNeedsContent(fileName: string): boolean {
  const n = normalise(fileName);
  if (!n) return false;
  if (KIND_ENTRIES.some(([, k]) => !k.content && k.matches(n.entry, n.base))) return false;
  return KIND_ENTRIES.some(([, k]) => k.content && k.matches(n.entry, n.base));
}

/**
 * The credential kind a package path is, or null when it is not one. Takes a
 * ZIP entry name or a relative file path (`\` and a leading `./` are
 * normalised). Directory entries (a trailing `/`) never match. A
 * content-decided kind matches only when `content` (the file's leading text)
 * is passed and holds the credential — pass it whenever
 * {@link secretFileNeedsContent} says so.
 */
export function secretFileKind(fileName: string, content?: string): SecretFileKindKey | null {
  const n = normalise(fileName);
  if (!n) return null;
  for (const [key, kind] of KIND_ENTRIES) {
    if (!kind.matches(n.entry, n.base)) continue;
    if (!kind.content) return key;
    if (content !== undefined && kind.content(content, n.base)) return key;
  }
  return null;
}
