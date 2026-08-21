'use client';

import Link from 'next/link';
import { Select } from '@/components/ui/Select';
import { useState, useEffect, useCallback, useRef } from 'react';
import { BookOpen, ToggleLeft, ToggleRight, Copy, Pin, PinOff, Loader2, Zap, Eye, CheckCircle, XCircle, AlertTriangle, Lock } from 'lucide-react';
import api from '@/lib/api';
import { Pagination, type PaginationState } from '@/components/ui/Pagination';
import { TextEmptyState } from '@/components/ui/EmptyState';
import { Checkbox } from '@/components/ui/Checkbox';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { useToast } from '@/components/ui/Toast';
import { useFeatures } from '@/hooks/useFeatures';
import type { ComplianceSetFlag } from '@/lib/feature-flags';
import { formatError } from '@/lib/constants';
import type { PublishedRuleCatalogEntry, ComplianceRule, ComplianceRuleSubscription, ComplianceCheckResult, RuleTarget, RuleSeverity } from '@/types/compliance';
import { SEVERITY_BADGE as SEVERITY_COLORS } from '@/lib/compliance-styles';

interface SubscriptionWithRule extends ComplianceRuleSubscription {
  rule: ComplianceRule | null;
}

/**
 * A published catalog rule can carry a `set:<name>` tag marking it as part of a
 * paid curated content set. Subscribing/activating such a rule is server-gated
 * on the matching `compliance_<name>` feature, so the catalog must show a locked
 * upsell (deep-linking to billing) instead of a Subscribe button when the org
 * doesn't hold the entitlement — otherwise the user hits a 403 round-trip.
 */
interface SetTagMeta {
  feature: ComplianceSetFlag;
  label: string;
}

const SET_TAG_META: Record<string, SetTagMeta> = {
  standard: { feature: 'compliance_standard', label: 'Standard' },
  advanced: { feature: 'compliance_advanced', label: 'Advanced' },
};

/** Resolve a rule's `set:<name>` tag (if any) to its gating feature + label. */
function ruleSetMeta(tags: string[] | undefined): SetTagMeta | null {
  if (!tags) return null;
  for (const t of tags) {
    if (t.startsWith('set:')) {
      const meta = SET_TAG_META[t.slice(4)];
      if (meta) return meta;
    }
  }
  return null;
}

interface SubscriptionManagerProps {
  readOnly?: boolean;
}

