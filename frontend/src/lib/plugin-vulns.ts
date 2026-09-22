// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Vulnerability-scan facts of a plugin version, as the plugin service reports
 * them, and the build refusals the scan gates produce.
 *
 * A finding is FIXABLE when the scanner knows a fixed version of the affected
 * package. The platform floor (`PLUGIN_VULN_MAX_CRITICAL`) and the ecosystem
 * gate compare the FIXABLE Critical count: a Critical with no fix yet is shown,
 * but it does not fail a build. NULL counts mean the image was never scanned.
 */

/** One scanner finding: the vulnerability id and the versions that fix it. */
export interface VulnFinding {
  id: string;
  severity: string;
  /** Affected package, when the server names it. */
  package: string | null;
  /** The installed (vulnerable) version of `package`. */
  packageVersion: string | null;
  /** Versions of `package` that fix it (empty = no fix known). */
  fixedIn: string[];
}

/** What a rescan found on a version that was clean when it was built. */
export interface ScanFlag {
  critical: number;
  high: number;
  findings: VulnFinding[];
}

/** The scan columns a plugin version carries (every one optional on the wire). */
export interface VulnFacts {
  vulnCritical?: number | null;
  vulnHigh?: number | null;
  vulnCriticalFixable?: number | null;
  vulnHighFixable?: number | null;
  scannedAt?: string | null;
  scanFlaggedAt?: string | null;
  scanFlag?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Fixed versions from `fixedIn` / `fixVersions` / `fix.versions`, as a string or a list. */
function fixedVersions(o: Record<string, unknown>): string[] {
  const raw = o.fixedIn ?? o.fixVersions ?? o.fixedVersions ?? (o.fix as { versions?: unknown } | undefined)?.versions;
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(raw)) return raw.map(str).filter((s): s is string => s !== null);
  return [];
}

/** Normalize a findings list (tolerant of the id living under `id`, `cve` or `vulnerability`). */
export function normalizeVulnFindings(raw: unknown): VulnFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: VulnFinding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = str(o.id) ?? str(o.cve) ?? str(o.vulnerability) ?? str(o.vulnerabilityId);
    if (!id) continue;
    out.push({
      id,
      severity: str(o.severity) ?? 'Unknown',
      package: str(o.packageName) ?? str(o.package) ?? str(o.artifact),
      packageVersion: str(o.packageVersion) ?? str(o.installedVersion),
      fixedIn: fixedVersions(o),
    });
  }
  return out;
}

/** The stored rescan flag, or null when the version is not flagged. */
export function normalizeScanFlag(raw: unknown): ScanFlag | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return {
    critical: num(o.critical) ?? 0,
    high: num(o.high) ?? 0,
    findings: normalizeVulnFindings(o.findings ?? o.top ?? o.topFindings),
  };
}

/**
 * `CVE-2026-1 (openssl@3.0.1 → 3.0.2)` — one finding as a line of text, in the
 * same words the server's gate messages use (api-core `describeFix`).
 */
export function describeFinding(f: VulnFinding): string {
  const at = f.package ? `${f.package}${f.packageVersion ? `@${f.packageVersion}` : ''}` : null;
  const fix = f.fixedIn.length > 0 ? `→ ${f.fixedIn.join(', ')}` : '(no fix)';
  return `${f.id} (${at ? `${at} ` : ''}${fix})`;
}

// ---------------------------------------------------------------------------
// Build refusals
// ---------------------------------------------------------------------------

/** The scan-gate failure codes a plugin build can end with. */
export type ScanGateCode = 'IMAGE_SCAN_UNAVAILABLE' | 'PLUGIN_VULN_GATE';

const SCAN_GATE_CODES: readonly ScanGateCode[] = ['IMAGE_SCAN_UNAVAILABLE', 'PLUGIN_VULN_GATE'];

/** A build failure explained for a person. */
export interface BuildFailureInfo {
  /** The scan-gate code, or null for any other failure. */
  code: ScanGateCode | null;
  title: string;
  /** What happened and what to do next. */
  message: string;
  /** The findings behind a PLUGIN_VULN_GATE refusal (may be empty). */
  findings: VulnFinding[];
  /** The server's own text — the build log tail for an ordinary failure. */
  detail: string;
}

/**
 * Explain a failed build from its terminal event. The scan gates carry their
 * code in the event data (`code`, falling back to the message text) and the
 * refused findings in `findings`; every other failure is shown as the server
 * wrote it.
 */
export function buildFailureInfo(event: { message: string; data?: Record<string, unknown> }): BuildFailureInfo {
  const data = event.data ?? {};
  const declared = str(data.code) ?? str(data.errorCode) ?? str(data.reason);
  const code = SCAN_GATE_CODES.find((c) => c === declared) ?? SCAN_GATE_CODES.find((c) => event.message.includes(c)) ?? null;
  const findings = normalizeVulnFindings(data.findings ?? (data.details as Record<string, unknown> | undefined)?.findings);
  if (code === 'IMAGE_SCAN_UNAVAILABLE') {
    return {
      code,
      title: 'The image could not be scanned',
      message: 'Every plugin image is scanned for vulnerabilities before it is stored, and the scanner could not be reached '
        + 'after several attempts. Nothing was saved and your plugin quota was not used. Try the build again later.',
      findings,
      detail: event.message,
    };
  }
  if (code === 'PLUGIN_VULN_GATE') {
    return {
      code,
      title: 'Blocked by Critical vulnerabilities',
      message: 'The image has Critical vulnerabilities that already have a fix, more than this platform allows. '
        + 'Upgrade the affected packages (or the base image) to the fixed versions and build again.',
      findings,
      detail: event.message,
    };
  }
  return { code: null, title: 'Build failed', message: event.message, findings: [], detail: event.message };
}

// ---------------------------------------------------------------------------
// Lookup warnings
// ---------------------------------------------------------------------------

/** A warning a plugin lookup answers with (`POST /plugins/lookup` → `warnings[]`). */
export interface LookupWarning {
  code: string;
  message: string;
  plugin?: string;
  version?: string;
  critical?: number;
  high?: number;
  /** `VULN_FLAGGED`: the top fixable findings with their fixed versions. */
  findings?: unknown;
}

/** The lookup warning for a version a rescan flagged. */
export const VULN_FLAGGED = 'VULN_FLAGGED';

/** The 409 a lookup answers when block mode refuses a pinned flagged version. */
export const PLUGIN_VERSION_VULN_BLOCKED = 'PLUGIN_VERSION_VULN_BLOCKED';
