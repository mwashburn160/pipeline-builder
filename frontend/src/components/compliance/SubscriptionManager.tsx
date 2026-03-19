'use client';

import { useState, useEffect, useCallback } from 'react';
import { BookOpen, ToggleLeft, ToggleRight, GitFork, Pin, PinOff, Loader2, Zap, Eye, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
import api from '@/lib/api';
import type { PublishedRuleCatalogEntry, ComplianceRule, ComplianceRuleSubscription, ComplianceCheckResult, RuleTarget, RuleSeverity } from '@/types/compliance';

const SEVERITY_COLORS: Record<string, string> = {
  warning: 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400',
  error: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
  critical: 'bg-red-200 dark:bg-red-900/50 text-red-800 dark:text-red-300',
};

interface SubscriptionWithRule extends ComplianceRuleSubscription {
  rule: ComplianceRule | null;
}

interface SubscriptionManagerProps {
  readOnly?: boolean;
}

export default function SubscriptionManager({ readOnly = false }: SubscriptionManagerProps) {
  const [tab, setTab] = useState<'subscriptions' | 'catalog'>('subscriptions');
  const [subscriptions, setSubscriptions] = useState<SubscriptionWithRule[]>([]);
  const [catalog, setCatalog] = useState<PublishedRuleCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<ComplianceCheckResult | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Catalog filters
  const [catalogTarget, setCatalogTarget] = useState<RuleTarget | ''>('');
  const [catalogSeverity, setCatalogSeverity] = useState<RuleSeverity | ''>('');

  const fetchSubscriptions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getComplianceSubscriptions({ limit: 100 });
      if (res.success && res.data) {
        setSubscriptions(res.data.subscriptions);
      }
    } catch { /* handled by loading state */ }
    setLoading(false);
  }, []);

  const fetchCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { limit: 100 };
      if (catalogTarget) params.target = catalogTarget;
      if (catalogSeverity) params.severity = catalogSeverity;
      const res = await api.getPublishedRules(params);
      if (res.success && res.data) {
        setCatalog(res.data.rules);
      }
    } catch { /* handled by loading state */ }
    setLoading(false);
  }, [catalogTarget, catalogSeverity]);

  useEffect(() => {
    if (tab === 'subscriptions') fetchSubscriptions();
    else fetchCatalog();
  }, [tab, fetchSubscriptions, fetchCatalog]);

  const handleToggle = async (ruleId: string, isActive: boolean) => {
    await api.setSubscriptionActive(ruleId, isActive);
    fetchSubscriptions();
  };

  const handleBulkToggle = async (isActive: boolean) => {
    if (selectedIds.size === 0) return;
    await api.bulkSetSubscriptionActive([...selectedIds], isActive);
    setSelectedIds(new Set());
    fetchSubscriptions();
  };

  const handleSubscribe = async (ruleId: string) => {
    await api.subscribeToRule(ruleId);
    fetchCatalog();
  };

  const handleAutoSubscribe = async () => {
    await api.autoSubscribe();
    fetchSubscriptions();
    fetchCatalog();
  };

  const handleFork = async (ruleId: string) => {
    await api.forkRule(ruleId);
    fetchSubscriptions();
  };

  const handlePin = async (ruleId: string) => {
    await api.pinSubscription(ruleId);
    fetchSubscriptions();
  };

  const handleUnpin = async (ruleId: string) => {
    await api.unpinSubscription(ruleId);
    fetchSubscriptions();
  };

  const handleUnsubscribe = async (ruleId: string) => {
    await api.unsubscribeFromRule(ruleId);
    fetchSubscriptions();
  };

  const handlePreview = async (ruleId: string) => {
    if (previewId === ruleId) { setPreviewId(null); setPreviewResult(null); return; }
    setPreviewId(ruleId);
    setPreviewResult(null);
    try {
      const res = await api.previewSubscription(ruleId);
      if (res.success && res.data?.preview) setPreviewResult(res.data.preview);
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
              <button onClick={() => handleBulkToggle(true)} className="px-2 py-1 text-xs bg-green-600 text-white rounded">Activate All</button>
              <button onClick={() => handleBulkToggle(false)} className="px-2 py-1 text-xs bg-gray-600 text-white rounded">Deactivate All</button>
            </div>
          )}
          {subscriptions.length === 0 ? (
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">
              <p>No subscriptions yet. Browse the catalog to subscribe to published rules.</p>
              {!readOnly && (
                <button
                  onClick={handleAutoSubscribe}
                  className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  <Zap className="h-4 w-4" /> Auto-Subscribe to All
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {!readOnly && (
                <div className="flex justify-end">
                  <button
                    onClick={handleAutoSubscribe}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                    title="Subscribe to all published rules not yet subscribed"
                  >
                    <Zap className="h-3 w-3" /> Auto-Subscribe
                  </button>
                </div>
              )}
              {subscriptions.map(sub => (
                <div key={sub.id} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
                  <div className="flex items-center justify-between p-3">
                    <div className="flex items-center gap-3">
                      {!readOnly && (
                        <input
                          type="checkbox"
                          checked={selectedIds.has(sub.ruleId)}
                          onChange={() => toggleSelect(sub.ruleId)}
                          className="rounded border-gray-300"
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
                      <button onClick={() => handlePreview(sub.ruleId)} className={`p-1.5 rounded-lg transition-colors ${previewId === sub.ruleId ? 'text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20' : 'text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20'}`} title="Preview impact" aria-label="Preview impact">
                        <Eye className="h-4 w-4" />
                      </button>
                      {!readOnly && (
                        <>
                          <button
                            onClick={() => handleToggle(sub.ruleId, !sub.isActive)}
                            className={`p-1.5 rounded-lg transition-colors ${sub.isActive ? 'text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20' : 'text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}`}
                            title={sub.isActive ? 'Deactivate' : 'Activate'}
                            aria-label={sub.isActive ? 'Deactivate' : 'Activate'}
                          >
                            {sub.isActive ? <ToggleRight className="h-5 w-5" /> : <ToggleLeft className="h-5 w-5" />}
                          </button>
                          <button onClick={() => handleFork(sub.ruleId)} className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors" title="Fork to org rule" aria-label="Fork to org rule">
                            <GitFork className="h-4 w-4" />
                          </button>
                          {sub.pinnedVersion ? (
                            <button onClick={() => handleUnpin(sub.ruleId)} className="p-1.5 rounded-lg text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-colors" title="Unpin version" aria-label="Unpin version">
                              <PinOff className="h-4 w-4" />
                            </button>
                          ) : (
                            <button onClick={() => handlePin(sub.ruleId)} className="p-1.5 rounded-lg text-gray-400 hover:text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-colors" title="Pin to current version" aria-label="Pin to current version">
                              <Pin className="h-4 w-4" />
                            </button>
                          )}
                          <button onClick={() => handleUnsubscribe(sub.ruleId)} className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" title="Unsubscribe" aria-label="Unsubscribe">
                            <span className="text-xs font-medium">&times;</span>
                          </button>
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
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'catalog' && (
        <div className="space-y-3">
          {/* Catalog filters */}
          <div className="flex gap-3">
            <select
              value={catalogTarget}
              onChange={(e) => setCatalogTarget(e.target.value as RuleTarget | '')}
              className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
            >
              <option value="">All targets</option>
              <option value="plugin">Plugin</option>
              <option value="pipeline">Pipeline</option>
            </select>
            <select
              value={catalogSeverity}
              onChange={(e) => setCatalogSeverity(e.target.value as RuleSeverity | '')}
              className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
            >
              <option value="">All severities</option>
              <option value="critical">Critical</option>
              <option value="error">Error</option>
              <option value="warning">Warning</option>
            </select>
          </div>

          {catalog.length === 0 ? (
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">No published rules available.</div>
          ) : catalog.map(rule => (
            <div key={rule.id} className="flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
              <div className="flex items-center gap-3">
                <div>
                  <div className="text-sm font-medium text-gray-900 dark:text-white">{rule.name}</div>
                  {rule.description && <div className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-md">{rule.description}</div>}
                </div>
                <span className={`text-xs rounded-full px-2 py-0.5 font-medium ${SEVERITY_COLORS[rule.severity] || SEVERITY_COLORS.warning}`}>{rule.severity}</span>
                <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-full px-2 py-0.5">{rule.target}</span>
              </div>
              {rule.subscribed ? (
                <span className="text-xs text-green-600 dark:text-green-400 font-medium">Subscribed</span>
              ) : (
                <button
                  onClick={() => handleSubscribe(rule.id)}
                  className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Subscribe
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
