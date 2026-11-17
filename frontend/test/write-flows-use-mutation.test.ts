// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Writes go through `useMutation`, pinned.
 *
 * Reads share one core (`fetchCore`, behind useFetch / useListPage /
 * useServerPagination / useEntityFetch). Writes used to be hand-rolled in ~75
 * files: a `const [saving, setSaving] = useState(false)` flag, an
 * `inFlightRef` / `submittingRef` / `mountedRef` guard, and a catch that
 * may or may not have remembered the step-up dialog. Each copy got one of those
 * subtly wrong — a double click that wrote twice (the flag is state, so it does
 * not exist until the next render), a result landing in the next org's dialog,
 * a step-up refusal shown as an error. ~40 such bugs were fixed one by one.
 *
 * `useMutation` (src/hooks/useMutation.ts) owns all of it once. This test
 * keeps new code from reintroducing the raw pattern:
 *
 *  1. a boolean `useState(false)` whose NAME says it is a write in flight
 *     (`saving`, `busy`, `submitting`, `deleting`, `fooBusy`, ...) is
 *     only allowed in a file on {@link UNMIGRATED} — the files that still
 *     predate the hook;
 *  2. a boolean in-flight REF (`useRef(false)` named `inFlight` /
 *     `submitting` / `saving` / `busy`...) is not allowed anywhere.
 *
 * The allowlist may only SHRINK: migrating a file means deleting its line here
 * (the test fails on a stale entry, so it cannot be forgotten). Never add one —
 * use `useMutation` instead. A flag that is not a write in flight (a dialog
 * being open) wants a name that says so (`confirmOpen`, `composing`).
 */
import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FRONTEND_DIR = resolve(__dirname, '..');

/** Files that still hand-roll a write flag. MAY ONLY SHRINK. */
const UNMIGRATED: ReadonlySet<string> = new Set([
  'pages/auth/callback/[provider].tsx',
  'pages/dashboard/admin/offers.tsx',
  'pages/dashboard/messages.tsx',
  'pages/dashboard/observability/alert-destinations.tsx',
  'pages/dashboard/observability/alert-rules.tsx',
  'pages/dashboard/security.tsx',
  'src/components/admin/OrgIdpConfigModal.tsx',
  'src/components/admin/StepUpModal.tsx',
  'src/components/admin/org-detail/OrgOperationsCard.tsx',
  'src/components/ask/AskPanel.tsx',
  'src/components/auth/SignInCard/useRequiredPasswordChange.ts',
  'src/components/auth/SignInCard/useSignInFlow.ts',
  'src/components/compliance/ScanDetail.tsx',
  'src/components/compliance/ScanManager.tsx',
  'src/components/deployments/RegisterDeploymentModal.tsx',
  'src/components/message/ComposeModal.tsx',
  'src/components/message/ThreadView.tsx',
  'src/components/pipeline/BulkImportPipelinesModal.tsx',
  'src/components/pipeline/security/PluginUpgradePanel.tsx',
  'src/components/plugin-installs/ApprovalsTab.tsx',
  'src/components/plugin-installs/InstallControls.tsx',
  'src/components/publisher/PublishRequestsPanel.tsx',
  'src/components/publisher/PublisherListingsPanel.tsx',
  'src/components/publisher/PublisherProfilePanel.tsx',
  'src/components/quotas/QuotaUsageBreakdown.tsx',
  'src/components/quotas/QuotasAdmin.tsx',
  'src/components/reports/tabs/StakeholderTab.tsx',
  'src/components/settings/AccessKeysSection.tsx',
  'src/components/settings/IncidentReportingSettings.tsx',
  'src/components/settings/PluginSecurityNotificationSettings.tsx',
  'src/components/settings/ScimProvisioning.tsx',
  'src/components/settings/ServiceAccountsSection.tsx',
  'src/components/settings/TotpSection.tsx',
  'src/components/sso/SsoSetupWizard.tsx',
  'src/hooks/internal/useRepoAnalysis.ts',
  'src/hooks/useAiStreamGeneration.ts',
  'src/hooks/useAuth.tsx',
  'src/hooks/useMemberRoles.ts',
  'src/hooks/useMemberTeams.ts',
]);

