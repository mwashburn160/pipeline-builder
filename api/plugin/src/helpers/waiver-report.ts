// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reporting for `PLUGIN_VULN_WAIVERS`, in its OWN module.
 *
 * It lived in index.ts, and the rescan scheduler reached it with
 * `await import('../index.js')` — which pulls the entire service bootstrap in
 * behind it. A scheduler tick does not want the server entry point, and under
 * test it fails outright on the transitive module graph. Two callers that are
 * not each other's entry point need a module neither of them owns.
 */

import { createLogger, parseVulnWaiversVerbose, vulnWaiverLabels } from '@pipeline-builder/api-core';
import { resetGauge, setGauge } from '@pipeline-builder/api-server';

const logger = createLogger('plugin-vuln-waivers');

/**
 * Say what `PLUGIN_VULN_WAIVERS` actually parsed to, at boot.
 *
 * The parser DROPS anything it does not fully understand, which is the right
 * direction — a typo must not become a wildcard — but silently dropping it is a
 * trap: the operator writes a waiver, the gate carries on blocking, and nothing
 * anywhere explains why. The likeliest failure of this feature is a malformed
 * entry, not a malicious one.
 *
 * Expiry is published as a gauge as well, because expiry is the whole mechanism
 * and nothing otherwise warns before it fires — the first sign would be a build
 * that used to pass starting to fail. The gauge is refreshed on every rescan
 * too, so it does not go stale between restarts.
 *
 * ONE SERIES PER ENTRY, labelled `{plugin, targets}` — `plugin` carrying the
 * `@version` pin, `targets` the comma-joined packages/advisories. Labelled by
 * plugin alone, every fleet-wide `*` entry and every pinned entry of the same
 * plugin collapsed onto one series and the last write won, so an entry expiring
 * next week could be hidden behind one expiring next year. And the series set is
 * RESET before each report: a gauge for an entry since deleted from the env
 * otherwise keeps its last value forever, and PluginVulnWaiverExpiringSoon goes
 * on firing for an exemption that no longer exists.
 */
export function reportVulnWaivers(): void {
  const { waivers, problems } = parseVulnWaiversVerbose();
  for (const p of problems) {
    logger.error('PLUGIN_VULN_WAIVERS entry IGNORED — the gate still blocks for it', { entry: p.entry, reason: p.reason });
  }
  setGauge('plugin_vuln_waivers_invalid', {}, problems.length);
  const now = Date.now();
  resetGauge('plugin_vuln_waiver_days_remaining');
  for (const w of waivers) {
    const days = Math.floor((w.expires.getTime() - now) / 86_400_000);
    logger.info('PLUGIN_VULN_WAIVERS entry active', {
      plugin: w.plugin,
      version: w.version ?? '(every version)',
      packages: w.packages.join(', '),
      expires: w.expires.toISOString().slice(0, 10),
      daysRemaining: days,
    });
    // Negative for an entry already past its date: it does nothing, and an
    // operator should be able to see that rather than assume it still covers
    // them. Labelled per ENTRY so a single expiry can be alerted on by name.
    setGauge('plugin_vuln_waiver_days_remaining', vulnWaiverLabels(w), days);
  }
}
