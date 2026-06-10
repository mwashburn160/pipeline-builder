// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * On-demand fetch of single-binary prerequisites (e.g. `yq`) so provision can
 * satisfy a missing host tool WITHOUT a system install (no brew/apt). The binary
 * is downloaded into a per-user cache dir; the caller prepends that dir to PATH
 * so both the prereq checks (`has()` → `command -v`) and the deploy (`bash -lc`,
 * which inherits process.env.PATH) find it.
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Cache dir for fetched tool binaries (kept across runs so we fetch once). */
export const TOOLS_DIR = path.join(os.homedir(), '.pipeline-manager', 'tools');

/**
 * Tools that are a single self-contained binary we can fetch on demand, keyed by
 * the prereq-check name. Each entry builds the release-asset URL for the host's
 * OS + arch (assets use darwin|linux and arm64|amd64). Builders may resolve a
 * version first (kubectl) — failures throw and fetchTool() reports them.
 *
 * NOT fetchable here (they aren't relocatable single binaries — keep the
 * system/external install + the prereq block's instruction):
 *   - git      → Xcode Command Line Tools (`xcode-select --install`) or `brew install git`
 *   - docker / docker compose → Docker Desktop (external host requirement)
 *   - aws      → AWS CLI v2 is a pkg/zip installer, not a drop-in binary
 *   - openssl  → ships with macOS/Linux; install via the system package manager
 */
const FETCHABLE: Record<string, (osId: string, arch: string) => string> = {
  yq: (osId, arch) => `https://github.com/mikefarah/yq/releases/latest/download/yq_${osId}_${arch}`,
  minikube: (osId, arch) => `https://storage.googleapis.com/minikube/releases/latest/minikube-${osId}-${arch}`,
  kubectl: (osId, arch) => {
    const ver = execSync('curl -fsSL https://dl.k8s.io/release/stable.txt', { timeout: 15000 }).toString().trim();
    return `https://dl.k8s.io/release/${ver}/bin/${osId}/${arch}/kubectl`;
  },
};

/** True when `tool` is a single-binary prereq provision knows how to fetch. */
export function isFetchable(tool: string): boolean {
  return tool in FETCHABLE;
}

/** Host OS + arch in the naming the release assets use. */
function hostOsArch(): { osId: string; arch: string } {
  const osId = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  return { osId, arch };
}

/**
 * Download `tool` into {@link TOOLS_DIR} (idempotent — skips if already present)
 * and mark it executable. Returns true on success. Single-quoted args are
 * injection-safe; `tool` is only ever a known key from {@link FETCHABLE}.
 */
export function fetchTool(tool: string): boolean {
  const urlFor = FETCHABLE[tool];
  if (!urlFor) return false;
  const dest = path.join(TOOLS_DIR, tool);
  if (existsSync(dest)) return true;
  const { osId, arch } = hostOsArch();
  try {
    mkdirSync(TOOLS_DIR, { recursive: true });
    execSync(`curl -fsSL --output '${dest}' '${urlFor(osId, arch)}' && chmod +x '${dest}'`, { stdio: 'ignore', timeout: 120000 });
    return existsSync(dest);
  } catch {
    return false;
  }
}

/** Prepend the tools cache dir to PATH so fetched binaries are discoverable. */
export function withToolsOnPath(): void {
  if (!process.env.PATH?.split(path.delimiter).includes(TOOLS_DIR)) {
    process.env.PATH = `${TOOLS_DIR}${path.delimiter}${process.env.PATH ?? ''}`;
  }
}
