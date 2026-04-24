// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { api } from '@/lib/api';

interface TriageSample {
  id: string | number;
  pluginName: string | null;
  imageTag: string | null;
  error: string | null;
  failedAt: string | null;
  source: 'queue' | 'dlq';
}
interface TriageGroup {
  category: string;
  count: number;
  pluginNames: string[];
  samples: TriageSample[];
}

const CATEGORY_LABELS: Record<string, { label: string; hint: string; color: string }> = {
  'docker-build': { label: 'Docker Build', hint: 'Dockerfile or image build failed — check Dockerfile syntax / base-image pulls', color: 'bg-red-50 border-red-200 text-red-800' },
  'template': { label: 'Template Resolution', hint: 'Plugin templates reference missing metadata/vars — run `pipeline-manager validate-templates`', color: 'bg-amber-50 border-amber-200 text-amber-800' },
  'quota': { label: 'Quota Exceeded', hint: 'Org hit plugin / build quota — raise limit or reduce concurrency', color: 'bg-purple-50 border-purple-200 text-purple-800' },
  'timeout': { label: 'Timeout', hint: 'Build exceeded configured timeout — bump timeout in plugin-spec or investigate hangs', color: 'bg-blue-50 border-blue-200 text-blue-800' },
  'auth-secrets': { label: 'Auth / Secrets', hint: 'Missing or invalid secret — check secrets yaml in plugin-spec and Secrets Manager path', color: 'bg-rose-50 border-rose-200 text-rose-800' },
  'network': { label: 'Network', hint: 'DNS / connect failure — check platform URL, DNS, outbound egress', color: 'bg-indigo-50 border-indigo-200 text-indigo-800' },
  'validation': { label: 'Validation', hint: 'Plugin spec failed validation — missing required fields or bad schema', color: 'bg-orange-50 border-orange-200 text-orange-800' },
  'other': { label: 'Other', hint: 'Uncategorized failure — open a sample for the raw error', color: 'bg-gray-50 border-gray-200 text-gray-800' },
  'unknown': { label: 'Unknown', hint: 'No error message captured on the job', color: 'bg-gray-50 border-gray-200 text-gray-800' },
};

export default function TriagePage() {
  const [loading, setLoading] = useState(true);
  const [totalFailed, setTotalFailed] = useState(0);
  const [groups, setGroups] = useState<TriageGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    void load();
  }, []);

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getQueueTriage({ samples: '5' });
      const payload = res.success ? res.data : null;
      if (!payload) throw new Error('Unexpected response shape');
      setGroups(payload.groups);
      setTotalFailed(payload.totalFailed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function toggle(category: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  return (
    <DashboardLayout
      title="Failed Build Triage"
      subtitle={`${totalFailed} failed build${totalFailed === 1 ? '' : 's'} grouped by category`}
      actions={
        <button
          onClick={() => void load()}
          className="btn btn-secondary"
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      }
    >
      <div className="max-w-6xl mx-auto px-4 py-6">
        {error && (
          <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-red-800 text-sm">
            Failed to load triage data: {error}
          </div>
        )}

        {!loading && groups.length === 0 && !error && (
          <div className="p-6 bg-green-50 border border-green-200 rounded text-green-800 text-sm">
            ✅ No failed builds. Everything's green.
          </div>
        )}

        <div className="space-y-3">
          {groups.map(g => {
            const meta = CATEGORY_LABELS[g.category] ?? CATEGORY_LABELS.other!;
            const isOpen = expanded.has(g.category);
            return (
              <div key={g.category} className={`border rounded-lg ${meta.color}`}>
                <button
                  onClick={() => toggle(g.category)}
                  className="w-full px-4 py-3 text-left flex items-center justify-between"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold">{meta.label}</span>
                    <span className="text-xs opacity-70">{g.count} failure{g.count === 1 ? '' : 's'}</span>
                    <span className="text-xs opacity-60">
                      • {g.pluginNames.length} plugin{g.pluginNames.length === 1 ? '' : 's'} affected
                    </span>
                  </div>
                  <span className="text-xs">{isOpen ? '▼' : '▶'}</span>
                </button>
                {isOpen && (
                  <div className="px-4 pb-4">
                    <p className="text-xs opacity-80 mb-3">💡 {meta.hint}</p>
                    {g.pluginNames.length > 0 && (
                      <div className="mb-3 flex flex-wrap gap-1">
                        {g.pluginNames.map(n => (
                          <span key={n} className="inline-block px-2 py-0.5 text-xs rounded bg-white/60 border border-current/20">
                            {n}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="space-y-2">
                      {g.samples.map(s => (
                        <div key={`${s.source}-${s.id}`} className="p-2 bg-white/50 dark:bg-gray-900/30 rounded border border-current/20 text-xs font-mono">
                          <div className="flex items-center justify-between mb-1 text-[10px] uppercase tracking-wider opacity-60">
                            <span>
                              {s.pluginName ?? 'unknown plugin'} • {s.source}
                            </span>
                            {s.failedAt && <span>{new Date(s.failedAt).toLocaleString()}</span>}
                          </div>
                          <div className="whitespace-pre-wrap break-words">
                            {s.error ?? '(no error message captured)'}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </DashboardLayout>
  );
}