/** `const [name, setName] = useState(false)` / `useState<boolean>(false)`. */
const FLAG_STATE = /const\s*\[\s*(\w+)\s*,\s*set\w+\s*\]\s*=\s*useState(?:<boolean>)?\(\s*false\s*\)/g;
/** `const nameRef = useRef(false)` / `useRef<boolean>(false)`. */
const FLAG_REF = /const\s+(\w+)\s*=\s*useRef(?:<boolean>)?\(\s*false\s*\)/g;

const VERBS = 'busy|submitting|saving|deleting|sending|creating|uploading|exporting|generating|claiming|cancell?ing|applying|verifying|retrying|resetting|resending|purging|revoking|removing|publishing|installing|posting|updating';
/** A name that says "a write is in flight": `saving`, `isSaving`, `savingEdit`, `deleteBusy`. */
const WRITE_FLAG_NAME = new RegExp(
  `^(?:is)?(?:${VERBS})(?:[A-Z]\\w*)?$|(?:Busy|Saving|Submitting|Deleting|Sending|Creating|Uploading|Revoking|Removing|Publishing)$`,
);
/** An in-flight ref: `inFlightRef`, `submittingRef`, `savingRef`, `busyRef`. */
const WRITE_REF_NAME = new RegExp(`^(?:inFlight|${VERBS})(?:[A-Z]\\w*)?Ref$|(?:InFlight|Busy|Saving|Submitting)Ref$`);

function sourceFiles(dir: string): string[] {
  return readdirSync(resolve(FRONTEND_DIR, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return rel === 'src/generated' ? [] : sourceFiles(rel);
    return /\.tsx?$/.test(e.name) ? [rel] : [];
  });
}

const FILES = ['pages', 'src'].flatMap(sourceFiles);

/** File → the write-flag names it declares. */
function scan(re: RegExp, name: RegExp): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of FILES) {
    const src = readFileSync(resolve(FRONTEND_DIR, file), 'utf8');
    for (const m of src.matchAll(re)) {
      if (!name.test(m[1])) continue;
      out.set(file, [...(out.get(file) ?? []), m[1]]);
    }
  }
  return out;
}

describe('write flows use useMutation', () => {
  const flags = scan(FLAG_STATE, WRITE_FLAG_NAME);

  it('no NEW file hand-rolls a write-in-flight useState flag', () => {
    const offenders = [...flags].filter(([f]) => !UNMIGRATED.has(f)).map(([f, names]) => `${f}: ${names.join(', ')}`);
    expect(offenders).toEqual([]);
  });

  it('the allowlist only lists files that still need it (delete migrated entries)', () => {
    const stale = [...UNMIGRATED].filter((f) => !flags.has(f));
    expect(stale).toEqual([]);
  });

  it('no file keeps a boolean in-flight ref', () => {
    const refs = [...scan(FLAG_REF, WRITE_REF_NAME)].map(([f, names]) => `${f}: ${names.join(', ')}`);
    expect(refs).toEqual([]);
  });

  it('the detector recognises the shapes it is meant to catch', () => {
    for (const n of ['saving', 'busy', 'isSubmitting', 'savingEdit', 'deleteBusy', 'bulkDeleting', 'revokingAll']) {
      expect(WRITE_FLAG_NAME.test(n)).toBe(true);
    }
    for (const n of ['open', 'confirmOpen', 'composing', 'showSaveTemplate', 'expanded', 'pendingDelete']) {
      expect(WRITE_FLAG_NAME.test(n)).toBe(false);
    }
    for (const n of ['inFlightRef', 'submittingRef', 'savingRef', 'deleteInFlightRef']) {
      expect(WRITE_REF_NAME.test(n)).toBe(true);
    }
    const sample = 'const [saving, setSaving] = useState(false);\nconst [x, setX] = useState<boolean>(false);';
    expect([...sample.matchAll(FLAG_STATE)].map((m) => m[1])).toEqual(['saving', 'x']);
  });
});
