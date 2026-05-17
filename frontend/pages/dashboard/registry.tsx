// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RepositoryList } from '@/components/registry/RepositoryList';
import { TagTable } from '@/components/registry/TagTable';
import { ManifestDetail } from '@/components/registry/ManifestDetail';
import { CopyTagModal } from '@/components/registry/CopyTagModal';
import { DeleteTagConfirm } from '@/components/registry/DeleteTagConfirm';
import { useRepositoryList } from '@/hooks/useRepositoryList';
import { useImageTags, invalidateImageTags } from '@/hooks/useImageTags';
import { useImageDetail } from '@/hooks/useImageDetail';
import { api } from '@/lib/api';

type HealthState = 'checking' | 'ok' | 'error';

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
 */
export default function RegistryPage() {
  const { isReady, isSysAdmin } = useAuthGuard({ requireSystemAdmin: true });
  const router = useRouter();

  // URL-encoded selection state.
  const repo = typeof router.query.repo === 'string' ? router.query.repo : null;
  const tag = typeof router.query.tag === 'string' ? router.query.tag : null;
  const platform = typeof router.query.platform === 'string' ? router.query.platform : null;

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

  const [copyTag, setCopyTag] = useState<string | null>(null);
  const [deleteTag, setDeleteTag] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthState>('checking');

  // Health badge: one-shot ping on mount. Per-pane errors surface state thereafter.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await api.listImages({ limit: 1 });
        if (!cancelled) setHealth('ok');
      } catch {
        if (!cancelled) setHealth('error');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 403 mid-session redirect — if the user got demoted from sysadmin while
  // the page was open, any registry API call returning 403 should bounce them.
  useEffect(() => {
    const handler = (err: Error & { statusCode?: number }) => {
      if (err.statusCode === 403) {
        void router.push('/dashboard');
      }
    };
    // The error hooks pick up 403s already; this effect is a placeholder for
    // a future global error bus. Today, individual hook errors render inline.
    return () => { void handler; };
  }, [router]);

  // If the selected tag is gone after a refresh (e.g. just deleted), clear it.
  useEffect(() => {
    if (tag && tags && !tags.includes(tag)) {
      setQuery({ tag: null, platform: null });
    }
  }, [tag, tags, setQuery]);

  const onSelectRepo = (name: string) => setQuery({ repo: name, tag: null, platform: null });
  const onSelectTag = (t: string) => setQuery({ tag: t, platform: null });
  const onSelectPlatform = (osArch: string) => setQuery({ platform: osArch });

  // After a successful copy, refresh the source repo's tag list (if we copied
  // within the same repo) and invalidate the target repo's cache so a future
  // navigation to it pulls fresh tags.
  const onCopySuccess = (targetRepo: string, _targetRef: string) => {
    setCopyTag(null);
    if (targetRepo === repo) refreshTags();
    else invalidateImageTags(targetRepo);
  };

  const onDeleted = () => {
    setDeleteTag(null);
    setQuery({ tag: null, platform: null });
    refreshTags();
  };

  const breadcrumb = useMemo(() => {
    if (!repo || !tag) return repo ?? '';
    return platform ? `${repo}:${tag} → ${platform}` : `${repo}:${tag}`;
  }, [repo, tag, platform]);

  // The repo names string list — used for CopyTagModal target-repo autocomplete.
  const knownRepoNames = useMemo(() => repos.map((r) => r.name), [repos]);

  if (!isReady || !isSysAdmin) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Registry"
      subtitle="Docker image repository browser"
      actions={<HealthBadge state={health} />}
      mainClassName="!px-0"
    >
      <div className="flex h-[calc(100vh-80px)] border-t border-gray-200 dark:border-gray-700">
        <div className="w-72 flex-shrink-0">
          <RepositoryList
            groups={groups}
            selectedRepo={repo}
            loading={loading}
            error={error}
            hasMore={hasMore}
            onSelect={onSelectRepo}
            onLoadMore={loadMore}
            onRefresh={refresh}
          />
        </div>
        <div className={`flex-shrink-0 ${tag ? 'w-[28rem]' : 'flex-1'}`}>
          {repo ? (
            <TagTable
              repo={repo}
              tags={tags}
              loading={tagsLoading}
              error={tagsError}
              selectedTag={tag}
              onSelect={onSelectTag}
              onCopy={(t) => setCopyTag(t)}
              onDelete={(t) => setDeleteTag(t)}
              onRefresh={refreshTags}
            />
          ) : (
            <div className="p-6 text-sm text-gray-500 dark:text-gray-400">
              Select a repository to view its tags.
            </div>
          )}
        </div>
        {tag && (
          <div className="flex-1">
            <ManifestDetail
              kind={kind}
              loading={manifestLoading}
              error={manifestError}
              breadcrumb={breadcrumb}
              onSelectPlatform={onSelectPlatform}
            />
          </div>
        )}
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
