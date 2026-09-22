// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate the in-app help topics FROM `docs/*.md` — the single source of truth
 * (the same corpus the Ask agent grounds on). Eliminates the hand-copy drift
 * between the help center and the docs.
 *
 * For each manifest entry it parses the mapped markdown doc into the structured
 * `HelpTopic` (sections of typed `ContentBlock`s the help renderer expects) and
 * writes `src/lib/help/generated/<id>.ts`. The manifest supplies the metadata
 * markdown lacks: the lucide icon, the display title/description, and the source
 * doc. Docs-less topics (getting-started, ai-generation, registry, pipelines,
 * plugins) stay hand-authored and are NOT listed here.
 *
 * Every product and operations doc under `docs/` is mapped. Deliberately absent:
 * the two indexes (`README.md`, `content-index.md`), which are link lists; the
 * per-category plugin docs under `docs/plugins/`, which the hand-authored
 * `plugins` topic already covers; and the two repo-contributor docs
 * (`testing.md`, `permission-contract.md`), which document the test suite rather
 * than the product.
 *
 * Run: `npm run generate:help` (from frontend/). Idempotent.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(HERE, '..');
const DOCS = join(FRONTEND, '..', 'docs');
// `HELP_OUT_DIR` redirects the output. Only the drift guard in
// `test/help-generated-drift.test.ts` sets it: it regenerates into a temp dir and
// compares, so a docs edit that was never regenerated fails the build instead of
// silently shipping stale help (which is how the deploy topic kept advertising a
// password the platform had started refusing as breached).
const OUT = process.env.HELP_OUT_DIR
  ? resolve(process.env.HELP_OUT_DIR)
  : join(FRONTEND, 'src', 'lib', 'help', 'generated');

/** id → { icon (lucide), title, description, doc (basename under docs/) }. */
const MANIFEST = [
  { id: 'organization-benefits', icon: 'Building2', title: 'Organization Benefits', description: 'How Pipeline Builder transforms CI/CD for engineering organizations', doc: 'organization-benefits.md' },
  { id: 'architecture-flow', icon: 'Workflow', title: 'Architecture & Flow', description: 'How Pipeline Builder turns plugins and pipelines into running AWS CodePipelines', doc: 'architecture-flow.md' },
  { id: 'developer-guide', icon: 'Code2', title: 'Developer Guide', description: 'Practical benefits and workflows for developers using Pipeline Builder', doc: 'developer-guide.md' },
  { id: 'templates', icon: 'Braces', title: 'Templates', description: 'Synth-time {{ … }} templating for pipelines and plugins', doc: 'templates.md' },
  { id: 'metadata-keys', icon: 'KeyRound', title: 'Metadata Keys', description: 'Strongly-typed keys for customizing CodePipeline and CodeBuild resources at synth time', doc: 'metadata-keys.md' },
  { id: 'cdk-usage', icon: 'Boxes', title: 'CDK Usage', description: 'Define pipelines as infrastructure-as-code with the PipelineBuilder CDK construct', doc: 'cdk-usage.md' },
  { id: 'samples', icon: 'FolderGit2', title: 'Samples', description: 'Ready-to-use pipeline configurations and CDK examples', doc: 'samples.md' },
  { id: 'compliance', icon: 'ShieldCheck', title: 'Compliance', description: 'Per-organization rule enforcement for plugins and pipelines', doc: 'compliance.md' },
  { id: 'audit-events', icon: 'ScrollText', title: 'Audit Events', description: 'How Pipeline Builder records and surfaces audit events', doc: 'audit-events.md' },
  { id: 'api-reference', icon: 'Code', title: 'API Reference', description: 'REST API endpoints and usage examples', doc: 'api-reference.md' },
  { id: 'env-variables', icon: 'FileCode', title: 'Environment Variables', description: 'Configuration reference for all services', doc: 'environment-variables.md' },
  { id: 'deployment', icon: 'Server', title: 'Deployment', description: 'Install with the pipeline-manager CLI, plus Local, Minikube, and AWS guides', doc: 'aws-deployment.md' },
  { id: 'cli-reference', icon: 'Terminal', title: 'CLI Reference', description: 'Pipeline Manager CLI commands and usage', doc: 'pipeline-manager.md' },
  { id: 'onboarding', icon: 'Rocket', title: 'Onboarding an Organization', description: 'First admin: login, org, members, access keys, event reporting, first pipeline', doc: 'onboarding.md' },
  { id: 'plugin-publishing', icon: 'Store', title: 'Plugin Publishing', description: 'Publish plugins to the ecosystem: publisher profile, listings limits, publish requests, accept-or-edit metadata, review', doc: 'plugin-publishing.md' },
  { id: 'plugin-installing', icon: 'PackagePlus', title: 'Plugin Installing', description: 'Use ecosystem plugins: the catalog, installs and version policies, implicit Official installs, consumption policy, publisher references', doc: 'plugin-installing.md' },
  { id: 'developer-portal', icon: 'LayoutDashboard', title: 'Developer Portal', description: 'Catalog ownership, My Services, golden-path templates, maturity scorecards', doc: 'developer-portal.md' },
  { id: 'authentication', icon: 'Lock', title: 'Authentication & SSO', description: 'Sign-in, MFA and assurance, enterprise SSO (OIDC / SAML), sessions and machine credentials', doc: 'authentication.md' },
  { id: 'permissions', icon: 'UserCog', title: 'Roles & Permissions', description: 'Permission catalog, built-in Roles, enforcement, session invalidation', doc: 'permissions.md' },
  { id: 'billing-providers', icon: 'CreditCard', title: 'Billing Providers', description: 'Stripe and AWS Marketplace setup — keys, webhooks, entitlements, metering', doc: 'billing-providers.md' },
  { id: 'billing-bundles', icon: 'Package', title: 'Billing Add-on Bundles', description: 'Stackable add-ons that raise pooled caps (seats, pipelines, plugins, storage)', doc: 'billing-bundles.md' },
  { id: 'billing-discounts', icon: 'BadgePercent', title: 'Billing Discounts', description: 'Coupon codes and usage credits — one-time, recurring, or credit grants', doc: 'billing-discounts.md' },
  { id: 'deploy-operations', icon: 'Wrench', title: 'Deploy Operations', description: 'Operator runbook — preflight, secret rotation, backups & DR, teardown', doc: 'deploy-operations.md' },
  { id: 'service-mesh', icon: 'Network', title: 'Service Mesh', description: 'Istio ambient — STRICT mTLS, identity-based L4 authorization, per-route L7 policy', doc: 'service-mesh.md' },
  { id: 'observability-logs', icon: 'FileSearch', title: 'Logs', description: 'Per-organization application logs — search syntax, entry detail, download, masking', doc: 'observability-logs.md' },
  { id: 'dora-metrics', icon: 'Gauge', title: 'DORA Metrics', description: 'Deploy frequency, change-failure rate, MTTR, measured lead time, build health', doc: 'dora-metrics.md' },
  { id: 'incidents-webhook', icon: 'Siren', title: 'Incident Webhook', description: 'Point PagerDuty, Datadog or Alertmanager at the platform for automated CFR and MTTR', doc: 'incidents-webhook.md' },
  { id: 'error-handling', icon: 'TriangleAlert', title: 'Error Handling', description: 'The error-to-HTTP convention and the typed AppError catalog', doc: 'error-handling.md' },
];