export default function SubscriptionManager({ readOnly = false }: SubscriptionManagerProps) {
  const toast = useToast();
  const { isEnabled } = useFeatures();
  const [tab, setTab] = useState<'subscriptions' | 'catalog'>('subscriptions');
  const [subscriptions, setSubscriptions] = useState<SubscriptionWithRule[]>([]);
  const [catalog, setCatalog] = useState<PublishedRuleCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<ComplianceCheckResult | null>(null);
  const [impactResult, setImpactResult] = useState<{
    total: number; wouldPass: number; wouldFail: number;
    samples: Array<{ entityId: string; entityName: string | null; messages: string[] }>;
  } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Pagination
  const DEFAULT_PAGE_SIZE = 10;
  const [subsPagination, setSubsPagination] = useState<PaginationState>({ limit: DEFAULT_PAGE_SIZE, offset: 0, total: 0 });
  const [catalogPagination, setCatalogPagination] = useState<PaginationState>({ limit: DEFAULT_PAGE_SIZE, offset: 0, total: 0 });

  // Catalog filters
  const [catalogTarget, setCatalogTarget] = useState<RuleTarget | ''>('');
  const [catalogSeverity, setCatalogSeverity] = useState<RuleSeverity | ''>('');

  // Stale-response guard shared across both fetchers: rapid tab switches or a
  // filter change while a page fetch is in flight must not let an older
  // response set `loading`/list state after a newer request. Each fetch takes a
  // generation number and skips setState if it's no longer the latest.
  const reqRef = useRef(0);

  const fetchSubscriptions = useCallback(async (offset = subsPagination.offset, limit = subsPagination.limit) => {
    const gen = ++reqRef.current;
    setLoading(true);
    try {
      const res = await api.getComplianceSubscriptions({ limit, offset });
      if (gen !== reqRef.current) return;
      if (res.success && res.data) {
        setSubscriptions(res.data.subscriptions);
        if (res.data.pagination) {
          setSubsPagination({ limit: res.data.pagination.limit, offset: res.data.pagination.offset, total: res.data.pagination.total });
        }
      }
    } catch { /* handled by loading state */ }
    if (gen === reqRef.current) setLoading(false);
  }, [subsPagination.offset, subsPagination.limit]);

  const fetchCatalog = useCallback(async (offset = catalogPagination.offset, limit = catalogPagination.limit) => {
    const gen = ++reqRef.current;
    setLoading(true);
    try {
      const params: Record<string, string | number> = { limit, offset };
      if (catalogTarget) params.target = catalogTarget;
      if (catalogSeverity) params.severity = catalogSeverity;
      const res = await api.getPublishedRules(params);
      if (gen !== reqRef.current) return;
      if (res.success && res.data) {
        setCatalog(res.data.rules);
        if (res.data.pagination) {
          setCatalogPagination({ limit: res.data.pagination.limit, offset: res.data.pagination.offset, total: res.data.pagination.total });
        }
      }
    } catch { /* handled by loading state */ }
    if (gen === reqRef.current) setLoading(false);
  }, [catalogPagination.offset, catalogPagination.limit, catalogTarget, catalogSeverity]);

  useEffect(() => {
    if (tab === 'subscriptions') fetchSubscriptions();
    else fetchCatalog();
    // Invalidate any in-flight fetch on unmount / tab switch so a late response
    // can't clobber the newly-selected tab's state.
    return () => { reqRef.current++; };
  }, [tab, fetchSubscriptions, fetchCatalog]);

  // Reset catalog offset when filters change
  useEffect(() => {
    setCatalogPagination(prev => ({ ...prev, offset: 0 }));
  }, [catalogTarget, catalogSeverity]);

  const handleSubsPageChange = (offset: number) => { fetchSubscriptions(offset, subsPagination.limit); };
  const handleSubsPageSizeChange = (limit: number) => { fetchSubscriptions(0, limit); };
  const handleCatalogPageChange = (offset: number) => { fetchCatalog(offset, catalogPagination.limit); };
  const handleCatalogPageSizeChange = (limit: number) => { fetchCatalog(0, limit); };

  // Route mutation failures to a toast — without this a rejected promise is
  // unhandled and the user sees nothing happen.
  const runMutation = async (fn: () => Promise<unknown>, errMsg: string) => {
    try { await fn(); } catch (err) { toast.error(formatError(err, errMsg)); }
  };

  const handleToggle = (ruleId: string, isActive: boolean) => runMutation(async () => {
    await api.setSubscriptionActive(ruleId, isActive);
    fetchSubscriptions();
  }, 'Failed to update subscription');

  const handleBulkToggle = (isActive: boolean) => runMutation(async () => {
    if (selectedIds.size === 0) return;
    await api.bulkSetSubscriptionActive([...selectedIds], isActive);
    setSelectedIds(new Set());
    fetchSubscriptions();
  }, 'Failed to update subscriptions');

  const handleSubscribe = (ruleId: string) => runMutation(async () => {
    await api.subscribeToRule(ruleId);
    fetchCatalog();
  }, 'Failed to subscribe to rule');

  const handleAutoSubscribe = () => runMutation(async () => {
    const res = await api.autoSubscribe();
    fetchSubscriptions();
    fetchCatalog();
    if (res.success && res.data) {
      const { subscribed, skipped } = res.data;
      const plural = (n: number) => (n === 1 ? '' : 's');
      toast.success(
        `Subscribed to ${subscribed} rule${plural(subscribed)}` +
          (skipped > 0 ? ` — skipped ${skipped} (already subscribed or set-gated)` : ''),
      );
    }
  }, 'Failed to auto-subscribe');

  const handleClone = (ruleId: string) => runMutation(async () => {
    await api.cloneRule(ruleId);
    fetchSubscriptions();
  }, 'Failed to clone rule');

  const handlePin = (ruleId: string) => runMutation(async () => {
    await api.pinSubscription(ruleId);
    fetchSubscriptions();
  }, 'Failed to pin subscription');

  const handleUnpin = (ruleId: string) => runMutation(async () => {
    await api.unpinSubscription(ruleId);
    fetchSubscriptions();
  }, 'Failed to unpin subscription');

  const handleUnsubscribe = (ruleId: string) => runMutation(async () => {
    await api.unsubscribeFromRule(ruleId);
    fetchSubscriptions();
  }, 'Failed to unsubscribe');

  const handlePreview = async (ruleId: string) => {
    if (previewId === ruleId) {
      setPreviewId(null);
      setPreviewResult(null);
      setImpactResult(null);
      return;
    }
    setPreviewId(ruleId);
    setPreviewResult(null);
    setImpactResult(null);
    try {
      // Run both previews in parallel — the rule-shape one is for display,
      // the impact one quantifies "how many of MY entities would fail."
      const [ruleRes, impactRes] = await Promise.allSettled([
        api.previewSubscription(ruleId),
        api.previewRuleImpact(ruleId),
      ]);
      if (ruleRes.status === 'fulfilled' && ruleRes.value.success && ruleRes.value.data?.preview) {
        setPreviewResult(ruleRes.value.data.preview);
      }
      if (impactRes.status === 'fulfilled' && impactRes.value.success && impactRes.value.data) {
        const d = impactRes.value.data;
        setImpactResult({
          total: d.total,
          wouldPass: d.wouldPass,
          wouldFail: d.wouldFail,
          samples: d.samples.map((s) => ({ entityId: s.entityId, entityName: s.entityName, messages: s.messages })),
        });
      }
    } catch { /* handled */ }
  };

  const toggleSelect = (ruleId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(ruleId)) next.delete(ruleId);
      else next.add(ruleId);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-blue-600" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Published Rules & Subscriptions</h2>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setTab('subscriptions')}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${tab === 'subscriptions' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`}
          >
            My Subscriptions
          </button>
          <button
            onClick={() => setTab('catalog')}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${tab === 'catalog' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`}
          >
            Browse Catalog
          </button>
        </div>
      </div>

      {tab === 'subscriptions' && (
        <>
          {!readOnly && selectedIds.size > 0 && (
            <div className="flex items-center gap-2 p-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
              <span className="text-sm text-blue-700 dark:text-blue-300">{selectedIds.size} selected</span>
              <Button variant="success" size="xs" onClick={() => handleBulkToggle(true)}>Activate All</Button>
              <Button variant="secondary" size="xs" onClick={() => handleBulkToggle(false)}>Deactivate All</Button>
            </div>
          )}
          {subscriptions.length === 0 ? (
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">
              <p>No subscriptions yet. Browse the catalog to subscribe to published rules.</p>
              {!readOnly && (
                <Button variant="primary" onClick={handleAutoSubscribe} className="mt-3">
                  <Zap className="h-4 w-4" /> Auto-Subscribe to All
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {!readOnly && (
                <div className="flex justify-end">
                  <Button
                    variant="primary"
                    size="xs"
                    onClick={handleAutoSubscribe}
                    title="Subscribe to all published rules not yet subscribed"
                  >
                    <Zap className="h-3 w-3" /> Auto-Subscribe
                  </Button>
                </div>
              )}
              {subscriptions.map(sub => (
                <div key={sub.id} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
                  <div className="flex items-center justify-between p-3">
                    <div className="flex items-center gap-3">
                      {!readOnly && (
                        <Checkbox
                          checked={selectedIds.has(sub.ruleId)}
                          onChange={() => toggleSelect(sub.ruleId)}
                        />
                      )}
                      <div>
                        <div className="text-sm font-medium text-gray-900 dark:text-white">{sub.rule?.name || sub.ruleId}</div>
                        {sub.rule?.description && (
                          <div className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-md">{sub.rule.description}</div>
                        )}
                      </div>
                      {sub.rule && (
                        <span className={`text-xs rounded-full px-2 py-0.5 font-medium ${SEVERITY_COLORS[sub.rule.severity] || SEVERITY_COLORS.warning}`}>
                          {sub.rule.severity}
                        </span>
                      )}
                      {sub.pinnedVersion && (
                        <span className="text-xs bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 rounded-full px-2 py-0.5">pinned</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {/* Preview is a stateful toggle: indigo at rest while its panel is open, else muted+hover-indigo. */}
                      <IconButton restTone={previewId === sub.ruleId ? 'indigo' : undefined} tone="indigo" onClick={() => handlePreview(sub.ruleId)} title="Preview impact" aria-label="Preview impact">
                        <Eye className="h-4 w-4" />
                      </IconButton>
                      {!readOnly && (
                        <>
                          <IconButton
                            restTone={sub.isActive ? 'success' : 'default'}
                            onClick={() => handleToggle(sub.ruleId, !sub.isActive)}
                            title={sub.isActive ? 'Deactivate' : 'Activate'}
                            aria-label={sub.isActive ? 'Deactivate' : 'Activate'}
                          >
                            {sub.isActive ? <ToggleRight className="h-5 w-5" /> : <ToggleLeft className="h-5 w-5" />}
                          </IconButton>
                          <IconButton tone="primary" onClick={() => handleClone(sub.ruleId)} title="Clone as an org-owned rule (one-shot copy, no upstream sync)" aria-label="Clone to org rule">
                            <Copy className="h-4 w-4" />
                          </IconButton>
                          {sub.pinnedVersion ? (
                            // Pinned: purple at rest (matches the "pinned" badge language).
                            <IconButton restTone="purple" onClick={() => handleUnpin(sub.ruleId)} title="Unpin version" aria-label="Unpin version">
                              <PinOff className="h-4 w-4" />
                            </IconButton>
                          ) : (
                            <IconButton tone="purple" onClick={() => handlePin(sub.ruleId)} title="Pin to current version" aria-label="Pin to current version">
                              <Pin className="h-4 w-4" />
                            </IconButton>
                          )}
                          <IconButton tone="danger" onClick={() => handleUnsubscribe(sub.ruleId)} title="Unsubscribe" aria-label="Unsubscribe">
                            <span className="text-xs font-medium">&times;</span>
                          </IconButton>
                        </>
                      )}
                    </div>
                  </div>
                  {previewId === sub.ruleId && previewResult && (
                    <div className="mx-3 mb-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-800 text-sm">
                      <div className="flex items-center gap-3 mb-1">
                        <span className="flex items-center gap-1 text-xs">
                          {previewResult.passed ? <CheckCircle className="h-3.5 w-3.5 text-green-600" /> : <XCircle className="h-3.5 w-3.5 text-red-600" />}
                          {previewResult.passed ? 'Would pass' : 'Would fail'}
                        </span>
                        <span className="text-xs text-gray-500">{previewResult.rulesEvaluated} rules evaluated</span>
                      </div>
                      {previewResult.violations.length > 0 && previewResult.violations.map((v, i) => (
                        <div key={i} className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                          <XCircle className="h-3 w-3 shrink-0" /> {v.ruleName}: {v.message}
                        </div>
                      ))}
                      {previewResult.warnings.length > 0 && previewResult.warnings.map((w, i) => (
                        <div key={i} className="flex items-center gap-1.5 text-xs text-yellow-600 dark:text-yellow-400">
                          <AlertTriangle className="h-3 w-3 shrink-0" /> {w.ruleName}: {w.message}
                        </div>
                      ))}
                    </div>
                  )}
                  {previewId === sub.ruleId && impactResult && (
                    <div className="mx-3 mb-3 p-3 rounded-lg bg-indigo-50 dark:bg-indigo-900/20 text-sm border border-indigo-200 dark:border-indigo-800">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-indigo-900 dark:text-indigo-200">
                          Impact on your existing entities
                        </span>
                        <span className="text-xs text-gray-600 dark:text-gray-400">
                          <span className={impactResult.wouldFail > 0 ? 'text-red-600 dark:text-red-400 font-medium' : 'text-green-600 dark:text-green-400'}>
                            {impactResult.wouldFail}
                          </span>
                          {' / '}
                          {impactResult.total}
                          {' would fail'}
                        </span>
                      </div>
                      {impactResult.samples.length > 0 && (
                        <ul className="space-y-1">
                          {impactResult.samples.map((s) => (
                            <li key={s.entityId} className="flex items-start gap-1.5 text-xs text-red-700 dark:text-red-300">
                              <XCircle className="h-3 w-3 shrink-0 mt-0.5" />
                              <span>
                                <span className="font-medium">{s.entityName ?? s.entityId.slice(0, 8)}</span>
                                {s.messages[0] && <span className="text-gray-600 dark:text-gray-400"> — {s.messages[0]}</span>}
                              </span>
                            </li>
                          ))}
                          {impactResult.wouldFail > impactResult.samples.length && (
                            <li className="text-xs text-gray-500 italic">
                              + {impactResult.wouldFail - impactResult.samples.length} more
                            </li>
                          )}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {subsPagination.total > subsPagination.limit && (
                <Pagination
                  pagination={subsPagination}
                  onPageChange={handleSubsPageChange}
                  onPageSizeChange={handleSubsPageSizeChange}
                />
              )}
            </div>
          )}
        </>
      )}

      {tab === 'catalog' && (
        <div className="space-y-3">
          {/* Catalog filters */}
          <div className="flex gap-3">
            <Select
              value={catalogTarget}
              onChange={(e) => setCatalogTarget(e.target.value as RuleTarget | '')}
              aria-label="Filter catalog by target"
              className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
            >
              <option value="">All targets</option>
              <option value="plugin">Plugin</option>
              <option value="pipeline">Pipeline</option>
            </Select>
            <Select
              value={catalogSeverity}
              onChange={(e) => setCatalogSeverity(e.target.value as RuleSeverity | '')}
              aria-label="Filter catalog by severity"
              className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
            >
              <option value="">All severities</option>
              <option value="critical">Critical</option>
              <option value="error">Error</option>
              <option value="warning">Warning</option>
            </Select>
          </div>

          {catalog.length === 0 ? (
            <TextEmptyState>No published rules available.</TextEmptyState>
          ) : (
            <>
              {catalog.map(rule => {
                const setMeta = ruleSetMeta(rule.tags);
                // Locked = a set-tagged rule whose entitlement the org lacks.
                // Server-gated on subscribe/activate, so surface the paywall here
                // instead of sending the user on a 403 round-trip.
                const locked = setMeta !== null && !isEnabled(setMeta.feature);
                return (
                  <div key={rule.id} className="flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
                    <div className="flex items-center gap-3">
                      <div>
                        <div className="text-sm font-medium text-gray-900 dark:text-white">{rule.name}</div>
                        {rule.description && <div className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-md">{rule.description}</div>}
                      </div>
                      <span className={`text-xs rounded-full px-2 py-0.5 font-medium ${SEVERITY_COLORS[rule.severity] || SEVERITY_COLORS.warning}`}>{rule.severity}</span>
                      <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-full px-2 py-0.5">{rule.target}</span>
                      {setMeta && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium rounded-full bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 px-2 py-0.5">
                          <Lock className="h-3 w-3" aria-hidden="true" /> {setMeta.label}
                        </span>
                      )}
                    </div>
                    {rule.subscribed ? (
                      <span className="text-xs text-green-600 dark:text-green-400 font-medium">Subscribed</span>
                    ) : locked ? (
                      <Link
                        href={`/dashboard/billing?highlight=${setMeta.feature}`}
                        className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 whitespace-nowrap"
                        title={`This rule is part of the ${setMeta.label} Compliance library — unlock it in billing`}
                      >
                        <Lock className="h-3 w-3" aria-hidden="true" /> Requires {setMeta.label}
                      </Link>
                    ) : (
                      <Button variant="primary" size="xs" onClick={() => handleSubscribe(rule.id)}>
                        Subscribe
                      </Button>
                    )}
                  </div>
                );
              })}
              {catalogPagination.total > catalogPagination.limit && (
                <Pagination
                  pagination={catalogPagination}
                  onPageChange={handleCatalogPageChange}
                  onPageSizeChange={handleCatalogPageSizeChange}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
