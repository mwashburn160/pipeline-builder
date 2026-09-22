import { TabBar } from './TabBar';

/**
 * Segmented tabs linking the two sysadmin plugin-build views — the live queue
 * and the failed-build (DLQ) triage, under one "Builds" nav entry.
 * Thin wrapper over the shared `TabBar` primitive (link/navigation mode).
 */
const TABS = [
  { id: 'queue', label: 'Queue', href: '/dashboard/build-queue' },
  { id: 'failed', label: 'Failed / Triage', href: '/dashboard/triage' },
] as const;

export function BuildsTabs({ active }: { active: 'queue' | 'failed' }) {
  return <TabBar items={TABS} activeId={active} />;
}
