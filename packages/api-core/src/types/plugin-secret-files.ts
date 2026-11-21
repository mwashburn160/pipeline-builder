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
 * (case-insensitive). Others are decided by CONTENT, because the name alone is
 * shared with harmless files: a `.pem` may be a CA certificate, a `.json` is
 * usually config, an `.npmrc` / `pip.conf` / Maven `settings.xml` usually just
 * names a registry. For those the name only makes the file a candidate
 * ({@link secretFileNeedsContent}) and the caller passes the first
 * {@link SECRET_FILE_CONTENT_SCAN_BYTES} of it — the server reads the ZIP
 * entry, the CLI the local file. A complete private-key block (or a PuTTY key)
 * is refused under ANY name, so every file except a `.tar` is a content
 * candidate unless its name already decides it.
 *
 * Allowed on purpose: dotenv templates (`.env.example`, `example.env`, …:
 * they document variables, they hold no values), public keys (`*.pub`, a
 * `PUBLIC KEY` PEM), certificate-only files, and a token / password whose
 * value is only an env-var reference (`_authToken=${NPM_TOKEN}`, Maven's
 * `${env.MAVEN_PASSWORD}`: how CI injects it).
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

/** A whole value that is only an env-var reference: `${VAR}`, `$VAR`, or Maven's `${env.VAR}`. */
const ENV_REFERENCE = /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\}|[A-Za-z_][A-Za-z0-9_]*)$/;

/** A token value that is real (not empty, not just a `${VAR}` / `$VAR` / `${env.VAR}` reference). */
function isLiteralToken(raw: string): boolean {
  const v = raw.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  return v.length > 0 && !ENV_REFERENCE.test(v);
}

/**
 * A COMPLETE private-key block of any flavour (PKCS#1 / PKCS#8 / EC / DSA /
 * OPENSSH / ENCRYPTED / PGP): matching BEGIN and END labels around a base64
 * body (PGP armour headers allowed), so a README quoting the header line, a
 * `...` placeholder, or a script grepping for it is not one.
 */
const PRIVATE_KEY_BLOCK = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----[ \t]*\r?\n(?:[A-Za-z-]+: [^\r\n]*\r?\n)*(?:[ \t]*\r?\n)?(?:[ \t]*[A-Za-z0-9+/=]+[ \t]*\r?\n){1,}-----END \1-----/;
/** A PuTTY private key file: its header, then (on a later line) its private-key lines. */
const PUTTY_HEADER = /^PuTTY-User-Key-File-\d+: \S+/m;
const PUTTY_PRIVATE_LINES = /^Private-Lines: \d+/m;

/**
 * Two linear searches, not one `header[\s\S]*^Private-Lines` regex: that one
 * rescans to the end from every header line, so a file of header lines
 * (any name: every file is a candidate) stalled the scan quadratically.
 */
function holdsPuttyKey(text: string): boolean {
  const header = PUTTY_HEADER.exec(text);
  return header !== null && PUTTY_PRIVATE_LINES.test(text.slice(header.index + header[0].length));
}

/** True when `text` holds a private key (literally, or inside a string with escaped `\n`s). */
function holdsPrivateKey(text: string): boolean {
  if (PRIVATE_KEY_BLOCK.test(text) || holdsPuttyKey(text)) return true;
  if (!text.includes('PRIVATE KEY')) return false;
  const unescaped = text.replace(/\\r\\n|\\n/g, '\n');
  return unescaped !== text && PRIVATE_KEY_BLOCK.test(unescaped);
}

/**
 * Every `<tag>…</tag>` body in an XML text (each `<tag>` up to the next `</tag>`).
 * indexOf, not a lazy `<tag>([\s\S]*?)</tag>` regex, which rescans to the end
 * from every unclosed `<tag>` (quadratic on a crafted file).
 */
