import { TabBar } from '@/components/ui/TabBar';

/** Inline state tab bar for report/billing pages. Thin wrapper over the shared
 *  `TabBar` primitive (button mode) — kept for its existing call-site API. */
interface ReportTabsProps {
  tabs: { id: string; label: string }[];
  activeTab: string;
  onTabChange: (id: string) => void;
}

export default function ReportTabs({ tabs, activeTab, onTabChange }: ReportTabsProps) {
  return <TabBar items={tabs} activeId={activeTab} onSelect={onTabChange} />;
}
