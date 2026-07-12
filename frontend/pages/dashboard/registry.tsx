// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Trash2 } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useToast } from '@/components/ui/Toast';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox';
import { Button } from '@/components/ui/Button';
import { RepositoryList, type RepositoryListHandle } from '@/components/registry/RepositoryList';
import { TagTable } from '@/components/registry/TagTable';
import { ManifestDetail } from '@/components/registry/ManifestDetail';
import { CopyTagModal } from '@/components/registry/CopyTagModal';
import { DeleteTagConfirm } from '@/components/registry/DeleteTagConfirm';
import { DeleteRepoConfirm } from '@/components/registry/DeleteRepoConfirm';
import { BulkDeleteConfirm } from '@/components/registry/BulkDeleteConfirm';
import { RecentActionsPanel, type RecentAction } from '@/components/registry/RecentActionsPanel';
import { KeyboardShortcutsModal } from '@/components/registry/KeyboardShortcutsModal';
import { useRepositoryList } from '@/hooks/useRepositoryList';
import { useImageTags, invalidateImageTags } from '@/hooks/useImageTags';
import { useImageDetail } from '@/hooks/useImageDetail';
import { useTagsWithMetadata } from '@/hooks/useTagsWithMetadata';
import { api, ApiError } from '@/lib/api';

type HealthState = 'checking' | 'ok' | 'error';

const RECENT_ACTIONS_MAX = 20;

/**
 * Docker registry browser (sysadmin only). Replaces the joxit
 * `registry-express` UI: lists repos with namespace grouping, drills into
 * tags, shows the manifest summary + raw JSON, and supports cross-repo
 * tag-copy (incl. multi-arch promotions) + tag deletion.
 *
 * State is encoded in the URL so refresh / back / forward / deep links
 * all work:
 *  - ?repo=<repoPath>     selected repo (drives middle column)
 *  - ?tag=<tagRef>        selected tag (drives right column)
 *  - ?platform=<os>/<arch>  drilled-into platform inside a multi-arch tag
 *  - ?action=copy&source=<repo:ref>  opens the copy modal pre-populated
 *    (deep-link target for Slack-driven "please promote X" workflows)
 *
 * Keyboard:
 *  - j / k         move repo selection down / up
 *  - c             copy the active tag
 *  - d             delete the active tag
 *  - /             focus the repo filter
 *  - ?             show the shortcuts overlay
 *  - Esc           close any open modal
 */

/**
 * The 3-column layout assumes ~1024px of horizontal space (repo list +
 * tag table + manifest detail). On narrower viewports the panes overlap
 * each other or the manifest detail gets squeezed unusable. We surface a
 * one-line warning rather than try to reflow — the operator's first
 * choice will be a wider window.
 */