function xmlValues(text: string, tag: string): string[] {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const out: string[] = [];
  for (let i = text.indexOf(open); i >= 0;) {
    const start = i + open.length;
    const end = text.indexOf(close, start);
    if (end < 0) break;
    out.push(text.slice(start, end));
    i = text.indexOf(open, end + close.length);
  }
  return out;
}

/**
 * A URL with credentials in it: `scheme://user:password@` with a literal
 * password, or `scheme://token@` with a literal token as the user (how
 * GitLab / Gemfury / Artifactory tokens ride in an index URL).
 */
function urlHoldsCredentials(text: string): boolean {
  // Only the scheme's last character is matched: a `[a-z][a-z0-9+.-]*://` prefix
  // is retried from every character of a long scheme-like run (quadratic).
  for (const m of text.matchAll(/[a-z0-9+.-]:\/\/([^\s/@]+)@/gi)) {
    const userinfo = m[1]!;
    const colon = userinfo.indexOf(':');
    if (isLiteralToken(colon >= 0 ? userinfo.slice(colon + 1) : userinfo)) return true;
  }
  return false;
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
  putty_private_key: {
    label: 'PuTTY private key',
    matches: (_entry, base) => base.endsWith('.ppk'),
  },
  pkcs8_private_key: {
    // `.p8` is PKCS#8 private-key syntax (Apple's AuthKey_*.p8, Snowflake key-pair auth).
    label: 'PKCS#8 private key',
    matches: (_entry, base) => base.endsWith('.p8'),
  },
  gem_credentials: {
    label: 'RubyGems credentials file',
    matches: (entry) => atPath(entry, '.gem/credentials'),
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
    // `_authToken`, `_auth` (base64 user:pass) and `_password` (base64, beside `username`).
    content: (text) => anyLine(text, /^\s*(?:\/\/\S*:)?_(?:auth(?:token)?|password)\s*=(.*)$/i),
  },
  yarnrc_token: {
    label: 'npm auth token (.yarnrc.yml)',
    matches: (_entry, base) => base === '.yarnrc.yml' || base === '.yarnrc.yaml',
    // npmAuthToken, or npmAuthIdent (`user:password` or its base64).
    content: (text) => anyLine(text, /^\s*npmAuth(?:Token|Ident)\s*:(.*)$/),
  },
  maven_settings: {
    label: 'Maven settings.xml with a password',
    matches: (_entry, base) => base === 'settings.xml',
    // A server `<password>` / key `<passphrase>` (an `{…}` encrypted one still decrypts with the master key);
    // `${env.VAR}` interpolation is how CI injects it.
    content: (text) => [...xmlValues(text, 'password'), ...xmlValues(text, 'passphrase')].some(isLiteralToken),
  },
  pip_conf: {
    label: 'pip configuration with credentials',
    matches: (_entry, base) => base === 'pip.conf' || base === 'pip.ini',
    // Credentials in an index-url / extra-index-url / find-links URL, or a `password` key.
    content: (text) => urlHoldsCredentials(text) || anyLine(text, /^\s*password\s*[=:](.*)$/i),
  },
  cargo_credentials: {
    label: 'Cargo registry credentials',
    matches: (entry) => atPath(entry, '.cargo/credentials') || atPath(entry, '.cargo/credentials.toml'),
    content: (text) => anyLine(text, /^\s*(?:token|secret-key)\s*=(.*)$/),
  },
  gh_hosts: {
    label: 'GitHub CLI token (gh hosts.yml)',
    matches: (entry) => atPath(entry, 'gh/hosts.yml') || atPath(entry, 'gh/hosts.yaml'),
    content: (text) => anyLine(text, /^\s*oauth_token\s*:(.*)$/),
  },
  // Last, so a more specific kind above names the file first: a private key under
  // ANY name (a heredoc in a script, a key string in code, an extensionless key file).
  // A tar is skipped — a prebuilt `image.tar` carries OS packages' own test keys.
  private_key_content: {
    label: 'private key',
    matches: (_entry, base) => !base.endsWith('.tar'),
    content: (text) => holdsPrivateKey(text),
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
