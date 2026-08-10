// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from 'react';
import { Megaphone, Plus, ShieldAlert, Eye, Gift, BarChart3, Zap } from 'lucide-react';
import { formatError } from '@/lib/constants';
import { formatCents } from '@/lib/format';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useListPage } from '@/hooks/useListPage';
import { useFormState } from '@/hooks/useFormState';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';
import { ApiError } from '@/lib/api/errors';
import api from '@/lib/api';
import { TIER_KEYS } from '@/lib/tiers';
import type { Promotion, PromotionInput } from '@/lib/api/domains/billing';

const EVENTS = [
  { value: 'subscription_created', label: 'On signup' },
  { value: 'plan_change', label: 'On plan change' },
  { value: 'manual', label: 'Manual only' },
  { value: 'referral', label: 'Referral (two-sided)' },
] as const;

/** Human-readable grant amount, e.g. "$50.00" or "20%". */
function formatAmount(p: Promotion): string {
  return p.unit === 'percent' ? `${p.value}%` : formatCents(p.value);
}

function eventLabel(event: Promotion['trigger']['event']): string {
  return EVENTS.find((e) => e.value === event)?.label ?? event;
}

/** Labeled form field (Input has no `label` prop). */
function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">{label}</label>
      {children}
    </div>
  );
}

