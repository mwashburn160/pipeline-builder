import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { HelpAccordionTopic } from '@/components/help/HelpAccordionTopic';
import { HELP_TOPICS } from '@/lib/help';

export default function HelpPage() {
  const { user, isReady } = useAuthGuard();

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout title="Help">
      <div className="space-y-3 max-w-4xl">
        {HELP_TOPICS.map((topic, i) => (
          <HelpAccordionTopic key={topic.id} topic={topic} defaultOpen={i === 0} />
        ))}
      </div>
    </DashboardLayout>
  );
}