const MIN_USABLE_WIDTH = 1024;
export default function RegistryPage() {
  const { isReady, isSuperAdmin } = useAuthGuard({ requireSystemAdmin: true });
  const router = useRouter();
  const toast = useToast();

  // URL-encoded selection state.
  const repo = typeof router.query.repo === 'string' ? router.query.repo : null;
  const tag = typeof router.query.tag === 'string' ? router.query.tag : null;
  const platform = typeof router.query.platform === 'string' ? router.query.platform : null;
  const action = typeof router.query.action === 'string' ? router.query.action : null;
  const actionSource = typeof router.query.source === 'string' ? router.query.source : null;
  // Filter persists across navigation (operator triages many tags in the
  // same org without losing their search context).
  const repoFilter = typeof router.query.repoFilter === 'string' ? router.query.repoFilter : '';

  const setQuery = useCallback((patch: Record<string, string | null>) => {
    const next = { ...router.query };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    void router.replace({ pathname: router.pathname, query: next }, undefined, { shallow: true });
  }, [router]);

  const { groups, repos, hasMore, loading, error, loadMore, refresh } = useRepositoryList();
  const { tags, loading: tagsLoading, error: tagsError, refresh: refreshTags } = useImageTags(repo);
  const { kind, loading: manifestLoading, error: manifestError } = useImageDetail(repo, tag);
  const { metadata: tagMetadata, loading: enrichingMetadata } = useTagsWithMetadata(repo, tags);

  const [copyTag, setCopyTag] = useState<string | null>(null);
  const [deleteTag, setDeleteTag] = useState<string | null>(null);
  const [deleteRepo, setDeleteRepo] = useState<string | null>(null);
  const [bulkDelete, setBulkDelete] = useState<string[] | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [health, setHealth] = useState<HealthState>('checking');
  const [recentActions, setRecentActions] = useState<RecentAction[]>([]);
  const [narrowViewport, setNarrowViewport] = useState(false);
  const [narrowDismissed, setNarrowDismissed] = useState(false);
  const repoListRef = useRef<RepositoryListHandle>(null);

  // Manual registry GC (sysadmin ops). Defaults to dry-run so an operator
  // validates the candidate set before issuing real DELETEs.
  const [gcOpen, setGcOpen] = useState(false);
  const [gcPrefix, setGcPrefix] = useState('');
  const [gcDryRun, setGcDryRun] = useState(true);
  const [gcRunning, setGcRunning] = useState(false);

  const handleRunGc = useCallback(async () => {
    const prefix = gcPrefix.trim();
    if (!prefix) return;
    // Real runs delete manifests — gate behind an explicit confirm. Dry-runs
    // only walk + count, so they skip the confirm.
    if (!gcDryRun && !window.confirm(
      `Run garbage collection under "${prefix}" and DELETE manifests older than the retention window? This cannot be undone.`,
    )) return;
    setGcRunning(true);
    try {
      const res = await api.runRegistryGc({ prefix, dryRun: gcDryRun });
      const r = res.data;
      if (r) {
        toast.success(
          gcDryRun
            ? `Dry-run: ${r.candidates} candidate${r.candidates === 1 ? '' : 's'} across ${r.reposScanned} repo${r.reposScanned === 1 ? '' : 's'} (nothing deleted)`
            : `GC complete: deleted ${r.deleted} of ${r.candidates} candidate${r.candidates === 1 ? '' : 's'} across ${r.reposScanned} repo${r.reposScanned === 1 ? '' : 's'}`,
        );
      }
      // Close + refresh the repo list only after a real run may have emptied repos.
      if (!gcDryRun) {
        setGcOpen(false);
        refresh();
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Registry GC failed');
    } finally {
      setGcRunning(false);
    }
  }, [gcPrefix, gcDryRun, toast, refresh]);

  /** Push a new entry to the recent-actions ring buffer (most-recent first, capped). */
  const recordAction = useCallback((a: RecentAction) => {
    setRecentActions((prev) => [a, ...prev].slice(0, RECENT_ACTIONS_MAX));
  }, []);

  // Health badge: ping on mount + every 60s while the tab is visible. Pause
  // when hidden to avoid background traffic; re-ping on visibility regain so
  // the badge reflects truth shortly after the operator refocuses.
  useEffect(() => {
    let cancelled = false;

    const ping = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        await api.listImages({ limit: 1 });
        if (!cancelled) setHealth('ok');
      } catch {
        if (!cancelled) setHealth('error');
      }
    };

    void ping();
    const timer = setInterval(() => { void ping(); }, 60_000);
    const onVisibility = () => { if (document.visibilityState === 'visible') void ping(); };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  /**
   * 403 mid-session handler. If any registry call returns 403 (sysadmin
   * demoted while the page was open), toast + redirect. We observe via
   * `unhandledrejection` since the page's hooks each surface errors
   * inline; we don't need a separate error bus.
   */
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      const err = e.reason;
      if (err instanceof ApiError && err.statusCode === 403) {
        toast.error('System-admin access required. Your session no longer has it — returning to the dashboard.');
        void router.push('/dashboard');
      }
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, [router, toast]);

  // Track narrow viewports — the 3-column layout doesn't reflow below ~1024px.
  useEffect(() => {
    const check = () => setNarrowViewport(window.innerWidth < MIN_USABLE_WIDTH);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // If the selected tag is gone after a refresh (e.g. just deleted), clear it.
  useEffect(() => {
    if (tag && tags && !tags.includes(tag)) {
      setQuery({ tag: null, platform: null });
    }
  }, [tag, tags, setQuery]);

  // Deep-link: ?action=copy&source=<repo:ref> opens the modal pre-populated.
  // Strips the `action`/`source` params after consuming them so the URL
  // state is stable on subsequent navigation.
  useEffect(() => {
    if (action === 'copy' && actionSource && !copyTag) {
      const sepIdx = actionSource.lastIndexOf(':');
      if (sepIdx > 0) {
        const sRepo = actionSource.slice(0, sepIdx);
        const sRef = actionSource.slice(sepIdx + 1);
        setQuery({ repo: sRepo, tag: sRef, action: null, source: null });
        setCopyTag(sRef);
      }
    }
  }, [action, actionSource, copyTag, setQuery]);

  const onSelectRepo = (name: string) => setQuery({ repo: name, tag: null, platform: null });
  const onSelectTag = (t: string) => setQuery({ tag: t, platform: null });
  const onSelectPlatform = (osArch: string) => setQuery({ platform: osArch });

  // After a successful copy: toast + record + invalidate target repo cache.
  const onCopySuccess = (targetRepo: string, targetRef: string, sourceDigest?: string, blobs?: number) => {
    const target = `${targetRepo}:${targetRef}`;
    const source = copyTag ? `${repo}:${copyTag}` : '';
    setCopyTag(null);
    if (targetRepo === repo) refreshTags();
    else invalidateImageTags(targetRepo);
    const isPromotion = targetRepo.startsWith('system/');
    toast.success(
      isPromotion
        ? `Promoted ${source} → ${target} (audit-logged)`
        : `Copied ${source} → ${target}`,
    );
    recordAction({
      kind: 'copy', at: new Date().toISOString(),
      source, target, digest: sourceDigest, blobs, isPromotion,
    });
  };

  const onDeleted = (digest?: string) => {
    const ref = deleteTag;
    setDeleteTag(null);
    setQuery({ tag: null, platform: null });
    refreshTags();
    if (repo && ref) {
      toast.success(`Deleted ${repo}:${ref}`);
      recordAction({ kind: 'delete', at: new Date().toISOString(), repo, ref, digest });
    }
  };

  /**
   * Repo-prune callback from DeleteRepoConfirm — clears selection if the
   * pruned repo was active, refreshes the (nonEmpty-filtered) list so the
   * repo drops out, and records/toasts the outcome.
   */
  const onRepoDeleted = (
    name: string,
    result: { deletedManifests: number; deletedTags: number; alreadyEmpty?: boolean },
  ) => {
    setDeleteRepo(null);
    if (repo === name) setQuery({ repo: null, tag: null, platform: null });
    refresh();
    if (result.alreadyEmpty) {
      toast.success(`Pruned empty repository ${name}`);
    } else {
      toast.success(
        `Deleted repository ${name} (${result.deletedTags} tag${result.deletedTags === 1 ? '' : 's'})`,
      );
    }
    recordAction({
      kind: 'delete', at: new Date().toISOString(),
      repo: name, ref: '(entire repository)',
    });
  };

  /**
   * Per-tag callback from BulkDeleteConfirm — recorded incrementally.
   * Failures are recorded silently here (no toast) — a single summary
   * toast fires from `onBulkDone` so a batch of 20 failures doesn't spawn
   * 20 stacked toasts. The audit log is the authoritative per-tag record.
   */
  const onBulkProgress = (ref: string, digest?: string, err?: Error) => {
    if (!repo) return;
    if (err) return; // intentionally silent — summarized in onBulkDone
    recordAction({ kind: 'delete', at: new Date().toISOString(), repo, ref, digest });
  };

  /** Final callback from BulkDeleteConfirm — one summary toast + UI refresh. */
  const onBulkDone = ({ succeeded, failed }: { succeeded: number; failed: number }) => {
    setBulkDelete(null);
    refreshTags();
    if (failed === 0) toast.success(`Deleted ${succeeded} tag${succeeded === 1 ? '' : 's'}`);
    else if (succeeded === 0) toast.error(`All ${failed} delete${failed === 1 ? '' : 's'} failed`);
    else toast.warning(`Deleted ${succeeded}, ${failed} failed`);
    // If the currently-selected tag was in the batch, clear it.
    if (tag && bulkDelete?.includes(tag)) setQuery({ tag: null, platform: null });
  };

  /**
   * Clickable breadcrumb segments. The last segment is non-interactive
   * (current location); earlier segments walk the URL state back.
   */
  const breadcrumbs = useMemo(() => {
    const out: Array<{ label: string; onClick?: () => void }> = [];
    if (repo && tag) {
      out.push({
        label: `${repo}:${tag}`,
        onClick: platform ? () => setQuery({ platform: null }) : undefined,
      });
      if (platform) out.push({ label: platform });
    } else if (repo) {
      out.push({ label: repo });
    }
    return out;
  }, [repo, tag, platform, setQuery]);

  // The repo names string list — used for CopyTagModal target-repo autocomplete.
  const knownRepoNames = useMemo(() => repos.map((r) => r.name), [repos]);

  // Keyboard shortcuts (bound at window level). Skipped when typing in a
  // form field or when a destructive/data-entry modal is open intercepting
  // keys. The shortcuts overlay (`?`) is allowed even when other modals
  // are closed, and Esc on it is handled by the Modal primitive.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (inField) return;
      if (copyTag || deleteTag || bulkDelete || shortcutsOpen) return;

      switch (e.key) {
        case 'j': repoListRef.current?.step(1); break;
        case 'k': repoListRef.current?.step(-1); break;
        case 'c':
          if (tag) { e.preventDefault(); setCopyTag(tag); }
          break;
        case 'd':
          if (tag) { e.preventDefault(); setDeleteTag(tag); }
          break;
        case '/': {
          e.preventDefault();
          const input = document.getElementById('registry-repo-filter') as HTMLInputElement | null;
          input?.focus();
          break;
        }
        case '?': {
          e.preventDefault();
          setShortcutsOpen(true);
          break;
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tag, copyTag, deleteTag, bulkDelete, shortcutsOpen]);

  if (!isReady || !isSuperAdmin) return <LoadingPage />;

  // Focus model: the "active" column is the right-most one with data —
  // manifest detail > tag table > repo list. Inactive columns dim so the
  // operator's eye lands on what they just drilled into.
  const activeColumn: 'repo' | 'tag' | 'manifest' = tag ? 'manifest' : repo ? 'tag' : 'repo';
  const dim = (col: 'repo' | 'tag' | 'manifest') =>
    col === activeColumn ? '' : 'opacity-70 hover:opacity-100 focus-within:opacity-100 transition-opacity';

  return (
    <DashboardLayout
      title="Registry"
      subtitle="Docker image repository browser"
      actions={
        <div className="flex items-center gap-3">
          <Button variant="secondary" size="sm" onClick={() => setGcOpen(true)} title="Run manual registry garbage collection">
            <Trash2 className="w-3.5 h-3.5 mr-1" /> Run GC
          </Button>
          <button
            onClick={() => setShortcutsOpen(true)}
            title="Keyboard shortcuts (?)"
            className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
          >
            <kbd className="px-1.5 py-0.5 border border-gray-300 dark:border-gray-600 rounded font-mono">?</kbd>
          </button>
          <HealthBadge state={health} />
        </div>
      }
      mainClassName="!px-0"
    >
      <div className="flex flex-col h-[calc(100vh-80px)] border-t border-gray-200 dark:border-gray-700">
        {narrowViewport && !narrowDismissed && (
          <div className="px-4 py-2 text-xs flex items-center gap-3 border-b border-yellow-300 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-900 dark:text-yellow-200">
            <span className="flex-1">
              This 3-pane layout is designed for ≥{MIN_USABLE_WIDTH}px. Some columns may be cramped at the current width — widen the window for the best experience.
            </span>
            <button
              onClick={() => setNarrowDismissed(true)}
              className="underline hover:no-underline"
            >
              Dismiss
            </button>
          </div>
        )}
        {health === 'error' && (
          <div className="px-4 py-2 text-xs border-b border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300">
            Registry health check failed. Some panes below may show their own error — the shared cause is registry connectivity.
          </div>
        )}
        <div className="flex flex-1 min-h-0">
          <div className={`w-72 flex-shrink-0 ${dim('repo')}`}>
            <RepositoryList
              ref={repoListRef}
              groups={groups}
              selectedRepo={repo}
              loading={loading}
              error={error}
              hasMore={hasMore}
              filter={repoFilter}
              onFilterChange={(f) => setQuery({ repoFilter: f || null })}
              onSelect={onSelectRepo}
              onLoadMore={loadMore}
              onRefresh={refresh}
              onDelete={(name) => setDeleteRepo(name)}
            />
          </div>
          <div className={`flex-shrink-0 ${tag ? 'w-[28rem]' : 'flex-1'} ${dim('tag')}`}>
            {repo ? (
              <TagTable
                repo={repo}
                tags={tags}
                loading={tagsLoading}
                enrichingMetadata={enrichingMetadata}
                error={tagsError}
                selectedTag={tag}
                onSelect={onSelectTag}
                onCopy={(t) => setCopyTag(t)}
                onDelete={(t) => setDeleteTag(t)}
                onBulkDelete={(t) => setBulkDelete(t)}
                onRefresh={refreshTags}
                metadata={tagMetadata}
              />
            ) : (
              <div className="p-6 text-sm text-gray-500 dark:text-gray-400">
                Select a repository to view its tags. <span className="text-gray-400">(Tip: press <kbd className="px-1 py-0.5 border rounded text-xs">?</kbd> to see all keyboard shortcuts.)</span>
              </div>
            )}
          </div>
          {tag && (
            <div className={`flex-1 ${dim('manifest')}`}>
              <ManifestDetail
                kind={kind}
                loading={manifestLoading}
                error={manifestError}
                breadcrumbs={breadcrumbs}
                onSelectPlatform={onSelectPlatform}
                repo={repo}
              />
            </div>
          )}
        </div>

        <RecentActionsPanel actions={recentActions} />
      </div>

      {copyTag && repo && (
        <CopyTagModal
          sourceRepo={repo}
          sourceRef={copyTag}
          knownRepos={knownRepoNames}
          onClose={() => setCopyTag(null)}
          onSuccess={onCopySuccess}
        />
      )}

      {deleteTag && repo && (
        <DeleteTagConfirm
          repo={repo}
          ref={deleteTag}
          onClose={() => setDeleteTag(null)}
          onDeleted={onDeleted}
        />
      )}

      {deleteRepo && (
        <DeleteRepoConfirm
          repo={deleteRepo}
          onClose={() => setDeleteRepo(null)}
          onDeleted={(result) => onRepoDeleted(deleteRepo, result)}
        />
      )}

      {bulkDelete && repo && bulkDelete.length > 0 && (
        <BulkDeleteConfirm
          repo={repo}
          refs={bulkDelete}
          onClose={() => setBulkDelete(null)}
          onProgress={onBulkProgress}
          onDone={onBulkDone}
        />
      )}

      {gcOpen && (
        <Modal
          title="Run registry garbage collection"
          onClose={() => !gcRunning && setGcOpen(false)}
          footer={
            <ModalFooter
              onCancel={() => setGcOpen(false)}
              onConfirm={handleRunGc}
              confirmLabel={gcDryRun ? 'Run dry-run' : 'Run GC'}
              confirmVariant={gcDryRun ? 'primary' : 'danger'}
              loading={gcRunning}
              confirmDisabled={!gcPrefix.trim()}
            />
          }
        >
          <div className="space-y-3">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Prunes manifests older than the retention window under a single repo
              namespace prefix (e.g. <code className="font-mono">org-acme/</code>). The
              trailing slash is added automatically.
            </p>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Namespace prefix</label>
              <Input
                type="text"
                placeholder="org-acme/"
                value={gcPrefix}
                onChange={(e) => setGcPrefix(e.target.value)}
                className="text-sm"
                autoFocus
                disabled={gcRunning}
              />
            </div>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={gcDryRun}
                onChange={() => setGcDryRun((v) => !v)}
                disabled={gcRunning}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="font-medium text-gray-800 dark:text-gray-200">Dry run</span>
                <span className="block text-gray-400 dark:text-gray-500">
                  Walk the namespace and count deletion candidates without deleting anything.
                </span>
              </span>
            </label>
          </div>
        </Modal>
      )}

      {shortcutsOpen && (
        <KeyboardShortcutsModal onClose={() => setShortcutsOpen(false)} />
      )}
    </DashboardLayout>
  );
}

function HealthBadge({ state }: { state: HealthState }) {
  const { color, label } = state === 'checking'
    ? { color: 'bg-gray-400', label: 'Checking…' }
    : state === 'ok'
      ? { color: 'bg-green-500', label: 'Registry OK' }
      : { color: 'bg-red-500', label: 'Registry error' };
  return (
    <span className="inline-flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
      <span className={`w-2 h-2 rounded-full ${color}`} aria-hidden />
      {label}
    </span>
  );
}
