#!/usr/bin/env node
// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Regenerates the 1200x630 social cards (Open Graph / Twitter) in assets/ and
// copies the two the dashboard serves into frontend/public/. Each card is an
// HTML page rendered by headless Chrome, so every card shares one layout.
//
//   node scripts/gen-og-images.mjs            # all cards
//   node scripts/gen-og-images.mjs og-image   # one card
//
// Needs Google Chrome (CHROME_PATH overrides the macOS default). Text uses the
// system UI font, so render on macOS to match the committed images.
//
// Keep the numbers true: plugin count = `find deploy/plugins -name plugin-spec.yaml`,
// AI models = packages/api-core/src/constants/ai-providers.ts, compliance
// operators = docs/compliance.md#operators.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Cards served by the frontend as well as the docs site. */
const FRONTEND_COPIES = ['og-image', 'og-image-solution'];

const CARDS = {
  // Site-wide default (index.md, every docs page without its own image).
  'og-image': {
    title: ['Self-Service CI/CD', 'for AWS'],
    subtitle: 'Golden paths for developers · guardrails for platform teams',
    stats: [['119', 'Official plugins'], ['5', 'ways to build'], ['14', 'AI models'], ['native AWS', 'no vendor lock-in']],
  },
  // Governance pages: permissions, authentication, organization benefits, …
  'og-image-solution': {
    title: ['Governance,', 'Built In'],
    subtitle: 'Fine-grained RBAC · tamper-evident audit · instant session revocation',
    stats: [['RBAC', 'per-org roles'], ['Audit', 'hash-chained'], ['SSO', 'SAML / OIDC'], ['Passkeys', 'MFA · SCIM']],
  },
  'og-image-solution-b': {
    title: ['Guardrails for', 'Platform Teams'],
    subtitle: 'Policy-as-code · golden-path templates · SSO for Team & up',
    stats: [['RBAC', 'per-org roles'], ['Audit', 'hash-chained'], ['SSO', 'SAML / OIDC'], ['4 tiers', 'seats · quotas']],
  },
  'og-image-solution-c': {
    title: ['Secure by', 'Default'],
    subtitle: 'Strict mTLS mesh · signed plugins · instant session revocation',
    stats: [['mTLS', 'Istio ambient'], ['Signed', 'cosign · SBOM'], ['Passkeys', 'WebAuthn · TOTP'], ['RLS', 'per-tenant data']],
  },
  'og-image-compliance': {
    title: ['Compliance,', 'as Code'],
    subtitle: 'Block non-compliant pipelines and plugins before they exist',
    stats: [['18', 'rule operators'], ['403', 'blocked at create'], ['SOC 2', 'PCI · CIS add-ons'], ['Scans', 'scheduled · bulk']],
  },
  'og-image-audit': {
    title: ['Every Action,', 'Audited'],
    subtitle: 'Tamper-evident hash chain · full attribution · durable delivery',
    stats: [['Chained', 'per-tenant hashes'], ['Verify', 'on demand'], ['Logs', 'per-org tenants'], ['Spool', 'survives outages']],
  },
  // Plugin ecosystem pages: plugin-installing, plugin-publishing, plugins/.
  'og-image-plugins': {
    title: ['Plugins You', 'Can Trust'],
    subtitle: 'Signed · SBOM-attested · digest-pinned · moderated before listing',
    stats: [['119', 'Official plugins'], ['4', 'trust tiers'], ['CVE', 'nightly rescans'], ['Reviews', 'ratings · health']],
  },
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function page({ title, subtitle, stats }) {
  const statCells = stats.map(([value, label], i) => `
      <div class="stat"><div class="v${i === stats.length - 1 ? ' accent' : ''}">${esc(value)}</div><div class="l">${esc(label)}</div></div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; overflow: hidden; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif;
    color: #fff; position: relative;
    background:
      radial-gradient(ellipse 900px 520px at 22% 0%, #1b3a63 0%, rgba(27,58,99,0) 70%),
      linear-gradient(160deg, #0f2140 0%, #0b1628 55%, #0a1220 100%);
  }
  .brand { position: absolute; left: 72px; top: 70px; display: flex; align-items: center; gap: 22px; }
  .logo {
    width: 66px; height: 66px; border-radius: 16px;
    background: linear-gradient(135deg, #2dd4bf 0%, #10b981 100%);
    box-shadow: 0 8px 28px rgba(16,185,129,0.35);
    display: flex; align-items: center; justify-content: center;
  }
  .name { font-size: 31px; font-weight: 700; letter-spacing: -0.2px; }
  .graph { position: absolute; right: 90px; top: 78px; }
  h1 { position: absolute; left: 72px; top: 206px; font-size: 96px; line-height: 1.02; font-weight: 800; letter-spacing: -2.5px; }
  h1 .hl { color: #3b82f6; display: block; }
  .sub { position: absolute; left: 74px; top: 422px; font-size: 29px; color: #8aa4c8; letter-spacing: -0.1px; white-space: nowrap; }
  .stats { position: absolute; left: 74px; top: 478px; display: flex; gap: 54px; }
  .v { font-size: 44px; font-weight: 800; letter-spacing: -1px; line-height: 1.1; }
  .v.accent { color: #34d399; }
  .l { font-size: 19px; color: #8aa4c8; margin-top: 6px; }
  .foot { position: absolute; right: 72px; bottom: 36px; font-size: 19px; color: #7089ad; }
</style></head><body>
  <div class="brand">
    <div class="logo">
      <svg width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round">
        <circle cx="9" cy="10" r="3.4" fill="#fff" stroke="none"/><circle cx="9" cy="26" r="3.4" fill="#fff" stroke="none"/>
        <circle cx="28" cy="18" r="3.4" fill="#fff" stroke="none"/>
        <path d="M12 10h6a6 6 0 0 1 6 6v0M12 26h6a6 6 0 0 0 6-6"/>
      </svg>
    </div>
    <div class="name">Pipeline Builder</div>
  </div>
  <svg class="graph" width="240" height="110" viewBox="0 0 240 110">
    <g stroke="#3b5578" stroke-width="3"><line x1="18" y1="18" x2="220" y2="18"/><line x1="18" y1="18" x2="68" y2="88"/><line x1="118" y1="18" x2="168" y2="88"/></g>
    <circle cx="18" cy="18" r="16" fill="#3b82f6"/><circle cx="118" cy="18" r="16" fill="#60a5fa"/><circle cx="220" cy="18" r="16" fill="#22c55e"/>
    <circle cx="68" cy="88" r="16" fill="#f59e0b"/><circle cx="168" cy="88" r="16" fill="#a855f7"/>
  </svg>
  <h1>${esc(title[0])}<span class="hl">${esc(title[1])}</span></h1>
  <div class="sub">${esc(subtitle)}</div>
  <div class="stats">${statCells}
  </div>
  <div class="foot">github.com/mwashburn160/pipeline-builder · Apache-2.0</div>
</body></html>`;
}

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(CARDS);
const work = mkdtempSync(join(tmpdir(), 'og-images-'));
try {
  for (const name of names) {
    const card = CARDS[name];
    if (!card) throw new Error(`unknown card "${name}" (known: ${Object.keys(CARDS).join(', ')})`);
    const html = join(work, `${name}.html`);
    writeFileSync(html, page(card));
    const out = join(root, 'assets', `${name}.png`);
    execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--window-size=1200,630', `--screenshot=${out}`, `file://${html}`,
    ], { stdio: 'ignore' });
    if (FRONTEND_COPIES.includes(name)) copyFileSync(out, join(root, 'frontend', 'public', `${name}.png`));
    console.log(`wrote assets/${name}.png`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