const camel = (id) => id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';

/**
 * Strip inline markdown to plain text (the help renderer shows text, not markdown).
 * Iterates so nested emphasis (bold containing italic) fully unwraps, and never
 * strips a lone `_` so snake_case identifiers survive.
 */
function stripInline(s) {
  let prev;
  do {
    prev = s;
    s = s
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')       // images → alt text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')         // links → text
      .replace(/`([^`]+)`/g, '$1')                      // inline code
      .replace(/\*\*([\s\S]+?)\*\*/g, '$1')             // bold (non-greedy; may wrap italic)
      .replace(/__([\s\S]+?)__/g, '$1')                 // bold (underscore)
      .replace(/\*([^*\s][\s\S]*?)\*/g, '$1');          // italic (paired *, not ** or a lone *)
  } while (s !== prev);
  return s.trim();
}

/** Parse a markdown table block (rows of `| a | b |`, with a `|---|` separator). */
function parseTable(lines) {
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => stripInline(c.trim()));
  const headers = cells(lines[0]);
  const rows = lines.slice(2).map(cells);
  return { type: 'table', headers, rows };
}

const SUBHEAD = ' H:'; // sentinel marking an H3+ heading captured as a lead-in

/**
 * Convert a block of markdown lines into typed ContentBlocks. Reusable so a
 * blockquote's inner content (after stripping `> `) is parsed the SAME way —
 * that's what keeps code fences, lists, and multi-paragraph text inside a
 * blockquote intact instead of leaking raw `>`-prefixed markup.
 */
function parseBlocks(lines) {
  const blocks = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    const t = stripInline(para.join(' ').replace(/\s+/g, ' ')).trim();
    if (t) blocks.push({ type: 'text', content: t });
    para = [];
  };
  const flushList = () => { if (list) { blocks.push({ type: 'list', items: list }); list = null; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // H3+ lead-in (captured by toSections as a sentinel) → a text block.
    if (line.startsWith(SUBHEAD)) { flushPara(); flushList(); blocks.push({ type: 'text', content: line.slice(SUBHEAD.length) }); continue; }

    // Fenced code block (tolerate an info string after the language).
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      flushPara(); flushList();
      const lang = fence[1];
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
      blocks.push(lang ? { type: 'code', content: code.join('\n'), language: lang } : { type: 'code', content: code.join('\n') });
      continue;
    }

    // Table (header row + a |---| separator).
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushPara(); flushList();
      const tbl = [line];
      let j = i + 1;
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) { tbl.push(lines[j]); j++; }
      blocks.push(parseTable(tbl));
      i = j - 1;
      continue;
    }

    // Blockquote → accumulate the consecutive `>` lines, strip the prefix, and
    // recurse so nested code/lists/paragraphs are parsed properly. A short
    // single-paragraph quote becomes a note/warning callout; a rich multi-block
    // quote is inlined as its constituent blocks (correct content over styling).
    if (/^>/.test(line)) {
      flushPara(); flushList();
      const inner = [];
      while (i < lines.length && /^>/.test(lines[i])) { inner.push(lines[i].replace(/^>\s?/, '')); i++; }
      i--;
      const innerBlocks = parseBlocks(inner);
      if (innerBlocks.length === 1 && innerBlocks[0].type === 'text') {
        const c = innerBlocks[0].content;
        const warn = /^(⚠|warning|caution|danger)/i.test(c);
        blocks.push({ type: warn ? 'warning' : 'note', content: c });
      } else {
        blocks.push(...innerBlocks);
      }
      continue;
    }

    // List item (unordered or ordered) → fold into one list block.
    const li = line.match(/^\s*[-*+]\s+(.*)$/) || line.match(/^\s*\d+\.\s+(.*)$/);
    if (li) { flushPara(); if (!list) list = []; list.push(stripInline(li[1])); continue; }

    // Horizontal rule / blank → flush both (rule and blank both end a block).
    if (/^(---+|\*\*\*+)\s*$/.test(line)) { flushPara(); flushList(); continue; }
    if (line.trim() === '') { flushPara(); flushList(); continue; }

    // Paragraph text — flush any pending list FIRST so ordering stays correct
    // (a paragraph right after a list must come after the list block).
    flushList();
    para.push(line);
  }
  flushPara(); flushList();
  return blocks;
}

/** Convert a doc's markdown body into HelpSections (split on H2). */
function toSections(md) {
  // Strip Jekyll frontmatter + liquid tags ({% raw %}, {% endraw %}, …).
  const body = md.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/\{%[^%]*%\}/g, '');
  const lines = body.split('\n');

  const sections = [];
  let current = { id: 'overview', title: 'Overview', lines: [] };
  const push = () => {
    const blocks = parseBlocks(current.lines);
    if (blocks.length) sections.push({ id: current.id, title: current.title, blocks });
  };

  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const title = stripInline(h[2]);
      if (level === 1) continue;                 // topic title comes from the manifest
      if (level === 2) { push(); current = { id: slug(title), title, lines: [] }; continue; }
      current.lines.push(`${SUBHEAD}${title}`);  // H3+ → a lead-in text block
      continue;
    }
    current.lines.push(line);
  }
  push();
  return sections;
}

/** Emit a topic module (icon import + typed HelpTopic export). */
function emit(entry, sections, sourceSha) {
  const varName = `${camel(entry.id)}Topic`;
  // The source doc's digest travels with the generated file so freshness is a
  // string comparison, not a regeneration: `test/help-generated-drift.test.ts`
  // hashes `docs/` and checks these, catching a docs edit that skipped
  // `npm run generate:help`. Cheap on purpose — it runs inside the normal jest
  // run, where spawning a generator would compete with the render-heavy suites.
  const header = `// GENERATED FROM docs/${entry.doc} — DO NOT EDIT.\n// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)\n// SOURCE-SHA256: ${sourceSha}\n// SPDX-License-Identifier: Apache-2.0\n`;
  const topic = {
    id: entry.id,
    title: entry.title,
    description: entry.description,
    sections,
    sourceDoc: `docs/${entry.doc}`,
  };
  // JSON.stringify the data, then splice in the runtime `icon` value (a lucide import).
  const dataJson = JSON.stringify(topic, null, 2).replace(/^{/, `{\n  "icon": "__ICON__",`);
  const body = dataJson.replace('"__ICON__"', entry.icon);
  return `${header}import { ${entry.icon} } from 'lucide-react';\nimport type { HelpTopic } from '../types';\n\nexport const ${varName}: HelpTopic = ${body};\n`;
}

mkdirSync(OUT, { recursive: true });
let count = 0;
for (const entry of MANIFEST) {
  const md = readFileSync(join(DOCS, entry.doc), 'utf8');
  const sections = toSections(md);
  // Hash the bytes on disk, so the digest the drift guard recomputes is over
  // exactly the same input regardless of how the doc is read.
  const sourceSha = createHash('sha256').update(readFileSync(join(DOCS, entry.doc))).digest('hex');
  writeFileSync(join(OUT, `${entry.id}.ts`), emit(entry, sections, sourceSha));
  count++;
  console.log(`  generated ${entry.id}.ts  (${sections.length} sections)  ← docs/${entry.doc}`);
}
console.log(`Generated ${count} help topics from docs/ → src/lib/help/generated/`);
