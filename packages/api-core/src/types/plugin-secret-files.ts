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
 * Matched on the file's path inside the package (case-insensitive). Templates
 * such as `.env.example` are allowed: they document variables, they hold no
 * values. Dependency-free.
 */

/** Suffixes that mark a dotenv file as a template rather than real values. */
const DOTENV_TEMPLATE_SUFFIXES = new Set(['example', 'sample', 'template', 'dist', 'defaults']);

export interface SecretFileKind {
  /** Human label used in the refusal message. */
  readonly label: string;
  /** True when the entry (lowercased package path, `/`-separated; `base` its last segment) is this kind. */
  readonly matches: (entry: string, base: string) => boolean;
}

export const SECRET_FILE_KINDS = {
  dotenv: {
    label: 'dotenv file',
    matches: (_entry, base) => {
      const m = /^\.env(?:\.(.+))?$/.exec(base);
      return m !== null && !(m[1] !== undefined && DOTENV_TEMPLATE_SUFFIXES.has(m[1]));
    },
  },
  ssh_private_key: {
    label: 'SSH private key',
    matches: (_entry, base) => /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/.test(base),
  },
  aws_credentials: {
    label: 'AWS credentials file',
    matches: (entry) => entry === '.aws/credentials' || entry.endsWith('/.aws/credentials'),
  },
  docker_config: {
    label: 'Docker registry credentials',
    matches: (entry) => entry === '.docker/config.json' || entry.endsWith('/.docker/config.json'),
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
} as const satisfies Record<string, SecretFileKind>;

export type SecretFileKindKey = keyof typeof SECRET_FILE_KINDS;

/**
 * The credential kind a package path is, or null when it is not one. Takes a
 * ZIP entry name or a relative file path (`\` and a leading `./` are
 * normalised). Directory entries (a trailing `/`) never match.
 */
export function secretFileKind(fileName: string): SecretFileKindKey | null {
  if (fileName.endsWith('/')) return null;
  const entry = fileName.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const base = entry.slice(entry.lastIndexOf('/') + 1);
  for (const [key, kind] of Object.entries(SECRET_FILE_KINDS) as [SecretFileKindKey, SecretFileKind][]) {
    if (kind.matches(entry, base)) return key;
  }
  return null;
}