export default function PromotionsPage() {
  const { user, isReady, isAuthenticated, isSuperAdmin } = useAuthGuard({ requireSystemAdmin: true });
  const toast = useToast();

  // Feature-off (BILLING_PROMOTIONS_ENABLED=false) surfaces as a 404 on list —
  // render an explainer instead of an unactionable error.
  const [notEnabled, setNotEnabled] = useState(false);

  const list = useListPage<Promotion>({
    fields: [{ key: 'active', type: 'select', defaultValue: 'all', primary: true }],
    fetcher: async (params) => {
      const activeParam = String(params.active || 'all');
      try {
        const response = await api.listPromotions(activeParam !== 'all' ? { active: activeParam as 'true' | 'false' } : undefined);
        setNotEnabled(false);
        const data = response.data;
        return { items: data?.promotions || [], pagination: { total: data?.total || 0, offset: 0 } };
      } catch (err) {
        if (err instanceof ApiError && err.statusCode === 404) {
          setNotEnabled(true);
          return { items: [], pagination: { total: 0, offset: 0 } };
        }
        throw err;
      }
    },
    enabled: isAuthenticated && isSuperAdmin,
  });

  // ── Create ──────────────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [campaign, setCampaign] = useState('');
  const [unit, setUnit] = useState<'dollar' | 'percent'>('dollar');
  const [kind, setKind] = useState<'onetime' | 'recurring'>('onetime');
  const [value, setValue] = useState('');
  const [event, setEvent] = useState<Promotion['trigger']['event']>('subscription_created');
  const [referrerValue, setReferrerValue] = useState('');
  const [tiers, setTiers] = useState<string[]>([]);
  const [firstOnly, setFirstOnly] = useState(false);
  const [budget, setBudget] = useState('');
  const [perOrgCap, setPerOrgCap] = useState('');
  const [maxGrants, setMaxGrants] = useState('');
  const createForm = useFormState();

  const openCreate = () => {
    setName(''); setCampaign(''); setUnit('dollar'); setKind('onetime'); setValue('');
    setEvent('subscription_created'); setReferrerValue(''); setTiers([]); setFirstOnly(false);
    setBudget(''); setPerOrgCap(''); setMaxGrants('');
    createForm.reset();
    setCreateOpen(true);
  };
  const toggleTier = (t: string) => setTiers((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const handleCreate = async () => {
    const nm = name.trim();
    const val = Number(value.trim());
    const budgetDollars = Number(budget.trim());
    if (!nm) { createForm.setError('Name is required.'); return; }
    if (!Number.isFinite(val) || val < 1) { createForm.setError('Value must be 1 or more.'); return; }
    // Percent values must be whole numbers (backend schema is z.number().int());
    // a fractional percent would otherwise pass here and 400 server-side.
    if (unit === 'percent' && (!Number.isInteger(val) || val > 100)) { createForm.setError('Percent value must be a whole number ≤ 100.'); return; }
    if (!Number.isFinite(budgetDollars) || budgetDollars < 0.01) { createForm.setError('Budget is required.'); return; }
    if (perOrgCap.trim() && !(Number(perOrgCap.trim()) > 0)) { createForm.setError('Per-org cap must be a positive number.'); return; }
    if (maxGrants.trim() && !(Number.isInteger(Number(maxGrants.trim())) && Number(maxGrants.trim()) >= 1)) { createForm.setError('Max grants must be a whole number ≥ 1.'); return; }
    if (event === 'referral' && referrerValue.trim()) {
      const rv = Number(referrerValue.trim());
      if (!Number.isFinite(rv) || rv < 1) { createForm.setError('Referrer value must be 1 or more.'); return; }
      if (unit === 'percent' && (!Number.isInteger(rv) || rv > 100)) { createForm.setError('Percent referrer value must be a whole number ≤ 100.'); return; }
    }

    // dollar value + budget/cap are entered in DOLLARS; the API takes cents.
    const body: PromotionInput = {
      name: nm,
      ...(campaign.trim() && { campaign: campaign.trim() }),
      unit,
      kind,
      value: unit === 'percent' ? val : Math.round(val * 100),
      trigger: {
        event,
        ...((tiers.length || firstOnly) && {
          conditions: { ...(tiers.length && { tiers }), ...(firstOnly && { firstSubscriptionOnly: true }) },
        }),
      },
      budgetCents: Math.round(budgetDollars * 100),
      ...(perOrgCap.trim() && { perOrgCapCents: Math.round(Number(perOrgCap.trim()) * 100) }),
      ...(maxGrants.trim() && { maxGrants: Number(maxGrants.trim()) }),
      // Referral: `value` is the referee's grant; referrerValue is the referrer's.
      ...(event === 'referral' && referrerValue.trim() && {
        referrerValue: unit === 'percent' ? Number(referrerValue.trim()) : Math.round(Number(referrerValue.trim()) * 100),
      }),
    };
    const result = await createForm.run(() => api.createPromotion(body));
    if (result) {
      toast.success('Promotion created');
      setCreateOpen(false);
      list.refresh();
    }
  };

  // ── Row actions ─────────────────────────────────────────
  const toggleActive = async (p: Promotion) => {
    try {
      await api.updatePromotion(p.id, { isActive: !p.isActive });
      toast.success(p.isActive ? 'Promotion revoked' : 'Promotion activated');
      list.refresh();
    } catch (err) {
      list.setError(formatError(err, 'Failed to update promotion'));
    }
  };

  const doPreview = async (p: Promotion) => {
    try {
      const res = await api.previewPromotion(p.id);
      const proj = res.data?.projection;
      if (proj) toast.info(`Projected: ${proj.eligibleOrgs} orgs, ${formatCents(proj.projectedCents)} of ${formatCents(proj.remainingBudgetCents)} remaining`);
      else toast.info('No projection returned.');
    } catch (err) {
      list.setError(formatError(err, 'Failed to preview promotion'));
    }
  };

  const doActivate = async (p: Promotion) => {
    try {
      const res = await api.activatePromotion(p.id);
      const r = res.data?.result;
      if (r) toast.success(`Activated: ${r.granted} granted (${r.matched} eligible)${r.alreadyGranted ? `, ${r.alreadyGranted} already granted` : ''}${r.skippedBudget ? `, ${r.skippedBudget} skipped (budget)` : ''}`);
      else toast.info('No activation result returned.');
      list.refresh();
    } catch (err) {
      list.setError(formatError(err, 'Failed to activate promotion'));
    }
  };

  const doSpend = async (p: Promotion) => {
    try {
      const res = await api.promotionSpend(p.id);
      const s = res.data?.spend;
      if (s) toast.info(`Committed ${formatCents(s.committedCents)} / ${formatCents(s.budgetCents)} (${s.committedGrants} grants)${s.driftCents ? ` — cache drift ${formatCents(s.driftCents)}` : ''}`);
      else toast.info('No spend data returned.');
    } catch (err) {
      list.setError(formatError(err, 'Failed to load spend'));
    }
  };

  // ── Manual grant ────────────────────────────────────────
  const [grantFor, setGrantFor] = useState<Promotion | null>(null);
  const [grantOrg, setGrantOrg] = useState('');
  const grantForm = useFormState();
  const openGrant = (p: Promotion) => { setGrantFor(p); setGrantOrg(''); grantForm.reset(); };
  const handleGrant = async () => {
    const org = grantOrg.trim();
    if (!grantFor || !org) return;
    const result = await grantForm.run(() => api.grantPromotion(grantFor.id, org));
    if (result) {
      const r = result.data?.result;
      toast[r?.granted ? 'success' : 'info'](r?.granted ? `Granted ${formatCents(r.cents ?? 0)}` : `Not granted: ${r?.reason ?? 'unknown'}`);
      setGrantFor(null);
      list.refresh();
    }
  };

  // Plain per-render const (not useMemo): the row action handlers close over
  // `list`/`toast`, so an empty-dep memo would capture them stale. A small admin
  // table doesn't need the memo, and this keeps the closures fresh.
  const columns: Column<Promotion>[] = [
    {
      id: 'name', header: 'Campaign',
      render: (p) => (
        <div>
          <div className="font-medium text-gray-900 dark:text-gray-100">{p.name}</div>
          {p.campaign && <div className="text-xs text-gray-500 dark:text-gray-400">{p.campaign}</div>}
        </div>
      ),
    },
    { id: 'amount', header: 'Grant', render: (p) => <span className="font-mono">{formatAmount(p)}</span> },
    { id: 'trigger', header: 'Trigger', render: (p) => <span className="text-sm">{eventLabel(p.trigger.event)}{p.kind === 'recurring' ? ' · recurring' : ''}</span> },
    {
      id: 'budget', header: 'Budget',
      render: (p) => {
        const pct = p.budgetCents > 0 ? Math.min(100, Math.round((p.spentCents / p.budgetCents) * 100)) : 0;
        return (
          <div className="min-w-[8rem]">
            <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>{formatCents(p.spentCents)}</span><span>{formatCents(p.budgetCents)}</span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
              <div className="h-full bg-blue-500" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      },
    },
    { id: 'active', header: 'Status', render: (p) => <Badge color={p.isActive ? 'green' : 'gray'}>{p.isActive ? 'Active' : 'Inactive'}</Badge> },
    {
      id: 'actions', header: '',
      render: (p) => (
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => doPreview(p)} title="Preview reach" aria-label="Preview reach"><Eye className="w-4 h-4" /></Button>
          <Button variant="ghost" size="sm" onClick={() => doActivate(p)} title="Grant to existing eligible base" aria-label="Grant to existing eligible base"><Zap className="w-4 h-4" /></Button>
          <Button variant="ghost" size="sm" onClick={() => doSpend(p)} title="Spend rollup" aria-label="Spend rollup"><BarChart3 className="w-4 h-4" /></Button>
          <Button variant="ghost" size="sm" onClick={() => openGrant(p)} title="Manual grant" aria-label="Manual grant"><Gift className="w-4 h-4" /></Button>
          <Button variant="ghost" size="sm" onClick={() => toggleActive(p)}>{p.isActive ? 'Revoke' : 'Activate'}</Button>
        </div>
      ),
    },
  ];

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Promotions"
      subtitle="Rule-driven usage-credit campaigns"
      titleExtra={<Badge color="red">System Admin</Badge>}
      actions={!notEnabled && (
        <Button onClick={openCreate}><Plus className="w-4 h-4 mr-1" /> New promotion</Button>
      )}
    >
      <ErrorAlert message={list.error} onDismiss={() => list.setError(null)} />

      {notEnabled ? (
        <Card className="flex flex-col items-center text-center py-14">
          <div className="w-16 h-16 rounded-2xl bg-gray-100 dark:bg-gray-700/50 flex items-center justify-center">
            <ShieldAlert className="w-9 h-9 text-gray-400 dark:text-gray-500" />
          </div>
          <h3 className="mt-4 text-base font-semibold text-gray-900 dark:text-gray-100">Promotions are not enabled</h3>
          <p className="mt-1.5 text-sm text-gray-500 dark:text-gray-400 max-w-sm">
            Set <code className="font-mono">BILLING_PROMOTIONS_ENABLED</code> (and <code className="font-mono">BILLING_DISCOUNTS_ENABLED</code>) to manage promotion campaigns here.
          </p>
        </Card>
      ) : (
        <>
          <div className="filter-bar flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-1" role="group" aria-label="Filter by active state">
              {([['all', 'All'], ['true', 'Active'], ['false', 'Inactive']] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => list.updateFilter('active', value)}
                  aria-pressed={String(list.filters.active) === value}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${String(list.filters.active) === value
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <DataTable
            data={list.data}
            columns={columns}
            isLoading={list.isLoading}
            emptyState={{ icon: Megaphone, title: 'No promotions', description: 'No promotion campaigns have been created yet.' }}
            getRowKey={(p) => p.id}
          />
        </>
      )}

      {/* Create modal */}
      {createOpen && (
        <Modal
          title="New promotion"
          onClose={() => setCreateOpen(false)}
          footer={
            <ModalFooter
              onCancel={() => setCreateOpen(false)}
              onConfirm={handleCreate}
              confirmLabel="Create"
              loading={createForm.loading}
              confirmDisabled={!name.trim() || !value.trim() || !budget.trim()}
            />
          }
        >
          <div className="space-y-3">
            <ErrorAlert message={createForm.error} onDismiss={() => createForm.setError(null)} />
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Summer signup credit" /></Field>
            <Field label={<>Campaign <span className="text-gray-400">(optional)</span></>}><Input value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="summer24" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Unit">
                <select className="input w-full" value={unit} onChange={(e) => setUnit(e.target.value as 'dollar' | 'percent')}>
                  <option value="dollar">Dollars</option>
                  <option value="percent">Percent of plan</option>
                </select>
              </Field>
              <Field label={unit === 'percent' ? 'Percent' : 'Amount ($)'}><Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={unit === 'percent' ? '20' : '50'} /></Field>
            </div>
            <Field label="Frequency">
              <select className="input w-full" value={kind} onChange={(e) => setKind(e.target.value as 'onetime' | 'recurring')}>
                <option value="onetime">One-time</option>
                <option value="recurring">Recurring (each period)</option>
              </select>
            </Field>
            <Field label="Trigger">
              <select className="input w-full" value={event} onChange={(e) => setEvent(e.target.value as Promotion['trigger']['event'])}>
                {EVENTS.map((ev) => <option key={ev.value} value={ev.value}>{ev.label}</option>)}
              </select>
            </Field>
            {event === 'referral' && (
              <Field label={<>Referrer {unit === 'percent' ? 'percent' : 'amount ($)'} <span className="text-gray-400">(blank = same as referee)</span></>}>
                <Input value={referrerValue} onChange={(e) => setReferrerValue(e.target.value)} placeholder={unit === 'percent' ? '10' : '25'} />
              </Field>
            )}
            <div>
              <span className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Eligible tiers <span className="text-gray-400">(none = all)</span></span>
              <div className="flex flex-wrap gap-2">
                {TIER_KEYS.map((t) => (
                  <button key={t} type="button" onClick={() => toggleTier(t)} aria-pressed={tiers.includes(t)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border capitalize transition-colors ${tiers.includes(t)
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600'}`}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={firstOnly} onChange={(e) => setFirstOnly(e.target.checked)} />
              First subscription only
            </label>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Budget ($)"><Input value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="500" /></Field>
              <Field label={<>Per-org cap <span className="text-gray-400">($)</span></>}><Input value={perOrgCap} onChange={(e) => setPerOrgCap(e.target.value)} placeholder="optional" /></Field>
              <Field label="Max grants"><Input value={maxGrants} onChange={(e) => setMaxGrants(e.target.value)} placeholder="optional" /></Field>
            </div>
          </div>
        </Modal>
      )}

      {/* Manual grant modal */}
      {grantFor && (
        <Modal
          title={`Grant "${grantFor.name}"`}
          onClose={() => setGrantFor(null)}
          footer={
            <ModalFooter
              onCancel={() => setGrantFor(null)}
              onConfirm={handleGrant}
              confirmLabel="Grant"
              loading={grantForm.loading}
              confirmDisabled={!grantOrg.trim()}
            />
          }
        >
          <div className="space-y-3">
            <ErrorAlert message={grantForm.error} onDismiss={() => grantForm.setError(null)} />
            <p className="text-sm text-gray-500 dark:text-gray-400">Grants this promotion to one org (honors budget + one-per-org idempotency).</p>
            <Field label="Target org ID"><Input value={grantOrg} onChange={(e) => setGrantOrg(e.target.value)} placeholder="org id" /></Field>
          </div>
        </Modal>
      )}
    </DashboardLayout>
  );
}
